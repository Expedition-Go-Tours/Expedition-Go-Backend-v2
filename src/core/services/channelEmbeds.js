/**
 * Centralized rich embed builders for the ops Discord channels
 * (sales / verification / approvals).
 *
 * Keeps embed structure consistent and testable — the same pattern as
 * scripts/deployNotify.js. Controllers call these helpers instead of
 * hand-building inline embeds.
 *
 * All builders return the same shape discordNotifier.notifyDiscord accepts:
 *   { content, opts }  where opts = { title, color, url, fields, cooldownKey, components }
 *
 * @version 1.0.0
 */

const { notifyDiscord } = require('./discordNotifier');

const COLORS = {
  green: 0x00c853,
  amber: 0xffaa00,
  red: 0xff4444,
  blue: 0x3498db,
  orange: 0xffa500,
};

function dashboardUrl(path) {
  const base = process.env.ADMIN_DASHBOARD_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}/${path}`;
}

function money(value, currency = 'USD') {
  return `${currency || 'USD'} ${Number(value || 0).toFixed(2)}`;
}

function bookingLink(bookingNumber) {
  return bookingNumber ? `\`${bookingNumber}\`` : '—';
}

// ── Sales channel ─────────────────────────────────────────────────

function salesBookingConfirmed(booking) {
  const fields = [
    { name: 'Tour', value: booking?.tour?.title || 'Unknown tour', inline: true },
    { name: 'Amount', value: money(booking?.grossAmount, booking?.currency), inline: true },
    { name: 'Commission', value: money(booking?.platformCommission, booking?.currency), inline: true },
    { name: 'Customer', value: booking?.customer?.name || booking?.leadTravelerName || '—', inline: true },
    { name: 'Booking #', value: bookingLink(booking?.bookingNumber), inline: true },
    { name: 'Source', value: booking?.source || 'N/A', inline: true },
  ];
  return {
    content: `Booking ${bookingLink(booking?.bookingNumber)} confirmed`,
    opts: {
      title: 'New Booking Confirmed',
      color: COLORS.green,
      fields,
      cooldownKey: booking?.id,
      timestamp: booking?.paidAt || new Date().toISOString(),
    },
  };
}

function salesBookingCancelled({ bookingNumber, tour, amount, currency, reason }) {
  return {
    content: `Booking ${bookingLink(bookingNumber)} cancelled`,
    opts: {
      title: 'Booking Cancelled',
      color: COLORS.red,
      fields: [
        { name: 'Tour', value: tour || '—', inline: true },
        { name: 'Amount', value: money(amount, currency), inline: true },
        { name: 'Reason', value: reason || '—', inline: false },
      ],
      cooldownKey: bookingNumber || `${tour}-${amount}`,
    },
  };
}

/**
 * Human-readable decline reason for a failed payment.
 *
 * `payment_intent.last_payment_error` usually only carries the generic code
 * ("payment_intent_payment_attempt_failed"), which tells nobody anything — the
 * merchant-facing detail (issuer_declined / generic_decline plus the bank's own
 * message) lives on the Charge's `outcome`. Callers pass whichever they have;
 * a charge outcome always wins because it is strictly more specific.
 */
function formatDeclineReason(error = {}, outcome = {}) {
  const label = [outcome.type, outcome.reason].filter(Boolean).join(' / ');
  if (label) return outcome.seller_message ? `${label} — ${outcome.seller_message}` : label;
  return error.decline_code || error.code || error.message || null;
}

