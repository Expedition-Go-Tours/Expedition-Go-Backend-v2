/**
 * Supplier-created bookings — API surface.
 *
 * Everything authoritative happens in services/supplierBookingService: the
 * controller only validates shape, resolves the acting supplier and renders
 * results. Nothing here trusts a price, a supplier id, an origin, a status or
 * a commission from the request body — those come from the server.
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const supplierBookingService = require('../services/supplierBookingService');
const { sanitizeBookingPaymentInternals } = require('../services/sanitizeBookings');
const supplierContact = require('../services/supplierContact');

/** The acting supplier comes from `resolveSupplier`, never from the body. */
function actingSupplier(req) {
  return req.supplierId || req.user?.id;
}

exports.quote = catchAsync(async (req, res, next) => {
  const { tourId, optionId, travelDate, selectedTime, travelers } = req.body;
  const quote = await supplierBookingService.quoteBooking({
    supplierId: actingSupplier(req),
    brandKey: 'ghana',
    tourId,
    optionId,
    travelDate,
    selectedTime,
    travelers,
  });
  res.status(200).json({ status: 'success', data: quote });
});

exports.create = catchAsync(async (req, res, next) => {
  const supplierId = actingSupplier(req);
  const { tourId, optionId, travelDate, selectedTime, travelers, guest, customerId, pickup, specialRequests, collection } = req.body;

  // The idempotency key is a header or a body field; the header is preferred
  // so a client can retry the identical request safely.
  const idempotencyKey =
    req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.body?.idempotencyKey;

  const booking = await supplierBookingService.createBooking({
    supplierId,
    actorId: req.user?.id,
    brandKey: 'ghana',
    tourId,
    optionId,
    travelDate,
    selectedTime,
    travelers,
    guest,
    customerId,
    pickupAddress: pickup?.address,
    pickupAreaName: pickup?.areaName,
    specialRequests,
    collection,
    idempotencyKey,
  });

  // The relay address in place of any real email — same privacy layer as the
  // rest of the bookings API. The minting helper resolves the supplier from
  // `booking.tour.supplierId`; a freshly created row carries no relations, so
  // the acting supplier is passed in explicitly. A guest booking (no
  // customerId) simply has no relay, and nothing real is ever substituted.
  const contact = await supplierContact
    .contactAddressForBooking({ ...booking, tour: { supplierId } })
    .catch(() => null);

  res.status(201).json({
    status: 'success',
    data: {
      booking: sanitizeBookingPaymentInternals(
        supplierContact.withSupplierContact(booking, contact),
      ),
    },
  });
});

exports.collections = catchAsync(async (req, res, next) => {
  const supplierId = actingSupplier(req);
  const booking = await require('../services/prismaClient').booking.findUnique({
    where: { id: req.params.id },
    include: { tour: { select: { supplierId: true } } },
  });
  if (!booking || booking.tour?.supplierId !== supplierId) {
    return next(new AppError('Booking not found or not yours', 404));
  }
  const summary = await supplierBookingService.collectionSummary(booking.id);
  res.status(200).json({ status: 'success', data: summary });
});

exports.recordCollection = catchAsync(async (req, res, next) => {
  const supplierId = actingSupplier(req);
  const idempotencyKey = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.body?.idempotencyKey;

  const row = await supplierBookingService.recordCollection({
    bookingId: req.params.id,
    supplierId,
    actorId: req.user?.id,
    amount: req.body.amount,
    method: req.body.method,
    collectedAt: req.body.collectedAt,
    externalRef: req.body.externalRef,
    note: req.body.note,
    idempotencyKey,
    reversesId: req.body.reversesId,
  });

  res.status(201).json({ status: 'success', data: { collection: row } });
});

/**
 * An offline refund is money the supplier RETURNS to the customer outside the
 * platform: the same ledger, a negative amount. Nothing here can mark a Stripe
 * refund as done — that path is untouched.
 */
exports.recordOfflineRefund = catchAsync(async (req, res, next) => {
  const supplierId = actingSupplier(req);
  const idempotencyKey = req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || req.body?.idempotencyKey;

  const row = await supplierBookingService.recordCollection({
    bookingId: req.params.id,
    supplierId,
    actorId: req.user?.id,
    amount: -Math.abs(Number(req.body.amount)),
    method: req.body.method,
    collectedAt: req.body.collectedAt,
    externalRef: req.body.externalRef,
    note: req.body.note,
    idempotencyKey,
    reversesId: req.body.reversesId,
  });

  res.status(201).json({ status: 'success', data: { refund: row } });
});
