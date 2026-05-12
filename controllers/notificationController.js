/**
 * Notification Controller - Production Ready
 * Handles user notifications and real-time updates
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification
} = require('../utils/notificationService');

/**
 * Get user's notifications
 */
exports.getNotifications = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, unreadOnly = false } = req.query;

  const result = await getUserNotifications(userId, {
    page: parseInt(page),
    limit: parseInt(limit),
    unreadOnly: unreadOnly === 'true'
  });

  res.status(200).json({
    status: 'success',
    data: result
  });
});

/**
 * Mark notification as read
 */
exports.markAsRead = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user.id;

  const result = await markNotificationAsRead(id, userId);

  if (!result.success) {
    return next(new AppError(result.error, 404));
  }

  res.status(200).json({
    status: 'success',
    message: 'Notification marked as read'
  });
});

/**
 * Mark all notifications as read
 */
exports.markAllAsRead = catchAsync(async (req, res, next) => {
  const userId = req.user.id;

  const result = await markAllNotificationsAsRead(userId);

  if (!result.success) {
    return next(new AppError(result.error, 500));
  }

  res.status(200).json({
    status: 'success',
    message: `${result.count} notifications marked as read`
  });
});

/**
 * Delete notification
 */
exports.deleteNotification = catchAsync(async (req, res, next) => {
  const { id } = req.params;
  const userId = req.user.id;

  const result = await deleteNotification(id, userId);

  if (!result.success) {
    return next(new AppError(result.error, 404));
  }

  res.status(204).json({
    status: 'success',
    data: null
  });
});

module.exports = exports;