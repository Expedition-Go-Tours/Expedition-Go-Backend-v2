/**
 * Stays bookings — supplier-facing reservations and cancellation reporting.
 *
 * There is no customer stays checkout yet, so the primary writer today is the
 * supplier-created booking endpoint (walk-in / phone reservations). The same
 * table will hold customer bookings when the storefront ships.
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const { generateBookingNumber } = require('../../core/services/bookingHelpers');
const { calculateCommission } = require('../../core/services/stripeHelpers');
const {
  BOOKING_TRANSITIONS,
  supplierIdFor,
  objectOrEmpty,
  parseDateKey,
  nightsBetween,
  enumBookingStatus,
  serializeStayBooking,
  stayBookingInclude,
} = require('./staysShared');

const MAX_BOOKINGS = 500;

function parseGuestName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseGuests(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.min(Math.trunc(number), 50);
}

function formatDisplayDate(value) {
  return new Date(`${value}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

exports.listBookings = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const where = { supplierId };

  const status = enumBookingStatus(req.query?.status);
  if (status) where.status = status;
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const rows = await prisma.stayBooking.findMany({
    where,
    include: stayBookingInclude,
    orderBy: { createdAt: 'desc' },
    take: MAX_BOOKINGS,
  });

  res.status(200).json({
    status: 'success',
    data: { bookings: rows.map(serializeStayBooking) },
  });
});

exports.getBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const booking = await prisma.stayBooking.findFirst({
    where: { id: req.params.id, supplierId },
    include: stayBookingInclude,
  });
  if (!booking) throw new AppError('Booking not found', 404);
  res.status(200).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

exports.createBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);

  if (!body.propertyId) throw new AppError('Property is required', 400);
  const property = await prisma.stayProperty.findFirst({
    where: { id: body.propertyId, supplierId, status: { not: 'ARCHIVED' } },
  });
  if (!property) throw new AppError('Property not found', 404);

  const data = objectOrEmpty(property.data);
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const room = rooms.find((row) => row.id === body.roomId);
  if (!room) throw new AppError('Room is required', 400);

  const plans = Array.isArray(data.ratePlans) ? data.ratePlans : [];
  const plan = body.ratePlanId
    ? plans.find((row) => row.id === body.ratePlanId && row.roomId === room.id)
    : plans.find((row) => row.roomId === room.id) || null;
  if (body.ratePlanId && !plan) throw new AppError('Rate plan not found for this room', 400);

  const checkIn = parseDateKey(body.checkIn);
  const checkOut = parseDateKey(body.checkOut);
  if (!checkIn || !checkOut) throw new AppError('Valid check-in and check-out dates are required', 400);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) throw new AppError('Check-out must be after check-in', 400);

  const guestName = parseGuestName(body.guestName);
  if (!guestName) throw new AppError('Guest name is required', 400);

  const guests = parseGuests(body.guests);
  const capacity = Math.max(1, Number(room.count) || 1);

  const [overlapping, blocked] = await Promise.all([
    prisma.stayBooking.count({
      where: {
        propertyId: property.id,
        roomId: room.id,
        status: { in: ['NEW', 'CONFIRMED', 'CHECKED_IN'] },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
    }),
    prisma.stayAvailabilityOverride.findFirst({
      where: {
        propertyId: property.id,
        roomId: room.id,
        closed: true,
        date: { gte: checkIn, lt: checkOut },
      },
      select: { id: true },
    }),
  ]);

  if (blocked) throw new AppError('Those dates are blocked for this room', 400);
  if (overlapping >= capacity) throw new AppError('No rooms are available for those dates', 400);

  const requestedAmount = Number(body.amount);
  const nightly = plan ? Number(plan.price) : Number(room.price);
  const amount = Number.isFinite(requestedAmount) && requestedAmount > 0
    ? Math.round(requestedAmount * 100) / 100
    : Math.round((Number.isFinite(nightly) ? nightly : 0) * nights * 100) / 100;

  if (!(amount > 0)) throw new AppError('A nightly price is required before taking a booking', 400);

  const commission = await calculateCommission(amount);
  const bookingNumber = await generateBookingNumber('TRG-S');

  const booking = await prisma.stayBooking.create({
    data: {
      bookingNumber,
      supplierId,
      propertyId: property.id,
      roomId: room.id,
      roomName: room.name || room.kind || null,
      ratePlanId: plan?.id || null,
      ratePlanName: plan?.name || null,
      guestName,
      guestEmail: typeof body.guestEmail === 'string' ? body.guestEmail.trim() || null : null,
      guestPhone: typeof body.guestPhone === 'string' ? body.guestPhone.trim() || null : null,
      checkIn,
      checkOut,
      nights,
      guests,
      amount,
      currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
      status: 'NEW',
      paymentStatus: 'PENDING',
      origin: 'SUPPLIER_CREATED',
      specialRequests: typeof body.specialRequests === 'string' ? body.specialRequests.trim() || null : null,
      commissionRate: commission.rate,
      platformCommission: commission.amount,
      supplierPayout: commission.supplierPayout,
    },
    include: stayBookingInclude,
  });

  res.status(201).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

exports.updateBookingStatus = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const nextStatus = enumBookingStatus(req.body?.status);
  if (!nextStatus) throw new AppError('Invalid booking status', 400);

  const existing = await prisma.stayBooking.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true, status: true },
  });
  if (!existing) throw new AppError('Booking not found', 404);

  const allowed = BOOKING_TRANSITIONS[existing.status] || [];
  if (!allowed.includes(nextStatus)) {
    throw new AppError(`Cannot change a ${existing.status.toLowerCase()} booking to ${nextStatus.toLowerCase()}`, 400);
  }

  const data = { status: nextStatus };
  if (nextStatus === 'CANCELLED') {
    data.cancellationReason = 'Supplier cancelled';
    data.cancellationNote = 'Cancelled from the supplier dashboard';
    data.countsTowardRate = true;
  }
  if (nextStatus === 'NO_SHOW') {
    data.countsTowardRate = false;
  }

  const booking = await prisma.stayBooking.update({
    where: { id: existing.id },
    data,
    include: stayBookingInclude,
  });

  res.status(200).json({
    status: 'success',
    data: { booking: serializeStayBooking(booking) },
  });
});

exports.getCancellationSummary = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const days = Math.max(1, parseInt(req.query?.days, 10) || 90);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const where = { supplierId, checkIn: { gte: cutoff } };
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const rows = await prisma.stayBooking.findMany({
    where,
    select: { status: true, amount: true, cancellationReason: true },
  });

  const eligibleBookings = rows.length;
  const cancelledRows = rows.filter((row) => row.status === 'CANCELLED');
  const noShowRows = rows.filter((row) => row.status === 'NO_SHOW');
  const confirmed = rows.filter((row) => row.status === 'CONFIRMED' || row.status === 'CHECKED_IN').length;
  const completed = rows.filter((row) => row.status === 'COMPLETED').length;

  const percent = (count) => (eligibleBookings
    ? Math.round((count / eligibleBookings) * 1000) / 10
    : 0);

  const reasonCounts = new Map();
  for (const row of [...cancelledRows, ...noShowRows]) {
    if (row.cancellationReason) {
      reasonCounts.set(row.cancellationReason, (reasonCounts.get(row.cancellationReason) || 0) + 1);
    }
  }
  const mostCommonReason = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const cancellationRate = percent(cancelledRows.length);
  const status = eligibleBookings < 10
    ? 'Building performance record'
    : cancellationRate <= 1
      ? 'Excellent'
      : cancellationRate <= 2
        ? 'Good'
        : cancellationRate <= 5
          ? 'Needs attention'
          : 'High';

  res.status(200).json({
    status: 'success',
    data: {
      days,
      cancellationRate,
      eligibleBookings,
      confirmed,
      cancelled: cancelledRows.length,
      completed,
      noShowRate: percent(noShowRows.length),
      completionRate: percent(completed),
      status,
      mostCommonReason,
      bookingValueLost: [...cancelledRows, ...noShowRows]
        .reduce((sum, row) => sum + Number(row.amount || 0), 0),
    },
  });
});

exports.getCancellationRecords = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const days = Math.max(1, parseInt(req.query?.days, 10) || 90);
  const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 25));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const where = {
    supplierId,
    status: { in: ['CANCELLED', 'NO_SHOW'] },
    checkIn: { gte: cutoff },
  };
  if (req.query?.propertyId) where.propertyId = req.query.propertyId;

  const [rows, totalCount] = await Promise.all([
    prisma.stayBooking.findMany({
      where,
      include: stayBookingInclude,
      orderBy: { checkIn: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.stayBooking.count({ where }),
  ]);

  const records = rows.map((row) => {
    const travelDate = row.checkIn.toISOString().slice(0, 10);
    return {
      id: row.id,
      travelDate: formatDisplayDate(travelDate),
      reason: row.cancellationReason || 'Cancelled',
      note: row.cancellationNote || '',
      bookingReference: row.bookingNumber,
      productName: row.property?.name || 'Property',
      bookingValue: Number(row.amount),
      refundAmount: row.refundAmount == null ? null : Number(row.refundAmount),
      countsTowardRate: row.countsTowardRate,
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      records,
      pagination: {
        currentPage: page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
    },
  });
});
