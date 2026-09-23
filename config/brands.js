/**
 * Brand registry — single source of truth for the three storefront brands.
 *
 *   expedition — "Expedition Go Tours": a storefront-only sub-store owned by the
 *                Ghana ecosystem. No supplier or admin dashboards of its own.
 *   ghana      — Travio Ghana: full ecosystem (storefront + supplier + admin).
 *   africa     — Travio Africa: full ecosystem (storefront + supplier + admin),
 *                the pan-African end goal, fully independent of Ghana/Expedition.
 *
 * Every brand identity value (domain, URL, BookingSource enum, UserRole, booking
 * prefix, cache namespace, event namespace, support email, Google OAuth env vars)
 * lives here. Code that branches on brand reads from this registry instead of
 * hardcoding strings.
 *
 * Legacy alias: the pre-existing auth/brand code used the key `default` for
 * Travio Africa. `resolveBrandKey` maps it to `africa` so old call sites keep
 * working while new code uses the canonical key.
 */

const BRANDS = {
  expedition: {
    key: 'expedition',
    brandName: 'Expedition-Go Tours',
    source: 'EXPEDITION', // BookingSource enum
    role: 'expedition', // UserRole enum
    bookingPrefix: 'EXP',
    storefrontDomain: 'expeditiongotours.com',
    storefrontUrl: 'https://expeditiongotours.com',
    supportEmail: 'support@expeditiongo.com',
    // Email identity. Expedition is Ghana's sub-store: it deliberately shares
    // Ghana's template, logo and support inbox, so the email says
    // "Expedition-Go Tours" as the badge under the logo and as the
    // body/footer name. The From: header stays on the shared Ghana sender.
    email: {
      logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1789926536/TravioG_csfsyl.png',
      brandName: 'Expedition-Go Tours',
      supportEmail: 'support@travioghana.com',
      from: 'Travio Ghana <notifications@travioghana.com>',
      poweredByLabel: 'Expedition-Go Tours',
      receivingDomain: 'travioghana.com',
    },
    cachePrefix: 'expedition:',
    eventNamespace: 'expedition',
    listingModel: 'expeditionTour', // Prisma model (camelCase)
    listingTableName: 'ExpeditionTour', // DB table name (raw SQL)
    placeScope: 'expeditionOnly', // placeTourIds() scope flag
    googleOAuth: {
      strategy: 'google-expedition',
      idVar: 'GOOGLE_CLIENT_ID_EXPEDITION',
      secretVar: 'GOOGLE_CLIENT_SECRET_EXPEDITION',
      callbackVar: 'GOOGLE_CALLBACK_URL_EXPEDITION',
      callbackFallback: 'https://api.expeditiongotours.com/api/auth/google/callback',
    },
    policies: {
      usesCombinedRating: true,
      includesSpecialOffers: true,
      supplierBookingsFilterBySource: true,
      paymentElementFlow: true,
    },
  },
  ghana: {
    key: 'ghana',
    brandName: 'Travio Ghana',
    source: 'GHANA', // BookingSource enum
    role: 'ghana', // UserRole enum
    bookingPrefix: 'GHA',
    storefrontDomain: 'travioghana.com',
    storefrontUrl: 'https://travioghana.com',
    supplierDashboardUrl: 'https://supplier.travioghana.com',
    supportEmail: 'support@travioghana.com',
    email: {
      logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1789926536/TravioG_csfsyl.png',
      brandName: 'Travio Ghana',
      supportEmail: 'support@travioghana.com',
      from: 'Travio Ghana <notifications@travioghana.com>',
      poweredByLabel: null,
      receivingDomain: 'travioghana.com',
    },
    cachePrefix: 'ghana:',
    eventNamespace: 'ghana',
    listingModel: 'travioGhanaTour', // Prisma model (camelCase)
    listingTableName: 'TravioGhanaTour', // DB table name (raw SQL)
    placeScope: 'ghanaOnly', // placeTourIds() scope flag
    // Ghana suppliers' tours can also be published to the Expedition sub-store;
    // getSupplierTours/getSupplierReviews query these extra listing models too.
    secondaryListingModels: ['expeditionTour'],
    googleOAuth: {
      strategy: 'google-ghana',
      idVar: 'GOOGLE_CLIENT_ID_GHANA',
      secretVar: 'GOOGLE_CLIENT_SECRET_GHANA',
      callbackVar: 'GOOGLE_CALLBACK_URL_GHANA',
      callbackFallback: 'https://api.travioghana.com/api/auth/google/callback',
    },
    policies: {
      usesCombinedRating: false,
      includesSpecialOffers: false,
      supplierBookingsFilterBySource: false,
      paymentElementFlow: false,
    },
  },
  africa: {
    key: 'africa',
    brandName: 'Travio Africa',
    source: 'TRAVIO_AFRICA', // BookingSource enum
    role: 'travioafrica', // UserRole enum
    bookingPrefix: 'AFR',
    storefrontDomain: 'travioafrica.com',
    storefrontUrl: 'https://travioafrica.com',
    supplierDashboardUrl: 'https://supplier.travioafrica.com',
    adminDashboardUrl: 'https://admin.travioafrica.com',
    supportEmail: 'support@travioafrica.com',
    email: {
      logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1778862668/TRAVOI_AFRICA_NEW_kd1tnr.png',
      brandName: 'Travio Africa',
      supportEmail: 'support@travioafrica.com',
      from: 'Travio Africa <notifications@travioafrica.com>',
      poweredByLabel: null,
      // Africa keeps its dedicated receiving subdomain: existing in-flight
      // reply addresses were minted against it and must keep resolving.
      receivingDomain: 'messages.travioafrica.com',
    },
    cachePrefix: 'travioafrica:',
    eventNamespace: 'travioafrica',
    listingModel: 'travioAfricaTour', // Prisma model (camelCase)
    listingTableName: 'TravioAfricaTour', // DB table name (raw SQL)
    placeScope: null, // Africa storefront not built yet
    googleOAuth: {
      strategy: 'google',
      idVar: 'GOOGLE_CLIENT_ID',
      secretVar: 'GOOGLE_CLIENT_SECRET',
      callbackVar: 'GOOGLE_CALLBACK_URL',
      callbackFallback: 'http://localhost:5000/api/auth/google/callback',
    },
    policies: {
      usesCombinedRating: true,
      includesSpecialOffers: false,
      supplierBookingsFilterBySource: false,
      paymentElementFlow: true,
    },
  },
};

