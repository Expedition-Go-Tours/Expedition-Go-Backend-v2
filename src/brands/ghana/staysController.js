/**
 * Travio Ghana — Stays (accommodation) supplier API.
 *
 * The Stays workspace in the supplier dashboard is a separate vertical from
 * tours. A StayProperty is a builder draft that autosaves a JSON payload; the
 * indexed columns are projections used for lists/scoping only. Rooms, rate
 * plans and photos live inside `data` until the bookings/finance milestones
 * need them normalised.
 *
 * Every query is scoped to `req.supplierId` (set by resolveSupplier), so a
 * team member reads/writes the owning supplier's properties and another
 * supplier's id always resolves to 404.
 */

const crypto = require('crypto');
const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const { cloudinary, isConfigured: cloudinaryConfigured } = require('../../../config/cloudinary');

const STATUS_TO_UI = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Under review',
  ACTIVE: 'Live',
  INACTIVE: 'Paused',
  ARCHIVED: 'Archived',
};

const STATUS_FROM_UI = {
  Draft: 'DRAFT',
  'Under review': 'PENDING_APPROVAL',
  Live: 'ACTIVE',
  Paused: 'INACTIVE',
  Archived: 'ARCHIVED',
};

const STEP_MAX = 17;
const MAX_PHOTOS = 50;
const MAX_PROPERTIES = 200;

const PROTECTED_KEYS = new Set([
  'id',
  'supplierId',
  'status',
  'createdAt',
  'updatedAt',
  'bookings',
  'data',
  '__proto__',
  'constructor',
  'prototype',
]);

/** Defaults mirror the supplier dashboard's create-property seed. */
function defaultPropertyData() {
  return {
    name: 'Untitled property',
    type: 'Hotel',
    bookingType: 'Individual rooms',
    operating: 'Open now',
    region: 'Greater Accra',
    country: 'Ghana',
    city: '',
    address: '',
    apartment: '',
    postcode: '',
    lat: null,
    lng: null,
    mapAddress: '',
    gps: '',
    landmark: '',
    shortDescription: '',
    description: '',
    step: 0,
    facilities: [],
    photos: [],
    rooms: [],
    ratePlans: [],
    start: '',
    advance: '12 months',
    checkin: '14:00',
    checkinEnd: '18:00',
    checkoutStart: '08:00',
    checkout: '11:00',
    cancellation: 'Flexible',
    listingScope: 'One property',
    sameAddress: null,
    propertyCount: null,
    otherListings: [],
    noOtherListings: false,
    channelManager: { connected: false, name: '' },
    services: { breakfast: 'No', parking: 'No' },
    languages: [],
    hostProfile: {
      property: { included: false, about: '' },
      host: { included: false, name: '', about: '' },
      neighbourhood: { included: false, about: '' },
      none: false,
    },
    sleeping: {
      bedrooms: [{ id: 'bed-1', name: 'Bedroom 1', doubleBeds: 1, singleBeds: 0 }],
      livingRoomBeds: 0,
      otherSpacesBeds: 0,
    },
    maxGuests: 2,
    excludeInfants: false,
    bathrooms: 1,
    children: 'Welcome',
    cots: 'Not available',
    size: '',
    sizeUnit: 'square metres',
    bookingPreference: 'instant',
    pricePerNight: '29.00',
    currency: 'GHS',
    promotion: true,
    startMode: 'asap',
    calendarWindow: '365 days',
    calendarImport: { mode: 'import', url: '' },
    longStays: null,
    payments: { mode: 'Online when they book' },
    invoicing: { name: '', legalName: '', sameAddress: true, address: '' },
    agreement: {
      certifyBusiness: false,
      certifyTerms: false,
      openMonths: '18 months',
      notReadyReason: '',
    },
  };
}

function supplierIdFor(req) {
  return req.supplierId || req.user?.id;
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clampStep(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(STEP_MAX, Math.trunc(n)));
}

function sanitizePropertyPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (PROTECTED_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function displayStatus(status) {
  return STATUS_TO_UI[status] || 'Draft';
}

function enumStatus(value) {
  if (!value || value === 'All') return null;
  return STATUS_FROM_UI[value] || (STATUS_TO_UI[value] ? value : null);
}

function serializeProperty(row) {
  const data = objectOrEmpty(row.data);
  return {
    ...data,
    id: row.id,
    name: row.name,
    type: row.type ?? data.type ?? null,
    city: row.city ?? data.city ?? '',
    country: row.country ?? data.country ?? 'Ghana',
    status: displayStatus(row.status),
    step: row.step ?? 0,
    bookings: 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

async function findOwnedProperty(id, supplierId) {
  const row = await prisma.stayProperty.findFirst({
    where: { id, supplierId, status: { not: 'ARCHIVED' } },
  });
  if (!row) throw new AppError('Property not found', 404);
  return row;
}

async function normalizePhoto(input) {
  if (isHttpUrl(input)) return input;
  if (typeof input !== 'string' || !input.startsWith('data:image/')) {
    throw new AppError('Only image files or hosted image URLs are accepted', 400);
  }
  if (!cloudinaryConfigured) {
    throw new AppError('File upload service is unavailable', 503);
  }
  const uploaded = await cloudinary.uploader.upload(input, {
    folder: 'stays/properties',
    resource_type: 'image',
  });
  return uploaded.secure_url;
}

function dateKey(value) {
  return value.toISOString().slice(0, 10);
}

function parseDateKey(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ── Dashboard ──────────────────────────────────────────────────────────── */

exports.getDashboard = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const rows = await prisma.stayProperty.findMany({
    where: { supplierId, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, status: true, data: true },
    orderBy: { updatedAt: 'desc' },
    take: MAX_PROPERTIES,
  });

  const counts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  const topProperties = rows.slice(0, 5).map((row) => {
    const data = objectOrEmpty(row.data);
    return {
      id: row.id,
      name: row.name,
      bookings: 0,
      roomTypes: Array.isArray(data.rooms) ? data.rooms.length : 0,
      revenue: 0,
    };
  });

  const currency = rows
    .map((row) => objectOrEmpty(row.data).currency)
    .find((value) => typeof value === 'string' && value) || 'GHS';

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        upcomingArrivals: 0,
        newReservations: 0,
        liveProperties: counts.ACTIVE || 0,
        grossBookingValue: 0,
      },
      currency,
      cancellation: { rate: 0, cancelled: 0, total: 0 },
      actionRequired: {
        messagesAwaitingReply: 0,
        bookingsToReview: 0,
        draftProperties: counts.DRAFT || 0,
      },
      recentBookings: [],
      topProperties,
    },
  });
});

/* ── Properties ─────────────────────────────────────────────────────────── */

exports.listProperties = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const { status, query } = req.query || {};
  const where = { supplierId, status: { not: 'ARCHIVED' } };

  const statusFilter = enumStatus(status);
  if (statusFilter) where.status = statusFilter;

  const search = typeof query === 'string' ? query.trim() : '';
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
      { type: { contains: search, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.stayProperty.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: MAX_PROPERTIES,
  });

  res.status(200).json({
    status: 'success',
    data: { properties: rows.map(serializeProperty) },
  });
});

exports.createProperty = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const payload = sanitizePropertyPayload(req.body);
  const data = { ...defaultPropertyData(), ...payload };

  const name = typeof payload.name === 'string' && payload.name.trim()
    ? payload.name.trim()
    : 'Untitled property';

  const row = await prisma.stayProperty.create({
    data: {
      supplierId,
      name,
      type: typeof payload.type === 'string' ? payload.type : data.type,
      city: typeof payload.city === 'string' ? payload.city : null,
      country: typeof payload.country === 'string' ? payload.country : 'Ghana',
      status: 'DRAFT',
      step: clampStep(payload.step, 0),
      data,
    },
  });

  res.status(201).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

exports.getProperty = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const row = await findOwnedProperty(req.params.id, supplierId);
  res.status(200).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

