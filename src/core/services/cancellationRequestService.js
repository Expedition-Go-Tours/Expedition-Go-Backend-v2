/**
 * Supplier Cancellation Requests — mandatory admin approval gate.
 *
 * When SUPPLIER_CANCEL_REQUIRES_APPROVAL is truthy, nothing that cancels a
 * booking runs directly: the supplier's intent is parked as a
 * CancellationRequest (PENDING_APPROVAL) and only `approveCancellationRequest`
 * executes the money path (cancelBySupplier → refund → 25% fee → customer
 * 48h choice window → emails). Reject and Withdraw change nothing on the
 * booking. Stop-selling dates, however, take effect AT REQUEST TIME (plan
 * decision 3) and are reverted by both Reject and Withdraw via a snapshot.
 *
 * Notification matrix (plan file: CANCELLATION-APPROVAL-PLAN.md):
 *  - request created  → admin feed + Discord + ops email
 *  - decided          → admin feed + Discord + supplier in-app/email
 *  - 24h              → admin feed reminder (never auto-approves)
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const AppError = require('./appError');
const { enqueueNotification } = require('./queue');
const { notifyAdmin } = require('./adminNotificationService');
const { sendEmail } = require('./emailService');
const { logActivity } = require('./auditLogger');
const emailUrls = require('../../../config/emailUrls');
const {
  validateCancellationPayload,
  calcCancellationFee,
} = require('./cancellationReasons');
const {
  plannedRefund,
  cancelBySupplier,
  matchPreview,
} = require('./supplierCancellation');

const CANCELABLE_STATUSES = ['PENDING', 'PROCESSING', 'CONFIRMED'];
const REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
const STOP_MARKER = (key) => `Blocked by cancellation request ${key}`;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** Is the admin-approval gate switched on? Default OFF (safe rollout). */
function requiresApproval() {
  return TRUE_VALUES.has(String(process.env.SUPPLIER_CANCEL_REQUIRES_APPROVAL || '').trim().toLowerCase());
}