function salesPaymentFailed({ amount, currency, paymentIntentId, bookingNumber, email, reason, recoverable }) {
  const fields = [
    { name: 'Amount', value: money(amount, currency), inline: true },
    { name: 'Booking #', value: bookingNumber ? bookingLink(bookingNumber) : '—', inline: true },
    { name: 'PaymentIntent', value: `\`${paymentIntentId || 'unknown'}\``, inline: true },
  ];
  if (email) fields.push({ name: 'Customer', value: email, inline: true });
  fields.push({ name: 'Reason', value: reason || '—', inline: false });
  // A decline the customer can retry (issuer decline, 3-D Secure) is NOT final —
  // say so, otherwise a retry that succeeds minutes later makes this look wrong.
  if (recoverable) {
    fields.push({
      name: 'Status',
      value: 'Declined on this attempt — the customer can retry. A recovery notice is posted if the retry succeeds.',
      inline: false,
    });
  }
  return {
    content: `Payment failed for PaymentIntent \`${paymentIntentId || 'unknown'}\``,
    opts: {
      title: recoverable ? 'Payment Declined (retryable)' : 'Payment Failed',
      color: COLORS.red,
      fields,
      cooldownKey: paymentIntentId,
    },
  };
}

/**
 * Posted when a PaymentIntent that previously failed is later paid — e.g. the
 * customer completed a 3-D Secure challenge and retried. Balances the earlier
 * "declined" alert so the channel reflects the final state.
 */
function salesPaymentRecovered({ amount, currency, paymentIntentId, email }) {
  return {
    content: `✅ Payment recovered for PaymentIntent \`${paymentIntentId || 'unknown'}\``,
    opts: {
      title: 'Payment Recovered',
      color: COLORS.green,
      fields: [
        { name: 'Amount', value: money(amount, currency), inline: true },
        { name: 'PaymentIntent', value: `\`${paymentIntentId || 'unknown'}\``, inline: true },
        ...(email ? [{ name: 'Customer', value: email, inline: true }] : []),
        { name: 'Note', value: 'Earlier decline was followed by a successful retry.', inline: false },
      ],
      cooldownKey: `recovered:${paymentIntentId}`,
    },
  };
}

function salesRefundIssued({ amount, currency, chargeId, bookingNumber }) {
  return {
    content: `Refund issued for Charge \`${chargeId || 'unknown'}\``,
    opts: {
      title: 'Refund Issued',
      color: COLORS.amber,
      fields: [
        { name: 'Amount Refunded', value: money(amount, currency), inline: true },
        { name: 'Booking #', value: bookingNumber ? bookingLink(bookingNumber) : '—', inline: true },
        { name: 'Charge', value: `\`${chargeId || 'unknown'}\``, inline: true },
      ],
      cooldownKey: chargeId,
    },
  };
}

// ── Verification channel ───────────────────────────────────────────

function verificationSupplierApplication({ user, supplierId, supplierType }) {
  const url = dashboardUrl(`suppliers/${supplierId}`);
  return {
    content: 'New supplier application submitted.',
    opts: {
      title: 'New Supplier Application',
      color: COLORS.blue,
      url: url || undefined,
      fields: [
        { name: 'Applicant', value: `${user?.name || 'Unknown'} (${user?.email || supplierId})`, inline: true },
        { name: 'Type', value: supplierType || 'Not specified', inline: true },
        ...(url ? [{ name: 'Review', value: `[Open Dashboard](${url})`, inline: false }] : []),
      ],
      cooldownKey: supplierId,
    },
  };
}

function verificationStatusChange({ supplierName, from, to, supplierId }) {
  const url = dashboardUrl(`suppliers/${supplierId}`);
  return {
    content: `${supplierName || 'Supplier'} status changed: \`${from}\` → \`${to}\``,
    opts: {
      title: 'Supplier Status Change',
      color: COLORS.blue,
      url: url || undefined,
      fields: [
        { name: 'Supplier', value: supplierName || '—', inline: true },
        { name: 'From', value: from || '—', inline: true },
        { name: 'To', value: to || '—', inline: true },
      ],
      cooldownKey: supplierId || `${supplierName}-${to}`,
    },
  };
}

function verificationTourSubmitted({ tourTitle, tourId, supplierName }) {
  const url = dashboardUrl(`tours/${tourId}`);
  return {
    content: `${tourTitle || 'A tour'} submitted for review.`,
    opts: {
      title: 'Tour Submitted for Review',
      color: COLORS.blue,
      url: url || undefined,
      fields: [
        { name: 'Tour', value: tourTitle || '—', inline: true },
        { name: 'Supplier', value: supplierName || '—', inline: true },
        ...(url ? [{ name: 'Review', value: `[Open Dashboard](${url})`, inline: false }] : []),
      ],
      cooldownKey: tourId,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `tour:approve:${tourId}` },
            { type: 2, style: 4, label: 'Reject', custom_id: `tour:reject:${tourId}` },
          ],
        },
      ],
    },
  };
}

