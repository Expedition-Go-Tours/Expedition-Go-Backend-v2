/**
 * Admin activity feed.
 *
 * A single, brand-scoped read model for the dashboard's "Recent Activity"
 * card. It deliberately combines three kinds of signal:
 *
 *   1. Customer commerce (bookings, reviews, wishlists, refunds, payouts)
 *      read from the source-of-truth tables. These rows survive missing or
 *      legacy analytics instrumentation.
 *   2. Storefront behaviour (checkout started, search, newsletter, contact)
 *      read from the branded Event stream.
 *   3. Operator actions (tour/supplier/settings/team/payout) read from the
 *      audit trail.
 *
 * It is NOT the compliance audit log. Customer logins, API errors and
 * security events stay on /admin/activity-log.
 *
 * The feed is brand-scoped by relation for commerce rows and by the `brand`
 * column (with a name-prefix fallback for legacy events) for behavioural rows.
 * Every source is window-bounded and cursor-paginated, and the merged list is
 * capped before it leaves the service.
 */

const prisma = require('./prismaClient');
const { getBrand } = require('../../../config/brands');
const { buildAuditMessage } = require('../domain/adminController');

const BRAND = getBrand('ghana');
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const BOOKING_BRAND_WHERE = {
  isSimulated: false,
  OR: [
    { source: BRAND.source },
    { tour: { supplier: { roles: { has: BRAND.role } } } },
  ],
};

const TOUR_BRAND_WHERE = { tour: { supplier: { roles: { has: BRAND.role } } } };

const EVENT_BRAND_WHERE = {
  OR: [
    { brand: BRAND.key },
    // Legacy rows predate the brand column. Storefront events were namespaced
    // with `ghana.` even before the column existed. Expedition is Ghana's
    // sub-store, so its events belong on the Ghana feed too.
    { name: { startsWith: `${BRAND.key}.` } },
    { name: { startsWith: 'expedition.' } },
  ],
};

// Behavioural events that belong in the card. Tour views are deliberately
// excluded; a page view firehose is not an activity feed. Views are available
// as aggregates on the tour performance pages.
const FEED_EVENT_NAMES = [
  `${BRAND.key}.checkout_started`,
  `${BRAND.key}.newsletter_subscribed`,
  `${BRAND.key}.contact_submitted`,
  'expedition.checkout_started',
  'expedition.newsletter_subscribed',
  'expedition.contact_submitted',
  'search.executed',
];

// Operator actions only. Customer actions are derived from the domain tables
// above, so they are never duplicated here, and login/API-error noise is kept
// out of the dashboard card.
const AUDIT_ACTIONS = [
  'tour.created',
  'tour.updated',
  'tour.deleted',
  'tour.seeded',
  'tour.submitted_for_review',
  'tour.edit_submitted_for_review',
  'tour.withdrawn_from_review',
  'tour.draft_saved',
  'booking.status_updated',
  'review.approve',
  'review.reject',
  'review.flag',
  'review.admin_updated',
  'review.admin_deleted',
  'review.admin_response_updated',
  'review.admin_response_deleted',
  'review.response_added',
  'review.response_updated',
  'review.response_deleted',
  'payout.approved',
  'payout.released',
  'payout.failed',
  'payout_method.added',
  'payout_method.updated',
  'payout_method.deleted',
  'payout_method.verified',
  'payout_method.unverified',
  'supplier.applied',
  'supplier.approve',
  'supplier.reject',
  'supplier.suspended',
  'supplier.reactivated',
  'supplier.activated',
  'special-offer.created',
  'special-offer.updated',
  'special-offer.deleted',
  'special-offer.toggled',
  'team.member_added',
  'team.invite_sent',
  'team.invite_accepted',
  'team.invite_declined',
  'team.invite_resend',
  'team.invite_revoked',
  'team.member_removed',
  'team.role_changed',
  'settings.updated',
  'admin.granted',
  'admin.role_changed',
  'admin.revoked',
  'admin_role.created',
  'admin_role.updated',
  'admin_role.deleted',
  'user.deleted_by_admin',
];

const TYPE_FILTERS = {
  all: null,
  bookings: 'booking',
  customers: 'customer',
  reviews: 'review',
  finance: 'finance',
  system: 'system',
};

function auditActionsFor(type) {
  if (type === 'bookings') return ['booking.status_updated'];
  if (type === 'reviews') return AUDIT_ACTIONS.filter((action) => action.startsWith('review'));
  if (type === 'finance') return AUDIT_ACTIONS.filter((action) => action.startsWith('payout'));
  if (type === 'system') {
    return AUDIT_ACTIONS.filter((action) => (
      !action.startsWith('review') && !action.startsWith('payout') && !action.startsWith('booking')
    ));
  }
  return AUDIT_ACTIONS;
}

