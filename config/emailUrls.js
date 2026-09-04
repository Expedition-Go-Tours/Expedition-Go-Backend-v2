/**
 * Email Deep-Link URLs — single source of truth for every button/link
 * rendered inside transactional emails.
 *
 * The same backend powers two branded storefronts with different layouts:
 *  - Legacy storefront (CLIENT_URL, e.g. https://travioafrica.com) uses the
 *    /booking/:id/... deep-link pages.
 *  - Expedition storefront (any other allow-listed origin) manages bookings in
 *    the authed dashboard (/dashboard/bookings?booking=:id) and a /review
 *    flow; there is no standalone ticket/voucher page yet.
 *
 * Customer links are built for the exact origin the customer booked on
 * (stored on the booking and allow-listed). Unknown/missing origins fall back
 * to CLIENT_URL + the legacy route shape, so behaviour is unchanged for
 * bookings that predate origin tracking.
 */

const { normalizeOrigin, getAllowedClientOrigins } = require('../utils/clientOrigin');

const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
const DASHBOARD_URL = (process.env.SUPPLIER_DASHBOARD_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

function baseUrl(origin) {
  return String(origin || CLIENT_URL).replace(/\/$/, '');
}

function isLegacy(origin) {
  return origin === CLIENT_URL;
}

function qBooking(id) {
  return `/dashboard/bookings?booking=${encodeURIComponent(id)}`;
}

// Route shapes per platform. Legacy deep links live on the old storefront;
// the Expedition storefront routes booking management through its dashboard.
const LEGACY_PATHS = {
  view: (id) => `/booking/${id}`,
  voucher: (id) => `/booking/${id}/ticket`,
  manage: (id) => `/booking/${id}/manage`,
  payment: (id) => `/booking/${id}/payment`,
  pickup: (id) => `/booking/${id}/pickup`,
  refund: (id) => `/booking/${id}/refund`,
  cancel: (id) => `/booking/${id}/cancellation`,
  support: () => `/support`,
};

const EXPEDITION_PATHS = {
  view: (id) => qBooking(id),
  voucher: (id) => qBooking(id),
  manage: (id) => qBooking(id),
  payment: (id) => qBooking(id),
  pickup: (id) => `/booking/${id}/pickup`,
  refund: (id) => qBooking(id),
  cancel: (id) => qBooking(id),
  support: () => `/help-centre`,
};

function brandPath(origin, kind, id) {
  const table = isLegacy(origin) ? LEGACY_PATHS : EXPEDITION_PATHS;
  return `${baseUrl(origin)}${table[kind](id)}`;
}

/**
 * Resolve the allow-listed storefront origin a booking was made on. Accepts a
 * booking row directly or a `{ booking }` wrapper. Falls back to CLIENT_URL
 * when there is no stored origin or it is not in the allow-list.
 */
function bookingClientOrigin(booking) {
  const rec = booking && booking.booking ? booking.booking : booking;
  const stored = rec && rec.clientOrigin ? normalizeOrigin(String(rec.clientOrigin)) : null;
  if (stored && getAllowedClientOrigins().has(stored)) return stored;
  return CLIENT_URL;
}

function mapsDirectionsUrl(location) {
  if (!location) return null;
  const address =
    (typeof location === 'string' && location) ||
    location.address ||
    location.name ||
    location.place ||
    location.areaName ||
    location.locationName ||
    '';
  if (!address.trim()) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`;
}

module.exports = {
  CLIENT_URL,
  DASHBOARD_URL,
  bookingClientOrigin,

  // ── Customer (storefront) — origin = allow-listed booking frontend ──────
  viewBooking: (bookingId, origin) => brandPath(origin, 'view', bookingId),
  downloadVoucher: (bookingId, origin) => brandPath(origin, 'voucher', bookingId),
  manageBooking: (bookingId, origin) => brandPath(origin, 'manage', bookingId),
  managePaymentMethod: (bookingId, origin) => brandPath(origin, 'payment', bookingId),
  addPickupLocation: (bookingId, origin) => brandPath(origin, 'pickup', bookingId),
  // Review goes through the guided /review/:tourSlug flow on Expedition (there
  // is no /booking/:id/review page there); legacy keeps its deep link.
  writeReview: (bookingId, origin, tourSlug) => {
    const base = baseUrl(origin);
    if (isLegacy(origin)) return `${base}/booking/${bookingId}/review`;
    const slug = tourSlug ? encodeURIComponent(tourSlug) : bookingId;
    return `${base}/review/${slug}`;
  },
  viewRefund: (bookingId, origin) => brandPath(origin, 'refund', bookingId),
  viewCancellation: (bookingId, origin) => brandPath(origin, 'cancel', bookingId),
  browseExperiences: (origin) => `${baseUrl(origin)}/tours`,
  contactSupport: (origin) => brandPath(origin, 'support'),
  getDirections: (location) => mapsDirectionsUrl(location),

  // ── Supplier (dashboard) ───────────────────────────────────────────
  supplierViewBooking: (bookingId) => `${DASHBOARD_URL}/bookings/${bookingId}`,
  supplierDashboard: () => `${DASHBOARD_URL}/dashboard`,
  supplierEarnings: () => `${DASHBOARD_URL}/earnings`,
  supplierPayouts: () => `${DASHBOARD_URL}/earnings/payouts`,
  supplierBookings: () => `${DASHBOARD_URL}/bookings`,
  supplierReview: (reviewId) => `${DASHBOARD_URL}/reviews/${reviewId}`,
};
