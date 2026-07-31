/**
 * Audit Logger - Production Ready
 * Tracks all important system activities for compliance and debugging
 * 
 * Features:
 * - User action logging
 * - Data change tracking
 * - Security event logging
 * - Performance monitoring
 * - Tamper-evident hash chain (prevHash + hash) for integrity verification
 * - Archive-not-purge retention (moves expired logs to AuditLogArchive)
 * - Automatic IP / user-agent capture from the request context
 * 
 * @author Tour Platform Team
 * @version 2.0.0
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const logger = require('./logger');
const { getRequestMeta } = require('../middleware/requestMeta');

// Advisory lock key used to serialize hash-chain appends.
const CHAIN_LOCK_KEY = 9135701;

/**
 * Produce a deterministic, key-sorted JSON string so the same logical payload
 * always serializes identically (JSON key order is not guaranteed otherwise).
 */
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Compute the chain hash for an entry: sha256(prevHash + canonical payload).
 */
function computeChainHash(prevHash, entry) {
  const payload = { ...entry };
  delete payload.prevHash;
  delete payload.hash;
  const canonical = JSON.stringify(canonicalize(payload));
  return crypto
    .createHash('sha256')
    .update(`${prevHash || ''}|${canonical}`)
    .digest('hex');
}

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
    const requestMeta = getRequestMeta();
    const resolvedIp = ipAddress || requestMeta.ipAddress || null;
    const resolvedAgent = userAgent || requestMeta.userAgent || null;
    const createdAt = new Date();

    // Auto-attach the touched endpoint (method + URL) so every entry records
    // which request produced it, unless the caller already provided one.
    const enrichedMeta = JSON.parse(JSON.stringify(metadata || {}));
    if (!enrichedMeta.endpoint && requestMeta.method && requestMeta.url) {
      enrichedMeta.endpoint = { method: requestMeta.method, url: requestMeta.url };
    }

    const base = {
      userId: userId || null,
      userEmail: userEmail || null,
      ipAddress: resolvedIp,
      userAgent: resolvedAgent,
      action,
      resource,
      resourceId: resourceId || null,
      oldValues: oldValues ? JSON.parse(JSON.stringify(oldValues)) : null,
      newValues: newValues ? JSON.parse(JSON.stringify(newValues)) : null,
      metadata: enrichedMeta,
      createdAt,
    };

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`;

      const last = await tx.auditLog.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { hash: true },
      });

      const prevHash = last?.hash ?? null;
      const hash = computeChainHash(prevHash, base);

      await tx.auditLog.create({
        data: { ...base, prevHash, hash },
      });
    });

    logger.info(`Audit log: ${action} on ${resource}${resourceId ? ` (${resourceId})` : ''} by user ${userId}`);
  } catch (error) {
    logger.error('Audit logging failed:', { action, resource, resourceId, userId, error: error?.message });
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

    logger.info(`Security event: ${event} (${severity}) from ${ipAddress}`);
  } catch (error) {
    logger.error('Security logging failed:', { event, severity, error: error?.message });
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

    logger.info(`Auth event: ${event} ${success ? 'succeeded' : 'failed'} for ${userEmail || userId}`);
  } catch (error) {
    logger.error('Auth logging failed:', { event, error: error?.message });
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

    logger.info(`Payment event: ${event} ${success ? 'succeeded' : 'failed'} - ${currency} ${amount}`);
  } catch (error) {
    logger.error('Payment logging failed:', { event, error: error?.message });
  }
}

/**
 * Get audit logs with filtering
 */
async function getAuditLogs({
  userId,
  userEmail,
  resourceId,
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
    if (userEmail) where.userEmail = { contains: userEmail, mode: 'insensitive' };
    if (resourceId) where.resourceId = resourceId;
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
    logger.error('Get audit logs failed:', { error: error?.message });
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
    logger.error('Get audit stats failed:', { error: error?.message });
    throw error;
  }
}

/**
 * Verify the integrity of the audit hash chain.
 *
 * Walks entries in insertion order and recomputes each entry's expected hash
 * from its stored prevHash + payload. Any entry whose stored hash does not
 * match the recomputed value indicates tampering (or a corrupted record).
 *
 * Returns { verified, total, breaks, firstBreakAt, firstBreakId } where
 * breaks is an array of { id, createdAt, action } for each invalid entry.
 */
async function verifyAuditChain({ limit = 100000 } = {}) {
  try {
    const entries = await prisma.auditLog.findMany({
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        createdAt: true,
        action: true,
        resource: true,
        userId: true,
        userEmail: true,
        ipAddress: true,
        userAgent: true,
        resourceId: true,
        oldValues: true,
        newValues: true,
        metadata: true,
        prevHash: true,
        hash: true,
      },
    });

    const breaks = [];
    let expectedHash = null;

    for (const entry of entries) {
      const { id, createdAt, action, prevHash, hash } = entry;

      if (prevHash !== expectedHash) {
        breaks.push({ id, createdAt, action, reason: `prevHash mismatch (expected ${expectedHash}, got ${prevHash})` });
      }

      const computed = computeChainHash(prevHash, entry);
      if (computed !== hash) {
        breaks.push({ id, createdAt, action, reason: 'hash does not match payload' });
      }

      expectedHash = hash;
    }

    return {
      verified: breaks.length === 0,
      total: entries.length,
      breaks,
      firstBreakAt: breaks[0]?.createdAt ?? null,
      firstBreakId: breaks[0]?.id ?? null,
    };
  } catch (error) {
    logger.error('Audit chain verification failed:', { error: error?.message });
    throw error;
  }
}

/**
 * Clean up old audit logs (run periodically).
 *
 * Retention is archive-not-purge: expired rows are copied to AuditLogArchive
 * (preserving createdAt and hash-chain fields) and then removed from the live
 * table. No audit data is ever destroyed.
 */
async function cleanupOldLogs(daysToKeep = 365) {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    let moved = 0;
    const BATCH = 500;

    while (true) {
      const expired = await prisma.auditLog.findMany({
        where: { createdAt: { lt: cutoffDate } },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      });

      if (expired.length === 0) break;

      await prisma.$transaction([
        prisma.auditLogArchive.createMany({
          data: expired.map(({ id, userId, userEmail, ipAddress, userAgent, action, resource, resourceId, oldValues, newValues, metadata, prevHash, hash, createdAt }) => ({
            id,
            userId,
            userEmail,
            ipAddress,
            userAgent,
            action,
            resource,
            resourceId,
            oldValues,
            newValues,
            metadata,
            prevHash,
            hash,
            createdAt,
          })),
        }),
        prisma.auditLog.deleteMany({
          where: { id: { in: expired.map((e) => e.id) } },
        }),
      ]);

      moved += expired.length;

      if (expired.length < BATCH) break;
    }

    logger.info(`Archived ${moved} old audit logs (cutoff ${cutoffDate.toISOString()})`);
    return { success: true, archivedCount: moved, cutoffDate };
  } catch (error) {
    logger.error('Audit log cleanup failed:', { error: error?.message });
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
  verifyAuditChain,
  cleanupOldLogs,
  computeChainHash,
};
