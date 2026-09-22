/**
 * Supplier notification recipients.
 *
 * A supplier (User + SupplierProfile) may add extra email addresses that
 * receive its email notifications. These are delivery-only addresses — they
 * are NOT logins and do not get in-app notifications (that remains TeamMember
 * territory). The login email (User.email) is always the implicit primary
 * recipient and never appears in this table.
 *
 * Every supplier email resolves its audience through `resolveRecipients()`,
 * so adding a second address is a data change, not a code change. Fan-out
 * (one provider send per address) happens in emailService.
 *
 * Verification is double opt-in: an address receives no mail until its owner
 * clicks the emailed link. Only the sha256 of the token is stored.
 */

const crypto = require('crypto');
const prisma = require('./prismaClient');
const AppError = require('./appError');

const MAX_RECIPIENTS = parseInt(process.env.NOTIFICATION_RECIPIENTS_MAX, 10) || 5;
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATEGORIES = ['bookings', 'reviews', 'payments', 'systemAlerts'];

// A recipient receives every category unless it explicitly opts out.
const DEFAULT_PREFERENCES = { bookings: true, reviews: true, payments: true, systemAlerts: true };

// Human labels for the email types — used in the confirmation email body.
const CATEGORY_LABELS = {
  bookings: 'Bookings & operations',
  reviews: 'Reviews & ratings',
  payments: 'Payments & payouts',
  systemAlerts: 'Account & system alerts',
};

// Labels of the types a recipient will actually receive, in display order.
function enabledTypeLabels(preferences) {
  const prefs = { ...DEFAULT_PREFERENCES, ...(preferences || {}) };
  return CATEGORIES.filter((c) => prefs[c] !== false).map((c) => CATEGORY_LABELS[c]);
}