const BOOKING_SELECT = {
  id: true,
  bookingNumber: true,
  status: true,
  paymentStatus: true,
  paymentTiming: true,
  grossAmount: true,
  refundAmount: true,
  currency: true,
  createdAt: true,
  paidAt: true,
  cancelledAt: true,
  refundedAt: true,
  leadTravelerName: true,
  customer: { select: { id: true, name: true, photoURL: true, roles: true } },
  tour: {
    select: {
      id: true,
      title: true,
      slug: true,
      supplier: { select: { id: true, name: true } },
    },
  },
};

const REVIEW_SELECT = {
  id: true,
  rating: true,
  title: true,
  comment: true,
  createdAt: true,
  customer: { select: { id: true, name: true, photoURL: true, roles: true } },
  tour: {
    select: {
      id: true,
      title: true,
      slug: true,
      supplier: { select: { id: true, name: true } },
    },
  },
};

const WISHLIST_SELECT = {
  id: true,
  addedAt: true,
  priceAtSave: true,
  currency: true,
  user: { select: { id: true, name: true, photoURL: true, roles: true } },
  tour: {
    select: {
      id: true,
      title: true,
      slug: true,
      supplier: { select: { id: true, name: true } },
    },
  },
};

const REFUND_SELECT = {
  id: true,
  requestNumber: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  executedAt: true,
  refundedAmount: true,
  preview: true,
  supplier: { select: { id: true, name: true, photoURL: true, roles: true } },
  booking: {
    select: {
      id: true,
      bookingNumber: true,
      currency: true,
      grossAmount: true,
      tour: { select: { id: true, title: true, slug: true } },
    },
  },
};

const PAYOUT_SELECT = {
  id: true,
  requestNumber: true,
  amount: true,
  currency: true,
  bookingCount: true,
  status: true,
  cycleLabel: true,
  createdAt: true,
  completedAt: true,
  rejectedAt: true,
  rejectedReason: true,
  reference: true,
  supplier: { select: { id: true, name: true, photoURL: true, roles: true } },
};

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(amount, currency) {
  const number = toNumber(amount);
  if (number === null) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(number);
  } catch {
    return `${currency || 'USD'} ${number.toFixed(2)}`;
  }
}

function truncate(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function resolveWindow(window) {
  const now = new Date();
  const today = startOfDay(now);
  if (window === 'yesterday') {
    const start = new Date(today);
    start.setDate(start.getDate() - 1);
    return { start, end: today };
  }
  if (window === 'week') {
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { start, end: now };
  }
  return { start: today, end: now };
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const [datePart, id] = raw.split('|');
    const date = new Date(datePart);
    if (!id || Number.isNaN(date.getTime())) return null;
    return { date, id };
  } catch {
    return null;
  }
}

// The composed row id is `source:rowId:action`. The keyset predicate runs
// against the source table, so the cursor must carry the database id, not the
// display id.
function cursorIdFor(item) {
  const parts = String(item.id || '').split(':');
  return parts.length > 1 ? parts[1] : String(item.id || '');
}

function encodeCursor(item) {
  if (!item) return null;
  return Buffer.from(`${item.occurredAt.toISOString()}|${cursorIdFor(item)}`, 'utf8').toString('base64url');
}

function passesCursor(row, cursor) {
  if (!cursor) return true;
  const rowTime = row.occurredAt.getTime();
  const cursorTime = cursor.date.getTime();
  if (rowTime < cursorTime) return true;
  if (rowTime > cursorTime) return false;
  return cursorIdFor(row) < cursor.id;
}

function cursorWhere(cursor, field) {
  if (!cursor) return {};
  return {
    OR: [
      { [field]: { lt: cursor.date } },
      { [field]: cursor.date, id: { lt: cursor.id } },
    ],
  };
}

function andWhere(...parts) {
  const filtered = parts.filter(Boolean);
  if (filtered.length === 0) return {};
  if (filtered.length === 1) return filtered[0];
  return { AND: filtered };
}

function roleFor(user) {
  if (!user) return 'system';
  const roles = Array.isArray(user.roles) ? user.roles : [];
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('supplier')) return 'supplier';
  if (roles.includes('customer')) return 'customer';
  return 'staff';
}

function actorFromUser(user, fallback = 'System') {
  if (!user) return { id: null, name: fallback, role: 'system', photoURL: null };
  return {
    id: user.id,
    name: user.name || fallback,
    role: roleFor(user),
    photoURL: user.photoURL || null,
  };
}

function actorName(actor, fallback = 'A customer') {
  return actor && actor.name ? actor.name : fallback;
}

function bookingHref(bookingId) {
  return `/admin/bookings?bookingId=${encodeURIComponent(bookingId)}`;
}

