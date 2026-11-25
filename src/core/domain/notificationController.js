/**
 * Notification Controller - Production Ready
 * Handles user notifications and real-time updates
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const { notificationTypesForCategories, NOTIFICATION_CATEGORY_KEYS } = require('../../../config/permissions');
const {
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification
} = require('../services/notificationService');
const { parseProductDomain } = require('../services/productDomain');

/**
 * Get user's notifications
 */
exports.getNotifications = catchAsync(async (req, res, next) => {
  const userId = req.user.id;
  const { page = 1, limit = 20, unreadOnly = false } = req.query;
  const domain = parseProductDomain(req.query.domain);

  const result = await getUserNotifications(userId, {
    page: parseInt(page),
    limit: parseInt(limit),
    unreadOnly: unreadOnly === 'true',
    ...(domain ? { domain } : {}),
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
  const domain = parseProductDomain(req.query.domain);

  const result = domain
    ? await markNotificationAsRead(id, userId, domain)
    : await markNotificationAsRead(id, userId);

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
  const allowedCategories = req.teamContext?.notificationCategories?.length
    ? req.teamContext.notificationCategories
    : NOTIFICATION_CATEGORY_KEYS;
  const requested = typeof req.query.categories === 'string'
    ? req.query.categories.split(',').map((value) => value.trim()).filter(Boolean)
    : allowedCategories;
  const categories = requested.filter((category) => allowedCategories.includes(category));
  const types = notificationTypesForCategories(categories);
  const domain = parseProductDomain(req.query.domain);

  const result = domain
    ? await markAllNotificationsAsRead(userId, types, domain)
    : await markAllNotificationsAsRead(userId, types);

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
  const domain = parseProductDomain(req.query.domain);

  const result = domain
    ? await deleteNotification(id, userId, domain)
    : await deleteNotification(id, userId);

  if (!result.success) {
    return next(new AppError(result.error, 404));
  }

  res.status(204).json({
    status: 'success',
    data: null
  });
});

module.exports = exports;