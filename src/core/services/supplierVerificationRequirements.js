/**
 * Per-operator verification requirements — the single source of truth for what
 * each supplier type must provide, once at registration ("upfront") and later
 * from the supplier dashboard ("later").
 *
 * This module is the ONLY place the rules exist. The storefront wizard asks the
 * server for them (`GET /suppliers/requirements`) instead of keeping its own
 * copy, and `apply` derives the up-front subset it enforces from here, so the
 * promise made at signup, the checklist in the dashboard and the enforced set
 * cannot drift apart.
 *
 * Two shapes of "type" are in play and both matter:
 *   - `supplierChoice` — the six cards on step 2 of the wizard. A registered
 *     company and a sole proprietor are both `TOUR_COMPANY`, so the enum alone
 *     cannot tell them apart.
 *   - `supplierType`   — the Prisma enum, which is what the database stores.
 * `resolveSupplierChoice` maps one onto the other, and rows that predate the
 * persisted choice are inferred from `businessType`.
 */

const DOCUMENT_LABELS = {
  GHANA_CARD: 'Ghana Card',
  NATIONAL_ID: 'National ID',
  BUSINESS_CERTIFICATE: 'Business registration certificate',
  GTA_CERTIFICATE: 'Ghana Tourism Authority licence',
  TOUR_GUIDE_LICENCE: 'Tour guide licence',
  DRIVERS_LICENCE: "Driver's licence",
  PASSENGER_TRANSPORT_LICENCE: 'Passenger transport licence',
  PROFILE_PHOTO: 'Profile photograph',
  PROOF_OF_ADDRESS: 'Proof of address',
  PUBLIC_LIABILITY_INSURANCE: 'Public liability / activity insurance',
  VEHICLE_REGISTRATION: 'Vehicle registration',
  VEHICLE_OWNERSHIP: 'Vehicle ownership document',
  VEHICLE_ROADWORTHINESS: 'Roadworthiness certificate',
  VEHICLE_INSURANCE: 'Vehicle insurance',
  OTHER: 'Other document',
};

/**
 * The sentence shown under each document. It lives here rather than in the UI so
 * the wording a supplier reads at signup is the same string they later read on
 * the dashboard, rather than two phrasings of one rule.
 */
const DOCUMENT_DETAILS = {
  GHANA_CARD:
    'Upload one Ghana Card, passport or another accepted government-issued ID. Your details should match the information on your profile.',
  NATIONAL_ID:
    'Upload a passport or another accepted government-issued ID. Your details should match the information on your profile.',
  BUSINESS_CERTIFICATE:
    'Upload your business registration certificate so we can confirm the business behind this supplier account.',
  PROFILE_PHOTO:
    'A clear, recent photo of you or your business that we can use on your TravioGhana profile.',
  PROOF_OF_ADDRESS:
    'Something that shows where the business is registered, such as a utility bill or a bank statement.',
  GTA_CERTIFICATE: 'May be required before applicable tour listings go live.',
  TOUR_GUIDE_LICENCE: 'Required before you can lead bookable tours on TravioGhana.',
  DRIVERS_LICENCE: 'Required before transport services or vehicle-based tours become bookable.',
  PASSENGER_TRANSPORT_LICENCE: 'Required before transport services or vehicle-based tours become bookable.',
  PUBLIC_LIABILITY_INSURANCE: 'May be required for applicable tours or activities before publishing.',
  VEHICLE_REGISTRATION: 'Required for the vehicle used to fulfil bookings.',
  VEHICLE_OWNERSHIP: 'Proof the vehicle is yours, or that you have the right to use it.',
  VEHICLE_ROADWORTHINESS: 'Required where applicable before the vehicle becomes active.',
  VEHICLE_INSURANCE: 'Required before the vehicle becomes active on TravioGhana.',
  OTHER: 'Anything else we should have on file.',
};

/**
 * ── The 30-day documentation window ─────────────────────────────────────
 * Only the enforced set is required to go live: a government ID, plus the
 * business registration certificate when the account is a business. Once those
 * are uploaded the account is ACTIVE and the supplier has this many days to
 * provide everything else ("later", per-vehicle and per-guide documents) from
 * the dashboard. The deadline is set ONCE when the window starts and the same
 * constant is served to the storefront wizard and the supplier dashboard, so
 * the promise made at signup and the countdown shown later can never drift.
 */
const DOCUMENTATION_GRACE_DAYS = 30;

