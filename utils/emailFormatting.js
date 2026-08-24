/**
 * Email Formatting Helpers — shared, deterministic formatters used to build
 * template data for every transactional email. Keeping formatting here means
 * every email renders the same date/currency/traveler/pickup shape.
 */

const { travelerCount } = require('./availabilityCore');

const CURRENCY_SYMBOLS = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  ZAR: 'R',
  CAD: '$',
  AUD: '$',
  NZD: '$',
  KES: 'KSh ',
  NGN: '₦',
  GHS: '₵',
  XOF: 'CFA ',
  MAD: 'MAD ',
  EGP: 'E£',
};

/**
 * Format a number as currency for the given code.
 * Falls back to a plain two-decimal number when no symbol is known.
 */
function formatCurrency(amount, currency = 'USD') {
  const value = Number(amount);
  if (!Number.isFinite(value)) return `${currency} 0.00`;
  const symbol = CURRENCY_SYMBOLS[currency] || `${currency} `;
  const negative = value < 0 ? '-' : '';
  const formatted = Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${negative}${symbol}${formatted}`;
}

/**
 * Format a Date as "Monday, August 17, 2026".
 */
function formatLongDate(date, timeZone = 'UTC') {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone,
  });
}

/**
 * Format a Date as "Monday, August 17".
 */
function formatShortDate(date, timeZone = 'UTC') {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone });
}

/**
 * Format a Date + time as "August 17, 2026, 9:00 AM".
 */
function formatDateTime(date, timeZone = 'UTC') {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone });
}

/**
 * Format a booking time string (e.g. "09:00" or "09:00 AM") for emails.
 * Tries to convert 24h "HH:MM" to a friendly "9:00 AM"; passes through
 * anything already readable.
 */
function formatTime(time) {
  if (!time) return '';
  const t = String(time).trim();
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  return t;
}

/**
 * Break down a travelers payload into counts + a human label.
 * Handles object {adults, children, infants}, array-of-details, and the
 * numeric parts of a mixed shape — mirrors formatTravelers in the dashboard.
 *
 * Returns { adults, children, infants, total, label }.
 */
function formatTravelers(travelers) {
  const out = { adults: 0, children: 0, infants: 0, total: 0, label: '' };

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  if (!travelers || typeof travelers !== 'object') {
    out.total = 1;
    out.label = '1 traveler';
    return out;
  }

  const asObj = travelers;

  if (asObj.details && Array.isArray(asObj.details)) {
    for (const d of asObj.details) {
      const group = d?.ageGroup || d?.type;
      if (group === 'adult' || group === 'Adult') out.adults += num(d?.count ?? d?.qty ?? 1);
      else if (group === 'child' || group === 'Child') out.children += num(d?.count ?? d?.qty ?? 1);
      else if (group === 'infant' || group === 'Infant') out.infants += num(d?.count ?? d?.qty ?? 1);
    }
  }

  if (out.adults === 0 && out.children === 0 && out.infants === 0) {
    out.adults = num(asObj.adults);
    out.children = num(asObj.children);
    out.infants = num(asObj.infants);
  }

  if (out.adults === 0 && out.children === 0 && out.infants === 0) {
    out.adults = Math.max(1, travelerCount(travelers));
  }

  out.total = out.adults + out.children + out.infants;
  const parts = [];
  if (out.adults > 0) parts.push(`${out.adults} ${out.adults === 1 ? 'adult' : 'adults'}`);
  if (out.children > 0) parts.push(`${out.children} ${out.children === 1 ? 'child' : 'children'}`);
  if (out.infants > 0) parts.push(`${out.infants} ${out.infants === 1 ? 'infant' : 'infants'}`);
  out.label = parts.length > 0 ? parts.join(', ') : `${out.total} ${out.total === 1 ? 'traveler' : 'travelers'}`;

  return out;
}

/**
 * Extract the customer phone from a travelers payload (phoneNumber field).
 */
function travelerPhone(travelers) {
  return travelers?.phoneNumber || travelers?.phone || '';
}

/**
 * Extract the customer location from a travelers payload.
 */
function travelerLocation(travelers) {
  return travelers?.location || '';
}

/**
 * Resolve pickup/meeting information for a booking.
 *
 * Prefers the customer-selected pickup snapshot stored on the booking; falls
 * back to the tour's static meeting point for legacy bookings.
 *
 * Returns:
 *   {
 *     pickupIncluded: bool,
 *     pickupLocation: string,
 *     pickupTime: string,
 *     pickupInstructions: string,
 *     meetingPoint: string,
 *     meetingTime: string,
 *     meetingInstructions: string,
 *     hasLocation: bool,     // true if any usable location exists
 *     locationLabel: string, // primary "pickup or meeting" label
 *   }
 */
function getPickupInfo(booking, tour = {}) {
  const ticket = tour.bookingAndTickets || {};
  const meeting = ticket.meetingPoint || {};
  const pickup = booking?.pickup || null;
  const pickupLater = !!(pickup && pickup.pickupLater);

  const meetingAddress =
    meeting.address || meeting.name || meeting.place || '';
  const pickupAddress = pickup
    ? pickup.address?.address || pickup.address?.name || pickup.place || pickup.areaName || pickup.locationName || ''
    : '';

  const pickupInstructions = pickup?.instructions || '';
  const pickupTime = pickup?.time ? formatTime(pickup.time) : '';

  return {
    pickupIncluded: !!(pickup && pickupAddress) || pickupLater,
    pickupLocation: pickupAddress,
    pickupTime,
    pickupInstructions,
    pickupLater,
    meetingPoint: meetingAddress,
    meetingTime: ticket.meetingTime ? formatTime(ticket.meetingTime) : '',
    meetingInstructions: meeting.instructions || '',
    hasLocation: !!(pickupAddress || meetingAddress),
    locationLabel: pickupAddress || meetingAddress || '',
  };
}

/**
 * Compute the free-cancellation deadline for a booking based on its tour's
 * cancellation policy. Returns a Date (or null when not refundable / always).
 */
function getCancelDeadline(booking, tour = {}) {
  const policy = tour.bookingAndTickets?.cancellationPolicy;
  if (!policy) {
    const date = new Date(booking?.travelDate);
    if (!Number.isNaN(date.getTime())) {
      return new Date(date.getTime() - 24 * 60 * 60 * 1000);
    }
    return null;
  }
  if (policy.type === 'all_sales_final') return null;
  const windowHours = Number.isFinite(policy.cancellationWindowHours) ? policy.cancellationWindowHours : 24;
  const date = new Date(booking?.travelDate);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getTime() - windowHours * 60 * 60 * 1000);
}

/**
 * Human label for tour duration. Reads categorization.durationMinutes first,
 * then the categorization.duration string.
 */
function getDurationLabel(tour = {}) {
  const categorization = tour.categorization || {};
  const minutes = Number(tour.durationMinutes ?? categorization.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    if (minutes >= 1440) {
      const days = minutes / 1440;
      return `${days} ${days === 1 ? 'day' : 'days'}`;
    }
    if (minutes >= 60) {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return m > 0 ? `${h}h ${m}m` : `${h} hour${h === 1 ? '' : 's'}`;
    }
    return `${minutes} min`;
  }
  if (typeof categorization.duration === 'string') return categorization.duration;
  return '';
}

/**
 * Human label for the tour language. Falls back to "English".
 */
function getLanguageLabel(tour = {}) {
  const ticket = tour.bookingAndTickets || {};
  const language = ticket.language || ticket.languages || tour.categorization?.language;
  if (Array.isArray(language)) return language[0] || 'English';
  return language || 'English';
}

/**
 * "Private" vs "Shared" from the tour's bookingAndTickets.
 */
function getBookingTypeLabel(tour = {}) {
  const ticket = tour.bookingAndTickets || {};
  if (ticket.privateTour === true) return 'Private';
  if (ticket.privateTour === false) return 'Shared';
  return ticket.bookingType || 'Shared';
}

/**
 * Derive "Card ending in 1234" from a Stripe payment method object or raw
 * card string. Returns '' when nothing usable is present.
 */
function formatCardLast4(paymentMethod) {
  if (!paymentMethod) return '';
  if (typeof paymentMethod === 'string') {
    const m = paymentMethod.match(/(\d{4})\s*$/);
    return m ? m[1] : paymentMethod;
  }
  const card = paymentMethod.card;
  if (card?.last4) return card.last4;
  if (card?.last_digits) return card.last_digits;
  if (card?.number && typeof card.number === 'string') {
    const m = card.number.match(/(\d{4})\s*$/);
    if (m) return m[1];
  }
  return '';
}

module.exports = {
  formatCurrency,
  formatLongDate,
  formatShortDate,
  formatDateTime,
  formatTime,
  formatTravelers,
  travelerPhone,
  travelerLocation,
  getPickupInfo,
  getCancelDeadline,
  getDurationLabel,
  getLanguageLabel,
  getBookingTypeLabel,
  formatCardLast4,
};