function auditType(action) {
  if (action.startsWith('booking')) return 'booking';
  if (action.startsWith('payout') || action.startsWith('payout_method')) return 'finance';
  if (action.startsWith('review')) return 'review';
  return 'system';
}

function auditHref(action, resource, resourceId) {
  if (action.startsWith('review')) return '/admin/reviews';
  if (action.startsWith('payout')) return '/admin/payouts?tab=requests';
  if (action.startsWith('supplier')) return resourceId ? `/admin/suppliers/${resourceId}` : '/admin/suppliers';
  if (action.startsWith('tour')) return resourceId ? `/admin/tours/${resourceId}` : '/admin/tours';
  if (action.startsWith('team') || action.startsWith('settings')) return '/admin/settings';
  if (action.startsWith('special-offer')) return '/admin/tours';
  if (action.startsWith('admin')) return '/admin/settings?tab=admins';
  if (resource === 'Booking' && resourceId) return bookingHref(resourceId);
  return null;
}

function auditDetail(action, metadata = {}) {
  const parts = [];
  if (metadata.tourTitle) parts.push(metadata.tourTitle);
  else if (metadata.title) parts.push(metadata.title);
  if (metadata.supplierName) parts.push(metadata.supplierName);
  if (metadata.email) parts.push(metadata.email);
  if (metadata.amount !== undefined && metadata.amount !== null) {
    const formatted = money(metadata.amount, metadata.currency);
    if (formatted) parts.push(formatted);
  }
  if (metadata.reason) parts.push(truncate(metadata.reason, 80));
  return parts.filter(Boolean).join(' · ') || null;
}

// Staff ids are only used as the legacy fallback for audit rows that predate
// the brand column. A short cache keeps the feed from re-reading the user table
// on every 30s poll while still picking up a newly added admin quickly.
let staffCache = { ids: [], expiresAt: 0 };

async function ghanaStaffIds() {
  if (Date.now() < staffCache.expiresAt) return staffCache.ids;
  const staff = await prisma.user.findMany({
    where: { roles: { has: BRAND.role } },
    select: { id: true },
  });
  const ids = staff.map((user) => user.id);
  staffCache = { ids, expiresAt: Date.now() + 60_000 };
  return ids;
}

function eventTourId(event) {
  const properties = event.properties && typeof event.properties === 'object' ? event.properties : {};
  if (event.resource === 'Tour' && event.resourceId) return event.resourceId;
  return properties.tourId || null;
}

function eventSummary(event, actor, tourTitle) {
  const properties = event.properties && typeof event.properties === 'object' ? event.properties : {};
  const name = String(event.name || '');
  const who = actorName(actor, 'A visitor');
  const tour = tourTitle || 'a tour';

  if (name.endsWith('.checkout_started')) {
    return {
      type: 'booking',
      action: 'checkout.started',
      summary: `${who} started checkout for ${tour}`,
      detail: money(properties.total, properties.currency),
      amount: toNumber(properties.total),
      currency: properties.currency || null,
      href: null,
    };
  }
  if (name === 'search.executed' || name.endsWith('.search_executed')) {
    const query = truncate(properties.query || properties.search || '', 80);
    const resultCount = toNumber(properties.resultCount);
    return {
      type: 'customer',
      action: 'search.executed',
      summary: query ? `${who} searched for “${query}”` : `${who} searched the storefront`,
      detail: resultCount !== null ? `${resultCount} result${resultCount === 1 ? '' : 's'}` : null,
      amount: null,
      currency: null,
      href: null,
    };
  }
  if (name.endsWith('.newsletter_subscribed')) {
    return {
      type: 'customer',
      action: 'newsletter.subscribed',
      summary: `${who} subscribed to the newsletter`,
      detail: properties.email || null,
      amount: null,
      currency: null,
      href: null,
    };
  }
  if (name.endsWith('.contact_submitted')) {
    return {
      type: 'customer',
      action: 'contact.submitted',
      summary: `${who} sent a contact message`,
      detail: [properties.email, tourTitle].filter(Boolean).join(' · ') || null,
      amount: null,
      currency: null,
      href: null,
    };
  }
  return null;
}

