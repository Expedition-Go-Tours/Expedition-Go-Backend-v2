const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { clearCache: clearMaintCache } = require('../middleware/maintenanceMode');

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

  await prisma.auditLog.create({
    data: {
      userId: req.user.id,
      userEmail: req.user.email,
      action: 'settings.updated',
      resource: 'SystemConfig',
      newValues: settings,
    },
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
  const action = req.query.action || '';

  const where = action ? { action: { contains: action, mode: 'insensitive' } } : {};

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

  const headers = ['Date/Time', 'Admin', 'Email', 'Action', 'Resource', 'Resource ID', 'Details'];
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

exports.getAuditLog = catchAsync(async (req, res, next) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const action = req.query.action || '';
  const skip = (page - 1) * limit;

  const where = action ? { action: { contains: action, mode: 'insensitive' } } : {};

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
