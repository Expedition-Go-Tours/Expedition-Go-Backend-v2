/**
 * Audit Logger - Production Ready
 * Tracks all important system activities for compliance and debugging
 * 
 * Features:
 * - User action logging
 * - Data change tracking
 * - Security event logging
 * - Performance monitoring
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');

/**
 * Log user activity for audit trail
 */
async function logActivity({
  userId,
  userEmail,
  ipAddress,
  userAgent,
  action,
  resource,
  resourceId,
  oldValues = null,
  newValues = null,
  metadata = {}
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        userEmail,
        ipAddress,
        userAgent,
        action,
        resource,
        resourceId,
        oldValues: oldValues ? JSON.parse(JSON.stringify(oldValues)) : null,
        newValues: newValues ? JSON.parse(JSON.stringify(newValues)) : null,
        metadata: JSON.parse(JSON.stringify(metadata))
      }
    });

    console.log(` Audit log: ${action} on ${resource}${resourceId ? ` (${resourceId})` : ''} by user ${userId}`);
  } catch (error) {
    console.error(' Audit logging failed:', error);
    // Don't throw error to avoid breaking main functionality
  }
}

/**
 * Log security events
 */
async function logSecurityEvent({
  userId,
  userEmail,
  ipAddress,
  userAgent,
  event,
  severity = 'medium',
  details = {}
}) {
  try {
    await logActivity({
      userId,
      userEmail,
      ipAddress,
      userAgent,
      action: `security.${event}`,
      resource: 'Security',
      metadata: {
        severity,
        ...details
      }
    });

    console.log(` Security event: ${event} (${severity}) from ${ipAddress}`);
  } catch (error) {
    console.error(' Security logging failed:', error);
  }
}

/**
 * Log authentication events
 */
async function logAuthEvent({
  userId,
  userEmail,
  ipAddress,
  userAgent,
  event,
  success = true,
  details = {}
}) {
  try {
    await logActivity({
      userId,
      userEmail,
      ipAddress,
      userAgent,
      action: `auth.${event}`,
      resource: 'Authentication',
      metadata: {
        success,
        ...details
      }
    });

    console.log(` Auth event: ${event} ${success ? 'succeeded' : 'failed'} for ${userEmail || userId}`);
  } catch (error) {
    console.error(' Auth logging failed:', error);
  }
}

/**
 * Log payment events
 */
async function logPaymentEvent({
  userId,
  bookingId,
  paymentIntentId,
  amount,
  currency,
  event,
  success = true,
  details = {}
}) {
  try {
    await logActivity({
      userId,
      action: `payment.${event}`,
      resource: 'Payment',
      resourceId: paymentIntentId,
      metadata: {
        bookingId,
        amount,
        currency,
        success,
        ...details
      }
    });

    console.log(`💳 Payment event: ${event} ${success ? 'succeeded' : 'failed'} - ${currency} ${amount}`);
  } catch (error) {
    console.error(' Payment logging failed:', error);
  }
}

/**
 * Get audit logs with filtering
 */
async function getAuditLogs({
  userId,
  action,
  resource,
  startDate,
  endDate,
  page = 1,
  limit = 50
}) {
  try {
    const where = {};
    
    if (userId) where.userId = userId;
    if (action) where.action = { contains: action };
    if (resource) where.resource = resource;
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [logs, totalCount] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.auditLog.count({ where })
    ]);

    const totalPages = Math.ceil(totalCount / parseInt(limit));

    return {
      logs,
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        totalCount,
        limit: parseInt(limit)
      }
    };
  } catch (error) {
    console.error(' Get audit logs failed:', error);
    throw error;
  }
}

/**
 * Get audit statistics for dashboard
 */
async function getAuditStats(days = 30) {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [
      totalLogs,
      logsByAction,
      logsByResource,
      securityEvents,
      recentActivity
    ] = await Promise.all([
      prisma.auditLog.count({
        where: {
          createdAt: { gte: startDate }
        }
      }),
      
      prisma.auditLog.groupBy({
        by: ['action'],
        where: {
          createdAt: { gte: startDate }
        },
        _count: true,
        orderBy: { _count: { action: 'desc' } },
        take: 10
      }),
      
      prisma.auditLog.groupBy({
        by: ['resource'],
        where: {
          createdAt: { gte: startDate }
        },
        _count: true,
        orderBy: { _count: { resource: 'desc' } }
      }),
      
      prisma.auditLog.count({
        where: {
          action: { startsWith: 'security.' },
          createdAt: { gte: startDate }
        }
      }),
      
      prisma.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          userId: true,
          userEmail: true,
          action: true,
          resource: true,
          createdAt: true
        }
      })
    ]);

    return {
      totalLogs,
      logsByAction,
      logsByResource,
      securityEvents,
      recentActivity,
      period: `${days} days`
    };
  } catch (error) {
    console.error('❌ Get audit stats failed:', error);
    throw error;
  }
}

/**
 * Clean up old audit logs (run periodically)
 */
async function cleanupOldLogs(daysToKeep = 365) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const result = await prisma.auditLog.deleteMany({
      where: {
        createdAt: {
          lt: cutoffDate
        }
      }
    });

    console.log(`🧹 Cleaned up ${result.count} old audit logs`);
    return { success: true, deletedCount: result.count };
  } catch (error) {
    console.error('❌ Audit log cleanup failed:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  logActivity,
  logSecurityEvent,
  logAuthEvent,
  logPaymentEvent,
  getAuditLogs,
  getAuditStats,
  cleanupOldLogs
};