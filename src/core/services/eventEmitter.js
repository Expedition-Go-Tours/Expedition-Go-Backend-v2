/**
 * Event Emitter — Analytics Event Tracking
 *
 * Writes structured events to the Event table for downstream analytics:
 *  - Funnel analysis (view → cart → checkout → purchase)
 *  - User-journey reconstruction
 *  - Time-series trend queries (daily/weekly/monthly)
 *  - Conversion-rate calculations
 *
 * DESIGN (why this exists alongside AuditLog):
 *  - AuditLog  → compliance / security / before-after diff tracking (who changed what)
 *  - Event     → product analytics / user behaviour / funnel metrics (what happened)
 *  They complement each other. Instrument both when both concerns apply.
 *
 * USAGE:
 *   const event = require('./eventEmitter');
 *   await event.emit('booking.completed', { userId, resource: 'Booking', resourceId: booking.id, properties: { total, currency } });
 *
 * @author Tour Platform Team
 * @version 1.0.0
 */

const prisma = require('./prismaClient');

/**
 * Generate a stable anonymous session fingerprint from request headers.
 * Used for unauthenticated event tracking (tour views, searches).
 */
function deriveSessionId(req) {
  if (!req) return null;
  const ip = req.ip || req.connection?.remoteAddress || '';
  const ua = req.headers?.['user-agent'] || '';
  if (!ip && !ua) return null;
  const crypto = require('crypto');
  return crypto.createHash('md5').update(`${ip}|${ua}`).digest('hex');
}

/**
 * Emit a product-analytics event.
 *
 * Fire-and-forget by design — never throws, never blocks the response.
 * If the write fails (DB connection issue, etc.) the request still succeeds.
 * Callers should NOT await this in hot paths unless they need the event ID.
 *
 * @param {Object}   options
 * @param {string}   options.name       — Dot-notation event name, e.g. "booking.completed"
 * @param {string}   [options.userId]   — Authenticated user ID (from req.user?.id)
 * @param {import('express').Request} [options.req]  — Express request object (for sessionId + source derivation)
 * @param {string}   [options.sessionId]— Explicit session ID (takes precedence over req-derived)
 * @param {string}   [options.resource] — Entity type, e.g. "Booking", "Tour", "Review"
 * @param {string}   [options.resourceId]  — Entity primary key
 * @param {Object}   [options.properties]  — Arbitrary JSON payload
 * @param {string}   [options.source]      — Override origin detection ("web" | "mobile" | "api" | "webhook")
 * @returns {Promise<string|null>} event ID if written, null on failure
 */
async function emit({
  name,
  userId,
  req,
  sessionId,
  resource,
  resourceId,
  properties = {},
  source,
}) {
  // Preserve callers that pass userId as the second argument (convenience overload)
  // e.g. emit('booking.completed', userId, { resource: 'Booking', ... })

  try {
    const resolvedSessionId = sessionId || (req ? deriveSessionId(req) : null);
    const resolvedSource = source || (req ? 'web' : 'api');
    const resolvedUserId = userId || req?.user?.id || null;

    const event = await prisma.event.create({
      data: {
        name,
        userId: resolvedUserId,
        sessionId: resolvedSessionId,
        resource,
        resourceId,
        properties,
        source: resolvedSource,
      },
      select: { id: true },
    });

    return event.id;
  } catch (error) {
    // Silently fail — analytics should never break the application.
    // In production, route this to your structured logger instead of console.
    if (process.env.NODE_ENV === 'development') {
      console.error('[eventEmitter] Failed to write event:', error.message);
    }
    return null;
  }
}

/**
 * Convenience: batch-emit multiple events inside a single Prisma $transaction.
 * Use when you need atomicity across multiple events (e.g. booking.created + payment.initiated).
 *
 * @param {Array<Object>} events — Array of event options (same shape as emit())
 * @returns {Promise<number>} count of successfully written events
 */
async function emitBatch(events) {
  try {
    await prisma.$transaction(
      events.map((evt) =>
        prisma.event.create({
          data: {
            name: evt.name,
            userId: evt.userId || evt.req?.user?.id || null,
            sessionId: evt.sessionId || (evt.req ? deriveSessionId(evt.req) : null),
            resource: evt.resource,
            resourceId: evt.resourceId,
            properties: evt.properties || {},
            source: evt.source || 'api',
          },
        })
      )
    );
    return events.length;
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[eventEmitter] Batch write failed:', error.message);
    }
    return 0;
  }
}

module.exports = { emit, emitBatch, deriveSessionId };
