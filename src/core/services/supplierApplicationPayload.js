/**
 * Validation + normalisation for the supplier application payload
 * (POST /suppliers/apply, PATCH /suppliers/application).
 *
 * The multipart JSON sections used to be stored verbatim, which meant a bad
 * `supplierType` reached Prisma and surfaced as a 500, and malformed sections
 * produced applications the admin dashboard renders as blank fields. This module
 * keeps the accepted contract deliberately tolerant — it mirrors what the
 * storefront and the legacy clients send — while rejecting payloads that would
 * create broken records.
 *
 * @see routes/supplierRoutes.js (multipart contract)
 * @see config/supplierUploadFields.js (upload fields + limits)
 */
const { SupplierType, PayoutCycle } = require('@prisma/client');
const { upfrontSupplierDocumentTypes } = require('./supplierVerificationRequirements');

const SUPPLIER_TYPE_VALUES = Object.values(SupplierType);
const PAYOUT_CYCLE_VALUES = Object.values(PayoutCycle);
const BUSINESS_TYPE_VALUES = ['individual', 'company', 'non_profit'];
const PAYOUT_METHOD_VALUES = ['bank', 'paypal', 'momo'];

/** Historic default when the client omits supplierType. */
const DEFAULT_SUPPLIER_TYPE = 'TOUR_COMPANY';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Uppercased supplier type, defaulting to TOUR_COMPANY (historic behaviour). */
function normalizeSupplierType(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_SUPPLIER_TYPE;
  return String(value).trim().toUpperCase();
}