exports.updateProperty = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const payload = sanitizePropertyPayload(req.body);
  const currentData = objectOrEmpty(existing.data);
  const nextData = { ...currentData, ...payload };

  const name = Object.prototype.hasOwnProperty.call(payload, 'name')
    ? (typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'Untitled property')
    : existing.name;

  const type = Object.prototype.hasOwnProperty.call(payload, 'type')
    ? (typeof payload.type === 'string' ? payload.type : null)
    : existing.type;

  const city = Object.prototype.hasOwnProperty.call(payload, 'city')
    ? (typeof payload.city === 'string' ? payload.city : null)
    : existing.city;

  const country = Object.prototype.hasOwnProperty.call(payload, 'country')
    ? (typeof payload.country === 'string' ? payload.country : null)
    : existing.country;

  const step = Object.prototype.hasOwnProperty.call(payload, 'step')
    ? clampStep(payload.step, existing.step)
    : existing.step;

  const row = await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { name, type, city, country, step, data: nextData },
  });

  res.status(200).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

exports.deleteProperty = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const deleted = await prisma.stayProperty.deleteMany({
    where: { id: req.params.id, supplierId },
  });
  if (!deleted.count) throw new AppError('Property not found', 404);
  res.status(200).json({ status: 'success', data: { ok: true } });
});

exports.submitProperty = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const errors = [];

  if (!existing.name || existing.name === 'Untitled property') {
    errors.push('add a property name');
  }
  if (!data.city || !data.address) errors.push('add a city and street address');
  const hasPin = data.lat !== null && data.lat !== undefined && data.lng !== null && data.lng !== undefined
    && Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lng));
  if (!hasPin) {
    errors.push('place the property pin on the map');
  }

  const photos = Array.isArray(data.photos) ? data.photos : [];
  if (photos.length < 5) errors.push('upload at least 5 photos');

  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  if (rooms.length < 1) errors.push('add at least one room type');

  const ratePlans = Array.isArray(data.ratePlans) ? data.ratePlans : [];
  if (rooms.length > 0 && rooms.some((room) => !ratePlans.some((plan) => plan.roomId === room.id))) {
    errors.push('add at least one rate plan to every room');
  }

  if (!(Number(data.pricePerNight) > 0)) errors.push('set a nightly price above zero');

  if (data.startMode === 'date' && !data.start) errors.push('choose the first bookable date');
  if (!data.longStays) errors.push('answer the 30+ night stays question');

  const agreement = objectOrEmpty(data.agreement);
  if (!agreement.certifyBusiness || !agreement.certifyTerms) {
    errors.push('accept the business and terms certifications');
  }

  if (errors.length) {
    throw new AppError(`Cannot publish property: ${errors.join('; ')}`, 400);
  }

  // Auto-publish for now — the admin review workflow is a later milestone.
  const row = await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { status: 'ACTIVE', step: STEP_MAX },
  });

  res.status(200).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

/* ── Photos ─────────────────────────────────────────────────────────────── */

exports.addPhotos = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);

  let incoming = [];
  if (Array.isArray(req.files) && req.files.length > 0) {
    incoming = req.files.map((file) => file.path).filter(isHttpUrl);
  } else if (Array.isArray(req.body?.photos)) {
    for (const photo of req.body.photos) {
      incoming.push(await normalizePhoto(photo));
    }
  }

  if (incoming.length === 0) throw new AppError('No valid images were uploaded', 400);

  const data = objectOrEmpty(existing.data);
  const photos = Array.isArray(data.photos) ? data.photos : [];
  const nextPhotos = [...photos, ...incoming].slice(0, MAX_PHOTOS);

  await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { data: { ...data, photos: nextPhotos } },
  });

  res.status(200).json({
    status: 'success',
    data: { photos: nextPhotos },
  });
});

exports.removePhoto = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const photos = Array.isArray(data.photos) ? [...data.photos] : [];
  const index = Number(req.params.index);

  if (!Number.isInteger(index) || index < 0 || index >= photos.length) {
    throw new AppError('Photo not found', 404);
  }

  photos.splice(index, 1);
  await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { data: { ...data, photos } },
  });

  res.status(200).json({
    status: 'success',
    data: { photos },
  });
});

/* ── Rate plans ─────────────────────────────────────────────────────────── */