// Rollout gate. With extras disabled the resolver returns only the primary, so
// deploying the code is a no-op until the flag is switched on.
function recipientsEnabled() {
  return process.env.NOTIFICATION_RECIPIENTS_ENABLED === 'true';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// Keep addresses out of logs at info level.
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return '***';
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(user.length - 2, 0))}@${domain}`;
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Whitelist + normalise the per-category preference object so callers can't
// persist arbitrary keys.
function sanitizePreferences(input) {
  const out = {};
  if (input && typeof input === 'object') {
    for (const key of CATEGORIES) {
      if (typeof input[key] === 'boolean') out[key] = input[key];
    }
  }
  return out;
}

function publicRecipient(record) {
  if (!record) return null;
  return {
    id: record.id,
    supplierId: record.supplierId,
    email: record.email,
    name: record.name,
    status: record.status,
    preferences: { ...DEFAULT_PREFERENCES, ...(record.preferences || {}) },
    verifiedAt: record.verifiedAt,
    disabledAt: record.disabledAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function listRecipients(supplierId) {
  const rows = await prisma.supplierNotificationRecipient.findMany({
    where: { supplierId },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(publicRecipient);
}

async function getRecipient(supplierId, id) {
  const row = await prisma.supplierNotificationRecipient.findFirst({
    where: { id, supplierId },
  });
  if (!row) throw new AppError('Notification email not found', 404);
  return row;
}

/**
 * Create (or re-invite) an additional recipient. Returns the record plus the
 * raw token that must be emailed — it is never persisted.
 */
async function addRecipient(supplierId, { email, name, preferences }, invitedById) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    throw new AppError('Enter a valid email address', 400);
  }

  const supplier = await prisma.user.findUnique({
    where: { id: supplierId },
    select: { email: true },
  });
  if (!supplier) throw new AppError('Supplier not found', 404);
  if (normalizeEmail(supplier.email) === normalized) {
    throw new AppError('That is already your account email address', 400);
  }

  const existing = await prisma.supplierNotificationRecipient.findUnique({
    where: { supplierId_email: { supplierId, email: normalized } },
  });

  if (!existing) {
    const count = await prisma.supplierNotificationRecipient.count({ where: { supplierId } });
    if (count >= MAX_RECIPIENTS) {
      throw new AppError(`You can add up to ${MAX_RECIPIENTS} notification emails`, 400);
    }
  }

  const rawToken = newToken();
  const prefs = sanitizePreferences(preferences);
  const data = {
    email: normalized,
    name: name ? String(name).trim().slice(0, 120) : null,
    status: 'PENDING',
    verifyTokenHash: sha256(rawToken),
    tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    disabledAt: null,
    disableReason: null,
    invitedById: invitedById || null,
  };

  const record = existing
    ? await prisma.supplierNotificationRecipient.update({
        where: { id: existing.id },
        data: {
          ...data,
          // Preserve already-chosen types on re-invite unless new ones are sent.
          ...(Object.keys(prefs).length
            ? { preferences: { ...(existing.preferences || {}), ...prefs } }
            : {}),
        },
      })
    : await prisma.supplierNotificationRecipient.create({
        data: { supplierId, ...data, ...(Object.keys(prefs).length ? { preferences: prefs } : {}) },
      });

  return { record: publicRecipient(record), rawToken };
}

/**
 * Re-issue a verification token for a pending/disabled recipient.
 */
async function resendVerification(supplierId, id) {
  const row = await getRecipient(supplierId, id);
  const rawToken = newToken();
  const record = await prisma.supplierNotificationRecipient.update({
    where: { id: row.id },
    data: {
      status: 'PENDING',
      verifyTokenHash: sha256(rawToken),
      tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      disabledAt: null,
      disableReason: null,
    },
  });
  return { record: publicRecipient(record), rawToken };
}

/**
 * Verify an address from its emailed token. Returns the recipient on success,
 * or throws with a reason code the caller can turn into a redirect.
 */
async function verifyByToken(rawToken) {
  const token = String(rawToken || '');
  if (!token) throw new AppError('Missing verification token', 400);

  const row = await prisma.supplierNotificationRecipient.findUnique({
    where: { verifyTokenHash: sha256(token) },
  });
  if (!row) throw new AppError('This verification link is not valid', 400);

  if (row.status === 'VERIFIED') {
    return publicRecipient(row);
  }
  if (!row.tokenExpiresAt || row.tokenExpiresAt.getTime() < Date.now()) {
    throw new AppError('This verification link has expired', 410);
  }

  const record = await prisma.supplierNotificationRecipient.update({
    where: { id: row.id },
    data: {
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verifyTokenHash: null,
      tokenExpiresAt: null,
      disabledAt: null,
      disableReason: null,
    },
  });
  return publicRecipient(record);
}

async function updateRecipient(supplierId, id, { name, preferences }) {
  const row = await getRecipient(supplierId, id);
  const data = {};
  if (name !== undefined) data.name = name ? String(name).trim().slice(0, 120) : null;
  if (preferences !== undefined) {
    data.preferences = { ...(row.preferences || {}), ...sanitizePreferences(preferences) };
  }
  const record = await prisma.supplierNotificationRecipient.update({ where: { id: row.id }, data });
  return publicRecipient(record);
}

async function removeRecipient(supplierId, id) {
  const row = await getRecipient(supplierId, id);
  await prisma.supplierNotificationRecipient.delete({ where: { id: row.id } });
  return { id: row.id };
}

/** Flip a recipient to DISABLED (bounce/complaint webhook or manual block). */
async function disableByEmail(email, reason) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { count: 0 };
  const result = await prisma.supplierNotificationRecipient.updateMany({
    where: { email: normalized, status: { not: 'DISABLED' } },
    data: { status: 'DISABLED', disabledAt: new Date(), disableReason: reason || 'manual' },
  });
  return { count: result.count };
}

async function disableById(id, reason) {
  const result = await prisma.supplierNotificationRecipient.updateMany({
    where: { id, status: { not: 'DISABLED' } },
    data: { status: 'DISABLED', disabledAt: new Date(), disableReason: reason || 'manual' },
  });
  return { count: result.count };
}

/**
 * Audience for one email category.
 *
 * Returns [{ email, recipientId }] — recipientId is null for the primary
 * (User.email) and the row id for an extra address, so the sender can tag each
 * fan-out send for per-recipient bounce handling.
 *
 * The primary preserves existing behaviour (always receives transactional
 * mail). Extra addresses honour their own per-category preferences.
 */
async function resolveRecipients(supplierId, category) {
  const user = await prisma.user.findUnique({
    where: { id: supplierId },
    select: { email: true },
  });
  if (!user) return [];

  const out = [];
  const primary = normalizeEmail(user.email);
  if (primary) out.push({ email: primary, recipientId: null });

  if (!recipientsEnabled()) return out;

  const extras = await prisma.supplierNotificationRecipient.findMany({
    where: { supplierId, status: 'VERIFIED' },
    orderBy: { createdAt: 'asc' },
  });
  for (const r of extras) {
    const prefs = r.preferences || {};
    if (category && prefs[category] === false) continue;
    if (out.some((o) => o.email === r.email)) continue;
    out.push({ email: r.email, recipientId: r.id });
  }
  return out;
}

/** Convenience: just the addresses. */
async function resolveRecipientEmails(supplierId, category) {
  return (await resolveRecipients(supplierId, category)).map((r) => r.email);
}

function signUnsubscribeToken(recipientId) {
  const secret = process.env.NOTIFICATION_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'notif-unsub';
  return crypto.createHmac('sha256', secret).update(String(recipientId)).digest('hex');
}

function verifyUnsubscribeToken(recipientId, token) {
  const expected = signUnsubscribeToken(recipientId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Recipient-initiated opt-out: turn every category off, keep the row. */
async function unsubscribeById(id) {
  const row = await prisma.supplierNotificationRecipient.findUnique({ where: { id } });
  if (!row) throw new AppError('Notification email not found', 404);
  const off = {};
  for (const c of CATEGORIES) off[c] = false;
  const record = await prisma.supplierNotificationRecipient.update({
    where: { id: row.id },
    data: { preferences: { ...(row.preferences || {}), ...off } },
  });
  return publicRecipient(record);
}

module.exports = {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_PREFERENCES,
  MAX_RECIPIENTS,
  enabledTypeLabels,
  recipientsEnabled,
  normalizeEmail,
  isValidEmail,
  maskEmail,
  sanitizePreferences,
  listRecipients,
  getRecipient,
  addRecipient,
  resendVerification,
  verifyByToken,
  updateRecipient,
  removeRecipient,
  disableByEmail,
  disableById,
  resolveRecipients,
  resolveRecipientEmails,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeById,
};
