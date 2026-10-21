/**
 * Zod schemas for the booking cancellation endpoints.
 *
 * The supplier wizard may not cancel without a structured reason: when
 * `status === 'CANCELLED'` the payload must carry a taxonomy code, the T&C
 * checkbox, and the category-conditional fields (explanation / evidence link /
 * refund-agreement). Validation delegates to validateCancellationPayload so
 * the route and the controller can never disagree about the rules.
 *
 * Non-cancel transitions (confirm / complete / no-show) are unaffected.
 */

const { z } = require('zod');
const { REASONS, validateCancellationPayload } = require('./cancellationReasons');

const KNOWN_CODES = REASONS.map((r) => r.code);

const STATUS_ENUM = z.enum(['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED']);

const baseShape = {
  // Optional so the supplier can save notes without changing the status:
  // the old shape required `status`, which forced a transition just to record
  // "customer will arrive at 9am". The superRefine below keeps at least one of
  // the two fields mandatory.
  status: STATUS_ENUM.optional(),
  supplierNotes: z.string().max(2000).optional(),
  // Legacy free-text reason (pre-wizard callers / extra context). The
  // human-readable cancellationReason falls back to it when no explanation
  // was given — the structured code remains mandatory.
  reason: z.string().max(500).optional(),

  // ── Structured cancellation fields (wizard) ──
  cancellationCode: z.enum(KNOWN_CODES).optional(),
  agreedToTerms: z.boolean().optional(),
  explanation: z.string().max(2000).optional(),
  evidenceUrl: z
    .string()
    .max(1000)
    .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
      message: 'evidenceUrl must be an http(s) link',
    })
    .optional(),
  customerRefundAgreed: z.boolean().optional(),
};

const cancellationIssues = (data, ctx) => {
  const validation = validateCancellationPayload(data);
  for (const message of validation.errors) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cancellationCode'],
      message,
    });
  }
};

// validate() middleware parses the full { body, query, params } envelope and
// writes each parsed slice back onto the request — so every schema exported
// here MUST be envelope-shaped (like the brand validation schemas), or the
// route 400s with "status: Required" before any handler runs.
const updateBookingStatusSchema = z.object({
  body: z
    .object(baseShape)
    .superRefine((data, ctx) => {
      if (!data.status && data.supplierNotes === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'Provide a status change or supplierNotes',
        });
      }
      if (data.status === 'CANCELLED') cancellationIssues(data, ctx);
    }),
  query: z.any().optional(),
  params: z.object({ id: z.string().min(1).max(100) }),
});

// ── Bulk cancellation wizard (one tour, one date range, one reason) ──
const bulkCancelSchema = z.object({
  body: z
    .object({
      tourId: z.string().min(1, 'tourId is required'),
      dateFrom: z.string().min(1, 'dateFrom is required'),
      dateTo: z.string().min(1, 'dateTo is required'),
      selectedTime: z.string().max(10).optional(),
      stopAcceptingBookings: z.boolean().default(false),

      supplierNotes: z.string().max(2000).optional(),
      reason: z.string().max(500).optional(),
      cancellationCode: z.enum(KNOWN_CODES).optional(),
      agreedToTerms: z.boolean().optional(),
      explanation: z.string().max(2000).optional(),
      evidenceUrl: z
        .string()
        .max(1000)
        .refine((v) => v === '' || /^https?:\/\/\S+$/i.test(v), {
          message: 'evidenceUrl must be an http(s) link',
        })
        .optional(),
      customerRefundAgreed: z.boolean().optional(),
    })
    .superRefine(cancellationIssues),
  query: z.any().optional(),
  params: z.any().optional(),
});

module.exports = {
  updateBookingStatusSchema,
  bulkCancelSchema,
  KNOWN_CODES,
};
