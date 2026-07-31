const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { buildAuditMessage } = require('./adminController');
const { clearCache: clearMaintCache } = require('../middleware/maintenanceMode');
const getConfig = require('../utils/getConfig');

exports.getSettings = catchAsync(async (req, res, next) => {
  const configs = await prisma.systemConfig.findMany({
    orderBy: { key: 'asc' },
  });

  const settings = {};
  for (const config of configs) {
    settings[config.key] = config.value;
  }

  res.status(200).json({
    status: 'success',
    data: settings,
  });
});

exports.updateSettings = catchAsync(async (req, res, next) => {
  const { settings } = req.body;

  if (!settings || typeof settings !== 'object') {
    return next(new AppError('Please provide settings object', 400));
  }

  const results = [];
  for (const [key, value] of Object.entries(settings)) {
    const updated = await prisma.systemConfig.upsert({
      where: { key },
      update: {
        value,
        updatedBy: req.user.id,
      },
      create: {
        key,
        value,
        updatedBy: req.user.id,
      },
    });
    results.push(updated);
  }

  if ('system.maintenance_mode' in settings) {
    clearMaintCache();
  }

  // Invalidate getConfig cache so new settings take effect immediately
  getConfig.clearCache();

  await logActivity({
    userId: req.user.id,
    userEmail: req.user.email,
    action: 'settings.updated',
    resource: 'SystemConfig',
    newValues: settings,
  });

  const allConfigs = await prisma.systemConfig.findMany({
    orderBy: { key: 'asc' },
  });

  const responseSettings = {};
  for (const config of allConfigs) {
    responseSettings[config.key] = config.value;
  }

  res.status(200).json({
    status: 'success',
    data: responseSettings,
  });
});

exports.getSetting = catchAsync(async (req, res, next) => {
  const config = await prisma.systemConfig.findUnique({
    where: { key: req.params.key },
  });

  if (!config) {
    return next(new AppError('Setting not found', 404));
  }

  res.status(200).json({
    status: 'success',
    data: { [config.key]: config.value },
  });
});

exports.exportAuditLog = catchAsync(async (req, res, next) => {
  const where = buildAuditWhere(req);

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
  });

  const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userMap = {};
  for (const u of users) {
    userMap[u.id] = u;
  }

  const headers = ['Date/Time', 'Admin', 'Email', 'Action', 'Resource', 'Resource ID', 'IP Address', 'Details'];
  const rows = entries.map((entry) => {
    const user = entry.userId ? userMap[entry.userId] : null;
    const userName = user?.name || entry.userEmail || entry.userId || 'System';
    const details = entry.oldValues || entry.newValues
      ? JSON.stringify({ old: entry.oldValues, new: entry.newValues })
      : '';
    return [
      entry.createdAt.toISOString(),
      escapeCsv(userName),
      escapeCsv(entry.userEmail || ''),
      escapeCsv(entry.action),
      escapeCsv(entry.resource || ''),
      escapeCsv(entry.resourceId || ''),
      escapeCsv(entry.ipAddress || ''),
      escapeCsv(details),
    ];
  });

  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().split('T')[0]}.csv"`);
  res.status(200).send(csv);
});

function escapeCsv(val) {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function buildAuditWhere(req) {
  const where = {};
  if (req.query.action) where.action = { contains: req.query.action, mode: 'insensitive' };
  if (req.query.resource) where.resource = { contains: req.query.resource, mode: 'insensitive' };
  if (req.query.email) where.userEmail = { contains: req.query.email, mode: 'insensitive' };
  if (req.query.userId) where.userId = req.query.userId;
  if (req.query.resourceId) where.resourceId = req.query.resourceId;
  if (req.query.startDate || req.query.endDate) {
    where.createdAt = {};
    if (req.query.startDate) where.createdAt.gte = new Date(req.query.startDate);
    if (req.query.endDate) where.createdAt.lte = new Date(req.query.endDate);
  }
  return where;
}

exports.getAuditLog = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const skip = (page - 1) * limit;
  const where = buildAuditWhere(req);

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  const userIds = [...new Set(entries.map((e) => e.userId).filter(Boolean))];
  const users = userIds.length > 0
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const userMap = {};
  for (const u of users) {
    userMap[u.id] = u;
  }

  const enriched = entries.map((entry) => {
    const user = entry.userId ? userMap[entry.userId] : null;
    return {
      ...entry,
      userName: user?.name || entry.userEmail || entry.userId || 'System',
      details: buildAuditMessage(entry.action, entry.resource, entry.metadata || {}),
    };
  });

  res.status(200).json({
    status: 'success',
    data: {
      entries: enriched,
      total,
      page,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * Aggregated stats for the Activity Log page:
 * totalActivities, uniqueUsers, thisWeek, today, thisMonth, actionBreakdown.
 */
exports.getAuditLogStats = catchAsync(async (req, res, next) => {
  const now = new Date();

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfToday.getDate() - 6); // rolling 7 days
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [totalActivities, thisWeek, today, thisMonth, actionBreakdown] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { createdAt: { gte: startOfWeek } } }),
    prisma.auditLog.count({ where: { createdAt: { gte: startOfToday } } }),
    prisma.auditLog.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.auditLog.groupBy({
      by: ['action'],
      _count: true,
      orderBy: { _count: { action: 'desc' } },
      take: 12,
    }),
  ]);

  // Unique actors across the whole trail (by admin userId, then userEmail)
  const [distinctUserIds, distinctEmails] = await Promise.all([
    prisma.auditLog.groupBy({
      by: ['userId'],
      where: { userId: { not: null } },
    }),
    prisma.auditLog.groupBy({
      by: ['userEmail'],
      where: { userEmail: { not: null } },
    }),
  ]);

  const uniqueUsers = new Set([
    ...distinctUserIds.map((r) => r.userId),
    ...distinctEmails.map((r) => r.userEmail),
  ]).size;

  res.status(200).json({
    status: 'success',
    data: {
      totalActivities,
      uniqueUsers,
      thisWeek,
      today,
      thisMonth,
      actionBreakdown: actionBreakdown.map((row) => ({
        action: row.action,
        count: row._count,
      })),
    },
  });
});

/** Distinct audit actions (for the action filter dropdown). */
exports.getAuditActions = catchAsync(async (req, res, next) => {
  const groups = await prisma.auditLog.groupBy({
    by: ['action'],
    orderBy: { action: 'asc' },
  });

  res.status(200).json({
    status: 'success',
    data: groups.map((g) => g.action),
  });
});

/** Tamper-evidence: verify the audit hash chain integrity. */
exports.verifyAuditChain = catchAsync(async (req, res, next) => {
  const { verifyAuditChain } = require('../utils/auditLogger');
  const report = await verifyAuditChain();
  res.status(200).json({ status: 'success', data: report });
});
