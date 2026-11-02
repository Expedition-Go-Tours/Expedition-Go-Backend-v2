/**
 * Field-level access for supplier responses.
 *
 * Hiding a card in React is not access control. These helpers strip money and
 * customer contact from the payload itself, after the full row is loaded and
 * before it leaves the server. Owners always pass every check.
 */

const { hasPermissionInSet } = require('../../../config/permissions');

function can(req, permission) {
  return hasPermissionInSet(req?.teamPermissions || [], permission);
}

function canAny(req, permissions) {
  return permissions.some((permission) => can(req, permission));
}

const MONEY_FIELDS = [
  'subtotal',
  'taxes',
  'fees',
  'discounts',
  'grossAmount',
  'supplierPayout',
  'platformCommission',
  'commissionRate',
  'commissionAmount',
  'payouts',
  'payoutStatus',
  'payoutRequestItems',
  'refundAmount',
  'refundedAmount',
  'appliedOffer',
  'offerDiscountFix',
  'offerDiscountPct',
  'offerDiscountType',
];

function stripBookingMoney(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  for (const key of MONEY_FIELDS) delete booking[key];
  return booking;
}

function stripBookingContact(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  if (booking.customer) {
    delete booking.customer.email;
    delete booking.customer.phone;
  }
  if (booking.guest) {
    delete booking.guest.email;
    delete booking.guest.phone;
  }
  delete booking.leadTravelerEmail;
  delete booking.leadTravelerPhone;
  delete booking.contactEmail;
  delete booking.contactPhone;
  if (booking.travelers && typeof booking.travelers === 'object') {
    delete booking.travelers.phoneNumber;
    delete booking.travelers.phone;
    delete booking.travelers.location;
  }
  if (booking.pickup && typeof booking.pickup === 'object') {
    delete booking.pickup.phone;
    delete booking.pickup.phoneNumber;
    delete booking.pickup.address;
    delete booking.pickup.location;
    delete booking.pickup.lat;
    delete booking.pickup.lng;
  }
  return booking;
}

function cloneBooking(booking) {
  if (!booking || typeof booking !== 'object') return booking;
  return {
    ...booking,
    ...(booking.customer ? { customer: { ...booking.customer } } : {}),
    ...(booking.guest ? { guest: { ...booking.guest } } : {}),
    ...(booking.travelers && typeof booking.travelers === 'object'
      ? { travelers: { ...booking.travelers } }
      : {}),
    ...(booking.pickup && typeof booking.pickup === 'object'
      ? { pickup: { ...booking.pickup } }
      : {}),
  };
}

function scopeBooking(req, booking, { contactPermission = 'bookings.contact.view' } = {}) {
  const next = cloneBooking(booking);
  if (!can(req, 'bookings.revenue.view') && !can(req, 'earnings.view')) stripBookingMoney(next);
  if (!can(req, contactPermission)) stripBookingContact(next);
  return next;
}

function scopeBookings(req, bookings) {
  return Array.isArray(bookings) ? bookings.map((booking) => scopeBooking(req, booking)) : bookings;
}

function scopeDashboard(req, data) {
  if (!data) return data;
  const next = JSON.parse(JSON.stringify(data));
  if (!can(req, 'bookings.view')) delete next.bookings;
  if (!can(req, 'tours.view')) delete next.tours;
  if (!can(req, 'reviews.view')) delete next.reviews;
  if (!canAny(req, ['earnings.view', 'finance.view'])) {
    delete next.earnings;
    if (Array.isArray(next.topProducts)) {
      next.topProducts = next.topProducts.map(({ revenue, totalRevenue, ...rest }) => rest);
    }
  }
  return next;
}

function scopeSettings(req, supplier) {
  if (!supplier) return supplier;
  const next = JSON.parse(JSON.stringify(supplier));
  const profile = next.supplierProfile;
  if (profile) {
    if (!canAny(req, ['earnings.view', 'finance.view'])) {
      delete profile.totalEarnings;
      delete profile.payoutInfo;
    }
    if (!can(req, 'bookings.view')) delete profile.totalBookings;
    if (!canAny(req, ['verification.view', 'settings.tax'])) delete profile.representativeInfo;
  }
  if (!can(req, 'settings.notifications')) delete next.notificationPreferences;
  return next;
}

module.exports = {
  can,
  canAny,
  stripBookingMoney,
  stripBookingContact,
  scopeBooking,
  scopeBookings,
  scopeDashboard,
  scopeSettings,
};
