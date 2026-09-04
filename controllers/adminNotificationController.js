const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const adminNotifService = require('../utils/adminNotificationService');

const TYPE_PERMISSION = {
  NEW_SUPPLIER_APPLICATION: ['suppliers.view', 'suppliers.approve'],
  REVIEW_NEEDS_MODERATION: ['reviews.view', 'reviews.moderate'],
  PAYOUT_NEEDS_APPROVAL: ['payouts.view', 'payouts.approve'],
  SUPPLIER_STATUS_CHANGE: ['suppliers.view', 'suppliers.suspend'],
  SYSTEM_ALERT: [],
  TOUR_SUBMITTED_FOR_REVIEW: ['tours.view', 'tours.approve'],
  BOOKING_CREATED: ['bookings.view', 'dashboard.*'],
  BOOKING_CONFIRMED: ['bookings.view', 'dashboard.*'],
};

// Every value in the AdminNotificationType enum. Types without a TYPE_PERMISSION
// entry (or with an empty list) are visible to every admin.
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
  'DOCUMENT_EXPIRING',
  'DOCUMENT_EXPIRED',
  'REFUND_REQUEST',
  'PAYMENT_UPCOMING',
  'PAYMENT_COLLECTED',
  'PAYMENT_COLLECTION_FAILED',
  'STRIPE_CUSTOMER_CREATE_FAILED',
  'REFUND_NEEDS_ATTENTION',
];

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

exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, unacknowledgedOnly = false } = req.query;
  const where = buildPermissionWhere(req.user.permissionKeys || []);
  const result = await adminNotifService.getNotifications({
    page: parseInt(page),
    limit: parseInt(limit),
    unacknowledgedOnly: unacknowledgedOnly === 'true',
    where,
  });
  res.status(200).json({ status: 'success', data: result });
});

exports.getUnreadCount = catchAsync(async (req, res) => {
  const where = buildPermissionWhere(req.user.permissionKeys || []);
  const result = await adminNotifService.getNotifications({ limit: 1, unacknowledgedOnly: true, where });
  res.status(200).json({
    status: 'success',
    data: { unacknowledgedCount: result.pagination.unacknowledgedCount },
  });
});

exports.acknowledge = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const result = await adminNotifService.acknowledgeNotification(id, req.user.id);
  if (!result.success) return next(new AppError('Notification not found', 404));
  res.status(200).json({ status: 'success', message: 'Notification acknowledged' });
});

exports.acknowledgeAll = catchAsync(async (req, res) => {
  const where = buildPermissionWhere(req.user.permissionKeys || []);
  const result = await adminNotifService.acknowledgeAll(req.user.id, where);
  res.status(200).json({
    status: 'success',
    message: `${result.count} notifications acknowledged`,
  });
});

exports.getStats = catchAsync(async (req, res) => {
  const where = buildPermissionWhere(req.user.permissionKeys || []);
  const stats = await adminNotifService.getStats(where);
  res.status(200).json({ status: 'success', data: stats });
});
