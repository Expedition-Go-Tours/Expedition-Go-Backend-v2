/**
 * Email Deep-Link URLs — single source of truth for every button/link
 * rendered inside transactional emails.
 *
 * Routes are split between the customer storefront (Expedition Go) and the
 * supplier dashboard. Both base URLs are env-driven so local, staging and
 * production resolve correctly without code changes.
 *
 * Google Maps directions links are generated from the resolved pickup or
 * meeting location so "Get directions" works for every booking shape.
 */

const CLIENT_URL = (process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');
const DASHBOARD_URL = (process.env.SUPPLIER_DASHBOARD_URL || process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/$/, '');

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

  // ── Customer (storefront) ─────────────────────────────────────────
  viewBooking: (bookingId) => `${CLIENT_URL}/booking/${bookingId}`,
  downloadVoucher: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/ticket`,
  manageBooking: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/manage`,
  managePaymentMethod: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/payment`,
  addPickupLocation: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/pickup`,
  writeReview: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/review`,
  viewRefund: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/refund`,
  viewCancellation: (bookingId) => `${CLIENT_URL}/booking/${bookingId}/cancellation`,
  browseExperiences: () => `${CLIENT_URL}/tours`,
  contactSupport: () => `${CLIENT_URL}/support`,
  getDirections: (location) => mapsDirectionsUrl(location),

  // ── Supplier (dashboard) ───────────────────────────────────────────
  supplierViewBooking: (bookingId) => `${DASHBOARD_URL}/bookings/${bookingId}`,
  supplierDashboard: () => `${DASHBOARD_URL}/dashboard`,
  supplierEarnings: () => `${DASHBOARD_URL}/earnings`,
  supplierPayouts: () => `${DASHBOARD_URL}/earnings/payouts`,
  supplierBookings: () => `${DASHBOARD_URL}/bookings`,
  supplierReview: (reviewId) => `${DASHBOARD_URL}/reviews/${reviewId}`,
};
