const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const { clearCache: clearMaintCache } = require('../middleware/maintenanceMode');
const { logActivity } = require('../utils/auditLogger');

exports.getSystemHealth = catchAsync(async (req, res, next) => {
  const checks = {
    api: { status: 'operational' },
    database: { status: 'unknown' },
  };

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    checks.database.status = 'connected';
  } catch {
    checks.database.status = 'disconnected';
  }

  res.status(200).json({
    status: 'success',
    data: {
      checks,
      serverTime: new Date().toISOString(),
      uptime: process.uptime(),
    },
  });
});

exports.clearSystemCache = catchAsync(async (req, res, next) => {
  clearMaintCache();

  logActivity({
    userId: req.user?.id,
    userEmail: req.user?.email,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    action: 'system.cache_cleared',
    resource: 'SystemConfig',
  });

  res.status(200).json({
    status: 'success',
    message: 'Application cache cleared',
  });
});