function bookingRow(booking, action, occurredAt) {
  const actor = actorFromUser(
    booking.customer,
    booking.leadTravelerName || 'A customer',
  );
  const who = actorName(actor, booking.leadTravelerName || 'A customer');
  const tourTitle = booking.tour?.title || 'a tour';
  const amount = toNumber(booking.grossAmount);
  const currency = booking.currency;
  const bookingNumber = booking.bookingNumber || 'Booking';

  if (action === 'booking.created') {
    return {
      id: `booking:${booking.id}:created`,
      source: 'booking',
      type: 'booking',
      action,
      summary: `${who} booked ${tourTitle}`,
      detail: [
        bookingNumber,
        money(amount, currency),
        booking.paymentTiming === 'later' ? 'Reserve now, pay later' : null,
      ].filter(Boolean).join(' · '),
      actor,
      object: { type: 'booking', id: booking.id, label: bookingNumber },
      amount,
      currency,
      href: bookingHref(booking.id),
      occurredAt,
    };
  }
  if (action === 'booking.paid') {
    return {
      id: `booking:${booking.id}:paid`,
      source: 'booking',
      type: 'booking',
      action,
      summary: `${who} paid for ${tourTitle}`,
      detail: [bookingNumber, money(amount, currency), 'Paid in full'].filter(Boolean).join(' · '),
      actor,
      object: { type: 'booking', id: booking.id, label: bookingNumber },
      amount,
      currency,
      href: bookingHref(booking.id),
      occurredAt,
    };
  }
  if (action === 'booking.cancelled') {
    return {
      id: `booking:${booking.id}:cancelled`,
      source: 'booking',
      type: 'booking',
      action,
      summary: `${bookingNumber} was cancelled`,
      detail: [tourTitle, who].filter(Boolean).join(' · '),
      actor,
      object: { type: 'booking', id: booking.id, label: bookingNumber },
      amount: null,
      currency,
      href: bookingHref(booking.id),
      occurredAt,
    };
  }
  return {
    id: `booking:${booking.id}:refunded`,
    source: 'booking',
    type: 'finance',
    action: 'booking.refunded',
    summary: `Refund issued for ${bookingNumber}`,
    detail: [money(booking.refundAmount || amount, currency), tourTitle].filter(Boolean).join(' · '),
    actor,
    object: { type: 'booking', id: booking.id, label: bookingNumber },
    amount: toNumber(booking.refundAmount || amount),
    currency,
    href: bookingHref(booking.id),
    occurredAt,
  };
}

function reviewRow(review) {
  const actor = actorFromUser(review.customer, 'A customer');
  const title = review.tour?.title || 'a tour';
  const stars = Number(review.rating) || 0;
  const body = truncate(review.title || review.comment || '', 90);
  return {
    id: `review:${review.id}:submitted`,
    source: 'review',
    type: 'review',
    action: 'review.submitted',
    summary: `${actorName(actor)} left a ${stars}-star review for ${title}`,
    detail: body ? `“${body}”` : null,
    actor,
    object: { type: 'review', id: review.id, label: title },
    amount: null,
    currency: null,
    href: '/admin/reviews',
    occurredAt: review.createdAt,
  };
}

function wishlistRow(item) {
  const actor = actorFromUser(item.user, 'A customer');
  const title = item.tour?.title || 'a tour';
  return {
    id: `wishlist:${item.id}:saved`,
    source: 'wishlist',
    type: 'customer',
    action: 'wishlist.saved',
    summary: `${actorName(actor)} saved ${title}`,
    detail: item.priceAtSave !== null && item.priceAtSave !== undefined
      ? `Wishlist · ${money(item.priceAtSave, item.currency)}`
      : 'Wishlist',
    actor,
    object: { type: 'tour', id: item.tour?.id || null, label: title },
    amount: toNumber(item.priceAtSave),
    currency: item.currency || null,
    href: item.tour?.id ? `/admin/tours/${item.tour.id}` : null,
    occurredAt: item.addedAt,
  };
}

function refundAmount(refund) {
  const preview = refund.preview && typeof refund.preview === 'object' ? refund.preview : {};
  return (
    toNumber(refund.refundedAmount)
    ?? toNumber(preview.requested)
    ?? toNumber(preview.proposed)
    ?? toNumber(refund.booking?.grossAmount)
  );
}

