/**
 * Payout Method validation schemas (zod)
 *
 * Format-level validation for banking identifiers, mirroring production
 * payout-method forms used by platforms such as GetYourGuide / Airbnb:
 *   - IBAN mod-97 (dependency-free)
 *   - BIC/SWIFT code structure (8 or 11 chars)
 *   - ABA routing number (8–11 digits)
 *   - Account number (6–32 digits, separators allowed in input)
 *   - UK / GH sort code (6 digits)
 *   - Country code (ISO 3166-1 alpha-2)
 *   - PayPal email format
 *
 * These run at the route layer via `middleware/validate`. The controller keeps
 * its own presence checks as defense-in-depth.
 *
 * @see middleware/validate.js   (safeParse -> 400 on first issue)
 * @see utils/expeditionValidation.js (style reference)
 */

const { z } = require('zod');

// ─────────────────────────────────────────────────────────────
// Dependency-free banking helpers
// ─────────────────────────────────────────────────────────────

const DIGITS_REGEX = /^\d+$/;

/**
 * Validate an IBAN per ISO 13616 using mod-97.
 * - Strips spaces, upper-cases.
 * - Requires country code + 2 check digits + BBAN.
 * - Total length 15–34.
 * - mod-97 check (rearranged) === 1.
 */
function ibanIsValid(value) {
  if (typeof value !== 'string') return false;
  const iban = value.toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban) && !/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    // length guard below covers the strict range; this regex is a fast fail
  }
  if (iban.length < 15 || iban.length > 34) return false;
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return false;
  // Rearrange: move the first 4 chars to the end, then convert letters to numbers
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  if (!/^\d+$/.test(numeric)) return false;
  // mod-97
  let remainder = '';
  for (const ch of numeric) {
    remainder += ch;
    remainder = String(parseInt(remainder, 10) % 97);
  }
  return parseInt(remainder, 10) === 1;
}

/** BIC/SWIFT: 4 letters + 2 letters (country) + 2 alphanum (location) + optional 3 (branch) = 8 or 11 */
const BIC_REGEX = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** Account number: 6–32 digits after stripping separators. */
function accountNumberIsValid(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[\s-]/g, '');
  return DIGITS_REGEX.test(digits) && digits.length >= 6 && digits.length <= 32;
}

/** ABA routing number: 8–11 digits (commonly 9) after stripping separators. */
function routingNumberIsValid(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[\s-]/g, '');
  return DIGITS_REGEX.test(digits) && digits.length >= 8 && digits.length <= 11;
}

/** Sort code: 6 digits after stripping dashes/spaces (UK, Ghana style). */
function sortCodeIsValid(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[\s-]/g, '');
  return DIGITS_REGEX.test(digits) && digits.length === 6;
}

// ─────────────────────────────────────────────────────────────
// Reusable field helpers
// ─────────────────────────────────────────────────────────────

/**
 * Optional string that trims whitespace and collapses empty/whitespace-only
 * values to `undefined` so the controller's conditional spread skips them.
 */
const optString = (maxLen, description) =>
  z
    .string()
    .max(maxLen, `${description} must be at most ${maxLen} characters`)
    .optional()
    .transform((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v));

/** Optional string trimmed + upper-cased (for codes/countries). */
const optUpper = (maxLen, description) =>
  optString(maxLen, description).transform((v) =>
    typeof v === 'string' ? v.trim().toUpperCase() : v
  );

// ─────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────

const BANK_TRANSFER_FIELDS = [
  'bankName',
  'bankAddress',
  'bankCountry',
  'accountName',
  'accountNumber',
  'routingNumber',
  'swiftCode',
  'iban',
  'sortCode',
  'branchCode',
  'branchName',
];

const requiredForBank = ['accountName', 'accountNumber'];

