const { z } = require('zod');

/**
 * Validation for the cookie-consent audit endpoint.
 *
 * The client is only ever recording a decision it has already applied locally,
 * so this is deliberately permissive about *values* (booleans) and strict about
 * *shape* — a malformed record is worse than no record, because it would look
 * like evidence of consent that was never given.
 */
const consentSchema = z.object({
  body: z.object({
    version: z.number().int().min(1).max(1000),
    necessary: z.boolean().optional().default(true),
    functional: z.boolean().optional().default(false),
    analytics: z.boolean().optional().default(false),
    marketing: z.boolean().optional().default(false),
    source: z.enum(['accept-all', 'reject-non-essential', 'preferences']),
    policyPath: z.string().max(200).optional().nullable(),
    userAgent: z.string().max(500).optional().nullable(),
    // ISO timestamp from the visitor's clock; the server records its own
    // createdAt alongside it so a skewed client clock is always detectable.
    decidedAt: z.string().datetime().optional(),
  }),
  query: z.any().optional(),
  params: z.object({}).optional(),
});

module.exports = { consentSchema };