// Friendly section names for diff paths (first path segment → label).
const SECTION_LABELS = {
  productContent: 'Content',
  bookingAndTickets: 'Booking & tickets',
  schedulesAndPricing: 'Pricing & availability',
  categorization: 'Categorization',
  photos: 'Photos',
  title: 'Title',
  description: 'Description',
  tags: 'Tags',
  metaTitle: 'Meta title',
  metaDescription: 'Meta description',
  coverPhoto: 'Cover photo',
};

function prettyChangePath(path) {
  const raw = String(path || '');
  const [head, ...rest] = raw.split('.');
  const label = SECTION_LABELS[head] || (head ? head.charAt(0).toUpperCase() + head.slice(1) : 'Field');
  return rest.length ? `${label} › ${rest.join('.')}` : label;
}

function clipValue(value, max = 80) {
  const s = value === undefined || value === null || value === '' ? '—' : String(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Render the raw diff as readable "field: old → new" lines, within Discord's
// 1024-char field limit.
function formatChangeLines(changes, { maxLines = 12, maxChars = 1000 } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const lines = [];
  for (const c of changes) {
    const label = prettyChangePath(c.path);
    if (c.kind === 'added') lines.push(`• ${label}: added “${clipValue(c.after)}”`);
    else if (c.kind === 'removed') lines.push(`• ${label}: removed “${clipValue(c.before)}”`);
    else lines.push(`• ${label}: “${clipValue(c.before)}” → “${clipValue(c.after)}”`);
    if (lines.length >= maxLines) break;
  }
  const remaining = changes.length - Math.min(changes.length, maxLines);
  if (remaining > 0) lines.push(`…and ${remaining} more`);
  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}

function verificationTourUpdateSubmitted({ tourTitle, tourId, supplierName, changesSummary, isResubmission, changes }) {
  const url = dashboardUrl(`tours/${tourId}`);
  const resubmit = isResubmission ? ' (resubmission)' : '';
  // Prefer the concrete diff; fall back to the section summary.
  let changesText = formatChangeLines(changes);
  if (!changesText) {
    changesText = '—';
    if (changesSummary && typeof changesSummary === 'object' && changesSummary.count != null) {
      const sectionNames = (changesSummary.sections || []).map(s => s.section).join(', ');
      changesText = `${changesSummary.count} change${changesSummary.count === 1 ? '' : 's'} across ${sectionNames || 'multiple fields'}`;
    }
  }
  return {
    content: `${tourTitle || 'A tour'} has a pending update submitted for review${resubmit}.`,
    opts: {
      title: isResubmission ? 'Tour Update (Resubmission)' : 'Tour Update Pending Approval',
      color: COLORS.blue,
      url: url || undefined,
      fields: [
        { name: 'Tour', value: tourTitle || '—', inline: true },
        { name: 'Supplier', value: supplierName || '—', inline: true },
        { name: 'Changes', value: changesText, inline: false },
        ...(url ? [{ name: 'Review', value: `[Open Dashboard](${url})`, inline: false }] : []),
      ],
      cooldownKey: tourId,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `tour:approve:${tourId}` },
            { type: 2, style: 4, label: 'Reject', custom_id: `tour:reject:${tourId}` },
          ],
        },
      ],
    },
  };
}

function verificationTourResult({ tourTitle, tourId, action }) {
  const approved = action === 'approve';
  return {
    content: `Tour update for "${tourTitle || 'unknown'}" ${approved ? 'approved' : 'rejected'}.`,
    opts: {
      title: approved ? 'Tour Update Approved' : 'Tour Update Rejected',
      color: approved ? COLORS.green : COLORS.red,
      fields: [
        { name: 'Tour', value: tourTitle || '—', inline: true },
      ],
      cooldownKey: tourId,
    },
  };
}

