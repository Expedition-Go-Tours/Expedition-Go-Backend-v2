const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');

/**
 * Record a cookie-consent decision.
 *
 * Best-effort audit trail: the storefront applies the choice locally and must
 * never be blocked on this call, so the endpoint stays small and never throws
 * for anything short of a genuine database failure.
 *
 * Idempotency is intentionally not enforced. A visitor who changes their mind
 * five times should leave five rows — that history is the point of the record.
 */
exports.recordConsent = catchAsync(async (req, res) => {
  const {
    version,
    necessary,
    functional,
    analytics,
    marketing,
    source,
    policyPath,
    userAgent,
    decidedAt,
  } = req.body;

  const record = await prisma.consentRecord.create({
    data: {
      userId: req.user?.id || null,
      policyVersion: version,
      necessary: necessary !== false,
      functional: functional === true,
      analytics: analytics === true,
      marketing: marketing === true,
      source,
      policyPath: policyPath || null,
      // Prefer what the client reported (it is the browser that holds the
      // cookies); fall back to the request header.
      userAgent: (userAgent || req.get('user-agent') || '').slice(0, 500) || null,
      ipAddress: req.ip || null,
      decidedAt: decidedAt ? new Date(decidedAt) : new Date(),
    },
    select: { id: true, createdAt: true },
  });

  res.status(201).json({
    status: 'success',
    data: { id: record.id, createdAt: record.createdAt },
  });
});
