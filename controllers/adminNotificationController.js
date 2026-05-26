const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const adminNotifService = require('../utils/adminNotificationService');

exports.getNotifications = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, unacknowledgedOnly = false } = req.query;
  const result = await adminNotifService.getNotifications({
    page: parseInt(page),
    limit: parseInt(limit),
    unacknowledgedOnly: unacknowledgedOnly === 'true',
  });
  res.status(200).json({ status: 'success', data: result });
});

exports.getUnreadCount = catchAsync(async (req, res) => {
  const result = await adminNotifService.getNotifications({ limit: 1, unacknowledgedOnly: true });
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