const DEFAULT_BRAND = 'africa';

// Legacy key 'default' (TravioAfrica) used by the auth/brand code.
const BRAND_ALIASES = { default: 'africa' };

/** Resolve a possibly-aliased brand key to its canonical key. */
function resolveBrandKey(key) {
  return BRAND_ALIASES[key] || key;
}

/** Return the brand object for a key, falling back to the default brand. */
function getBrand(key) {
  return BRANDS[resolveBrandKey(key)] || BRANDS[DEFAULT_BRAND];
}

function getDefaultBrand() {
  return BRANDS[DEFAULT_BRAND];
}

/**
 * Email identity for a brand (logo, display name, support inbox, From: header,
 * "powered by" badge, receiving domain) with safe fallbacks, so a brand that
 * has no `email` block still renders something sensible.
 */
function getBrandEmail(key) {
  const brand = getBrand(key);
  const e = brand.email || {};
  const brandName = e.brandName || brand.brandName;
  return {
    key: brand.key,
    logoUrl: e.logoUrl || '',
    brandName,
    supportEmail: e.supportEmail || brand.supportEmail,
    from: e.from || `${brandName} <notifications@travioafrica.com>`,
    poweredByLabel: e.poweredByLabel || null,
    receivingDomain: e.receivingDomain || 'messages.travioafrica.com',
  };
}

/** Every configured inbound/reply domain (for the inbound parser allow-list). */
function getReceivingDomains() {
  const set = new Set();
  for (const b of Object.values(BRANDS)) {
    const d = b.email && b.email.receivingDomain;
    if (d) set.add(String(d).toLowerCase());
  }
  return [...set];
}

module.exports = {
  BRANDS,
  DEFAULT_BRAND,
  BRAND_ALIASES,
  resolveBrandKey,
  getBrand,
  getDefaultBrand,
  getBrandEmail,
  getReceivingDomains,
};
