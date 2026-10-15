/**
 * Pay-later charge timing — the single source of truth.
 *
 * A reserve-now-pay-later booking is charged automatically
 * `PAY_LATER_CHARGE_BEFORE_HOURS` (default 24) before the activity date, i.e.
 * at `travelDate − 24h`. Every place that talks about that moment must derive
 * it from `payLaterChargeAt()` so the customer-facing promise ("we charge on
 * <date>") can never drift from what the sweep actually does:
 *
 *   - payLaterSweep.js       charge window   → chargeWindowEnd()
 *   - bookingReminders.js    reminder timing → payLaterChargeAt()
 *   - emailService.js        charge-date copy → payLaterChargeAt()
 *   - admin alerts           charge-date copy → payLaterChargeAt()
 *
 * The offset is expressed relative to the *activity* date rather than as a
 * fixed date, so if the env var is tuned the sweep window, the reminder, the
 * emails and the alerts all move together.
 *
 * Note: this is distinct from payLaterLeadTime.js, which enforces the *minimum
 * booking lead* (how far ahead a customer may reserve-now-pay-later at all).
 */

const DEFAULT_CHARGE_BEFORE_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Hours before the activity date at which the saved card is charged. */
function chargeBeforeHours() {
  const raw = parseFloat(process.env.PAY_LATER_CHARGE_BEFORE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHARGE_BEFORE_HOURS;
}

/**
 * The instant the saved card is charged for a booking on `travelDate`.
 *
 * @param {Date|string|number} travelDate start of the activity day
 * @returns {Date|null} null when travelDate is missing or invalid
 */
function payLaterChargeAt(travelDate) {
  if (travelDate === null || travelDate === undefined || travelDate === '') return null;
  const travel = travelDate instanceof Date ? travelDate : new Date(travelDate);
  if (Number.isNaN(travel.getTime())) return null;
  return new Date(travel.getTime() - chargeBeforeHours() * MS_PER_HOUR);
}

/**
 * Latest activity date still inside the charge window at `now`. This is the
 * Prisma-queryable form of `payLaterChargeAt(travelDate) <= now` (a query
 * cannot call a JS function per row), so the sweep's WHERE clause and the
 * promise made in the emails stay the same statement.
 *
 * @param {Date} [now]
 * @returns {Date}
 */
function chargeWindowEnd(now = new Date()) {
  return new Date(now.getTime() + chargeBeforeHours() * MS_PER_HOUR);
}

module.exports = {
  DEFAULT_CHARGE_BEFORE_HOURS,
  chargeBeforeHours,
  payLaterChargeAt,
  chargeWindowEnd,
};
