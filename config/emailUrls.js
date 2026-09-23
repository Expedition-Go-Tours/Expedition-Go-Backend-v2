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

const { normalizeOrigin, getAllowedClientOrigins } = require('../src/core/services/clientOrigin');

const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
const DASHBOARD_URL = (process.env.SUPPLIER_DASHBOARD_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
// Ghana suppliers sign in on a separate dashboard from the TravioAfrica one.
const GHANA_DASHBOARD_URL = (process.env.GHANA_SUPPLIER_DASHBOARD_URL || 'https://supplier.travioghana.com').replace(/\/$/, '');
// Public API origin — used for links that must work without a dashboard login
// (e.g. confirming a notification email address).
const API_URL = (process.env.API_URL || 'http://localhost:5000').replace(/\/$/, '');
// Admin apps origin — deep links from ops emails into the cancellation queue.
// ADMIN_URL wins; ADMIN_DASHBOARD_URL is the origin already configured on the
// production server, so ops emails deep-link correctly without new config.
const ADMIN_URL = (process.env.ADMIN_URL || process.env.ADMIN_DASHBOARD_URL || API_URL).replace(/\/$/, '');
// Ghana runs its own admin app; Ghana-scoped requests must link there.
const GHANA_ADMIN_URL = (process.env.GHANA_ADMIN_DASHBOARD_URL || ADMIN_URL).replace(/\/$/, '');

function adminBaseForRoles(roles) {
  return Array.isArray(roles) && roles.includes('ghana') ? GHANA_ADMIN_URL : ADMIN_URL;
}

/**
 * Resolve the supplier dashboard base URL for a user. Suppliers with the
 * `ghana` role use the Ghana dashboard; everyone else uses the default one.
 * Accepts a plain user object (with `roles`) or a `{ supplier }` wrapper.
 */
function dashboardBaseForUser(user) {
  const rec = user && user.supplier ? user.supplier : user;
  const roles = Array.isArray(rec?.roles) ? rec.roles : [];
  return roles.includes('ghana') ? GHANA_DASHBOARD_URL : DASHBOARD_URL;
}

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
  // Review goes through the guided /review/:tourSlug flow on every storefront.
  // The link carries bookingId (+tourId) as query params so a cold open can
  // still enable submission and, on legacy, self-resolve the booking.
  writeReview: (bookingId, origin, tourSlug, tourId) => {
    const base = baseUrl(origin);
    const params = new URLSearchParams();
    params.set('bookingId', bookingId);
    if (tourId) params.set('tourId', tourId);
    const slug = tourSlug || tourId || bookingId;
    return `${base}/review/${encodeURIComponent(slug)}?${params.toString()}`;
  },
  viewRefund: (bookingId, origin) => brandPath(origin, 'refund', bookingId),
  viewCancellation: (bookingId, origin) => brandPath(origin, 'cancel', bookingId),
  // Reschedule-or-refund decision page (signed token, no login required).
  cancellationChoice: (token, origin) =>
    `${baseUrl(origin)}/cancellation-choice?token=${encodeURIComponent(token)}`,
  browseExperiences: (origin) => `${baseUrl(origin)}/tours`,
  contactSupport: (origin) => brandPath(origin, 'support'),
  getDirections: (location) => mapsDirectionsUrl(location),

  // ── Supplier (dashboard) ───────────────────────────────────────────
  supplierViewBooking: (bookingId) => `${DASHBOARD_URL}/bookings/${bookingId}`,
  supplierDashboard: () => `${DASHBOARD_URL}/dashboard`,
  supplierEarnings: () => `${DASHBOARD_URL}/earnings`,
  supplierPayouts: () => `${DASHBOARD_URL}/earnings/payouts`,
  supplierBookings: () => `${DASHBOARD_URL}/bookings`,
  supplierProducts: () => `${DASHBOARD_URL}/products`,
  supplierProduct: (tourId) => `${DASHBOARD_URL}/products/build/${encodeURIComponent(tourId)}/type`,
  // Brand-aware variants — route Ghana suppliers to the Ghana dashboard.
  supplierProductsForUser: (user) => `${dashboardBaseForUser(user)}/products`,
  supplierProductForUser: (tourId, user) => `${dashboardBaseForUser(user)}/products/build/${encodeURIComponent(tourId)}/type`,
  supplierReview: (reviewId) => `${DASHBOARD_URL}/reviews?reviewId=${encodeURIComponent(reviewId)}`,
  supplierReplyReview: (reviewId) => `${DASHBOARD_URL}/reviews?reviewId=${encodeURIComponent(reviewId)}&reply=1`,
  // Brand-aware bookings link (Ghana suppliers → Ghana dashboard).
  supplierBookingsForUser: (user) => `${dashboardBaseForUser(user)}/bookings`,
  // Brand-aware home/earnings/review links — the bare variants above always
  // point at the TravioAfrica dashboard, which is the wrong home for Ghana
  // suppliers opening a branded email.
  supplierDashboardForUser: (user) => `${dashboardBaseForUser(user)}/dashboard`,
  supplierEarningsForUser: (user) => `${dashboardBaseForUser(user)}/earnings`,
  supplierReviewForUser: (reviewId, user) =>
    `${dashboardBaseForUser(user)}/reviews?reviewId=${encodeURIComponent(reviewId)}`,
  supplierReplyReviewForUser: (reviewId, user) =>
    `${dashboardBaseForUser(user)}/reviews?reviewId=${encodeURIComponent(reviewId)}&reply=1`,
  // Raw helper — used by chat deep-links and team-invite URLs too.
  dashboardBaseForUser,

  // ── Supplier notification recipients ───────────────────────────────
  // Confirm/unsubscribe links must resolve without a dashboard session, so
  // they point at the API and redirect back to the dashboard afterwards.
  supplierNotificationRecipientVerify: (token) =>
    `${API_URL}/api/suppliers/settings/notification-recipients/verify?token=${encodeURIComponent(token)}`,
  supplierNotificationRecipientUnsubscribe: (id, token) =>
    `${API_URL}/api/suppliers/settings/notification-recipients/unsubscribe?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
  // Branded links (preferred): the recipient opens a link on the brand's own
  // dashboard domain, which proxies to the API result page. Keeps the email
  // link on a domain the recipient recognises.
  supplierNotificationRecipientVerifyForUser: (user, token) =>
    `${dashboardBaseForUser(user)}/confirm/${encodeURIComponent(token)}`,
  supplierNotificationRecipientUnsubscribeForUser: (user, id, token) =>
    `${dashboardBaseForUser(user)}/unsubscribe/${encodeURIComponent(id)}/${encodeURIComponent(token)}`,
  supplierNotificationSettings: (user) => `${dashboardBaseForUser(user)}/settings?tab=notifications`,

  // ── Admin (ops) — approval queue deep link ─────────────────────────────
  // `roles` (the requesting supplier's roles) routes Ghana requests to the
  // Ghana admin app; everything else uses the main admin origin.
  adminCancellationRequests: (requestId, roles) =>
    `${adminBaseForRoles(roles)}/cancellations${requestId ? `?request=${encodeURIComponent(requestId)}` : ''}`,
  adminBooking: (bookingId, roles) =>
    `${adminBaseForRoles(roles)}/bookings?booking=${encodeURIComponent(bookingId)}`,
};
