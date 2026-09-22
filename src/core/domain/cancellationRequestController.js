/**
 * Cancellation Request endpoints — admin approval gate.
 *
 * Admin side is served by the core admin routes AND the Ghana/Africa brand
 * admin routes; brand scoping is derived from `req.brandKey` (attachBrand),
 * so one controller serves every admin app without forking.
 *
 * Supplier side (own requests + withdraw) lives on the dashboards' booking
 * routes (`/bookings/supplier/cancellation-requests`).
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const service = require('../services/cancellationRequestService');

// ── Admin: queue ─────────────────────────────────────────────────────────
exports.listAdmin = catchAsync(async (req, res) => {
  const { status = 'PENDING_APPROVAL', page = 1, limit = 20, search = '' } = req.query;
  const data = await service.listAdminCancellationRequests({
    status,
    page,
    limit,
    search,
    brandKey: req.brandKey || null,
  });
  res.status(200).json({ status: 'success', data });
});

exports.getAdminOne = catchAsync(async (req, res) => {
  const request = await service.getAdminCancellationRequest(req.params.id);
  res.status(200).json({ status: 'success', data: { request } });
});

exports.approve = catchAsync(async (req, res) => {
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const data = await service.approveCancellationRequest({
    requestId: req.params.id,
    adminUser: req.user,
    req,
    note,
  });
  res.status(200).json({ status: 'success', data });
});

exports.reject = catchAsync(async (req, res) => {
  const note = req.body ? req.body.note : null;
  const data = await service.rejectCancellationRequest({
    requestId: req.params.id,
    adminUser: req.user,
    req,
    note,
  });
  res.status(200).json({ status: 'success', data });
});

/**
 * Batch approve — one decision loop, per-request results, never all-or-nothing
 * (one stale booking cannot block the rest of the queue).
 */
exports.batchApprove = catchAsync(async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
  if (!ids || !ids.length) throw new AppError('ids must be a non-empty array', 400);
  if (ids.length > 100) throw new AppError('Maximum 100 requests per batch', 400);

  const results = [];
  let approved = 0;
  for (const id of ids) {
    try {
      const outcome = await service.approveCancellationRequest({
        requestId: id,
        adminUser: req.user,
        req,
        note: req.body && req.body.note ? String(req.body.note) : 'Batch approved',
      });
      approved += 1;
      results.push({ id, ok: true, bookingId: outcome.booking && outcome.booking.id });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      requested: ids.length,
      approved,
      failed: ids.length - approved,
      results,
    },
  });
});

// ── Supplier: own requests ───────────────────────────────────────────────
exports.listSupplier = catchAsync(async (req, res) => {
  const { status = '', page = 1, limit = 20 } = req.query;
  const data = await service.listSupplierCancellationRequests({
    supplierId: req.supplierId,
    status,
    page,
    limit,
  });
  res.status(200).json({ status: 'success', data });
});

exports.withdraw = catchAsync(async (req, res) => {
  const data = await service.withdrawCancellationRequest({
    requestId: req.params.id,
    supplierId: req.supplierId,
    actorId: req.user ? req.user.id : req.supplierId,
    req,
  });
  res.status(200).json({ status: 'success', data });
});
