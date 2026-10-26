/**
 * Shared helpers for the Travio Ghana Stays vertical.
 *
 * The supplier dashboard speaks display strings ("Checked in", "Live"), while
 * the database uses enums. Every stays controller maps through these helpers so
 * a value can never be spelled two different ways on two pages.
 */

const { computeOfferStatus } = require('../../core/services/offerStatus');

const PROPERTY_STATUS_TO_UI = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Under review',
  ACTIVE: 'Live',
  INACTIVE: 'Paused',
  ARCHIVED: 'Archived',
};

const PROPERTY_STATUS_FROM_UI = {
  Draft: 'DRAFT',
  'Under review': 'PENDING_APPROVAL',
  Live: 'ACTIVE',
  Paused: 'INACTIVE',
  Archived: 'ARCHIVED',
};

const BOOKING_STATUS_TO_UI = {
  NEW: 'New',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No-show',
};

const BOOKING_STATUS_FROM_UI = {
  New: 'NEW',
  Confirmed: 'CONFIRMED',
  'Checked in': 'CHECKED_IN',
  Completed: 'COMPLETED',
  Cancelled: 'CANCELLED',
  'No-show': 'NO_SHOW',
};

/** Lifecycle transitions the dashboard offers. */
const BOOKING_TRANSITIONS = {
  NEW: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['CHECKED_IN', 'CANCELLED', 'NO_SHOW'],
  CHECKED_IN: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

function supplierIdFor(req) {
  return req.supplierId || req.user?.id;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dateKey(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function parseDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nightsBetween(checkIn, checkOut) {
  return Math.round((checkOut.getTime() - checkIn.getTime()) / (24 * 60 * 60 * 1000));
}

function displayPropertyStatus(status) {
  return PROPERTY_STATUS_TO_UI[status] || 'Draft';
}

function enumPropertyStatus(value) {
  if (!value || value === 'All') return null;
  return PROPERTY_STATUS_FROM_UI[value] || (PROPERTY_STATUS_TO_UI[value] ? value : null);
}

function displayBookingStatus(status) {
  return BOOKING_STATUS_TO_UI[status] || 'New';
}

function enumBookingStatus(value) {
  if (!value || value === 'All') return null;
  return BOOKING_STATUS_FROM_UI[value] || (BOOKING_STATUS_TO_UI[value] ? value : null);
}

function serializeStayBooking(row) {
  const propertyName = row.property?.name || 'Property';
  return {
    id: row.id,
    bookingNumber: row.bookingNumber,
    guest: row.guestName,
    guestName: row.guestName,
    guestEmail: row.guestEmail || '',
    guestPhone: row.guestPhone || '',
    propertyId: row.propertyId,
    propertyName,
    room: row.roomName || row.roomId || 'Room',
    roomId: row.roomId || null,
    roomName: row.roomName || null,
    ratePlanId: row.ratePlanId || null,
    ratePlanName: row.ratePlanName || null,
    from: dateKey(row.checkIn),
    to: dateKey(row.checkOut),
    checkIn: dateKey(row.checkIn),
    checkOut: dateKey(row.checkOut),
    nights: row.nights,
    guests: row.guests,
    amount: Number(row.amount),
    currency: row.currency,
    status: displayBookingStatus(row.status),
    paymentStatus: row.paymentStatus,
    reason: row.cancellationReason || '',
    note: row.cancellationNote || '',
    refundAmount: row.refundAmount == null ? null : Number(row.refundAmount),
    countsTowardRate: row.countsTowardRate,
    specialRequests: row.specialRequests || '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeStayOffer(row) {
  return {
    ...row,
    status: computeOfferStatus(row),
    targets: (row.targets || []).map((target) => ({
      propertyId: target.propertyId,
      propertyName: target.propertyName || target.property?.name || 'Property',
      roomId: target.roomId || null,
      roomLabel: target.roomLabel || null,
    })),
  };
}

function serializeStayReview(row) {
  return {
    id: row.id,
    propertyId: row.propertyId,
    propertyName: row.property?.name || 'Property',
    guest: row.guestName,
    rating: row.rating,
    text: row.text || '',
    reply: row.reply || '',
    repliedAt: row.repliedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Parse "30 days" / "12 months" into a cutoff date. */
function periodCutoff(period = '90 days') {
  const match = /(\d+)\s*(day|days|month|months)/i.exec(String(period || ''));
  const count = match ? parseInt(match[1], 10) : 90;
  const unit = match ? match[2].toLowerCase() : 'days';
  const cutoff = new Date();
  if (unit.startsWith('month')) cutoff.setMonth(cutoff.getMonth() - count);
  else cutoff.setDate(cutoff.getDate() - count);
  return { count, unit, cutoff };
}

const stayBookingInclude = {
  property: { select: { id: true, name: true } },
};

const stayOfferInclude = {
  targets: { include: { property: { select: { id: true, name: true } } } },
};

module.exports = {
  PROPERTY_STATUS_TO_UI,
  PROPERTY_STATUS_FROM_UI,
  BOOKING_STATUS_TO_UI,
  BOOKING_STATUS_FROM_UI,
  BOOKING_TRANSITIONS,
  supplierIdFor,
  objectOrEmpty,
  dateKey,
  parseDateKey,
  addDays,
  nightsBetween,
  displayPropertyStatus,
  enumPropertyStatus,
  displayBookingStatus,
  enumBookingStatus,
  serializeStayBooking,
  serializeStayOffer,
  serializeStayReview,
  periodCutoff,
  stayBookingInclude,
  stayOfferInclude,
};
