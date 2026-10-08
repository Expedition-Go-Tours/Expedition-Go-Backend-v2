const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const adminNotifService = require('../services/adminNotificationService');

const { brandKeyFromUser } = require('../../../middleware/brandContext');

/**
 * Brand-scope the admin notification feed.
 *
 * Every AdminNotification is tagged with a `storefront` at creation time
 * ('ghana' when it is tied to a Ghana supplier/booking, null otherwise — see
 * adminNotificationService.notifyAdmin). Ghana's admin sees only its own
 * notifications; every other platform (Africa, and the legacy shared admin)
 * sees everything NOT tagged Ghana, which is the pre-isolation default, so no
 * notification is ever orphaned.
 *
 * The brand comes from the request's brand-scoped mount (req.brandKey), with
 * the admin's brand role as a fallback.
 */
function brandNotificationWhere(req) {
  const brandKey = req.brandKey || brandKeyFromUser(req.user);
  if (brandKey === 'ghana') return { storefront: 'ghana' };
  return {
    OR: [
      { storefront: null },
      { storefront: { not: 'ghana' } },
    ],
  };
}

const TYPE_PERMISSION = {
  NEW_SUPPLIER_APPLICATION: ['suppliers.view', 'suppliers.approve'],
  REVIEW_NEEDS_MODERATION: ['reviews.view', 'reviews.moderate'],
  PAYOUT_NEEDS_APPROVAL: ['payouts.view', 'payouts.approve'],
  SUPPLIER_STATUS_CHANGE: ['suppliers.view', 'suppliers.suspend'],
  SYSTEM_ALERT: [],
  TOUR_SUBMITTED_FOR_REVIEW: ['tours.view', 'tours.approve'],
  BOOKING_CREATED: ['bookings.view', 'dashboard.*'],
  BOOKING_CONFIRMED: ['bookings.view', 'dashboard.*'],
  BOOKING_MODIFIED: ['bookings.view', 'dashboard.*'],
  REFUND_CLAIM: ['payouts.view', 'payouts.approve'],
};

// Every value in the AdminNotificationType enum. Types without a TYPE_PERMISSION
// entry (or with an empty list) are visible to every admin.
// ⚠️ Keep in sync with the AdminNotificationType enum in prisma/schema.prisma —
// a type missing here is silently hidden from the bell feed/unread badge/stats.
const ADMIN_NOTIFICATION_TYPES = [
  'NEW_SUPPLIER_APPLICATION',
  'SUPPLIER_STATUS_CHANGE',
  'REVIEW_NEEDS_MODERATION',
  'PAYOUT_NEEDS_APPROVAL',
  'SYSTEM_ALERT',
  'NEW_MESSAGE',
  'TOUR_SUBMITTED_FOR_REVIEW',
  'BOOKING_CREATED',
  'BOOKING_CONFIRMED',
  'BOOKING_MODIFIED',
  'DOCUMENT_EXPIRING',
  'DOCUMENT_EXPIRED',
  'REFUND_REQUEST',
  'REFUND_CLAIM',
  'PAYMENT_UPCOMING',
  'PAYMENT_COLLECTED',
  'PAYMENT_COLLECTION_FAILED',
  'STRIPE_CUSTOMER_CREATE_FAILED',
  'REFUND_NEEDS_ATTENTION',
  'SUPPLIER_CANCELLATION_REQUEST',
  'SUPPLIER_CANCELLATION_DECIDED',
];

/**
 * Compose every visibility constraint into ONE where clause.
 *
 * These used to be spread-merged (`{ ...buildPermissionWhere(), ...brandNotificationWhere() }`),
 * which silently dropped conditions whenever both objects carried an `OR` key:
 * brandNotificationWhere()'s branch won, so on a non-Ghana brand the permission
 * filter never reached the database and every notification type was visible to
 * every admin. Using an explicit `$and` makes each constraint independent of
 * the others, so permission, brand and request filters always apply together.
 *
 * `extra` is for request-scoped filters (e.g. `?types=`). It is composed the
 * same way, so a filter can never widen the visible set.
 */
function buildNotificationWhere(req, extra = {}) {
  const parts = [
    buildPermissionWhere(req.user?.permissionKeys || []),
    brandNotificationWhere(req),
  ];
  if (extra && Object.keys(extra).length > 0) parts.push(extra);
  return { AND: parts };
}

/**
 * Build a Prisma where clause that keeps only the notifications this admin
 * role is allowed to see, so list/count/stats all agree with the feed instead
 * of filtering after pagination.
 */