/** The enforced set — the ONLY document types a supplier must provide to go live. */
function enforcedUpfrontRequirementTypes(requirements) {
  return (requirements?.documents || [])
    .filter((doc) => doc.enforced && doc.timing === 'upfront')
    .map((doc) => doc.type);
}

const IDENTITY_TYPES = new Set(['GHANA_CARD', 'NATIONAL_ID']);

function isIdentityType(type) {
  return IDENTITY_TYPES.has(String(type || '').toUpperCase());
}

/**
 * True when every enforced document has an uploaded file for the supplier.
 * A Ghana Card and a national ID both satisfy the identity requirement, so
 * either is accepted for the identity type the engine asks for.
 */
function isEnforcedSetSatisfied({ requirements, uploadedTypes = [] }) {
  const enforced = enforcedUpfrontRequirementTypes(requirements);
  if (enforced.length === 0) return false;
  const uploaded = new Set(uploadedTypes);
  const has = (type) =>
    isIdentityType(type)
      ? uploaded.has('GHANA_CARD') || uploaded.has('NATIONAL_ID')
      : uploaded.has(type);
  return enforced.every(has);
}

/** The date the documentation window ends: `graceDays` after the start. */
function documentationDeadlineAfter(start = new Date(), graceDays = DOCUMENTATION_GRACE_DAYS) {
  const deadline = new Date(start.getTime());
  deadline.setUTCDate(deadline.getUTCDate() + graceDays);
  return deadline;
}

/** Supplier types that trade as a business (need a business certificate). */
const BUSINESS_SUPPLIER_TYPES = new Set([
  'TOUR_COMPANY',
  'TRANSPORTATION_PROVIDER',
  'ACCOMMODATION_PROVIDER',
]);

/**
 * The six cards on step 2 of the storefront wizard, keyed by the stable id the
 * wizard persists. This mirrors `SUPPLIER_TYPE_OPTIONS` in the storefront's
 * `lib/supplierRegistration.ts`; the two are compared by
 * `__tests__/unit/supplierVerificationRequirements.test.js` so they cannot
 * disagree about which enum each choice maps to.
 */
const SUPPLIER_CHOICES = {
  registered_company: {
    label: 'Registered Company',
    supplierType: 'TOUR_COMPANY',
    businessType: 'company',
    kind: 'business',
  },
  sole_proprietor: {
    label: 'Sole Proprietor / Business',
    supplierType: 'TOUR_COMPANY',
    businessType: 'individual',
    kind: 'business',
  },
  individual_guide: {
    label: 'Individual Tour Guide',
    supplierType: 'TOUR_GUIDE',
    businessType: 'individual',
    kind: 'individual',
  },
  experience_host: {
    label: 'Independent Experience Host',
    supplierType: 'OTHER_SERVICE_PROVIDER',
    businessType: 'individual',
    kind: 'individual',
  },
  transport_company: {
    label: 'Transport Company',
    supplierType: 'TRANSPORTATION_PROVIDER',
    businessType: 'company',
    kind: 'business',
  },
  independent_driver: {
    label: 'Independent Driver',
    supplierType: 'VEHICLE_OPERATOR',
    businessType: 'individual',
    kind: 'individual',
  },
};

const SUPPLIER_CHOICE_IDS = Object.keys(SUPPLIER_CHOICES);

/** Documents every vehicle must carry once the operator is a vehicle operator. */
const FULL_VEHICLE_DOCUMENTS = [
  'VEHICLE_REGISTRATION',
  'VEHICLE_OWNERSHIP',
  'VEHICLE_ROADWORTHINESS',
  'VEHICLE_INSURANCE',
];

/** A lighter set for operators who may only occasionally put a vehicle on sale. */
const BASIC_VEHICLE_DOCUMENTS = ['VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE'];

/** Documents each guide must carry. */
const GUIDE_DOCUMENTS = ['TOUR_GUIDE_LICENCE'];

/**
 * `operatingInfo.services` stores the storefront's labels ("Tours & Activities",
 * "Airport Transfers", "Private Transport", "Other Experience"), but older rows
 * may hold the raw ids — match on either, case-insensitively.
 */
function hasToursService(services = []) {
  return services.some((service) => /tour|experience|activit/.test(String(service).toLowerCase()));
}

