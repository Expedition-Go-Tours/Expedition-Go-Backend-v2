/**
 * Notification Service - Production Ready
 * Handles real-time notifications via WebSocket and database storage
 * 
 * Features:
 * - Real-time WebSocket notifications
 * - Database notification storage
 * - Email notification integration
 * - Push notification support (future)
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const { sendEmail } = require('./emailService');

/**
 * Send notification to user
 * Supports WebSocket real-time delivery and database storage
 */
async function sendNotification({
  userId,
  type,
  title,
  message,
  data = {},
  sendEmail: shouldSendEmail = false,
  emailTemplate = null
}) {
  try {
    // Create notification in database
    const notification = await prisma.notification.create({
      data: {
        userId,
        type,
        title,
        message,
        data,
        emailSent: false,
        pushSent: false
      }
    });

    // Get user details for WebSocket and email
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        language: true
      }
    });

    if (!user) {
      console.error(`❌ User not found for notification: ${userId}`);
      return { success: false, error: 'User not found' };
    }

    // Send real-time notification via WebSocket
    await sendWebSocketNotification(userId, {
      id: notification.id,
      type,
      title,
      message,
      data,
      createdAt: notification.createdAt
    });

    // Send email notification if requested
    if (shouldSendEmail && user.email) {
      try {
        await sendNotificationEmail(user, {
          type,
          title,
          message,
          data,
          template: emailTemplate
        });

        // Update notification as email sent
        await prisma.notification.update({
          where: { id: notification.id },
          data: {
            emailSent: true,
            emailSentAt: new Date()
          }
        });

        console.log(`📧 Email notification sent to ${user.email}`);
      } catch (emailError) {
        console.error('❌ Email notification failed:', emailError);
      }
    }

    console.log(`🔔 Notification sent to user ${userId}: ${title}`);
    return { success: true, notificationId: notification.id };

  } catch (error) {
    console.error('❌ Notification service error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send real-time notification via WebSocket
 */
async function sendWebSocketNotification(userId, notificationData) {
  try {
    // Get Socket.IO instance from app
    const app = require('../app');
    const io = app.get('io');

    if (!io) {
      console.warn('⚠️ Socket.IO not available for real-time notifications');
      return;
    }

    // Send to user's room
    io.to(`user:${userId}`).emit('notification', notificationData);

    // Also send to admin room if it's a system alert
    if (['SUPPLIER_APPROVED', 'BOOKING_CONFIRMED', 'REVIEW_RECEIVED'].includes(notificationData.type)) {
      io.to('admin-room').emit('admin-notification', {
        ...notificationData,
        userId
      });
    }

    console.log(`📡 WebSocket notification sent to user:${userId}`);
  } catch (error) {
    console.error('❌ WebSocket notification failed:', error);
  }
}

/**
 * Send email notification
 */
async function sendNotificationEmail(user, { type, title, message, data, template }) {
  const emailTemplates = {
    BOOKING_CONFIRMED: {
      subject: 'Booking Confirmation',
      template: 'booking-confirmation'
    },
    BOOKING_CANCELLED: {
      subject: 'Booking Cancelled',
      template: 'booking-cancellation'
    },
    REVIEW_RECEIVED: {
      subject: 'New Review Received',
      template: 'review-notification'
    },
    SUPPLIER_APPROVED: {
      subject: 'Supplier Application Approved',
      template: 'supplier-approved'
    },
    SUPPLIER_REJECTED: {
      subject: 'Supplier Application Update',
      template: 'supplier-rejected'
    },
    PAYMENT_RECEIVED: {
      subject: 'Payment Received',
      template: 'payment-confirmation'
    },
    PAYOUT_PROCESSED: {
      subject: 'Payout Processed',
      template: 'payout-notification'
    },
    PAYOUT_APPROVED: {
      subject: 'Payout Approved',
      template: 'payout-notification'
    }
  };

  const emailConfig = emailTemplates[type] || {
    subject: title,
    template: 'generic-notification'
  };

  await sendEmail({
    to: user.email,
    subject: emailConfig.subject,
    template: template || emailConfig.template,
    data: {
      userName: user.name,
      title,
      message,
      ...data
    }
  });
}

/**
 * Get user notifications with pagination
 */
async function getUserNotifications(userId, { page = 1, limit = 20, unreadOnly = false }) {
  const where = { userId };
  if (unreadOnly) {
    where.read = false;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [notifications, totalCount, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit)
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: { userId, read: false }
    })
  ]);

  const totalPages = Math.ceil(totalCount / parseInt(limit));

  return {
    notifications,
    pagination: {
      currentPage: parseInt(page),
      totalPages,
      totalCount,
      unreadCount,
      limit: parseInt(limit)
    }
  };
}

/**
 * Mark notification as read
 */
async function markNotificationAsRead(notificationId, userId) {
  try {
    const notification = await prisma.notification.updateMany({
      where: {
        id: notificationId,
        userId
      },
      data: {
        read: true,
        readAt: new Date()
      }
    });

    if (notification.count === 0) {
      throw new Error('Notification not found or access denied');
    }

    return { success: true };
  } catch (error) {
    console.error('❌ Mark notification as read failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Mark all notifications as read for user
 */
async function markAllNotificationsAsRead(userId) {
  try {
    const result = await prisma.notification.updateMany({
      where: {
        userId,
        read: false
      },
      data: {
        read: true,
        readAt: new Date()
      }
    });

    console.log(`✅ Marked ${result.count} notifications as read for user ${userId}`);
    return { success: true, count: result.count };
  } catch (error) {
    console.error('❌ Mark all notifications as read failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Delete notification
 */
async function deleteNotification(notificationId, userId) {
  try {
    const result = await prisma.notification.deleteMany({
      where: {
        id: notificationId,
        userId
      }
    });

    if (result.count === 0) {
      throw new Error('Notification not found or access denied');
    }

    return { success: true };
  } catch (error) {
    console.error('❌ Delete notification failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Send bulk notifications to multiple users
 */
async function sendBulkNotifications(notifications) {
  try {
    const results = [];

    for (const notification of notifications) {
      const result = await sendNotification(notification);
      results.push(result);
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`📢 Bulk notifications: ${successCount}/${notifications.length} sent successfully`);

    return {
      success: true,
      total: notifications.length,
      successful: successCount,
      failed: notifications.length - successCount
    };
  } catch (error) {
    console.error('❌ Bulk notifications failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Clean up old notifications (run periodically)
 */
async function cleanupOldNotifications(daysOld = 90) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await prisma.notification.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate
        },
        read: true
      }
    });

    console.log(`🧹 Cleaned up ${result.count} old notifications`);
    return { success: true, deletedCount: result.count };
  } catch (error) {
    console.error('❌ Notification cleanup failed:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get notification statistics for admin dashboard
 */
async function getNotificationStats() {
  try {
    const [
      totalNotifications,
      unreadNotifications,
      notificationsByType,
      recentActivity
    ] = await Promise.all([
      prisma.notification.count(),
      prisma.notification.count({ where: { read: false } }),
      prisma.notification.groupBy({
        by: ['type'],
        _count: true,
        orderBy: { _count: { type: 'desc' } }
      }),
      prisma.notification.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              name: true,
              email: true
            }
          }
        }
      })
    ]);

    return {
      totalNotifications,
      unreadNotifications,
      notificationsByType,
      recentActivity
    };
  } catch (error) {
    console.error('❌ Get notification stats failed:', error);
    throw error;
  }
}

module.exports = {
  sendNotification,
  sendWebSocketNotification,
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,
  sendBulkNotifications,
  cleanupOldNotifications,
  getNotificationStats
};