/** Comma-separated ops mailbox; empty → warn and skip (documented plan decision 5). */
function opsEmailTargets() {
  return String(process.env.ADMIN_OPS_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function money(amount, currency) {
  const n = Number(amount || 0);
  return `${currency || 'USD'} ${n.toFixed(2)}`;
}

function dateKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

// ── Stop-selling (decision 3: effective at request time, reverted on
//    reject/withdraw). We snapshot what was there before touching anything,
//    and only ever revert rows that still carry our marker — so a supplier
//    who re-opens selling manually after the request is never overridden.
async function blockRangeForRequest(tourId, start, end, key) {
  const endOfEnd = new Date(end);
  endOfEnd.setHours(23, 59, 59, 999);
  const existing = await prisma.tourDateOverride.findMany({
    where: { tourId, date: { gte: new Date(dateKey(start)), lte: endOfEnd } },
    select: { date: true, status: true, notes: true },
  });
  const prevByDate = new Map(existing.map((r) => [dateKey(r.date), r]));

  const marker = STOP_MARKER(key);
  const blocked = [];
  const snapshot = [];
  const cursor = new Date(start);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  while (cursor <= end) {
    const k = dateKey(cursor);
    const dayStart = new Date(`${k}T00:00:00.000Z`);
    if (dayStart >= today) {
      const prev = prevByDate.get(k) || null;
      snapshot.push({ date: k, prevStatus: prev ? prev.status : null, prevNotes: prev ? prev.notes || null : null });
      await prisma.tourDateOverride
        .upsert({
          where: { tourId_date: { tourId, date: dayStart } },
          create: { tourId, date: dayStart, status: 'BLOCKED', notes: marker },
          update: { status: 'BLOCKED', notes: marker },
        })
        .catch((err) => console.error('[CancellationRequest] block date failed for', k, err.message));
      blocked.push(k);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return { marker, blocked, snapshot };
}

async function revertStopSelling(request) {
  const snap = request && request.preview && request.preview.stopSell;
  if (!snap || !Array.isArray(snap.blocked) || !snap.blocked.length) return 0;

  let reverted = 0;
  for (const entry of snap.blocked) {
    const dayStart = new Date(`${entry.date}T00:00:00.000Z`);
    const row = await prisma.tourDateOverride.findUnique({
      where: { tourId_date: { tourId: snap.tourId, date: dayStart } },
    }).catch(() => null);
    // Only touch rows that still bear our marker — respect any manual change.
    if (!row || row.status !== 'BLOCKED' || row.notes !== snap.marker) continue;

    try {
      if (!entry.prevStatus) {
        await prisma.tourDateOverride.delete({ where: { tourId_date: { tourId: snap.tourId, date: dayStart } } });
      } else {
        await prisma.tourDateOverride.update({
          where: { tourId_date: { tourId: snap.tourId, date: dayStart } },
          data: { status: entry.prevStatus, notes: entry.prevNotes },
        });
      }
      reverted += 1;
    } catch (err) {
      console.error('[CancellationRequest] revert stop-selling failed for', entry.date, err.message);
    }
  }
  return reverted;
}

// ── Serialization (one shape for admin queue, supplier list, endpoints) ──
function serializeCancellationRequest(r) {
  if (!r) return null;
  const b = r.booking;
  return {
    id: r.id,
    status: r.status,
    bookingId: r.bookingId,
    booking: b
      ? {
          id: b.id,
          bookingNumber: b.bookingNumber,
          status: b.status,
          paymentStatus: b.paymentStatus,
          refundStatus: b.refundStatus,
          refundAmount: b.refundAmount,
          grossAmount: b.grossAmount,
          currency: b.currency,
          travelDate: b.travelDate,
          selectedTime: b.selectedTime,
          cancellationCode: b.cancellationCode,
          cancellationCategory: b.cancellationCategory,
          cancellationOrigin: b.cancellationOrigin,
          countsTowardRate: b.countsTowardRate,
          cancellationFee: b.cancellationFee,
          cancellationReason: b.cancellationReason,
          cancelledAt: b.cancelledAt,
          cancellationChoiceDeadline: b.cancellationChoiceDeadline,
          customerChoice: b.customerChoice,
          customer: b.customer
            ? { id: b.customer.id, name: b.customer.name, email: b.customer.email }
            : null,
        }
      : null,
    tour: b && b.tour
      ? {
          id: b.tour.id,
          title: b.tour.title,
          supplier: b.tour.supplier
            ? { id: b.tour.supplier.id, name: b.tour.supplier.name }
            : null,
        }
      : null,
    supplier: r.supplier || null,
    payload: r.payload,
    preview: r.preview,
    stopSellingApplied: r.stopSellingApplied,
    batchId: r.batchId,
    decidedBy: r.decidedByUser || null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    reminderCount: r.reminderCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// ── Admin awareness: feed + Discord (inside notifyAdmin) + ops email ─────
async function alertAdminsOnRequest(request, { booking, tour, supplierName, batchCount = 0 }) {
  const targets = opsEmailTargets();
  const refund = (request.preview && request.preview.refund) || { amount: 0 };
  const fee = (request.preview && request.preview.fee) || 0;
  const scope = batchCount > 0 ? ` (${batchCount} bookings in one request)` : '';

  notifyAdmin({
    type: 'SUPPLIER_CANCELLATION_REQUEST',
    title: `Supplier cancellation request${batchCount > 1 ? ` ×${batchCount}` : ''} — #${booking.bookingNumber}`,
    message: `${supplierName || 'Supplier'} requested to cancel "${tour.title}" (${booking.bookingNumber}) for ${booking.travelDate ? dateKey(booking.travelDate) : 'n/a'}. Refund ${money(refund.amount, booking.currency)} · fee ${money(fee, booking.currency)}.${scope} Nothing has been executed — awaiting admin approval.`,
    data: {
      requestId: request.id,
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      supplierId: request.supplierId,
      tourId: tour.id,
      tourTitle: tour.title,
      refundAmount: refund.amount,
      fee,
      countsTowardRate: !!(request.preview && request.preview.countsTowardRate),
    },
    storefront: request.storefront || null,
  }).catch(() => {});

  if (!targets.length) {
    console.warn('[CancellationRequest] ADMIN_OPS_EMAIL not set — skipping ops email for', request.id);
    return;
  }
  sendEmail({
    to: targets,
    subject: `Action needed: supplier cancellation request — #${booking.bookingNumber}`,
    template: 'admin-cancellation-request',
    data: {
      bookingNumber: booking.bookingNumber,
      tourTitle: tour.title,
      supplierName: supplierName || 'Supplier',
      travelDateLabel: booking.travelDate ? dateKey(booking.travelDate) : '—',
      refundLabel: money(refund.amount, booking.currency),
      feeLabel: money(fee, booking.currency),
      rateLabel: (request.preview && request.preview.countsTowardRate) ? 'Yes — counts toward the supplier rate' : 'No',
      categoryLabel: (request.payload && request.payload.cancellationCategory) || '—',
      reasonLabel: (request.payload && (request.payload.explanation || request.payload.cancellationCode)) || '—',
      requestedAt: new Date(request.createdAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      reviewUrl: emailUrls.adminCancellationRequests(request.id),
      scopeLabel: batchCount > 1 ? `${batchCount} bookings (bulk)` : 'Single booking',
    },
  }).catch((err) => console.error('[CancellationRequest] ops email failed:', err.message));
}

function alertAdminsOnDecision(request, booking, tour, approved, adminName) {
  notifyAdmin({
    type: 'SUPPLIER_CANCELLATION_DECIDED',
    title: `Cancellation ${approved ? 'approved' : 'rejected'} — #${booking.bookingNumber}`,
    message: `${adminName || 'An admin'} ${approved ? 'approved' : 'rejected'} the cancellation request for "${tour.title}" (${booking.bookingNumber}).${approved ? ' The refund and fee path has executed.' : ' The booking remains active.'}`,
    data: {
      requestId: request.id,
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      supplierId: request.supplierId,
      tourId: tour.id,
      decision: approved ? 'APPROVED' : 'REJECTED',
      decidedBy: request.decidedBy || null,
    },
    storefront: request.storefront || null,
  }).catch(() => {});
}

function notifySupplierOfDecision(request, booking, tour, approved, note) {
  const supplierId = request.supplierId || tour.supplierId;
  if (!supplierId) return;
  // Resolve the supplier's roles so the bookings link points at THEIR
  // dashboard (Ghana suppliers use a different origin).
  prisma.user
    .findUnique({ where: { id: supplierId }, select: { roles: true } })
    .then((u) => {
      enqueueNotification({
        userId: supplierId,
        type: approved ? 'CANCELLATION_REQUEST_APPROVED' : 'CANCELLATION_REQUEST_REJECTED',
        title: approved ? 'Cancellation request approved' : 'Cancellation request rejected',
        message: approved
          ? `Your cancellation request for booking ${booking.bookingNumber} ("${tour.title}") was approved. The customer has been notified and the refund is on its way.`
          : `Your cancellation request for booking ${booking.bookingNumber} ("${tour.title}") was rejected. The booking remains confirmed.${note ? ` Reason: ${note}` : ''}`,
        data: {
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber,
          tourTitle: tour.title,
          requestId: request.id,
          decision: approved ? 'APPROVED' : 'REJECTED',
          decisionLabel: approved ? 'Approved' : 'Rejected',
          approved,
          note: note || null,
          bookingUrl: emailUrls.supplierBookingsForUser(u || {}),
        },
        sendEmail: true,
        emailTemplate: 'supplier-cancellation-decision',
      }).catch((err) => console.error('[CancellationRequest] supplier decision notification failed:', err.message));
    })
    .catch((err) => console.error('[CancellationRequest] supplier lookup failed:', err.message));
}

async function loadRequestForSerialize(id, { includeSupplier = true } = {}) {
  return prisma.cancellationRequest.findUnique({
    where: { id },
    include: {
      booking: {
        include: {
          customer: { select: { id: true, name: true, email: true } },
          tour: { select: { id: true, title: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
        },
      },
    },
  }).then(async (r) => {
    if (!r || !includeSupplier || !r.supplierId) return r;
    const supplierUser = await prisma.user.findUnique({
      where: { id: r.supplierId },
      select: { id: true, name: true, email: true },
    });
    return { ...r, supplier: supplierUser };
  });
}

// ── 1. Single booking: create the request (no booking/money/customer
//       changes beyond stop-selling, which only applies to bulk today) ─────
async function createCancellationRequest({ booking, payload, supplierId, req }) {
  const validation = validateCancellationPayload(payload);
  if (!validation.ok) throw new AppError(validation.errors.join('; '), 400);

  // Refetch fresh with a consistent include — fork sites pass different
  // partial tour shapes, and previews must run against policy-loaded tour.
  booking = await prisma.booking.findUnique({
    where: { id: booking.id },
    include: {
      tour: { select: { id: true, title: true, slug: true, supplierId: true } },
      customer: { select: { id: true, name: true, email: true } },
    },
  });
  if (!booking) throw new AppError('Booking not found', 404);

  if (!CANCELABLE_STATUSES.includes(booking.status)) {
    throw new AppError(`Booking is ${booking.status} — it can no longer be cancelled this way`, 409);
  }

  const existing = await prisma.cancellationRequest.findFirst({
    where: { bookingId: booking.id, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
    select: { id: true },
  });
  if (existing) {
    throw new AppError('A cancellation request for this booking is already awaiting approval', 409);
  }

  const normalized = validation.normalized;
  const tour = booking.tour;
  const refund = plannedRefund(booking, tour, normalized);
  const fee = calcCancellationFee(booking.grossAmount, normalized);

  const request = await prisma.cancellationRequest.create({
    data: {
      bookingId: booking.id,
      supplierId: supplierId || null,
      payload: { ...normalized, supplierNotes: payload.supplierNotes },
      preview: {
        refund: { amount: refund.amount, note: refund.note },
        fee,
        countsTowardRate: !!normalized.countsTowardRate,
      },
    },
  });

  const supplierUser = supplierId
    ? await prisma.user.findUnique({ where: { id: supplierId }, select: { name: true } })
    : null;

  await alertAdminsOnRequest(request, {
    booking,
    tour,
    supplierName: supplierUser ? supplierUser.name : null,
  });

  logActivity({
    userId: supplierId,
    action: 'booking.cancellation_requested',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: {
      requestId: request.id,
      cancellationCode: normalized.cancellationCode,
      category: normalized.cancellationCategory,
      refundAmount: refund.amount,
      fee,
    },
    req,
  }).catch(() => {});

  const full = await loadRequestForSerialize(request.id);
  return { request: serializeCancellationRequest(full), booking };
}

// ── 2. Bulk: one request per matched booking, shared batchId, stop-selling
//       applied immediately (and snapshotted for revert) ───────────────────
async function submitCancellationRequests({ supplierId, payload, filters, req }) {
  const { matched, overflow, tour, start, end, validation } = await matchPreview({ supplierId, payload, filters });

  const batchId = `cb_${crypto.randomBytes(8).toString('hex')}`;
  const created = [];
  const results = [];
  let skipped = 0;

  // One-pending-per-booking: bookings with an open request are reported, not
  // duplicated.
  const pendingRows = await prisma.cancellationRequest.findMany({
    where: { bookingId: { in: matched.map((b) => b.id) }, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
    select: { bookingId: true },
  });
  const pendingSet = new Set(pendingRows.map((r) => r.bookingId));

  for (const booking of matched) {
    if (pendingSet.has(booking.id)) {
      skipped += 1;
      results.push({ bookingId: booking.id, bookingNumber: booking.bookingNumber, ok: false, error: 'already pending approval' });
      continue;
    }
    const refund = plannedRefund(booking, booking.tour, validation.normalized);
    const fee = calcCancellationFee(booking.grossAmount, validation.normalized);
    try {
      const request = await prisma.cancellationRequest.create({
        data: {
          bookingId: booking.id,
          supplierId: supplierId || null,
          batchId,
          payload: { ...validation.normalized, supplierNotes: payload.supplierNotes },
          preview: {
            refund: { amount: refund.amount, note: refund.note },
            fee,
            countsTowardRate: !!validation.normalized.countsTowardRate,
          },
        },
      });
      created.push({ request, booking });
      results.push({ bookingId: booking.id, bookingNumber: booking.bookingNumber, ok: true, requestId: request.id });
    } catch (err) {
      results.push({ bookingId: booking.id, bookingNumber: booking.bookingNumber, ok: false, error: err.message });
    }
  }

  // ── Stop-selling (decision 3): effective NOW, snapshot for revert ──
  let stopSellingApplied = false;
  const blockedDates = [];
  if (filters && filters.stopAcceptingBookings && created.length > 0) {
    const { blocked, snapshot, marker } = await blockRangeForRequest(tour.id, start, end, batchId);
    stopSellingApplied = blocked.length > 0;
    blockedDates.push(...blocked);
    if (stopSellingApplied) {
      // Persist the snapshot on every request of the batch (each row needs it
      // so a withdraw of ONE booking still reverts cleanly — dates belong to
      // the batch, and revertStopSelling is marker-guarded so double reverts
      // are no-ops).
      for (const { request } of created) {
        await prisma.cancellationRequest.update({
          where: { id: request.id },
          data: {
            stopSellingApplied: true,
            preview: {
              ...request.preview,
              stopSell: { tourId: tour.id, marker, blocked, snapshot },
            },
          },
        }).catch((err) => console.error('[CancellationRequest] snapshot persist failed:', err.message));
      }
    }
  }

  if (created.length > 0) {
    const first = created[0];
    const supplierUser = supplierId
      ? await prisma.user.findUnique({ where: { id: supplierId }, select: { name: true } })
      : null;
    await alertAdminsOnRequest(first.request, {
      booking: first.booking,
      tour,
      supplierName: supplierUser ? supplierUser.name : null,
      batchCount: created.length,
    });
    logActivity({
      userId: supplierId,
      action: 'booking.cancellation_batch_requested',
      resource: 'Tour',
      resourceId: tour.id,
      metadata: {
        batchId,
        requested: created.length,
        skipped,
        stopSellingApplied,
        blockedDates,
        range: { dateFrom: dateKey(start), dateTo: dateKey(end) },
      },
      req,
    }).catch(() => {});
  }

  const rows = await Promise.all(created.map((c) => loadRequestForSerialize(c.request.id)));
  return {
    matched: matched.length,
    overflow,
    requested: created.length,
    skipped,
    failed: results.filter((r) => !r.ok && r.error !== 'already pending approval').length,
    stopSellingApplied,
    blockedDates,
    batchId,
    results,
    requests: rows.map(serializeCancellationRequest),
  };
}

// ── 3. Approve: atomic claim → revalidate fresh booking → execute ────────
async function approveCancellationRequest({ requestId, adminUser, req, note = null }) {
  const claim = await prisma.cancellationRequest.updateMany({
    where: { id: requestId, status: 'PENDING_APPROVAL' },
    data: { status: 'APPROVING' },
  });
  if (claim.count === 0) {
    const current = await prisma.cancellationRequest.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    if (!current) throw new AppError('Cancellation request not found', 404);
    throw new AppError(`Request is already ${current.status.replace('_', ' ').toLowerCase()}`, 409);
  }

  const request = await prisma.cancellationRequest.findUnique({
    where: { id: requestId },
    include: { booking: { include: { tour: true } } },
  });
  const booking = request.booking;
  const tour = booking.tour;

  // Belt-and-braces: the booking must still be cancellable. (Supersede hooks
  // should already have caught every transition; this closes the last gap.)
  if (!CANCELABLE_STATUSES.includes(booking.status)) {
    await prisma.cancellationRequest.updateMany({
      where: { id: requestId, status: 'APPROVING' },
      data: { status: 'SUPERSEDED', decisionNote: `Booking became ${booking.status}`, decidedAt: new Date() },
    });
    throw new AppError(`Booking is now ${booking.status} — the request has been superseded`, 409);
  }

  let result;
  try {
    result = await cancelBySupplier({
      booking,
      payload: request.payload,
      supplierId: adminUser.id,
      req,
      skipValidation: true,
    });

    if (request.payload && request.payload.supplierNotes !== undefined && request.payload.supplierNotes !== null) {
      result.booking = await prisma.booking.update({
        where: { id: booking.id },
        data: { supplierNotes: request.payload.supplierNotes, updatedAt: new Date() },
      });
    }
  } catch (err) {
    // Release the claim so the request can be retried/decided again.
    await prisma.cancellationRequest.updateMany({
      where: { id: requestId, status: 'APPROVING' },
      data: { status: 'PENDING_APPROVAL' },
    }).catch(() => {});
    throw err;
  }

  const updated = await prisma.cancellationRequest.update({
    where: { id: requestId },
    data: {
      status: 'APPROVED',
      decidedBy: adminUser.id,
      decidedAt: new Date(),
      decisionNote: note,
    },
  });

  alertAdminsOnDecision({ ...updated, supplierId: request.supplierId, storefront: request.storefront }, booking, tour, true, adminUser.name);
  notifySupplierOfDecision({ ...updated, supplierId: request.supplierId }, booking, tour, true, note);

  logActivity({
    userId: adminUser.id,
    action: 'booking.cancellation_approved',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: {
      requestId: updated.id,
      supplierId: request.supplierId,
      refundAmount: result.refundAmount,
      fee: result.fee,
      note,
    },
    req,
  }).catch(() => {});

  const full = await loadRequestForSerialize(updated.id);
  return {
    booking: result.booking,
    cancellation: {
      refundStatus: result.refundStatus,
      refundAmount: result.refundAmount,
      refundExecuted: result.refundExecuted,
      fee: result.fee,
      countsTowardRate: result.countsTowardRate,
      choiceDeadline: result.choiceDeadline ? result.choiceDeadline.toISOString() : null,
    },
    request: serializeCancellationRequest(full),
  };
}

// ── 4. Reject: booking untouched, stop-selling reverted, supplier told ───
async function rejectCancellationRequest({ requestId, adminUser, req, note }) {
  const cleanNote = String(note || '').trim();
  if (cleanNote.length < 3) throw new AppError('A rejection reason is required (min 3 characters)', 400);

  const claim = await prisma.cancellationRequest.updateMany({
    where: { id: requestId, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
    data: { status: 'REJECTED' },
  });
  if (claim.count === 0) {
    const current = await prisma.cancellationRequest.findUnique({ where: { id: requestId }, select: { status: true } });
    if (!current) throw new AppError('Cancellation request not found', 404);
    throw new AppError(`Request is already ${current.status.replace('_', ' ').toLowerCase()}`, 409);
  }

  const request = await prisma.cancellationRequest.update({
    where: { id: requestId },
    data: { decidedBy: adminUser.id, decidedAt: new Date(), decisionNote: cleanNote },
  });
  const full = await loadRequestForSerialize(request.id);
  const booking = full.booking;
  const tour = booking.tour;

  await revertStopSelling(full);
  if (full.stopSellingApplied) {
    await prisma.cancellationRequest.update({ where: { id: requestId }, data: { stopSellingApplied: false } }).catch(() => {});
  }

  alertAdminsOnDecision({ ...full, supplierId: request.supplierId }, booking, tour, false, adminUser.name);
  notifySupplierOfDecision({ ...full, supplierId: request.supplierId }, booking, tour, false, cleanNote);

  logActivity({
    userId: adminUser.id,
    action: 'booking.cancellation_rejected',
    resource: 'Booking',
    resourceId: booking.id,
    metadata: { requestId: request.id, note: cleanNote },
    req,
  }).catch(() => {});

  const refreshed = await loadRequestForSerialize(request.id);
  return { request: serializeCancellationRequest(refreshed) };
}

// ── 5. Withdraw (supplier scope, own pending request) ────────────────────
async function withdrawCancellationRequest({ requestId, supplierId, actorId, req }) {
  const claim = await prisma.cancellationRequest.updateMany({
    where: { id: requestId, status: { in: ['PENDING_APPROVAL', 'APPROVING'] }, supplierId },
    data: { status: 'WITHDRAWN' },
  });
  if (claim.count === 0) {
    throw new AppError('Cancellation request not found or no longer pending', 404);
  }

  await prisma.cancellationRequest.update({
    where: { id: requestId },
    data: { decidedAt: new Date(), decisionNote: 'Withdrawn by supplier' },
  });

  const full = await loadRequestForSerialize(requestId);
  const reverted = await revertStopSelling(full);
  if (full.stopSellingApplied) {
    await prisma.cancellationRequest.update({ where: { id: requestId }, data: { stopSellingApplied: false } }).catch(() => {});
  }

  logActivity({
    userId: actorId || supplierId,
    action: 'booking.cancellation_withdrawn',
    resource: 'Booking',
    resourceId: full.bookingId,
    metadata: { requestId, revertedDates: reverted },
    req,
  }).catch(() => {});

  const refreshed = await loadRequestForSerialize(requestId);
  return { request: serializeCancellationRequest(refreshed), revertedDates: reverted };
}

// ── 6. Supersede: any conflicting booking transition kills the request ───
// Deliberately infallible: superseding is bookkeeping and must never break
// the primary operation that triggered it (a status change, a sweep, …).
async function supersedePendingRequests(bookingIds, reason) {
  const ids = Array.isArray(bookingIds) ? bookingIds : [bookingIds];
  if (!ids.length) return 0;

  try {
    const count = await prisma.cancellationRequest.updateMany({
      where: { bookingId: { in: ids }, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
      data: { status: 'SUPERSEDED', decisionNote: reason || 'Booking status changed', decidedAt: new Date() },
    }).then((r) => r.count);

    if (count > 0) {
      // The stop-selling block (if any) must not outlive the request.
      const rows = await prisma.cancellationRequest.findMany({
        where: { bookingId: { in: ids }, status: 'SUPERSEDED', stopSellingApplied: true },
      });
      for (const row of rows) {
        await revertStopSelling(row).catch(() => {});
        await prisma.cancellationRequest.update({ where: { id: row.id }, data: { stopSellingApplied: false } }).catch(() => {});
      }
    }
    return count;
  } catch (err) {
    console.error('[CancellationRequest] supersede failed for', ids, err.message);
    return 0;
  }
}

// ── 7. 24h escalation sweep (remind, NEVER auto-approve) ─────────────────
async function remindPendingCancellationRequests() {
  const cutoff = new Date(Date.now() - REMINDER_AFTER_MS);
  const due = await prisma.cancellationRequest.findMany({
    where: {
      status: 'PENDING_APPROVAL',
      createdAt: { lt: cutoff },
      OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: new Date(Date.now() - REMINDER_AFTER_MS) } }],
    },
    include: { booking: { include: { tour: { select: { id: true, title: true, supplier: { select: { name: true } } } } } } },
    take: 50,
  });

  let reminded = 0;
  for (const request of due) {
    const booking = request.booking;
    const hours = Math.floor((Date.now() - new Date(request.createdAt).getTime()) / (60 * 60 * 1000));
    notifyAdmin({
      type: 'SUPPLIER_CANCELLATION_REQUEST',
      title: `Awaiting approval for ${hours}h — #${booking.bookingNumber}`,
      message: `The cancellation request for "${booking.tour.title}" (${booking.bookingNumber}) is still pending admin approval after ${hours} hours. No money has moved.`,
      data: {
        requestId: request.id,
        bookingId: booking.id,
        bookingNumber: booking.bookingNumber,
        supplierId: request.supplierId,
        reminder: true,
        reminderCount: request.reminderCount + 1,
      },
      storefront: request.storefront || null,
    }).catch(() => {});
    await prisma.cancellationRequest.update({
      where: { id: request.id },
      data: { reminderSentAt: new Date(), reminderCount: { increment: 1 } },
    }).catch(() => {});
    reminded += 1;
  }
  if (reminded > 0) console.log(`[CancellationRequest] reminder sweep → ${reminded} request(s) escalated`);
  return { reminded };
}

// ── 8. Lists (admin + supplier) ──────────────────────────────────────────
// ── Brand scoping for the admin queue (Ghana/Africa admin apps) ─────────
// Mirrors the brand admin factory's booking filter: a request is visible to a
// brand's admins when its booking's source or supplier role belongs to that
// brand. No brandKey (legacy shared admin) → everything.
function brandBookingFilter(brandKey) {
  if (!brandKey) return null;
  try {
    const { getBrand } = require('../../../config/brands');
    const brand = getBrand(brandKey);
    if (!brand || !brand.source || !brand.role) return null;
    return {
      OR: [
        { source: brand.source },
        { tour: { supplier: { roles: { has: brand.role } } } },
      ],
    };
  } catch (_) {
    return null;
  }
}

async function listAdminCancellationRequests({ status = 'PENDING_APPROVAL', page = 1, limit = 20, search = '', brandKey = null } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (pageNum - 1) * limitNum;

  const where = {};
  if (status && status !== 'ALL') where.status = status;

  const bookingAnd = [];
  const brandFilter = brandBookingFilter(brandKey);
  if (brandFilter) bookingAnd.push(brandFilter);
  if (search && String(search).trim()) {
    const q = String(search).trim();
    bookingAnd.push({
      OR: [
        { bookingNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { tour: { title: { contains: q, mode: 'insensitive' } } },
      ],
    });
  }
  if (bookingAnd.length) where.booking = { AND: bookingAnd };

  const [rows, totalCount, pendingCount] = await Promise.all([
    prisma.cancellationRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
      include: {
        booking: {
          select: {
            id: true, bookingNumber: true, status: true, paymentStatus: true,
            refundStatus: true, refundAmount: true, grossAmount: true, currency: true,
            travelDate: true, selectedTime: true,
            cancellationCode: true, cancellationCategory: true, cancellationOrigin: true,
            countsTowardRate: true, cancellationFee: true, cancellationReason: true,
            cancelledAt: true, cancellationChoiceDeadline: true, customerChoice: true,
            customer: { select: { id: true, name: true, email: true } },
            tour: { select: { id: true, title: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.cancellationRequest.count({ where }),
    prisma.cancellationRequest.count({ where: { status: 'PENDING_APPROVAL' } }),
  ]);

  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter(Boolean))];
  const suppliers = supplierIds.length
    ? await prisma.user.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true, email: true } })
    : [];
  const supplierById = new Map(suppliers.map((s) => [s.id, s]));

  const decidedById = [...new Set(rows.map((r) => r.decidedBy).filter(Boolean))];
  const deciders = decidedById.length
    ? await prisma.user.findMany({ where: { id: { in: decidedById } }, select: { id: true, name: true, email: true } })
    : [];
  const deciderById = new Map(deciders.map((d) => [d.id, d]));

  const requests = rows.map((r) =>
    serializeCancellationRequest({
      ...r,
      supplier: r.supplierId ? supplierById.get(r.supplierId) || null : null,
      decidedByUser: r.decidedBy ? deciderById.get(r.decidedBy) || null : null,
    }),
  );

  return {
    requests,
    pendingCount,
    pagination: {
      currentPage: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      totalCount,
      limit: limitNum,
    },
  };
}

async function getAdminCancellationRequest(id) {
  const row = await prisma.cancellationRequest.findUnique({
    where: { id },
    include: {
      booking: {
        include: {
          customer: { select: { id: true, name: true, email: true, phone: true } },
          tour: { select: { id: true, title: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
        },
      },
    },
  });
  if (!row) throw new AppError('Cancellation request not found', 404);

  const [supplierUser, decider] = await Promise.all([
    row.supplierId
      ? prisma.user.findUnique({ where: { id: row.supplierId }, select: { id: true, name: true, email: true } })
      : null,
    row.decidedBy
      ? prisma.user.findUnique({ where: { id: row.decidedBy }, select: { id: true, name: true, email: true } })
      : null,
  ]);

  return serializeCancellationRequest({
    ...row,
    supplier: supplierUser,
    decidedByUser: decider,
  });
}

async function listSupplierCancellationRequests({ supplierId, status = '', page = 1, limit = 20 } = {}) {
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const where = { supplierId };
  if (status && status !== 'ALL') where.status = status;

  const [rows, totalCount] = await Promise.all([
    prisma.cancellationRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
      include: {
        booking: {
          select: {
            id: true, bookingNumber: true, status: true, paymentStatus: true,
            refundStatus: true, refundAmount: true, grossAmount: true, currency: true,
            travelDate: true, selectedTime: true,
            cancellationCode: true, cancellationCategory: true, cancellationOrigin: true,
            countsTowardRate: true, cancellationFee: true, cancellationReason: true,
            cancelledAt: true, cancellationChoiceDeadline: true, customerChoice: true,
            customer: { select: { id: true, name: true, email: true } },
            tour: { select: { id: true, title: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
          },
        },
      },
    }),
    prisma.cancellationRequest.count({ where }),
  ]);

  return {
    requests: rows.map((r) => serializeCancellationRequest({ ...r, supplier: null })),
    pagination: {
      currentPage: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      totalCount,
      limit: limitNum,
    },
  };
}

// Pending chips on the supplier bookings list — one query for the page.
// Enrichment only: a lookup failure must never break the bookings list.
async function pendingRequestsForBookingIds(bookingIds) {
  if (!bookingIds || !bookingIds.length) return new Map();
  try {
    const rows = await prisma.cancellationRequest.findMany({
      where: { bookingId: { in: bookingIds }, status: { in: ['PENDING_APPROVAL', 'APPROVING'] } },
      select: { id: true, status: true, createdAt: true, bookingId: true },
    });
    return new Map(rows.map((r) => [r.bookingId, { id: r.id, status: r.status, createdAt: r.createdAt }]));
  } catch (err) {
    console.error('[CancellationRequest] pending-chip lookup failed:', err.message);
    return new Map();
  }
}

module.exports = {
  requiresApproval,
  opsEmailTargets,
  serializeCancellationRequest,
  createCancellationRequest,
  submitCancellationRequests,
  approveCancellationRequest,
  rejectCancellationRequest,
  withdrawCancellationRequest,
  supersedePendingRequests,
  remindPendingCancellationRequests,
  listAdminCancellationRequests,
  getAdminCancellationRequest,
  listSupplierCancellationRequests,
  pendingRequestsForBookingIds,
};