function refundRows(refund) {
  const actor = actorFromUser(refund.supplier, 'A supplier');
  const supplier = actorName(actor, 'A supplier');
  const bookingNumber = refund.booking?.bookingNumber || 'Booking';
  const amount = refundAmount(refund);
  const currency = refund.booking?.currency || 'USD';
  const title = refund.booking?.tour?.title || 'a tour';
  const rows = [];

  if (refund.createdAt) {
    rows.push({
      id: `refund:${refund.id}:requested`,
      source: 'refund',
      type: 'finance',
      action: 'refund.requested',
      summary: `${supplier} requested a refund for ${bookingNumber}`,
      detail: [money(amount, currency), title].filter(Boolean).join(' · '),
      actor,
      object: { type: 'refund', id: refund.id, label: refund.requestNumber },
      amount,
      currency,
      href: '/admin/refund-requests',
      occurredAt: refund.createdAt,
    });
  }
  if (refund.decidedAt) {
    const rejected = refund.status === 'REJECTED' || refund.status === 'WITHDRAWN';
    rows.push({
      id: `refund:${refund.id}:decided`,
      source: 'refund',
      type: 'finance',
      action: rejected ? 'refund.rejected' : 'refund.approved',
      summary: `${rejected ? 'Refund rejected' : 'Refund approved'} for ${bookingNumber}`,
      detail: [supplier, money(amount, currency)].filter(Boolean).join(' · '),
      actor,
      object: { type: 'refund', id: refund.id, label: refund.requestNumber },
      amount,
      currency,
      href: '/admin/refund-requests',
      occurredAt: refund.decidedAt,
    });
  }
  if (refund.executedAt) {
    rows.push({
      id: `refund:${refund.id}:completed`,
      source: 'refund',
      type: 'finance',
      action: 'refund.completed',
      summary: `Refund issued for ${bookingNumber}`,
      detail: [money(amount, currency), title].filter(Boolean).join(' · '),
      actor,
      object: { type: 'refund', id: refund.id, label: refund.requestNumber },
      amount,
      currency,
      href: '/admin/refund-requests',
      occurredAt: refund.executedAt,
    });
  }
  return rows;
}

function payoutRows(payout) {
  const actor = actorFromUser(payout.supplier, 'A supplier');
  const supplier = actorName(actor, 'A supplier');
  const amount = toNumber(payout.amount);
  const currency = payout.currency || 'USD';
  const rows = [];

  if (payout.createdAt) {
    rows.push({
      id: `payout:${payout.id}:requested`,
      source: 'payout',
      type: 'finance',
      action: 'payout.requested',
      summary: `${supplier} requested a payout`,
      detail: [
        money(amount, currency),
        payout.bookingCount ? `${payout.bookingCount} booking${payout.bookingCount === 1 ? '' : 's'}` : null,
        payout.cycleLabel,
      ].filter(Boolean).join(' · '),
      actor,
      object: { type: 'payout', id: payout.id, label: payout.requestNumber },
      amount,
      currency,
      href: '/admin/payouts?tab=requests',
      occurredAt: payout.createdAt,
    });
  }
  if (payout.completedAt) {
    rows.push({
      id: `payout:${payout.id}:completed`,
      source: 'payout',
      type: 'finance',
      action: 'payout.completed',
      summary: `Payout paid to ${supplier}`,
      detail: [money(amount, currency), payout.reference || payout.requestNumber].filter(Boolean).join(' · '),
      actor,
      object: { type: 'payout', id: payout.id, label: payout.requestNumber },
      amount,
      currency,
      href: '/admin/payouts?tab=requests',
      occurredAt: payout.completedAt,
    });
  }
  if (payout.rejectedAt) {
    rows.push({
      id: `payout:${payout.id}:rejected`,
      source: 'payout',
      type: 'finance',
      action: 'payout.rejected',
      summary: `Payout request rejected for ${supplier}`,
      detail: [money(amount, currency), payout.rejectedReason].filter(Boolean).join(' · '),
      actor,
      object: { type: 'payout', id: payout.id, label: payout.requestNumber },
      amount,
      currency,
      href: '/admin/payouts?tab=requests',
      occurredAt: payout.rejectedAt,
    });
  }
  return rows;
}

