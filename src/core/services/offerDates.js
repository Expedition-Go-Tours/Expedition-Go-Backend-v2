const AppError = require('./appError');

/**
 * Date semantics for special offers.
 *
 * `endDate` is a CALENDAR DAY, not an instant: a supplier who picks 30/09/2026
 * means "still redeemable on 30/09". Historically the picked date was stored at
 * 00:00:00Z — midnight at the *start* of that day — so the offer died the moment
 * the day began: the nightly `expire-special-offers` job (`endDate <= now`)
 * deactivated it, `computeStatus` reported it expired, and suppliers saw
 * "Expired" on a day the picker told them was included.
 *
 * Every write therefore normalises `endDate` to the LAST millisecond of its UTC
 * day. Start dates stay at 00:00 (start-of-day is already correct), and every
 * comparison site can keep reading the stored value directly.
 *
 * UTC on purpose: offer windows are calendar days shared by every supplier
 * regardless of where they sit, and `date-fns`'s `endOfDay` resolves in the
 * *server's* local timezone — the same offer would then expire on a different
 * instant depending on the host.
 */
function endOfUtcDay(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError('Invalid end date', 400);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

module.exports = { endOfUtcDay };
