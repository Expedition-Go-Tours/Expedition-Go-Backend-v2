/**
 * Supplier refund request endpoints.
 *
 * Supplier side lives on the dashboard's booking routes; admin side on the
 * admin router. One controller serves both, and the service owns every rule —
 * this layer only unwraps the request and shapes the response.
 */

const catchAsync = require('../services/catchAsync');
const service = require('../services/supplierRefundRequest');

function supplierIdOf(req) {
  return req.supplierId || (req.user && req.user.id) || null;
}

// ── Supplier ─────────────────────────────────────────────────────────────

/** What the modal needs: ceiling, share, reasons, any open request. */
exports.quote = catchAsync(async (req, res, next) => {
  const data = await service.quoteRefund({
    bookingId: req.params.id,
    supplierId: supplierIdOf(req),
    requesterEmail: (req.user && req.user.email) || null,
  });
  res.status(200).json({ status: 'success', data });
});

exports.create = catchAsync(async (req, res, next) => {
  const data = await service.createRefundRequest({
    bookingId: req.params.id,
    supplierId: supplierIdOf(req),
    supplier: req.user,
    payload: req.body,
    actor: req.user,
    req,
  });
  res.status(201).json({ status: 'success', data: { request: data } });
});

exports.listMine = catchAsync(async (req, res, next) => {
  const { status, page, limit } = req.query;
  const data = await service.listSupplierRefundRequests({
    supplierId: supplierIdOf(req),
    status,
    page,
    limit,
  });
  res.status(200).json({ status: 'success', data });
});

exports.withdraw = catchAsync(async (req, res, next) => {
  const data = await service.withdrawRefundRequest({
    requestId: req.params.id,
    supplierId: supplierIdOf(req),
    actor: req.user,
    req,
  });
  res.status(200).json({ status: 'success', data });
});

// ── Admin ────────────────────────────────────────────────────────────────

exports.listAdmin = catchAsync(async (req, res, next) => {
  const { status, page, limit, search } = req.query;
  const data = await service.listAdminRefundRequests({ status, page, limit, search });
  res.status(200).json({ status: 'success', data });
});

exports.getAdminOne = catchAsync(async (req, res, next) => {
  const data = await service.getAdminRefundRequest(req.params.id);
  res.status(200).json({ status: 'success', data: { request: data } });
});

exports.approve = catchAsync(async (req, res, next) => {
  const note = req.body && req.body.note ? String(req.body.note) : null;
  const data = await service.approveRefundRequest({
    requestId: req.params.id,
    adminUser: req.user,
    note,
    req,
  });
  res.status(200).json({ status: 'success', data: { request: data } });
});

exports.reject = catchAsync(async (req, res, next) => {
  const note = req.body ? req.body.note : null;
  const data = await service.rejectRefundRequest({
    requestId: req.params.id,
    adminUser: req.user,
    note,
    req,
  });
  res.status(200).json({ status: 'success', data: { request: data } });
});