function buildPermissionWhere(permissionKeys = []) {
  const keys = new Set(permissionKeys);
  const canChat = (t) => keys.has(`chat.${t}`);
  const canSuppliers = canChat('suppliers');
  const canCustomers = canChat('customers');
  const canExpedition = canChat('expedition');
  const allChat = canSuppliers && canCustomers && canExpedition;

  const or = [];
  const typeIn = [];

  for (const type of ADMIN_NOTIFICATION_TYPES) {
    if (type === 'NEW_MESSAGE') {
      if (allChat) {
        typeIn.push(type);
      } else {
        if (canSuppliers) or.push({ type: 'NEW_MESSAGE', data: { path: ['chatType'], equals: 'suppliers' } });
        if (canCustomers) or.push({ type: 'NEW_MESSAGE', data: { path: ['chatType'], equals: 'customers' } });
        if (canExpedition) or.push({ type: 'NEW_MESSAGE', data: { path: ['chatType'], equals: 'expedition' } });
      }
      continue;
    }

    const required = TYPE_PERMISSION[type];
    if (!required || required.length === 0 || required.some((p) => keys.has(p))) {
      typeIn.push(type);
    }
  }

  if (typeIn.length > 0) or.push({ type: { in: typeIn } });
  if (or.length === 0) return { id: '__no_permission__' };
  return { OR: or };
}

/**
 * Parse the optional `?types=` filter (comma-separated enum values).
 *
 * Returns `null` when the parameter is absent (no type filter), or an array of
 * types to keep. Values are validated against ADMIN_NOTIFICATION_TYPES so an
 * unknown value can never reach Prisma; if the caller asked only for unknown
 * types the result is an empty array, which deliberately matches nothing
 * rather than silently falling back to an unfiltered feed.
 */
function parseTypesParam(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const allowed = new Set(ADMIN_NOTIFICATION_TYPES);
  const requested = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(requested.filter((t) => allowed.has(t)))];
}

/**
 * Parse the optional `?search=` free-text filter.
 *
 * Returns `null` when there is nothing to search for, otherwise the trimmed
 * term. Capped so a long payload can't turn into an unbounded LIKE scan.
 */
const MAX_SEARCH_LENGTH = 200;

function parseSearchParam(raw) {
  if (raw === undefined || raw === null) return null;
  const term = String(raw).trim().slice(0, MAX_SEARCH_LENGTH);
  return term.length > 0 ? term : null;
}

exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, unacknowledgedOnly = false, types, search } = req.query;
  const typeFilter = parseTypesParam(types);
  const term = parseSearchParam(search);

  const extra = {};
  if (typeFilter) extra.type = { in: typeFilter };
  if (term) {
    extra.OR = [
      { title: { contains: term, mode: 'insensitive' } },
      { message: { contains: term, mode: 'insensitive' } },
    ];
  }

  const where = buildNotificationWhere(req, extra);
  const result = await adminNotifService.getNotifications({
    page: parseInt(page),
    limit: parseInt(limit),
    unacknowledgedOnly: unacknowledgedOnly === 'true',
    where,
  });
  res.status(200).json({ status: 'success', data: result });
});

exports.getUnreadCount = catchAsync(async (req, res) => {
  const where = buildNotificationWhere(req);
  const result = await adminNotifService.getNotifications({ limit: 1, unacknowledgedOnly: true, where });
  res.status(200).json({
    status: 'success',
    data: { unacknowledgedCount: result.pagination.unacknowledgedCount },
  });
});

exports.acknowledge = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  // Scope the write with the same visibility rules as the read, so an id from
  // another brand (or a type this role cannot see) cannot be acknowledged by
  // crafting the request directly.
  const result = await adminNotifService.acknowledgeNotification(id, req.user.id, buildNotificationWhere(req));
  if (!result.success) return next(new AppError('Notification not found', 404));
  res.status(200).json({ status: 'success', message: 'Notification acknowledged' });
});

exports.acknowledgeAll = catchAsync(async (req, res) => {
  const where = buildNotificationWhere(req);
  const result = await adminNotifService.acknowledgeAll(req.user.id, where);
  res.status(200).json({
    status: 'success',
    message: `${result.count} notifications acknowledged`,
  });
});

exports.getStats = catchAsync(async (req, res) => {
  const { unacknowledgedOnly = false } = req.query;
  // The filter rail's counts must agree with the feed underneath them, so the
  // caller can scope stats to the same read-state the list is showing.
  const where = buildNotificationWhere(
    req,
    unacknowledgedOnly === 'true' ? { acknowledged: false } : {},
  );
  const stats = await adminNotifService.getStats(where);
  res.status(200).json({ status: 'success', data: stats });
});

exports.buildPermissionWhere = buildPermissionWhere;
exports.buildNotificationWhere = buildNotificationWhere;
exports.ADMIN_NOTIFICATION_TYPES = ADMIN_NOTIFICATION_TYPES;
