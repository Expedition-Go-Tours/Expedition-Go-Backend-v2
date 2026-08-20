/**
 * Commission helpers - shared rate normalization utilities.
 */

const DEFAULT_COMMISSION_RATE = 0.15;

/**
 * Normalize a commission rate config value into a decimal fraction in (0, 1].
 *
 * Accepts both decimal-fraction ("0.15") and percentage ("15") input so a
 * misconfigured value can never overflow the Booking.commissionRate
 * Decimal(5,4) column (max 9.9999) or produce an invalid commission split.
 * Invalid/missing input falls back to the provided fallback (default 0.15).
 *
 * @param {*} raw - raw value from SystemConfig (string/number) or anything
 * @param {number} [fallback=DEFAULT_COMMISSION_RATE] - safe default when raw is unusable
 * @returns {number|null} commission rate as a fraction clamped to (0, 1],
 *   or the fallback (which may be null) when raw cannot be parsed
 */
function normalizeCommissionRate(raw, fallback = DEFAULT_COMMISSION_RATE) {
  let rate = parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) {
    return fallback;
  }
  // Tolerate percentage-style input ("15" -> 0.15)
  if (rate > 1) {
    rate = rate / 100;
  }
  return Math.min(rate, 1);
}

module.exports = {
  normalizeCommissionRate,
  DEFAULT_COMMISSION_RATE,
};