/** Parse a JSON string section from a multipart body (objects pass through). */
function parseSection(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * @param {object} payload The parsed sections + supplierType.
 * @param {{ partial?: boolean }} [options] `partial` skips the "section must be
 *   present" rule (PATCH sends only the sections being changed).
 * @returns {{ errors: string[], supplierType: string }} Validation errors in a
 *   human-readable form (safe to return to the client) + the normalised type.
 */
function validateSupplierApplication(payload = {}, options = {}) {
  const { partial = false } = options;
  const errors = [];

  const supplierType = normalizeSupplierType(payload.supplierType);
  if (
    payload.supplierType !== undefined &&
    payload.supplierType !== null &&
    payload.supplierType !== '' &&
    !SUPPLIER_TYPE_VALUES.includes(supplierType)
  ) {
    errors.push(`supplierType must be one of: ${SUPPLIER_TYPE_VALUES.join(', ')}`);
  }

  const sections = ['businessInfo', 'operatingInfo', 'representativeInfo', 'payoutInfo'];
  for (const name of sections) {
    const value = payload[name];
    if (value === undefined || value === null) {
      if (!partial) errors.push(`${name} is required`);
      continue;
    }
    if (!isPlainObject(value)) errors.push(`${name} must be an object`);
  }

  const business = isPlainObject(payload.businessInfo) ? payload.businessInfo : null;
  if (business) {
    const name = business.legalBusinessName || business.displayName || business.businessName;
    if (!nonEmptyString(name)) {
      errors.push('businessInfo.legalBusinessName or businessInfo.displayName is required');
    }
    if (business.businessType !== undefined && !BUSINESS_TYPE_VALUES.includes(business.businessType)) {
      errors.push(`businessInfo.businessType must be one of: ${BUSINESS_TYPE_VALUES.join(', ')}`);
    }
    // `country` drives Ghana-only publishing/payout behaviour, so a malformed
    // value would silently look like a non-Ghana supplier.
    if (business.country !== undefined && business.country !== null) {
      if (typeof business.country !== 'string' || !/^[A-Za-z]{2}$/.test(business.country.trim())) {
        errors.push('businessInfo.country must be an ISO 3166-1 alpha-2 code (e.g. "GH")');
      }
    }
    if (business.phoneNumber !== undefined && business.phoneNumber !== null) {
      if (!nonEmptyString(business.phoneNumber)) errors.push('businessInfo.phoneNumber must be a string');
    }
  }

  const operating = isPlainObject(payload.operatingInfo) ? payload.operatingInfo : null;
  if (operating) {
    if (operating.regions !== undefined && !Array.isArray(operating.regions)) {
      errors.push('operatingInfo.regions must be an array');
    }
    if (operating.yearsInBusiness !== undefined && operating.yearsInBusiness !== null) {
      const years = Number(operating.yearsInBusiness);
      if (!Number.isFinite(years) || years < 0 || years > 100) {
        errors.push('operatingInfo.yearsInBusiness must be a number between 0 and 100');
      }
    }
  }

  const representative = isPlainObject(payload.representativeInfo) ? payload.representativeInfo : null;
  if (representative) {
    if (!nonEmptyString(representative.fullName)) {
      errors.push('representativeInfo.fullName is required');
    }
    if (
      representative.email !== undefined &&
      representative.email !== null &&
      !(typeof representative.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(representative.email.trim()))
    ) {
      errors.push('representativeInfo.email must be a valid email address');
    }
  }

  const payout = isPlainObject(payload.payoutInfo) ? payload.payoutInfo : null;
  if (payout) {
    if (payout.schedule !== undefined && payout.schedule !== null && payout.schedule !== '') {
      const schedule = String(payout.schedule).trim().toUpperCase();
      if (!PAYOUT_CYCLE_VALUES.includes(schedule)) {
        errors.push(`payoutInfo.schedule must be one of: ${PAYOUT_CYCLE_VALUES.join(', ')}`);
      }
    }
    if (payout.method !== undefined && payout.method !== null && payout.method !== '') {
      if (!PAYOUT_METHOD_VALUES.includes(String(payout.method).trim().toLowerCase())) {
        errors.push(`payoutInfo.method must be one of: ${PAYOUT_METHOD_VALUES.join(', ')}`);
      }
    }
    if (payout.payoutCurrency !== undefined && payout.payoutCurrency !== null && payout.payoutCurrency !== '') {
      if (typeof payout.payoutCurrency !== 'string' || !/^[A-Za-z]{3}$/.test(payout.payoutCurrency.trim())) {
        errors.push('payoutInfo.payoutCurrency must be an ISO 4217 code (e.g. "GHS")');
      }
    }
  }

  if (payload.compliance !== undefined && payload.compliance !== null && !isPlainObject(payload.compliance)) {
    errors.push('compliance must be an object');
  }

  return { errors, supplierType };
}

/** The supplier's chosen cadence, when it is a valid PayoutCycle. */
function requestedPayoutCycle(payoutInfo) {
  const requested = isPlainObject(payoutInfo) ? String(payoutInfo.schedule || '').trim().toUpperCase() : '';
  return PAYOUT_CYCLE_VALUES.includes(requested) ? requested : null;
}

/**
 * Document types a supplier must attach on submission, per supplier type.
 * Derived from the shared verification requirements so the enforced up-front
 * set and the dashboard checklist cannot drift.
 */
function requiredSupplierDocumentTypes(supplierType, country) {
  return upfrontSupplierDocumentTypes(normalizeSupplierType(supplierType), country);
}

/**
 * Turn the application's `payoutInfo` into the fields of the supplier's first
 * `PayoutMethod` row.
 *
 * TravioGhana admits suppliers immediately, so the details they typed at
 * sign-up have to exist in the dashboard already — otherwise they land on an
 * empty payout settings page and retype everything. Returns null when the
 * applicant did not provide enough for the chosen method.
 */
function payoutMethodFromApplication(payoutInfo) {
  if (!isPlainObject(payoutInfo)) return null;
  const clean = (value) => {
    const text = String(value == null ? '' : value).trim();
    return text || undefined;
  };
  const currency = clean(payoutInfo.payoutCurrency);
  const method = String(payoutInfo.method || '').trim().toLowerCase();
  const type = {
    bank: 'BANK_TRANSFER',
    bank_transfer: 'BANK_TRANSFER',
    paypal: 'PAYPAL',
    momo: 'MOBILE_MONEY',
    mobile_money: 'MOBILE_MONEY',
  }[method];
  if (!type) return null;

  if (type === 'BANK_TRANSFER') {
    const accountName = clean(payoutInfo.bankAccountName);
    const accountNumber = clean(payoutInfo.bankAccountNumber);
    if (!accountName && !accountNumber) return null;
    return {
      type,
      currency: currency || 'GHS',
      bankName: clean(payoutInfo.bankName),
      bankCountry: clean(payoutInfo.bankCountry),
      accountName,
      accountNumber,
    };
  }

  if (type === 'PAYPAL') {
    const paypalEmail = clean(payoutInfo.paypalEmail);
    if (!paypalEmail) return null;
    return { type, currency: currency || 'USD', paypalEmail, accountName: clean(payoutInfo.paypalAccountName) };
  }

  const mobileNumber = clean(payoutInfo.momoNumber);
  const mobileProvider = clean(payoutInfo.momoNetwork);
  if (!mobileNumber && !mobileProvider) return null;
  return {
    type,
    currency: currency || 'GHS',
    accountName: clean(payoutInfo.momoAccountName),
    mobileProvider,
    mobileNumber,
  };
}

module.exports = {
  BUSINESS_TYPE_VALUES,
  PAYOUT_METHOD_VALUES,
  PAYOUT_CYCLE_VALUES,
  SUPPLIER_TYPE_VALUES,
  normalizeSupplierType,
  parseSection,
  payoutMethodFromApplication,
  requestedPayoutCycle,
  requiredSupplierDocumentTypes,
  validateSupplierApplication,
};
