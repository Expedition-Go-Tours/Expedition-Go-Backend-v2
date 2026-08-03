'use strict';

/**
 * ISO 4217 currency support.
 *
 * Provides the authoritative whitelist of active 3-letter currency codes and
 * the price bounds enforced by write-time validation, publish validation, and
 * checkout pricing. Centralized here so the Zod schema (productSchema), stored
 * pricing validation (validateStoredPricing), and checkout math
 * (calculateTourPrice) all agree on the same rules.
 */

const ISO_CURRENCY_CODES = new Set([
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN',
  'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF', 'BMD', 'BND', 'BOB', 'BOV', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD',
  'CAD', 'CDF', 'CHE', 'CHF', 'CHW', 'CLF', 'CLP', 'CNY', 'COP', 'COU', 'CRC', 'CUC', 'CUP', 'CVE', 'CZK',
  'DJF', 'DKK', 'DOP', 'DZD',
  'EGP', 'ERN', 'ETB', 'EUR',
  'FJD', 'FKP',
  'GBP', 'GEL', 'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD',
  'HKD', 'HNL', 'HRK', 'HTG', 'HUF',
  'IDR', 'ILS', 'INR', 'IQD', 'IRR', 'ISK',
  'JMD', 'JOD', 'JPY',
  'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT',
  'LAK', 'LBP', 'LKR', 'LRD', 'LSL', 'LYD',
  'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MXV', 'MYR', 'MZN',
  'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD',
  'OMR',
  'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG',
  'QAR',
  'RON', 'RSD', 'RUB', 'RWF',
  'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP', 'STN', 'SVC', 'SYP', 'SZL',
  'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS',
  'UAH', 'UGX', 'USD', 'USN', 'UYI', 'UYU', 'UYW', 'UZS',
  'VED', 'VES', 'VND', 'VUV',
  'WST',
  'XAF', 'XCD', 'XDR', 'XOF', 'XPF',
  'YER',
  'ZAR', 'ZMW', 'ZWL',
]);

/** Upper bound for stored prices — matches Prisma Decimal(10,2) (99,999,999.99). */
const MAX_PRICE = 99999999;

/**
 * Return true when the value is a valid ISO 4217 currency code.
 */
function isValidCurrencyCode(value) {
  return typeof value === 'string' && ISO_CURRENCY_CODES.has(value.trim().toUpperCase());
}

/**
 * Normalize a raw currency value to a safe ISO 4217 code for downstream
 * payment/display use. Falls back to 'USD' when missing or invalid so Stripe
 * never receives an empty or bogus currency.
 */
function normalizeCurrency(value) {
  return isValidCurrencyCode(value) ? value.trim().toUpperCase() : 'USD';
}

module.exports = { ISO_CURRENCY_CODES, MAX_PRICE, isValidCurrencyCode, normalizeCurrency };
