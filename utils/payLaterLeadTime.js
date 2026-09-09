/**
 * Pay-later minimum lead time.
 *
 * Reserve-now-pay-later bookings rely on the pay-later sweep to auto-charge the
 * customer's card a fixed time before the activity (default: 24h). If a
 * reservation is taken inside that window the charge can't run on time (or has
 * no room to retry a declined card before the event), so the booking silently
 * ends up cancelled after the activity day.
 *
 * This rule guarantees the sweep always has its window: a customer may only
 * reserve-now-pay-later when the activity is at least `PAY_LATER_MIN_ADVANCE_HOURS`
 * (default 48h, env-tunable) in the future. Pay-now bookings are unaffected.
 *
 * The `startAt` anchor is the same slot-aware clock the booking cutoff engine
 * uses (per-slot local wall clock when the tour uses per-slot cutoffs, otherwise
 * the start of the travel day in UTC) — pass the exact `startAt` each caller
 * already computes for its cutoff check.
 */

const AppError = require('./appError');

const DEFAULT_MIN_ADVANCE_HOURS = 48;

function payLaterMinAdvanceHours() {
  const value = parseFloat(process.env.PAY_LATER_MIN_ADVANCE_HOURS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_ADVANCE_HOURS;
}

/**
 * Throw when a reserve-now-pay-later booking's activity start is closer than the
 * pay-later minimum lead time. No-op for pay-now and when startAt is unavailable.
 *
 * @param {{ paymentTiming?: string, startAt?: Date | number | string }} opts
 */
function assertPayLaterLeadTime({ paymentTiming, startAt }) {
  if (paymentTiming !== 'later') return;
  if (startAt == null) return;
  const start = startAt instanceof Date ? startAt.getTime() : new Date(startAt).getTime();
  if (!Number.isFinite(start)) return;

  const minHours = payLaterMinAdvanceHours();
  const hoursUntil = (start - Date.now()) / (1000 * 60 * 60);
  if (hoursUntil < minHours) {
    throw new AppError(
      `Reserve now, pay later is only available when you book at least ${minHours} hours before the activity. For sooner dates, pay now at checkout.`,
      400
    );
  }
}

module.exports = { assertPayLaterLeadTime, payLaterMinAdvanceHours, DEFAULT_MIN_ADVANCE_HOURS };
