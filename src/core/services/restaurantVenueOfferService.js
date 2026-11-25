/**
 * Admin writes for restaurant venue offers.
 *
 * Offers are brand-scoped: the brand comes from the route, is checked against
 * the body, and is required to match an existing listing on that venue. An
 * admin cannot use a Ghana path to create an offer on another storefront, and
 * a public read can never see an offer switched off or outside its window.
 *
 * Every write invalidates the storefront caches after the row lands. Reads
 * also re-check the window against the current clock and abandon a cached
 * payload at its next offer boundary, so natural expiry is never held until
 * the ordinary cache TTL.
 */

const prisma = require('./prismaClient');
const AppError = require('./appError');
const cache = require('./cacheHelper');
const logger = require('./logger');
const { BRANDS } = require('./restaurantVenueService');

const DISCOUNT_TYPES = ['PERCENTAGE', 'FIXED'];
const OFFER_FIELDS = [
  'title',
  'discountType',
  'discountValue',
  'promoCode',
  'startsAt',
  'endsAt',
  'isActive',
  'terms',
];

function parseOptionalDate(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new AppError(`${field} must be a valid date`, 400, { code: 'INVALID_OFFER_DATE' });
  }
  return at;
}

/**
 * Validate and normalise an admin payload. Zod already rejects most bad input
 * at the HTTP boundary; this is the same contract for direct callers and it
 * also validates the *merged* window on a partial update.
 */
function normalizeOfferData(input, existing = null, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('Invalid offer payload', 400, { code: 'INVALID_OFFER' });
  }
  if (input.brand !== undefined && !BRANDS.includes(input.brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }

  const merged = { ...(existing || {}), ...input };

  if ((!partial || input.title !== undefined) && String(merged.title || '').trim().length < 2) {
    throw new AppError('Offer title is too short', 400, { code: 'INVALID_OFFER_TITLE' });
  }
  if ((!partial || input.discountType !== undefined) && !DISCOUNT_TYPES.includes(merged.discountType)) {
    throw new AppError('discountType must be PERCENTAGE or FIXED', 400, {
      code: 'INVALID_DISCOUNT_TYPE',
    });
  }
  if (!partial || input.discountValue !== undefined) {
    const value = Number(merged.discountValue);
    if (!Number.isFinite(value) || value <= 0) {
      throw new AppError('discountValue must be positive', 400, {
        code: 'INVALID_DISCOUNT_VALUE',
      });
    }
  }

  const startsAt = parseOptionalDate(merged.startsAt, 'startsAt');
  const endsAt = parseOptionalDate(merged.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) {
    throw new AppError('endsAt must be after startsAt', 400, { code: 'INVALID_OFFER_WINDOW' });
  }

  const data = {};
  for (const field of OFFER_FIELDS) {
    if (partial && !Object.prototype.hasOwnProperty.call(input, field)) continue;
    if (field === 'startsAt') data.startsAt = startsAt;
    else if (field === 'endsAt') data.endsAt = endsAt;
    else if (field === 'discountValue') data.discountValue = Number(merged.discountValue);
    else if (field === 'title') data.title = String(merged.title).trim();
    else data[field] = merged[field] ?? null;
  }

  if (!partial && data.isActive === null) data.isActive = true;
  return data;
}

function toAdminOffer(offer) {
  return {
    id: offer.id,
    venueId: offer.venueId,
    brand: offer.brand,
    title: offer.title,
    discountType: offer.discountType,
    discountValue: Number(offer.discountValue),
    promoCode: offer.promoCode || null,
    startsAt: offer.startsAt || null,
    endsAt: offer.endsAt || null,
    isActive: Boolean(offer.isActive),
    terms: offer.terms || null,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
  };
}

async function invalidate(venue) {
  try {
    await cache.invalidateRestaurantVenueCaches(venue.id, venue.slug);
  } catch (error) {
    logger.warn('[cache] restaurant venue offer invalidation failed:', error?.message);
  }
}

/** Admin may prepare an offer for a venue that is not yet live, but the brand listing must exist. */
async function resolveVenue(venueId, brand) {
  if (!BRANDS.includes(brand)) {
    throw new AppError('Unknown brand', 400, { code: 'INVALID_BRAND' });
  }
  const id = String(venueId || '').trim();
  if (!id) return null;

  return prisma.restaurantVenue.findFirst({
    where: { id, listings: { some: { brand } } },
    select: { id: true, slug: true },
  });
}

function assertBrand(input, brand) {
  if (input && input.brand !== undefined && input.brand !== brand) {
    throw new AppError('Offer brand does not match the venue listing', 400, {
      code: 'OFFER_BRAND_MISMATCH',
    });
  }
}

async function listOffers({ venueId, brand } = {}) {
  const venue = await resolveVenue(venueId, brand);
  if (!venue) return null;

  const offers = await prisma.restaurantVenueOffer.findMany({
    where: { venueId: venue.id, brand },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return offers.map(toAdminOffer);
}

async function createOffer({ venueId, brand, input } = {}) {
  const venue = await resolveVenue(venueId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });
  assertBrand(input, brand);

  const data = normalizeOfferData(input, null, false);
  const offer = await prisma.restaurantVenueOffer.create({
    data: { venueId: venue.id, brand, ...data },
  });
  await invalidate(venue);
  return toAdminOffer(offer);
}

async function findOffer(venueId, brand, offerId) {
  const id = String(offerId || '').trim();
  if (!id) return null;
  return prisma.restaurantVenueOffer.findFirst({
    where: { id, venueId, brand },
  });
}

async function updateOffer({ venueId, brand, offerId, input } = {}) {
  const venue = await resolveVenue(venueId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });
  assertBrand(input, brand);

  const existing = await findOffer(venue.id, brand, offerId);
  if (!existing) throw new AppError('Offer not found', 404, { code: 'OFFER_NOT_FOUND' });

  const data = normalizeOfferData(input, existing, true);
  if (Object.keys(data).length === 0) {
    throw new AppError('At least one field is required', 400, { code: 'EMPTY_OFFER_UPDATE' });
  }
  const offer = await prisma.restaurantVenueOffer.update({
    where: { id: existing.id },
    data,
  });
  await invalidate(venue);
  return toAdminOffer(offer);
}

async function deleteOffer({ venueId, brand, offerId } = {}) {
  const venue = await resolveVenue(venueId, brand);
  if (!venue) throw new AppError('Venue not found', 404, { code: 'VENUE_NOT_FOUND' });

  const existing = await findOffer(venue.id, brand, offerId);
  if (!existing) throw new AppError('Offer not found', 404, { code: 'OFFER_NOT_FOUND' });

  await prisma.restaurantVenueOffer.delete({ where: { id: existing.id } });
  await invalidate(venue);
  return { id: existing.id, deleted: true };
}

module.exports = {
  DISCOUNT_TYPES,
  normalizeOfferData,
  toAdminOffer,
  listOffers,
  createOffer,
  updateOffer,
  deleteOffer,
};
