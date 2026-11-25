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
const { enqueueNotification } = require('../../core/services/queue');
const chatService = require('../../core/services/chatService');
const {
  BOOKING_TRANSITIONS,
  supplierIdFor,
  objectOrEmpty,
  dateKey,
  parseDateKey,
  addDays,
  nightsBetween,
  enumBookingStatus,
  displayBookingStatus,
  serializeStayBooking,
  stayBookingInclude,
} = require('./staysShared');

const MAX_BOOKINGS = 500;

/**
 * Stays notifications are tagged with the product domain so the Stays bell can
 * request domain=STAYS and never surface tour activity.
 */
function enqueueStayNotification({ userId, type, title, message, booking }) {
  return enqueueNotification({
    userId,
    type,
    title,
    message,
    domain: 'STAYS',
    data: {
      domain: 'STAYS',
      bookingId: booking.id,
      stayBookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      propertyId: booking.propertyId,
      propertyName: booking.property?.name || '',
      guestName: booking.guestName,
    },
  }).catch((err) => {
    console.error('[Stays] booking notification failed:', err.message);
  });
}

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

/** Statuses that occupy a room. CANCELLED / NO_SHOW / COMPLETED release it. */
const ACTIVE_BOOKING_STATUSES = ['NEW', 'CONFIRMED', 'CHECKED_IN'];

/**
 * Arbitrary but stable namespace for the per-room advisory lock. Postgres keyed
 * locks are (namespace, key) pairs; keeping the first component fixed leaves the
 * whole second component free for the room.
 */
const INVENTORY_LOCK_NAMESPACE = 4242;

/**
 * Serialization failures and deadlocks are expected under load, not
 * exceptional: when two transactions touch the same rows, Postgres aborts one
 * rather than admitting both. The correct response is to re-run the loser
 * against the state the winner committed.
 */
const MAX_TRANSACTION_ATTEMPTS = 3;

function isRetryableTransactionError(err) {
  if (!err) return false;
  // Prisma maps 40001 (serialization_failure) and 40P01 (deadlock_detected) to
  // P2034. Raw driver errors keep the SQLSTATE on `code`.
  if (err.code === 'P2034' || err.code === '40001' || err.code === '40P01') return true;
  const message = String(err.message || '');
  return /could not serialize access|deadlock detected|write conflict/i.test(message);
}

async function runInventoryTransaction(fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableTransactionError(err)) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Count how many occupied bookings touch each night of a date range.
 *
 * Per-night rather than "one booking overlaps the whole range": a date whose
 * override lowers `count` to 1 must reject a second booking that merely
 * overlaps it, even when the room's base inventory is 5.
 */