// ── Approvals channel ──────────────────────────────────────────────

function approvalPayoutRequest({ requestNumber, amount, currency, bookingCount, requestId }) {
  return {
    content: `Payout request ${requestNumber} awaiting approval.`,
    opts: {
      title: 'Payout Approval Needed',
      color: COLORS.amber,
      fields: [
        { name: 'Request #', value: requestNumber, inline: true },
        { name: 'Amount', value: money(amount, currency), inline: true },
        { name: 'Bookings', value: String(bookingCount || 0), inline: true },
      ],
      cooldownKey: requestId,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve', custom_id: `pv:approve:${requestId}` },
            { type: 2, style: 4, label: 'Reject', custom_id: `pv:reject:${requestId}` },
          ],
        },
      ],
    },
  };
}

function approvalPayoutResult({ requestNumber, amount, currency, action }) {
  const approved = action === 'approved';
  return {
    content: `Payout request ${requestNumber} ${approved ? 'approved' : 'rejected'}.`,
    opts: {
      title: approved ? 'Payout Approved' : 'Payout Rejected',
      color: approved ? COLORS.green : COLORS.red,
      fields: [
        { name: 'Request #', value: requestNumber, inline: true },
        { name: 'Amount', value: money(amount, currency), inline: true },
      ],
      cooldownKey: requestNumber,
    },
  };
}

function approvalRefundRequest({ disputeNumber, tour, amount, currency, reason, bookingNumber, disputeId, description }) {
  const url = dashboardUrl(`disputes/${disputeId}`);
  const reasonLabel = (reason || '').replace(/_/g, ' ');
  return {
    content: `Refund request ${disputeNumber} for "${tour}"`,
    opts: {
      title: 'Refund Request Opened',
      color: COLORS.amber,
      url: url || undefined,
      fields: [
        { name: 'Request #', value: disputeNumber, inline: true },
        { name: 'Amount', value: money(amount, currency), inline: true },
        { name: 'Reason', value: reasonLabel, inline: true },
        { name: 'Booking #', value: bookingLink(bookingNumber), inline: true },
        { name: 'Tour', value: tour, inline: true },
        ...(description ? [{ name: 'Details', value: description.slice(0, 1024), inline: false }] : []),
      ],
      cooldownKey: disputeId,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Approve Refund', custom_id: `dsp:approve:${disputeId}` },
            { type: 2, style: 4, label: 'Deny', custom_id: `dsp:deny:${disputeId}` },
          ],
        },
      ],
    },
  };
}

function approvalRefundResult({ disputeNumber, outcome, amount, currency }) {
  const approved = outcome === 'CUSTOMER';
  return {
    content: `Refund request ${disputeNumber} ${approved ? 'approved' : 'denied'}.`,
    opts: {
      title: approved ? 'Refund Approved' : 'Refund Denied',
      color: approved ? COLORS.green : COLORS.red,
      fields: [
        { name: 'Request #', value: disputeNumber, inline: true },
        { name: 'Amount', value: money(amount, currency), inline: true },
      ],
      cooldownKey: disputeNumber,
    },
  };
}

/**
 * Send a builder's payload to a Discord channel (fire-and-forget).
 */
function send(builder, channelOverride) {
  const { content, opts } = builder;
  return notifyDiscord(channelOverride || opts._channel || 'default', content, opts);
}

module.exports = {
  COLORS,
  formatDeclineReason,
  money,
  dashboardUrl,
  send,
  // sales
  salesBookingConfirmed,
  salesBookingCancelled,
  salesPaymentFailed,
  salesPaymentRecovered,
  salesRefundIssued,
  // verification
  verificationSupplierApplication,
  verificationStatusChange,
  verificationTourSubmitted,
  verificationTourUpdateSubmitted,
  verificationTourResult,
  // approvals
  approvalPayoutRequest,
  approvalPayoutResult,
  approvalRefundRequest,
  approvalRefundResult,
};