/** POST /payout-methods — new payout method */
const payoutMethodInputSchema = z.object({
  body: z
    .object({
      type: z.enum(['BANK_TRANSFER', 'PAYPAL'], {
        errorMap: () => ({ message: 'type must be BANK_TRANSFER or PAYPAL' }),
      }),
      isDefault: z.boolean().optional(),
      currency: z.preprocess(
        (v) => (v === undefined || v === '' ? 'USD' : v),
        z
          .string()
          .min(3, 'currency must be a 3-letter ISO code (e.g. USD)')
          .max(3, 'currency must be a 3-letter ISO code (e.g. USD)')
          .toUpperCase()
      ),

      // Bank Transfer
      bankName: optString(150, 'Bank name'),
      bankAddress: optString(250, 'Bank address'),
      bankCountry: z
        .string()
        .optional()
        .transform((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v))
        .refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), {
          message: 'bankCountry must be a 2-letter ISO country code (e.g. NG, GH, US)',
        }),
      accountName: optString(100, 'Account name'),
      accountNumber: optString(32, 'Account number').refine(
        (v) => v === undefined || accountNumberIsValid(v),
        { message: 'account number must be 6–32 digits (spaces and dashes allowed)' }
      ),
      routingNumber: optString(11, 'Routing number').refine(
        (v) => v === undefined || routingNumberIsValid(v),
        { message: 'routing number must be 8–11 digits' }
      ),
      swiftCode: optString(11, 'SWIFT/BIC code').transform((v) =>
        typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v
      ).refine(
        (v) => v === undefined || BIC_REGEX.test(v),
        { message: 'invalid SWIFT/BIC code (e.g. DEUTDEFF)' }
      ),
      iban: optUpper(34, 'IBAN').transform((v) =>
        typeof v === 'string' ? v.replace(/\s+/g, '') : v
      ).refine(
        (v) => v === undefined || ibanIsValid(v),
        { message: 'invalid IBAN (failed mod-97 check)' }
      ),
      sortCode: optString(11, 'Sort code').refine(
        (v) => v === undefined || sortCodeIsValid(v),
        { message: 'invalid sort code (e.g. 12-34-56 or 123456)' }
      ),
      branchCode: optString(20, 'Branch code'),
      branchName: optString(100, 'Branch name'),

      // PayPal
      paypalEmail: optString(254, 'PayPal email').refine(
        (v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        { message: 'invalid PayPal email address' }
      ),
    })
    .superRefine((val, ctx) => {
      if (val.type === 'BANK_TRANSFER') {
        const hasIban = val.iban !== undefined;
        if (!val.accountNumber && !hasIban) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accountNumber'],
            message: 'account number (or IBAN) is required for BANK_TRANSFER',
          });
        }
        if (val.iban && !val.bankCountry) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['bankCountry'],
            message: 'bankCountry is required when providing an IBAN',
          });
        }
        if (val.swiftCode && !val.bankCountry) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['bankCountry'],
            message: 'bankCountry is required when providing a SWIFT/BIC code',
          });
        }
        if (val.accountNumber && !val.accountName) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['accountName'],
            message: 'accountName is required for BANK_TRANSFER',
          });
        }
      }
      if (val.type === 'PAYPAL') {
        if (!val.paypalEmail) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['paypalEmail'],
            message: 'paypalEmail is required for PAYPAL',
          });
        }
      }
    }),
  query: z.any().optional(),
  params: z.any().optional(),
});

/** PATCH /payout-methods/:id — partial update (format checks only, no presence/required rules) */
const payoutMethodPatchSchema = z.object({
  body: z
    .object({
      currency: z.preprocess(
        (v) => (v === undefined || v === '' ? undefined : v),
        z
          .string()
          .min(3)
          .max(3)
          .toUpperCase()
          .optional()
      ),
      isDefault: z.boolean().optional(),
      bankName: optString(150, 'Bank name'),
      bankAddress: optString(250, 'Bank address'),
      bankCountry: z
        .string()
        .optional()
        .transform((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v))
        .refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), {
          message: 'bankCountry must be a 2-letter ISO country code (e.g. NG, GH, US)',
        }),
      accountName: optString(100, 'Account name'),
      accountNumber: optString(32, 'Account number').refine(
        (v) => v === undefined || accountNumberIsValid(v),
        { message: 'account number must be 6–32 digits (spaces and dashes allowed)' }
      ),
      routingNumber: optString(11, 'Routing number').refine(
        (v) => v === undefined || routingNumberIsValid(v),
        { message: 'routing number must be 8–11 digits' }
      ),
      swiftCode: optString(11, 'SWIFT/BIC code').transform((v) =>
        typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() : v
      ).refine(
        (v) => v === undefined || BIC_REGEX.test(v),
        { message: 'invalid SWIFT/BIC code (e.g. DEUTDEFF)' }
      ),
      iban: optUpper(34, 'IBAN').transform((v) =>
        typeof v === 'string' ? v.replace(/\s+/g, '') : v
      ).refine(
        (v) => v === undefined || ibanIsValid(v),
        { message: 'invalid IBAN (failed mod-97 check)' }
      ),
      sortCode: optString(11, 'Sort code').refine(
        (v) => v === undefined || sortCodeIsValid(v),
        { message: 'invalid sort code (e.g. 12-34-56 or 123456)' }
      ),
      branchCode: optString(20, 'Branch code'),
      branchName: optString(100, 'Branch name'),
      paypalEmail: optString(254, 'PayPal email').refine(
        (v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
        { message: 'invalid PayPal email address' }
      ),
      // `type` is accepted only so the immutability refine below can detect and
      // reject attempts to change it; it is never persisted by the controller.
      type: z.any().optional(),
    })
    .refine((val) => val.type === undefined, {
      path: ['type'],
      message: 'payout method type cannot be changed',
    }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1, 'payout method id is required'),
  }),
});

/** PATCH /payout-methods/admin/:id/verify — toggle verification status */
const verifyPayoutMethodSchema = z.object({
  body: z.object({
    verified: z.boolean().default(true),
  }),
  query: z.any().optional(),
  params: z.object({
    id: z.string().min(1, 'payout method id is required'),
  }),
});

module.exports = {
  payoutMethodInputSchema,
  payoutMethodPatchSchema,
  verifyPayoutMethodSchema,
  // exported for testing
  ibanIsValid,
  BIC_REGEX,
  accountNumberIsValid,
  routingNumberIsValid,
  sortCodeIsValid,
  BANK_TRANSFER_FIELDS,
  requiredForBank,
};
