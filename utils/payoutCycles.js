const getConfig = require('./getConfig');
const prisma = require('./prismaClient');

// ── Finance v2: bi-monthly payout cycles ──
//
// Cycle A: accumulates bookings 1st–15th, withdrawal window opens on the 16th
//          and closes on the 20th (configurable).
// Cycle B: accumulates bookings 16th–end of month, withdrawal window opens on
//          the 1st of the next month and closes on the 5th (configurable).
//
// Windows are configurable via SystemConfig:
//   payout.window_cycle1_days  "16,20"   (open day, close day)
//   payout.window_cycle2_days  "1,5"
//   payout.clearance_buffer_days "0"    (extra days after travelDate before
//                                         a booking's funds become eligible)

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function formatCycleLabel(start, end) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (start.getMonth() === end.getMonth()) {
    return `${months[start.getMonth()]} ${start.getDate()}–${end.getDate()}`;
  }
  return `${months[start.getMonth()]} ${start.getDate()} – ${months[end.getMonth()]} ${end.getDate()}`;
}

/**
 * Parse a SystemConfig window value like "16,20" into { openDay, closeDay }.
 * Falls back to the provided default when missing/invalid.
 */
async function getWindowDays(configKey, fallback) {
  const raw = await getConfig(configKey, null);
  if (typeof raw === 'string' && /^\d{1,2}\s*,\s*\d{1,2}$/.test(raw.trim())) {
    const [a, b] = raw.split(',').map((n) => parseInt(n.trim(), 10));
    if (a >= 1 && a <= 31 && b >= 1 && b <= 31) return { openDay: a, closeDay: b };
  }
  if (raw && typeof raw === 'object') {
    const a = parseInt(raw.openDay ?? raw[0], 10);
    const b = parseInt(raw.closeDay ?? raw[1], 10);
    if (Number.isFinite(a) && Number.isFinite(b)) return { openDay: a, closeDay: b };
  }
  return fallback;
}

/**
 * The cycle that is currently accumulating bookings.
 * Cycle A: 1st → 15th. Cycle B: 16th → last day of month.
 */
function getCurrentCycle(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const day = now.getDate();

  if (day <= 15) {
    const start = new Date(y, m, 1);
    const end = new Date(y, m, 15, 23, 59, 59, 999);
    return { start, end, label: formatCycleLabel(start, end), slot: 'A' };
  }
  const start = new Date(y, m, 16);
  const end = new Date(y, m, daysInMonth(y, m), 23, 59, 59, 999);
  return { start, end, label: formatCycleLabel(start, end), slot: 'B' };
}

/**
 * The previous (just-finished) accumulation cycle.
 */
function getPreviousCycle(now = new Date()) {
  const current = getCurrentCycle(now);
  if (current.slot === 'B') {
    const y = now.getFullYear();
    const m = now.getMonth();
    const start = new Date(y, m, 1);
    const end = new Date(y, m, 15, 23, 59, 59, 999);
    return { start, end, label: formatCycleLabel(start, end), slot: 'A' };
  }
  // Current is A — previous is B of last month
  const py = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const pm = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
  const start = new Date(py, pm, 16);
  const end = new Date(py, pm, daysInMonth(py, pm), 23, 59, 59, 999);
  return { start, end, label: formatCycleLabel(start, end), slot: 'B' };
}

/**
 * The withdrawal window associated with the most recently completed cycle,
 * or null when no window is currently open.
 *
 * Returns { open, start, end, label, cycle } where `cycle` is the accumulation
 * cycle whose earnings can be requested during this window.
 */
async function getRequestWindow(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth();
  const day = now.getDate();

  const w1 = await getWindowDays('payout.window_cycle1_days', { openDay: 16, closeDay: 20 });
  const w2 = await getWindowDays('payout.window_cycle2_days', { openDay: 1, closeDay: 5 });

  // Window for cycle B (prev month 16th→EOM): opens w2.openDay of this month
  if (day >= w2.openDay && day <= w2.closeDay) {
    // The relevant cycle is always last month's B slot.
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 11 : m - 1;
    const bStart = new Date(py, pm, 16);
    const bEnd = new Date(py, pm, daysInMonth(py, pm), 23, 59, 59, 999);
    return {
      open: true,
      start: new Date(y, m, w2.openDay),
      end: new Date(y, m, w2.closeDay, 23, 59, 59, 999),
      label: formatCycleLabel(bStart, bEnd),
      cycle: { start: bStart, end: bEnd, label: formatCycleLabel(bStart, bEnd), slot: 'B' },
    };
  }

  // Window for cycle A (this month 1st→15th): opens w1.openDay of this month
  if (day >= w1.openDay && day <= w1.closeDay) {
    const aStart = new Date(y, m, 1);
    const aEnd = new Date(y, m, 15, 23, 59, 59, 999);
    return {
      open: true,
      start: new Date(y, m, w1.openDay),
      end: new Date(y, m, w1.closeDay, 23, 59, 59, 999),
      label: formatCycleLabel(aStart, aEnd),
      cycle: { start: aStart, end: aEnd, label: formatCycleLabel(aStart, aEnd), slot: 'A' },
    };
  }

  // No window open — report the next one that will open.
  if (day < w2.openDay) {
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 11 : m - 1;
    const bStart = new Date(py, pm, 16);
    const bEnd = new Date(py, pm, daysInMonth(py, pm), 23, 59, 59, 999);
    return {
      open: false,
      start: new Date(y, m, w2.openDay),
      end: new Date(y, m, w2.closeDay, 23, 59, 59, 999),
      label: formatCycleLabel(bStart, bEnd),
      cycle: { start: bStart, end: bEnd, label: formatCycleLabel(bStart, bEnd), slot: 'B' },
    };
  }
  const nY = m === 11 ? y + 1 : y;
  const nM = m === 11 ? 0 : m + 1;
  const nextAStart = new Date(nY, nM, 1);
  const nextAEnd = new Date(nY, nM, 15, 23, 59, 59, 999);
  return {
    open: false,
    start: new Date(nY, nM, w1.openDay),
    end: new Date(nY, nM, w1.closeDay, 23, 59, 59, 999),
    label: formatCycleLabel(nextAStart, nextAEnd),
    cycle: { start: nextAStart, end: nextAEnd, label: formatCycleLabel(nextAStart, nextAEnd), slot: 'A' },
  };
}

/**
 * Extra clearance buffer (days after travelDate) before funds are eligible.
 */
async function getClearanceBufferDays() {
  const raw = await getConfig('payout.clearance_buffer_days', 0);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Eligibility sweep — flips PENDING → ELIGIBLE once a booking's travel date
 * has passed (plus configurable clearance buffer), payment succeeded and the
 * booking is confirmed/completed. Bookings with an open dispute stay frozen.
 * Idempotent; safe to run frequently.
 */
async function sweepEarningsEligibility() {
  const bufferDays = await getClearanceBufferDays();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - bufferDays);

  const result = await prisma.booking.updateMany({
    where: {
      payoutStatus: 'PENDING',
      paymentStatus: 'SUCCEEDED',
      status: { in: ['CONFIRMED', 'COMPLETED'] },
      travelDate: { lt: cutoff },
      disputes: { none: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } },
    },
    data: { payoutStatus: 'ELIGIBLE' },
  });

  if (result.count > 0) {
    console.log(`[Finance] Eligibility sweep: ${result.count} booking(s) became ELIGIBLE`);
  }
  return result.count;
}

module.exports = {
  getCurrentCycle,
  getPreviousCycle,
  getRequestWindow,
  getClearanceBufferDays,
  sweepEarningsEligibility,
  formatCycleLabel,
};