function occupiedNights(bookings) {
  const counts = new Map();
  for (const booking of bookings) {
    for (
      let night = new Date(booking.checkIn);
      night < booking.checkOut;
      night = addDays(night, 1)
    ) {
      const key = dateKey(night);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Validate one reservation night by night against the room's base inventory
 * and its per-date overrides.
 *
 * Returns the authoritative room-and-nights total. Overrides were previously
 * consulted for `closed` only; `count`, `price` and `minStay` were read from
 * the database and then ignored, so a supplier could cut a night's inventory to
 * one room, raise its price, or require a three-night stay, and the booking
 * endpoint would still sell it at the room's base price for a single night.
 */
async function validateStayNights({
  tx,
  property,
  room,
  plan,
  checkIn,
  checkOut,
  nights,
}) {
  const baseCapacity = Math.max(1, Number(room.count) || 1);
  const baseNightly = plan ? Number(plan.price) : Number(room.price);

  const [overrides, overlapping] = await Promise.all([
    tx.stayAvailabilityOverride.findMany({
      where: {
        propertyId: property.id,
        roomId: room.id,
        date: { gte: checkIn, lt: checkOut },
      },
      select: { date: true, count: true, closed: true, price: true, minStay: true },
    }),
    tx.stayBooking.findMany({
      where: {
        propertyId: property.id,
        roomId: room.id,
        status: { in: ACTIVE_BOOKING_STATUSES },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
      },
      select: { checkIn: true, checkOut: true },
    }),
  ]);

  const overrideByDate = new Map(overrides.map((row) => [dateKey(row.date), row]));
  const occupied = occupiedNights(overlapping);

  let total = 0;

  for (let index = 0; index < nights; index += 1) {
    const night = addDays(checkIn, index);
    const key = dateKey(night);
    const override = overrideByDate.get(key);

    if (override?.closed) {
      throw new AppError(`Those dates are blocked for this room (${key} is closed)`, 400);
    }

    if (override?.minStay != null && nights < override.minStay) {
      throw new AppError(
        `A minimum stay of ${override.minStay} night(s) applies on ${key}`,
        400,
      );
    }

    const capacity = override?.count != null ? Math.max(0, override.count) : baseCapacity;
    const alreadyBooked = occupied.get(key) || 0;
    if (alreadyBooked + 1 > capacity) {
      throw new AppError(`No rooms are available for ${key}`, 400);
    }

    // A per-date price wins over the rate plan, which wins over the room rate.
    // `null`/absent means "no override", not "free".
    const nightly =
      override?.price != null ? Number(override.price) : baseNightly;
    if (!Number.isFinite(nightly) || nightly < 0) {
      throw new AppError(`A valid nightly price is required before taking a booking (${key})`, 400);
    }
    total += nightly;
  }

  return Math.round(total * 100) / 100;
}

exports.createBooking = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const body = objectOrEmpty(req.body);

  if (!body.propertyId) throw new AppError('Property is required', 400);
  if (!body.roomId) throw new AppError('Room is required', 400);

  const checkIn = parseDateKey(body.checkIn);
  const checkOut = parseDateKey(body.checkOut);
  if (!checkIn || !checkOut) throw new AppError('Valid check-in and check-out dates are required', 400);
  const nights = nightsBetween(checkIn, checkOut);
  if (nights <= 0) throw new AppError('Check-out must be after check-in', 400);

  const guestName = parseGuestName(body.guestName);
  if (!guestName) throw new AppError('Guest name is required', 400);
  const guestEmail = typeof body.guestEmail === 'string' ? body.guestEmail.trim() || null : null;

  // Link an existing customer account by email so the Stays inbox can show the
  // guest and both sides can share one conversation thread.
  const customer = guestEmail
    ? await prisma.user.findFirst({
      where: { email: { equals: guestEmail, mode: 'insensitive' }, roles: { has: 'customer' } },
      select: { id: true },
    })
    : null;

  const guests = parseGuests(body.guests);

  // Allocate the booking number BEFORE the inventory transaction.
  //
  // `generateBookingNumber` bumps a single per-prefix counter row. Doing that
  // inside the inventory transaction makes every concurrent booking conflict on
  // that one row — even when they are for different rooms — because the counter
  // update is a write to a row every other transaction's snapshot must account
  // for. A number is not inventory state: if the transaction below fails or
  // retries, the number is simply unused, which is cheaper than serialising all
  // bookings through one counter row.
  const bookingNumber = await generateBookingNumber('TRG-S');

  // Everything that decides whether the room is actually available happens
  // inside one transaction holding a per-room advisory lock:
  //
  //   lock room → read availability → decide → insert
  //
  // Splitting those steps across separate connections is what allowed two
  // simultaneous requests to both observe "0 of 1 rooms booked" and both
  // insert a reservation. The advisory lock is transaction-scoped: it is
  // released on commit or rollback, and it serialises creators for one
  // (property, room) without blocking bookings for every other room.
  //
  // READ COMMITTED, not SERIALIZABLE, is deliberate. The lock already provides
  // mutual exclusion, and every statement after it sees the state the previous
  // holder committed. Serializable would additionally abort the waiting
  // transaction because the snapshot it captured before acquiring the lock is
  // now stale — one wasted attempt and a scary log line per concurrent booking,
  // for a guarantee the lock already provides.
  const booking = await runInventoryTransaction(() =>
    prisma.$transaction(
      async (tx) => {
        const lockKey = `${body.propertyId}:${body.roomId}`;
        // `pg_advisory_xact_lock` returns `void`, which Prisma cannot
        // deserialize. Selecting a constant from a subquery that evaluates the
        // lock keeps the side effect and returns an Int column instead.
        //
        // `$queryRawUnsafe` with positional parameters, not the tagged
        // `$queryRaw`: `jest.setup.js` rewrites tagged raw queries onto the
        // root client to work around a Prisma-under-Jest quirk, which would run
        // this statement OUTSIDE the interactive transaction. A transaction
        // lock taken in autocommit is released the moment the statement
        // finishes, which silently reopens the oversell race the lock exists to
        // close. The Unsafe variant is not rewritten and stays bound to `tx`;
        // values are still parameterised ($1/$2), so this is not interpolation.
        await tx.$queryRawUnsafe(
          'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)) AS lock',
          INVENTORY_LOCK_NAMESPACE,
          lockKey,
        );

        // Re-read inside the lock: a property edit or archive between the
        // request and the lock acquisition must not be ignored.
        const property = await tx.stayProperty.findFirst({
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

        const computedAmount = await validateStayNights({
          tx,
          property,
          room,
          plan,
          checkIn,
          checkOut,
          nights,
        });

        const requestedAmount = Number(body.amount);
        const amount = Number.isFinite(requestedAmount) && requestedAmount > 0
          ? Math.round(requestedAmount * 100) / 100
          : computedAmount;

        if (!(amount > 0)) {
          throw new AppError('A nightly price is required before taking a booking', 400);
        }

        const commission = await calculateCommission(amount);

        return tx.stayBooking.create({
          data: {
            bookingNumber,
            supplierId,
            propertyId: property.id,
            roomId: room.id,
            roomName: room.name || room.kind || null,
            ratePlanId: plan?.id || null,
            ratePlanName: plan?.name || null,
            guestName,
            customerId: customer?.id ?? null,
            guestEmail,
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
      },
      { isolationLevel: 'ReadCommitted', timeout: 15000, maxWait: 10000 },
    ),
  );

  enqueueStayNotification({
    userId: supplierId,
    type: 'BOOKING_CREATED_BY_SUPPLIER',
    title: 'New stay booking',
    message: `${guestName} booked ${booking.property?.name || 'a property'} (${booking.bookingNumber}).`,
    booking,
  });

  if (customer && customer.id !== supplierId) {
    await chatService.findOrCreateConversation(
      supplierId,
      customer.id,
      'SUPPLIER_CUSTOMER',
      {
        domain: 'STAYS',
        stayBookingId: booking.id,
        propertyId: booking.propertyId,
        bookingNumber: booking.bookingNumber,
        tourTitle: booking.property?.name || '',
      },
    ).catch((err) => {
      console.error('[Stays] conversation creation failed:', err.message);
    });
  }

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

  enqueueStayNotification({
    userId: supplierId,
    type: 'BOOKING_STATUS_UPDATED',
    title: 'Stay booking updated',
    message: `${booking.guestName}'s booking is now ${displayBookingStatus(booking.status)}.`,
    booking,
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