function qWhereForBooking(q) {
  if (!q) return null;
  return {
    OR: [
      { bookingNumber: { contains: q, mode: 'insensitive' } },
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      { tour: { title: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function qWhereForReview(q) {
  if (!q) return null;
  return {
    OR: [
      { title: { contains: q, mode: 'insensitive' } },
      { comment: { contains: q, mode: 'insensitive' } },
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      { tour: { title: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function qWhereForWishlist(q) {
  if (!q) return null;
  return {
    OR: [
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { tour: { title: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function qWhereForRefund(q) {
  if (!q) return null;
  return {
    OR: [
      { requestNumber: { contains: q, mode: 'insensitive' } },
      { supplier: { name: { contains: q, mode: 'insensitive' } } },
      { booking: { bookingNumber: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function qWhereForPayout(q) {
  if (!q) return null;
  return {
    OR: [
      { requestNumber: { contains: q, mode: 'insensitive' } },
      { supplier: { name: { contains: q, mode: 'insensitive' } } },
    ],
  };
}

function qWhereForAudit(q) {
  if (!q) return null;
  return {
    OR: [
      { action: { contains: q, mode: 'insensitive' } },
      { userEmail: { contains: q, mode: 'insensitive' } },
      { resource: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function qWhereForEvent(q) {
  if (!q) return null;
  return { properties: { path: ['query'], string_contains: q } };
}

async function fetchBookings(range, cursor, limit, q) {
  const base = andWhere(
    BOOKING_BRAND_WHERE,
    qWhereForBooking(q),
    { createdAt: { gte: range.start, lte: range.end } },
    cursorWhere(cursor, 'createdAt'),
  );
  const paid = andWhere(
    BOOKING_BRAND_WHERE,
    qWhereForBooking(q),
    { paidAt: { gte: range.start, lte: range.end }, paymentStatus: 'SUCCEEDED' },
    cursorWhere(cursor, 'paidAt'),
  );
  const cancelled = andWhere(
    BOOKING_BRAND_WHERE,
    qWhereForBooking(q),
    { cancelledAt: { gte: range.start, lte: range.end } },
    cursorWhere(cursor, 'cancelledAt'),
  );
  const refunded = andWhere(
    BOOKING_BRAND_WHERE,
    qWhereForBooking(q),
    { refundedAt: { gte: range.start, lte: range.end } },
    cursorWhere(cursor, 'refundedAt'),
  );

  const [createdRows, paidRows, cancelledRows, refundedRows] = await Promise.all([
    prisma.booking.findMany({
      where: base,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: BOOKING_SELECT,
    }),
    prisma.booking.findMany({
      where: paid,
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: BOOKING_SELECT,
    }),
    prisma.booking.findMany({
      where: cancelled,
      orderBy: [{ cancelledAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: BOOKING_SELECT,
    }),
    prisma.booking.findMany({
      where: refunded,
      orderBy: [{ refundedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: BOOKING_SELECT,
    }),
  ]);

  return [
    ...createdRows.map((row) => bookingRow(row, 'booking.created', row.createdAt)),
    ...paidRows.map((row) => bookingRow(row, 'booking.paid', row.paidAt)),
    ...cancelledRows.map((row) => bookingRow(row, 'booking.cancelled', row.cancelledAt)),
    ...refundedRows.map((row) => bookingRow(row, 'booking.refunded', row.refundedAt)),
  ];
}

async function fetchReviews(range, cursor, limit, q) {
  const rows = await prisma.review.findMany({
    where: andWhere(
      TOUR_BRAND_WHERE,
      qWhereForReview(q),
      { createdAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'createdAt'),
    ),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: REVIEW_SELECT,
  });
  return rows.map(reviewRow);
}

async function fetchWishlists(range, cursor, limit, q) {
  const rows = await prisma.wishlistItem.findMany({
    where: andWhere(
      TOUR_BRAND_WHERE,
      qWhereForWishlist(q),
      { addedAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'addedAt'),
    ),
    orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: WISHLIST_SELECT,
  });
  return rows.map(wishlistRow);
}

async function fetchRefunds(range, cursor, limit, q) {
  const requested = await prisma.supplierRefundRequest.findMany({
    where: andWhere(
      { booking: BOOKING_BRAND_WHERE },
      qWhereForRefund(q),
      { createdAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'createdAt'),
    ),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: REFUND_SELECT,
  });
  const decided = await prisma.supplierRefundRequest.findMany({
    where: andWhere(
      { booking: BOOKING_BRAND_WHERE, decidedAt: { not: null } },
      qWhereForRefund(q),
      { decidedAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'decidedAt'),
    ),
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: REFUND_SELECT,
  });
  const executed = await prisma.supplierRefundRequest.findMany({
    where: andWhere(
      { booking: BOOKING_BRAND_WHERE, executedAt: { not: null } },
      qWhereForRefund(q),
      { executedAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'executedAt'),
    ),
    orderBy: [{ executedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: REFUND_SELECT,
  });

  // A refund can legitimately appear in more than one of these queries (it was
  // requested and decided inside the same window). refundRows() emits a stable
  // id per lifecycle step, so the global merge dedupes without dropping the
  // later step. Filter each composed row back to the window: a decided row can
  // pull in its older requested timestamp.
  return [...requested, ...decided, ...executed]
    .flatMap(refundRows)
    .filter((row) => row.occurredAt >= range.start && row.occurredAt <= range.end);
}

async function fetchPayouts(range, cursor, limit, q) {
  const created = await prisma.payoutRequest.findMany({
    where: andWhere(
      { supplier: { roles: { has: BRAND.role } } },
      qWhereForPayout(q),
      { createdAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'createdAt'),
    ),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: PAYOUT_SELECT,
  });
  const completed = await prisma.payoutRequest.findMany({
    where: andWhere(
      { supplier: { roles: { has: BRAND.role } }, completedAt: { not: null } },
      qWhereForPayout(q),
      { completedAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'completedAt'),
    ),
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: PAYOUT_SELECT,
  });
  const rejected = await prisma.payoutRequest.findMany({
    where: andWhere(
      { supplier: { roles: { has: BRAND.role } }, rejectedAt: { not: null } },
      qWhereForPayout(q),
      { rejectedAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'rejectedAt'),
    ),
    orderBy: [{ rejectedAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: PAYOUT_SELECT,
  });

  return [...created, ...completed, ...rejected]
    .flatMap(payoutRows)
    .filter((row) => row.occurredAt >= range.start && row.occurredAt <= range.end);
}

async function fetchEvents(range, cursor, limit, q) {
  const events = await prisma.event.findMany({
    where: andWhere(
      EVENT_BRAND_WHERE,
      { name: { in: FEED_EVENT_NAMES } },
      qWhereForEvent(q),
      { createdAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'createdAt'),
    ),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      name: true,
      userId: true,
      resource: true,
      resourceId: true,
      properties: true,
      createdAt: true,
    },
  });

  if (events.length === 0) return [];

  const userIds = [...new Set(events.map((event) => event.userId).filter(Boolean))];
  const tourIds = [...new Set(events.map(eventTourId).filter(Boolean))];

  const [users, tours] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, photoURL: true, roles: true },
      })
      : [],
    tourIds.length
      ? prisma.tour.findMany({
        where: { id: { in: tourIds } },
        select: { id: true, title: true, slug: true },
      })
      : [],
  ]);

  const userMap = new Map(users.map((user) => [user.id, user]));
  const tourMap = new Map(tours.map((tour) => [tour.id, tour]));

  return events
    .map((event) => {
      const actor = actorFromUser(userMap.get(event.userId), 'A visitor');
      const tourId = eventTourId(event);
      const composed = eventSummary(event, actor, tourMap.get(tourId)?.title);
      if (!composed) return null;
      return {
        id: `event:${event.id}`,
        source: 'event',
        ...composed,
        actor,
        object: tourId
          ? { type: 'tour', id: tourId, label: tourMap.get(tourId)?.title || 'Tour' }
          : null,
        href: String(event.name).startsWith('expedition.')
          ? '/admin/expedition'
          : (composed.href || (tourId ? `/admin/tours/${tourId}` : null)),
        occurredAt: event.createdAt,
      };
    })
    .filter(Boolean);
}

async function fetchAudits(range, cursor, limit, q, actions = AUDIT_ACTIONS) {
  const staffIds = await ghanaStaffIds();
  const brandWhere = {
    OR: [
      { brand: BRAND.key },
      ...(staffIds.length ? [{ userId: { in: staffIds } }] : []),
    ],
  };

  const audits = await prisma.auditLog.findMany({
    where: andWhere(
      brandWhere,
      { action: { in: actions } },
      qWhereForAudit(q),
      { createdAt: { gte: range.start, lte: range.end } },
      cursorWhere(cursor, 'createdAt'),
    ),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      userId: true,
      userEmail: true,
      action: true,
      resource: true,
      resourceId: true,
      metadata: true,
      createdAt: true,
    },
  });

  if (audits.length === 0) return [];

  const userIds = [...new Set([
    ...audits.map((audit) => audit.userId).filter(Boolean),
    ...audits
      .filter((audit) => ['User', 'SupplierProfile'].includes(audit.resource) && audit.resourceId)
      .map((audit) => audit.resourceId),
  ])];
  const tourIds = [...new Set(audits
    .filter((audit) => audit.resource === 'Tour' && audit.resourceId)
    .map((audit) => audit.resourceId))];
  const bookingIds = [...new Set(audits
    .filter((audit) => audit.resource === 'Booking' && audit.resourceId)
    .map((audit) => audit.resourceId))];

  const [users, tours, bookings] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, photoURL: true, roles: true },
      })
      : [],
    tourIds.length
      ? prisma.tour.findMany({
        where: { id: { in: tourIds } },
        select: { id: true, title: true, slug: true },
      })
      : [],
    bookingIds.length
      ? prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: {
          id: true,
          bookingNumber: true,
          status: true,
          customer: { select: { name: true } },
          tour: { select: { title: true } },
        },
      })
      : [],
  ]);

  const userMap = new Map(users.map((user) => [user.id, user]));
  const tourMap = new Map(tours.map((tour) => [tour.id, tour]));
  const bookingMap = new Map(bookings.map((booking) => [booking.id, booking]));

  return audits.map((audit) => {
    const metadata = audit.metadata && typeof audit.metadata === 'object' ? audit.metadata : {};
    const actor = actorFromUser(userMap.get(audit.userId), audit.userEmail || 'System');
    const type = auditType(audit.action);
    const title = audit.resource === 'Tour' && audit.resourceId
      ? tourMap.get(audit.resourceId)?.title
      : null;
    const booking = audit.resource === 'Booking' && audit.resourceId
      ? bookingMap.get(audit.resourceId)
      : null;
    const newStatus = String(metadata.newStatus || booking?.status || '').toUpperCase();
    if (audit.action === 'booking.status_updated' && ['CANCELLED', 'REFUNDED'].includes(newStatus)) {
      return null;
    }
    const summary = audit.action === 'booking.status_updated'
      ? `Booking ${booking?.bookingNumber || ''} ${newStatus ? newStatus.toLowerCase().replace(/_/g, ' ') : 'updated'}`.replace(/\s+/g, ' ').trim()
      : buildAuditMessage(audit.action, audit.resource, metadata);
    const resourceUser = audit.resourceId ? userMap.get(audit.resourceId) : null;
    const detail = audit.action === 'booking.status_updated'
      ? [booking?.tour?.title, booking?.customer?.name].filter(Boolean).join(' · ') || null
      : (auditDetail(audit.action, { ...metadata, tourTitle: metadata.tourTitle || title })
        || resourceUser?.name
        || null);
    return {
      id: `audit:${audit.id}`,
      source: 'audit',
      type,
      action: audit.action,
      summary,
      detail,
      actor,
      object: audit.resourceId
        ? {
          type: String(audit.resource || 'record').toLowerCase(),
          id: audit.resourceId,
          label: title || booking?.bookingNumber || resourceUser?.name || audit.resource,
        }
        : null,
      amount: toNumber(metadata.amount),
      currency: metadata.currency || null,
      href: auditHref(audit.action, audit.resource, audit.resourceId),
      occurredAt: audit.createdAt,
    };
  }).filter(Boolean);
}

/**
 * Build a page of the activity feed.
 *
 * @param {Object} options
 * @param {'today'|'yesterday'|'week'} [options.window]
 * @param {'all'|'bookings'|'customers'|'reviews'|'finance'|'system'} [options.type]
 * @param {string} [options.q]
 * @param {string} [options.cursor]
 * @param {number} [options.limit]
 */
async function getActivityFeed({
  window = 'today',
  type = 'all',
  q = '',
  cursor: rawCursor = null,
  limit: rawLimit = DEFAULT_LIMIT,
} = {}) {
  const safeWindow = ['today', 'yesterday', 'week'].includes(window) ? window : 'today';
  const safeType = Object.prototype.hasOwnProperty.call(TYPE_FILTERS, type) ? type : 'all';
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, parseInt(rawLimit, 10) || DEFAULT_LIMIT));
  const range = resolveWindow(safeWindow);
  const cursor = decodeCursor(rawCursor);
  const search = String(q || '').trim().slice(0, 100);
  const wanted = TYPE_FILTERS[safeType];

  const streams = [];
  if (!wanted || wanted === 'booking') streams.push(fetchBookings(range, cursor, safeLimit, search));
  if (!wanted || wanted === 'customer') streams.push(fetchWishlists(range, cursor, safeLimit, search));
  if (!wanted || wanted === 'review') streams.push(fetchReviews(range, cursor, safeLimit, search));
  if (!wanted || wanted === 'finance') streams.push(fetchRefunds(range, cursor, safeLimit, search));
  if (!wanted || wanted === 'finance') streams.push(fetchPayouts(range, cursor, safeLimit, search));
  if (!wanted || safeType === 'bookings' || safeType === 'customers') {
    streams.push(fetchEvents(range, cursor, safeLimit, search));
  }
  if (!wanted || safeType === 'system' || safeType === 'reviews' || safeType === 'finance' || safeType === 'bookings') {
    streams.push(fetchAudits(
      range,
      cursor,
      safeLimit,
      search,
      auditActionsFor(safeType),
    ));
  }

  const groups = await Promise.all(streams);
  const byId = new Map();
  for (const row of groups.flat()) {
    if (!row || !row.occurredAt) continue;
    byId.set(row.id, row);
  }

  const sorted = [...byId.values()]
    .filter((row) => !wanted || row.type === wanted)
    .filter((row) => passesCursor(row, cursor))
    .sort((a, b) => (
      b.occurredAt.getTime() - a.occurredAt.getTime()
      || b.id.localeCompare(a.id)
    ));

  const items = sorted.slice(0, safeLimit);
  const hasMore = sorted.length > safeLimit;
  const last = items[items.length - 1];

  return {
    items: items.map((row) => ({
      ...row,
      occurredAt: undefined,
      createdAt: row.occurredAt.toISOString(),
    })),
    hasMore,
    nextCursor: hasMore ? encodeCursor(last) : null,
    window: safeWindow,
    type: safeType,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getActivityFeed,
  // Exported for unit tests.
  _private: {
    resolveWindow,
    decodeCursor,
    encodeCursor,
    cursorIdFor,
    bookingRow,
    reviewRow,
    wishlistRow,
    refundRows,
    payoutRows,
    eventSummary,
    auditType,
  },
};
