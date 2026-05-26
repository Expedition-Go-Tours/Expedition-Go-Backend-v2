const prisma = require('./prismaClient');

async function notifyAdmin({ type, title, message, data = {} }) {
  try {
    const notification = await prisma.adminNotification.create({
      data: { type, title, message, data },
    });

    const app = require('../app');
    const io = app.get('io');
    if (io) {
      io.to('admin-room').emit('admin-notification', {
        id: notification.id,
        type,
        title,
        message,
        data,
        acknowledged: false,
        createdAt: notification.createdAt,
      });
    }

    return { success: true, id: notification.id };
  } catch (error) {
    console.error('[AdminNotification] Error:', error.message);
    return { success: false, error: error.message };
  }
}

async function getNotifications({ page = 1, limit = 20, unacknowledgedOnly = false }) {
  const where = {};
  if (unacknowledgedOnly) where.acknowledged = false;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [notifications, totalCount, unacknowledgedCount] = await Promise.all([
    prisma.adminNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: parseInt(limit),
    }),
    prisma.adminNotification.count({ where }),
    prisma.adminNotification.count({ where: { acknowledged: false } }),
  ]);

  return {
    notifications,
    pagination: {
      currentPage: parseInt(page),
      totalPages: Math.ceil(totalCount / parseInt(limit)),
      totalCount,
      unacknowledgedCount,
      limit: parseInt(limit),
    },
  };
}

async function acknowledgeNotification(id, adminId) {
  try {
    const result = await prisma.adminNotification.updateMany({
      where: { id, acknowledged: false },
      data: { acknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: adminId },
    });
    return { success: result.count > 0 };
  } catch (error) {
    console.error('[AdminNotification] Acknowledge error:', error.message);
    return { success: false, error: error.message };
  }
}

async function acknowledgeAll(adminId) {
  try {
    const result = await prisma.adminNotification.updateMany({
      where: { acknowledged: false },
      data: { acknowledged: true, acknowledgedAt: new Date(), acknowledgedBy: adminId },
    });
    return { success: true, count: result.count };
  } catch (error) {
    console.error('[AdminNotification] Acknowledge all error:', error.message);
    return { success: false, error: error.message };
  }
}

async function getStats() {
  const [total, unacknowledged, byType, recent] = await Promise.all([
    prisma.adminNotification.count(),
    prisma.adminNotification.count({ where: { acknowledged: false } }),
    prisma.adminNotification.groupBy({
      by: ['type'],
      _count: true,
      orderBy: { _count: { type: 'desc' } },
    }),
    prisma.adminNotification.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { total, unacknowledged, byType, recent };
}

module.exports = { notifyAdmin, getNotifications, acknowledgeNotification, acknowledgeAll, getStats };
