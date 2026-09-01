const prisma = require('./prismaClient');
const { notifyDiscord } = require('./discordNotifier');

/**
 * Types that get mirrored to Discord. Types with richer explicit embeds
 * elsewhere (NEW_SUPPLIER_APPLICATION, PAYOUT_NEEDS_APPROVAL, PAYOUT_*)
 * are excluded to avoid duplicates.
 */
const DISCORD_MAP = {
  PAYMENT_COLLECTED:         { channel: 'incidents', color: 0x00c853 },
  PAYMENT_COLLECTION_FAILED: { channel: 'incidents', color: 0xff4444 },
  REVIEW_NEEDS_MODERATION:   { channel: 'sales',    color: 0xffa500 },
  DOCUMENT_EXPIRING:         { channel: 'verification', color: 0xffaa00 },
  DOCUMENT_EXPIRED:          { channel: 'verification', color: 0xff4444 },
  TOUR_SUBMITTED_FOR_REVIEW: { channel: 'verification', color: 0x3498db },
  SUPPLIER_STATUS_CHANGE:    { channel: 'verification', color: 0x3498db },
  SYSTEM_ALERT:              { channel: 'incidents', color: 0xff4444 },
};

// Human-friendly field labels for common keys, in display order.
const FIELD_LABELS = {
  supplierName: 'Supplier',
  supplierId: 'Supplier ID',
  documentType: 'Document',
  documentName: 'Document',
  expiresAt: 'Expires',
  daysLeft: 'Days left',
  tourTitle: 'Tour',
  tourId: 'Tour ID',
  status: 'Status',
  fromStatus: 'From',
  toStatus: 'To',
  reviewerName: 'Reviewer',
  message: 'Message',
};

function formatFields(data) {
  const entries = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return [];
  // Sort by preferred label order, then alphabetical.
  const order = Object.keys(FIELD_LABELS);
  entries.sort((a, b) => {
    const ai = order.indexOf(a[0]);
    const bi = order.indexOf(b[0]);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a[0].localeCompare(b[0]);
  });
  return entries.map(([k, v]) => ({
    name: FIELD_LABELS[k] || k.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase()),
    value: String(v ?? '—').slice(0, 1024),
    inline: true,
  }));
}

function mirrorToDiscord(type, title, message, data) {
  const cfg = DISCORD_MAP[type];
  if (!cfg) return;
  notifyDiscord(cfg.channel, message, {
    title,
    color: cfg.color,
    fields: formatFields(data),
    cooldownKey: data?.supplierId || data?.tourId || data?.payoutRequestId || data?.disputeId || title,
  }).catch(() => {});
}

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

    mirrorToDiscord(type, title, message, data);

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

async function emitToRoom(room, { type, title, message, data = {} }) {
  try {
    const app = require('../app');
    const io = app.get('io');
    if (io) {
      io.to(room).emit('admin-notification', {
        type,
        title,
        message,
        data,
        createdAt: new Date().toISOString(),
      });
    }
    return { success: true };
  } catch (error) {
    console.error('[AdminNotification] emitToRoom error:', error.message);
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

module.exports = { notifyAdmin, emitToRoom, getNotifications, acknowledgeNotification, acknowledgeAll, getStats };