exports.saveRatePlan = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const plan = objectOrEmpty(req.body);

  if (!plan.roomId || !rooms.some((room) => room.id === plan.roomId)) {
    throw new AppError('Rate plan must target a room on this property', 400);
  }

  const plans = Array.isArray(data.ratePlans) ? [...data.ratePlans] : [];
  const planId = req.params.planId || plan.id || `plan-${crypto.randomUUID()}`;
  const index = plans.findIndex((row) => row.id === planId);

  if (req.params.planId && index === -1) {
    throw new AppError('Rate plan not found', 404);
  }

  const saved = { ...plan, id: planId, roomId: plan.roomId };
  if (index >= 0) plans[index] = { ...plans[index], ...saved };
  else plans.push(saved);

  const row = await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { data: { ...data, ratePlans: plans } },
  });

  res.status(200).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

exports.deleteRatePlan = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const plans = Array.isArray(data.ratePlans) ? [...data.ratePlans] : [];
  const plan = plans.find((row) => row.id === req.params.planId);

  if (!plan) throw new AppError('Rate plan not found', 404);

  const siblings = plans.filter((row) => row.roomId === plan.roomId);
  if (siblings.length <= 1) {
    throw new AppError('Keep at least one rate plan for this room', 400);
  }

  const nextPlans = plans.filter((row) => row.id !== req.params.planId);
  const row = await prisma.stayProperty.update({
    where: { id: existing.id },
    data: { data: { ...data, ratePlans: nextPlans } },
  });

  res.status(200).json({
    status: 'success',
    data: { property: serializeProperty(row) },
  });
});

/* ── Availability ───────────────────────────────────────────────────────── */

exports.getAvailability = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const roomIds = new Set(rooms.map((room) => room.id));

  const where = { propertyId: existing.id };
  const from = req.query?.from ? parseDateKey(req.query.from) : null;
  const to = req.query?.to ? parseDateKey(req.query.to) : null;
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = from;
    if (to) where.date.lte = to;
  }

  const rows = await prisma.stayAvailabilityOverride.findMany({
    where,
    orderBy: { date: 'asc' },
  });

  const overrides = {};
  for (const row of rows) {
    if (!roomIds.has(row.roomId)) continue;
    const value = {};
    if (row.count !== null) value.count = row.count;
    if (row.closed) value.closed = true;
    if (row.price !== null) value.price = Number(row.price);
    if (row.minStay !== null) value.minStay = row.minStay;
    overrides[`${row.roomId}|${dateKey(row.date)}`] = value;
  }

  res.status(200).json({
    status: 'success',
    data: {
      overrides,
      currency: typeof data.currency === 'string' && data.currency ? data.currency : 'GHS',
    },
  });
});

exports.setAvailabilityCell = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const data = objectOrEmpty(existing.data);
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];
  const { roomId, date, count, closed, price, minStay } = req.body || {};

  if (!rooms.some((room) => room.id === roomId)) {
    throw new AppError('Room not found on this property', 400);
  }

  const parsedDate = parseDateKey(date);
  if (!parsedDate) throw new AppError('Invalid date', 400);

  const provided = {};
  if (count !== undefined) provided.count = count;
  if (closed !== undefined) provided.closed = Boolean(closed);
  if (price !== undefined) provided.price = price;
  if (minStay !== undefined) provided.minStay = minStay;

  await prisma.stayAvailabilityOverride.upsert({
    where: {
      propertyId_roomId_date: {
        propertyId: existing.id,
        roomId,
        date: parsedDate,
      },
    },
    create: {
      propertyId: existing.id,
      roomId,
      date: parsedDate,
      ...provided,
    },
    update: provided,
  });

  res.status(200).json({ status: 'success', data: { ok: true } });
});

exports.clearAvailabilityCell = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const existing = await findOwnedProperty(req.params.id, supplierId);
  const parsedDate = parseDateKey(req.query?.date);
  if (!parsedDate) throw new AppError('Invalid date', 400);

  await prisma.stayAvailabilityOverride.deleteMany({
    where: {
      propertyId: existing.id,
      roomId: req.query.roomId,
      date: parsedDate,
    },
  });

  res.status(200).json({ status: 'success', data: { ok: true } });
});

// Exported for unit tests.
exports._private = {
  defaultPropertyData,
  sanitizePropertyPayload,
  serializeProperty,
  displayStatus,
  enumStatus,
  clampStep,
};
