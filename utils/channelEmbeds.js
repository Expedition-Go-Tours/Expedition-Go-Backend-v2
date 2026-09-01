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

function salesPaymentFailed({ amount, currency, paymentIntentId, bookingNumber }) {
  return {
    content: `Payment failed for PaymentIntent \`${paymentIntentId || 'unknown'}\``,
    opts: {
      title: 'Payment Failed',
      color: COLORS.red,
      fields: [
        { name: 'Amount', value: money(amount, currency), inline: true },
        { name: 'Booking #', value: bookingNumber ? bookingLink(bookingNumber) : '—', inline: true },
        { name: 'PaymentIntent', value: `\`${paymentIntentId || 'unknown'}\``, inline: true },
      ],
      cooldownKey: paymentIntentId,
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
  money,
  dashboardUrl,
  send,
  // sales
  salesBookingConfirmed,
  salesBookingCancelled,
  salesPaymentFailed,
  salesRefundIssued,
  // verification
  verificationSupplierApplication,
  verificationStatusChange,
  verificationTourSubmitted,
  // approvals
  approvalPayoutRequest,
  approvalPayoutResult,
  approvalRefundRequest,
  approvalRefundResult,
};
