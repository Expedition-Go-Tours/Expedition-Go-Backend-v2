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

function filterAdminNotifications(notifications, permissionKeys) {
  return notifications.filter((n) => {
    if (n.type === 'NEW_MESSAGE') {
      const canSupplier = permissionKeys.includes('chat.suppliers');
      const canCustomer = permissionKeys.includes('chat.customers');
      const canExpedition = permissionKeys.includes('chat.expedition');
      const chatType = n.data?.chatType;
      if (chatType === 'suppliers') return canSupplier;
      if (chatType === 'customers') return canCustomer;
      if (chatType === 'expedition') return canExpedition;
      return canSupplier || canCustomer || canExpedition;
    }

    const required = TYPE_PERMISSION[n.type];
    if (!required || required.length === 0) return true;
    return required.some((key) => permissionKeys.includes(key));
  });
}

exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, unacknowledgedOnly = false } = req.query;
  const result = await adminNotifService.getNotifications({
    page: parseInt(page),
    limit: parseInt(limit),
    unacknowledgedOnly: unacknowledgedOnly === 'true',
  });
  result.notifications = filterAdminNotifications(result.notifications, req.user.permissionKeys || []);
  res.status(200).json({ status: 'success', data: result });
});

exports.getUnreadCount = catchAsync(async (req, res) => {
  const result = await adminNotifService.getNotifications({ limit: 100, unacknowledgedOnly: true });
  const filtered = filterAdminNotifications(result.notifications, req.user.permissionKeys || []);
  res.status(200).json({
    status: 'success',
    data: { unacknowledgedCount: filtered.length },
  });
});

exports.acknowledge = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const result = await adminNotifService.acknowledgeNotification(id, req.user.id);
  if (!result.success) return next(new AppError('Notification not found', 404));
  res.status(200).json({ status: 'success', message: 'Notification acknowledged' });
});

exports.acknowledgeAll = catchAsync(async (req, res) => {
  const result = await adminNotifService.acknowledgeAll(req.user.id);
  res.status(200).json({
    status: 'success',
    message: `${result.count} notifications acknowledged`,
  });
});

exports.getStats = catchAsync(async (req, res) => {
  const stats = await adminNotifService.getStats();
  res.status(200).json({ status: 'success', data: stats });
});