function hasTransportService(services = []) {
  return services.some((service) =>
    /transport|transfer|airport|driver|chauffeur|shuttle|rental/.test(String(service).toLowerCase())
  );
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

/**
 * Resolve the six-way wizard choice.
 *
 * Prefers the explicitly stored `supplierChoice`; falls back to inferring it
 * from the enum plus `businessInfo.businessType` for rows created before the
 * choice was persisted. Returns null for a type the wizard never offers
 * (accommodation providers, which have their own onboarding path) so callers
 * can tell "we know this one" from "we have never seen it".
 */
function resolveSupplierChoice({ supplierChoice, supplierType, businessType } = {}) {
  const explicit = String(supplierChoice || '').trim();
  if (explicit && Object.prototype.hasOwnProperty.call(SUPPLIER_CHOICES, explicit)) {
    return explicit;
  }

  const type = String(supplierType || '').trim().toUpperCase();
  const isCompany = String(businessType || '').trim().toLowerCase() === 'company';

  if (type === 'TOUR_COMPANY') return isCompany ? 'registered_company' : 'sole_proprietor';
  if (type === 'TOUR_GUIDE') return 'individual_guide';
  if (type === 'OTHER_SERVICE_PROVIDER') return 'experience_host';
  if (type === 'TRANSPORTATION_PROVIDER') return 'transport_company';
  if (type === 'VEHICLE_OPERATOR') return 'independent_driver';
  return null;
}

function document(type, required, timing, ownerType = 'SUPPLIER') {
  return {
    type,
    label: DOCUMENT_LABELS[type] || DOCUMENT_LABELS.OTHER,
    detail: DOCUMENT_DETAILS[type] || DOCUMENT_DETAILS.OTHER,
    required: Boolean(required),
    timing,
    ownerType,
    // Only the up-front set is enforced: `apply` rejects a submission missing
    // one of these. "Later" documents are requested, never a condition of
    // submitting or publishing, and the UI says so.
    enforced: timing === 'upfront' && Boolean(required),
  };
}

/**
 * The full verification profile for a supplier.
 *
 * @param {object} input
 * @param {string} [input.supplierChoice] The wizard's six-way id, if known.
 * @param {string} input.supplierType Prisma SupplierType
 * @param {'company'|'individual'} [input.businessType] Distinguishes a
 *   registered company from a sole proprietor (both are TOUR_COMPANY).
 * @param {string[]} [input.services] `operatingInfo.services`
 * @param {string} [input.country] `businessInfo.country` (ISO 3166-1 alpha-2)
 */
function requirementsFor({ supplierChoice, supplierType, businessType, services = [], country } = {}) {
  const isGhana = String(country || '').trim().toUpperCase() === 'GH';
  const identityType = isGhana ? 'GHANA_CARD' : 'NATIONAL_ID';
  const serviceList = asArray(services);
  const tours = hasToursService(serviceList);
  const transport = hasTransportService(serviceList);

  const explicitChoice = String(supplierChoice || '').trim();
  const hasExplicitChoice =
    Boolean(explicitChoice) && Object.prototype.hasOwnProperty.call(SUPPLIER_CHOICES, explicitChoice);

  // The six-way choice is MORE specific than the enum — registered_company and
  // sole_proprietor are both TOUR_COMPANY — so when it is known it wins, and
  // it also answers on its own. The wizard has only the choice in hand at step
  // 2, long before a profile exists.
  const choice = resolveSupplierChoice({ supplierChoice, supplierType, businessType });
  const choiceMeta = choice ? SUPPLIER_CHOICES[choice] : null;
  const type = hasExplicitChoice
    ? choiceMeta.supplierType
    : String(supplierType || '').trim().toUpperCase();
  const resolvedBusinessType = hasExplicitChoice
    ? choiceMeta.businessType
    : String(businessType || '').trim().toLowerCase();
  const kind = hasExplicitChoice
    ? choiceMeta.kind
    : BUSINESS_SUPPLIER_TYPES.has(type)
      ? 'business'
      : 'individual';
  const isRegisteredCompany = type === 'TOUR_COMPANY' && resolvedBusinessType === 'company';

  // ── Up front: collected during registration and enforced by `apply` ──────
  const documents = [document(identityType, true, 'upfront')];
  if (BUSINESS_SUPPLIER_TYPES.has(type)) {
    documents.push(document('BUSINESS_CERTIFICATE', true, 'upfront'));
  }

  // ── Later: requested on the dashboard, never a condition of going live ──
  const addLater = (docType) => {
    if (!documents.some((doc) => doc.type === docType)) {
      documents.push(document(docType, true, 'later'));
    }
  };

  // Everyone needs a profile photo; the other identity-side paperwork depends
  // on whether a business or a person stands behind the account.
  addLater('PROFILE_PHOTO');
  if (kind === 'business') addLater('PROOF_OF_ADDRESS');

  // A business selling tours needs the authority to sell one (GTA certificate)
  // and cover for running it (public liability). Individuals hold their own
  // credential instead — the tour-guide licence for guides, nothing extra for
  // experience hosts — so they are never asked for the operator certificate.
  if (tours && kind === 'business') {
    addLater('GTA_CERTIFICATE');
    addLater('PUBLIC_LIABILITY_INSURANCE');
  }

  switch (type) {
    case 'TOUR_COMPANY':
      // Nothing type-specific: the authority to sell tours is the GTA
      // certificate above, and a registered company covers it as an operator.
      break;
    case 'TRANSPORTATION_PROVIDER':
    case 'VEHICLE_OPERATOR':
      addLater('PASSENGER_TRANSPORT_LICENCE');
      addLater('DRIVERS_LICENCE');
      break;
    case 'TOUR_GUIDE':
      // A guide leads under their own licence. The GTA certificate belongs to
      // the operator, not to the person holding the guide licence, so it is
      // only added above for an account that sells tours as a business.
      addLater('TOUR_GUIDE_LICENCE');
      break;
    case 'ACCOMMODATION_PROVIDER':
    case 'OTHER_SERVICE_PROVIDER':
    default:
      break;
  }

  // A guide who also drives needs a licence of their own on file.
  if (type === 'TOUR_GUIDE' && transport) addLater('DRIVERS_LICENCE');

  // ── Entities (vehicles / guides) relevant to this operator ──────────────
  let vehicles = 'hidden';
  let guides = 'hidden';

  if (type === 'TRANSPORTATION_PROVIDER' || type === 'VEHICLE_OPERATOR') {
    vehicles = 'required';
  } else if (transport) {
    vehicles = 'optional';
  }

  if (isRegisteredCompany) {
    // A registered company is expected to work with guides; a sole proprietor
    // may act alone, so the section is offered rather than required.
    guides = 'required';
  } else if (type === 'TOUR_COMPANY' || type === 'TRANSPORTATION_PROVIDER') {
    guides = 'optional';
  }

  // Per-entity documents, so a vehicle created without insurance can be
  // repaired instead of deleted and rebuilt.
  const vehicleDocumentTypes =
    vehicles === 'required' ? FULL_VEHICLE_DOCUMENTS : BASIC_VEHICLE_DOCUMENTS;
  const guideDocumentTypes =
    type === 'TOUR_COMPANY' || type === 'TRANSPORTATION_PROVIDER' ? GUIDE_DOCUMENTS : [];

  return {
    supplierType: type,
    supplierChoice: choice,
    supplierChoiceLabel: choiceMeta ? choiceMeta.label : null,
    // The 30-day window for the non-required documents — served to both the
    // signup wizard and the dashboard so they promise/demand the same span.
    documentationGraceDays: DOCUMENTATION_GRACE_DAYS,
    documents,
    vehicleDocuments:
      vehicles === 'hidden'
        ? []
        : vehicleDocumentTypes.map((docType) => document(docType, true, 'per_vehicle', 'VEHICLE')),
    guideDocuments:
      guides === 'hidden'
        ? []
        : guideDocumentTypes.map((docType) => document(docType, true, 'per_guide', 'GUIDE')),
    vehicles,
    guides,
  };
}

/** The subset collected at registration — what `apply` enforces. */
function upfrontSupplierDocumentTypes(supplierType, country) {
  return requirementsFor({ supplierType, country }).documents
    .filter((doc) => doc.timing === 'upfront' && doc.required)
    .map((doc) => doc.type);
}

module.exports = {
  DOCUMENT_LABELS,
  DOCUMENT_DETAILS,
  SUPPLIER_CHOICES,
  SUPPLIER_CHOICE_IDS,
  DOCUMENTATION_GRACE_DAYS,
  enforcedUpfrontRequirementTypes,
  isEnforcedSetSatisfied,
  documentationDeadlineAfter,
  requirementsFor,
  resolveSupplierChoice,
  upfrontSupplierDocumentTypes,
};
