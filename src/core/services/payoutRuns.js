/**
 * Automated payout runs — supplier-selectable payout schedules (GetYourGuide
 * style).
 *
 * A supplier with a value in SupplierProfile.payoutCycle is *enrolled*: the
 * scheduler builds their payout request automatically on each run date and it
 * lands in the admin approval queue exactly like a supplier-requested one.
 * A supplier with `payoutCycle = null` keeps the legacy twice-monthly manual
 * withdrawal windows, so brands (and suppliers) that have not adopted the
 * schedule feature are completely unaffected.
 *
 * Cadences (Africa/Accra = UTC+0, no DST, so server-local dates are stable):
 *   WEEKLY         run every Monday
 *   TWICE_MONTHLY  run on the 1st and the 15th
 *   MONTHLY        run on the 1st (for the previous calendar month)
 *
 * Plan changes always take effect on the 1st of the following month (a supplier
 * can never switch mid-cycle); the very first enrolment applies immediately so
 * a new supplier is never left unmanaged waiting for a month.
 *
 * Money movement is unchanged: this only *generates* the request. A finance
 * admin still approves it and records the bank/PayPal reference.
 */

const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const AppError = require('./appError');
const { logActivity } = require('./auditLogger');
const { formatCycleLabel } = require('./payoutCycles');

const VALID_CYCLES = ['WEEKLY', 'TWICE_MONTHLY', 'MONTHLY'];

// Copy shown in the supplier + admin dashboards. Deliberately avoids the
// ambiguous word "bi-monthly" (which can read as "twice a month" or "every two
// months") — the cadence and anchor days are always stated explicitly.
const CYCLE_META = {
  WEEKLY: {
    shortLabel: 'Weekly',
    label: 'Every week — paid every Monday',
    runDays: 'Every Monday',
    description: 'Payouts are generated every Monday for experiences completed by the Sunday before.',
  },
  TWICE_MONTHLY: {
    shortLabel: 'Twice a month',
    label: 'Twice a month — paid on the 1st & 15th',
    runDays: 'The 1st and 15th of each month',
    description: 'Payouts are generated twice a month, on the 1st and the 15th.',
  },
  MONTHLY: {
    shortLabel: 'Monthly',
    label: 'Monthly — paid on the 1st',
    runDays: 'The 1st of each month',
    description: 'One payout a month, generated on the 1st for the previous month.',
  },
};

function toNumber(v) {
  return v == null ? 0 : parseFloat(v);
}

// ── Date helpers ────────────────────────────────────────────────────────────

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** Is `date` a payout run date for this cadence? */
function isRunDate(cycle, date) {
  const day = date.getDate();
  if (cycle === 'WEEKLY') return date.getDay() === 1; // Monday
  if (cycle === 'TWICE_MONTHLY') return day === 1 || day === 15;
  if (cycle === 'MONTHLY') return day === 1;
  return false;
}

/**
 * The next run date strictly after `from` (start of day). Strictly-after means
 * that on a run day — once the scheduler has fired — the dashboard shows the
 * *next* payout, not the one already generated.
 */
function nextRunAt(cycle, from = new Date()) {
  let d = startOfDay(addDays(from, 1));
  for (let i = 0; i < 40; i++) {
    if (isRunDate(cycle, d)) return d;
    d = addDays(d, 1);
  }
  return null;
}

/** The most recent run date on or before `from`. */
function lastRunAt(cycle, from = new Date()) {
  let d = startOfDay(from);
  for (let i = 0; i < 40; i++) {
    if (isRunDate(cycle, d)) return d;
    d = addDays(d, -1);
  }
  return null;
}

/**
 * The accumulation window a run on `runDate` covers — e.g. the Monday run
 * covers the previous Mon–Sun; the 15th run covers the 1st–14th. Used for the
 * human-readable cycle label on the payout request.
 */
function cyclePeriodFor(cycle, runDate) {
  const run = startOfDay(runDate);

  if (cycle === 'WEEKLY') {
    return { start: addDays(run, -7), end: endOfDay(addDays(run, -1)), slot: 'W' };
  }

  if (cycle === 'MONTHLY') {
    const y = run.getFullYear();
    const m = run.getMonth();
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 11 : m - 1;
    return { start: new Date(py, pm, 1), end: endOfDay(new Date(py, pm, daysInMonth(py, pm))), slot: 'M' };
  }

  // TWICE_MONTHLY
  const y = run.getFullYear();
  const m = run.getMonth();
  if (run.getDate() === 1) {
    const py = m === 0 ? y - 1 : y;
    const pm = m === 0 ? 11 : m - 1;
    return { start: new Date(py, pm, 15), end: endOfDay(new Date(py, pm, daysInMonth(py, pm))), slot: 'B' };
  }
  return { start: new Date(y, m, 1), end: endOfDay(new Date(y, m, 14)), slot: 'A' };
}

/** A cycle window decorated with its display label. */
function withLabel(period) {
  return { ...period, label: formatCycleLabel(period.start, period.end) };
}

// ── Plan resolution ─────────────────────────────────────────────────────────

/** 1st of next month at 00:00 — when a plan switch takes effect. */
function nextEffectiveDate(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
}

/**
 * The cadence actually in force for a profile: a pending change that has
 * reached its effective date wins, otherwise the active value. Pure — safe to
 * call on read paths without writing.
 */
function resolveEffectiveCycle(profile, now = new Date()) {
  if (!profile) return null;
  if (
    profile.payoutCyclePending
    && profile.payoutCyclePendingAt
    && new Date(profile.payoutCyclePendingAt) <= now
  ) {
    return profile.payoutCyclePending;
  }
  return profile.payoutCycle || null;
}

/** Platform default cadence for suppliers who have not chosen one. */
async function getDefaultCycle() {
  const raw = await getConfig('payout.default_cycle', 'TWICE_MONTHLY');
  const value = String(raw || '').toUpperCase().replace(/[\s-]+/g, '_');
  return VALID_CYCLES.includes(value) ? value : 'TWICE_MONTHLY';
}

/**
 * Master switch for the scheduler. When it is off, enrolled suppliers fall back
 * to to the manual withdrawal flow so money can never get stuck.
 */
async function autoRunsEnabled() {
  const raw = await getConfig('payout.auto_generate_enabled', 'true');
  return raw !== false && String(raw).toLowerCase() !== 'false';
}

async function getMinThreshold() {
  const raw = await getConfig('payout.min_threshold', 0);
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Pure plan projection from a SupplierProfile row — no DB access, so list
 * endpoints can decorate many suppliers without an N+1.
 */
function buildPayoutPlan(profile, { now = new Date(), defaultCycle = 'TWICE_MONTHLY', autoRuns = true } = {}) {
  const cycle = resolveEffectiveCycle(profile, now);
  const meta = cycle ? CYCLE_META[cycle] : null;
  const pendingCycle = profile?.payoutCyclePending || null;
  const pendingAt = profile?.payoutCyclePendingAt || null;
  const pendingActive = pendingCycle && pendingAt && new Date(pendingAt) > now ? pendingCycle : null;

  const next = cycle ? nextRunAt(cycle, now) : null;
  const last = cycle ? lastRunAt(cycle, now) : null;

  return {
    autoManaged: Boolean(cycle),
    cycle,
    scheduleLabel: meta ? meta.label : null,
    scheduleShortLabel: meta ? meta.shortLabel : null,
    runDays: meta ? meta.runDays : null,
    description: meta ? meta.description : null,
    nextRunAt: next,
    nextRunPeriodLabel: next ? withLabel(cyclePeriodFor(cycle, next)).label : null,
    lastRunAt: last,
    effectiveAt: profile?.payoutCycleEffectiveAt || null,
    pendingCycle: pendingActive,
    pendingEffectiveAt: pendingActive ? pendingAt : null,
    defaultCycle,
    autoRunsEnabled: autoRuns,
  };
}

/**
 * Everything the dashboards need to render a supplier's payout schedule.
 */
async function getSupplierPayoutPlan(supplierId, now = new Date()) {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: supplierId },
    select: {
      payoutCycle: true,
      payoutCycleEffectiveAt: true,
      payoutCyclePending: true,
      payoutCyclePendingAt: true,
    },
  });

  return {
    ...buildPayoutPlan(profile, {
      now,
      defaultCycle: await getDefaultCycle(),
      autoRuns: await autoRunsEnabled(),
    }),
    options: VALID_CYCLES.map((c) => ({ value: c, ...CYCLE_META[c] })),
  };
}

/**
 * Create/change a supplier's payout cadence.
 *
 * @param {object} opts
 * @param {string} opts.supplierId
 * @param {string} opts.cycle            WEEKLY | TWICE_MONTHLY | MONTHLY
 * @param {boolean} [opts.immediate]     admin override — skip the 1st-of-month rule
 * @param {string}  [opts.actorUserId]   who made the change (null = system)
 * @param {string}  [opts.actorEmail]
 * @param {string}  [opts.note]          admin reason
 */
async function updateSupplierPayoutPlan({
  supplierId,
  cycle,
  immediate = false,
  actorUserId = null,
  actorEmail = null,
  note = null,
}) {
  if (!VALID_CYCLES.includes(cycle)) {
    throw new AppError(`Invalid payout plan "${cycle}"`, 400);
  }

  const profile = await prisma.supplierProfile.findUnique({ where: { userId: supplierId } });
  if (!profile) throw new AppError('Supplier profile not found', 404);

  const now = new Date();
  const current = resolveEffectiveCycle(profile, now);

  // Re-selecting the cadence already in force just cancels a scheduled switch.
  if (cycle === current) {
    if (profile.payoutCyclePending) {
      await prisma.supplierProfile.update({
        where: { userId: supplierId },
        data: { payoutCyclePending: null, payoutCyclePendingAt: null },
      });
      await logActivity({
        userId: actorUserId || undefined,
        userEmail: actorEmail || undefined,
        action: 'payout_schedule.updated',
        resource: 'SupplierProfile',
        resourceId: profile.id,
        metadata: { cycle, cancelledPending: true },
      });
    }
    return getSupplierPayoutPlan(supplierId, now);
  }

  let data;
  if (immediate || current === null) {
    // Admin override, or a supplier's first enrolment: start now rather than
    // leaving them unmanaged for a month.
    data = {
      payoutCycle: cycle,
      payoutCycleEffectiveAt: now,
      payoutCyclePending: null,
      payoutCyclePendingAt: null,
    };
  } else {
    // GetYourGuide rule: switch on the 1st of next month, never mid-cycle.
    data = { payoutCyclePending: cycle, payoutCyclePendingAt: nextEffectiveDate(now) };
  }

  await prisma.supplierProfile.update({ where: { userId: supplierId }, data });

  await logActivity({
    userId: actorUserId || undefined,
    userEmail: actorEmail || undefined,
    action: immediate ? 'payout_schedule.overridden' : 'payout_schedule.updated',
    resource: 'SupplierProfile',
    resourceId: profile.id,
    oldValues: { payoutCycle: profile.payoutCycle },
    newValues: { payoutCycle: data.payoutCycle ?? profile.payoutCycle, pendingCycle: data.payoutCyclePending ?? null },
    metadata: {
      previous: current,
      requested: cycle,
      immediate,
      effectiveAt: data.payoutCycleEffectiveAt || data.payoutCyclePendingAt,
      note: note || null,
    },
  });

  return getSupplierPayoutPlan(supplierId, now);
}

/** Promote plan changes whose effective date has arrived. */
async function promoteDueCycles(now = new Date()) {
  const due = await prisma.supplierProfile.findMany({
    where: { payoutCyclePending: { not: null }, payoutCyclePendingAt: { lte: now } },
    select: { id: true, userId: true, payoutCycle: true, payoutCyclePending: true, payoutCyclePendingAt: true },
  });

  for (const p of due) {
    await prisma.supplierProfile.update({
      where: { id: p.id },
      data: {
        payoutCycle: p.payoutCyclePending,
        payoutCycleEffectiveAt: p.payoutCyclePendingAt,
        payoutCyclePending: null,
        payoutCyclePendingAt: null,
      },
    });
    await logActivity({
      action: 'payout_schedule.applied',
      resource: 'SupplierProfile',
      resourceId: p.id,
      oldValues: { payoutCycle: p.payoutCycle },
      newValues: { payoutCycle: p.payoutCyclePending },
      metadata: { effectiveAt: p.payoutCyclePendingAt },
    });
  }

  if (due.length > 0) {
    console.log(`[Finance] Payout schedule: ${due.length} plan change(s) applied`);
  }
  return due.length;
}

// ── Payout request building (shared by the manual endpoint + the scheduler) ──

/** Candidate bookings for a payout: eligible funds, not disputed. */
async function selectEligibleBookings({ supplierId, bookingIds = null }) {
  const where = {
    tour: { supplierId },
    payoutStatus: 'ELIGIBLE',
    paymentStatus: 'SUCCEEDED',
    status: { in: ['CONFIRMED', 'COMPLETED'] },
  };
  if (Array.isArray(bookingIds) && bookingIds.length > 0) {
    where.id = { in: bookingIds };
  }
  return prisma.booking.findMany({ where });
}

/** The destination account: an explicit method, else the default verified one. */
async function resolvePayoutMethod({ supplierId, payoutMethodId = null }) {
  if (payoutMethodId) {
    const method = await prisma.payoutMethod.findFirst({ where: { id: payoutMethodId, supplierId } });
    if (!method) throw new AppError('Payout method not found', 404);
    if (!method.verified) throw new AppError('The selected payout method is not verified yet', 400);
    return method;
  }
  return prisma.payoutMethod.findFirst({
    where: { supplierId, verified: true },
    orderBy: { isDefault: 'desc' },
  });
}

/**
 * Write the payout request(s) for a set of eligible bookings.
 *
 * Mixed currencies are split into one request per currency. Open cancellation
 * fees are netted off (and blocked if they meet or exceed the amount). Booking
 * funds move ELIGIBLE → REQUESTED in the same transaction.
 *
 * @returns {{ requests: object[], feesDeducted: number }}
 */
async function createRequestsForBookings({
  supplierId,
  bookings,
  method,
  cycleWindow,
  notes = null,
  autoGenerated = false,
}) {
  const byCurrency = {};
  for (const b of bookings) {
    (byCurrency[b.currency] = byCurrency[b.currency] || []).push(b);
  }

  const requests = await prisma.$transaction(async (tx) => {
    const created = [];
    for (const [currency, group] of Object.entries(byCurrency)) {
      const amount = group.reduce((s, b) => s + toNumber(b.supplierPayout), 0);

      // Open fees can't be withdrawn — they reduce this payout. If they meet or
      // exceed it, refuse rather than create a zero/negative payout.
      const openCharges = await tx.supplierCharge.findMany({
        where: { supplierId, status: 'OPEN', currency },
        orderBy: { createdAt: 'asc' },
      });
      const feeTotal = openCharges.reduce((s, c) => s + toNumber(c.amount), 0);
      if (feeTotal > 0 && feeTotal >= amount) {
        throw new AppError(
          `Your open cancellation fees (${feeTotal.toFixed(2)} ${currency}) are equal to or greater than this payout amount (${amount.toFixed(2)} ${currency}). The fees will be settled against a larger payout, or contact support to resolve them.`,
          400
        );
      }
      const netAmount = Math.round((amount - feeTotal) * 100) / 100;

      const ts = Date.now().toString().slice(-6);
      const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
      const request = await tx.payoutRequest.create({
        data: {
          requestNumber: `PR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${ts}${rand}`,
          supplierId,
          amount: netAmount,
          currency,
          bookingCount: group.length,
          status: 'PROCESSING',
          cycleStartDate: cycleWindow.start,
          cycleEndDate: cycleWindow.end,
          cycleLabel: cycleWindow.label,
          payoutMethodId: method.id,
          autoGenerated,
          // Hard idempotency guard: one generated request per supplier/period/
          // currency, so a re-delivered job can never double-pay.
          runKey: autoGenerated ? `auto:${supplierId}:${cycleWindow.start.toISOString()}:${currency}` : null,
          notes:
            feeTotal > 0
              ? `${notes ? `${notes} · ` : ''}Includes ${feeTotal.toFixed(2)} ${currency} cancellation fees`
              : notes || null,
          items: {
            create: group.map((b) => ({
              bookingId: b.id,
              grossAmount: b.grossAmount,
              platformCommission: b.platformCommission,
              supplierPayout: b.supplierPayout,
              currency: b.currency,
            })),
          },
        },
        include: { items: true },
      });

      if (feeTotal > 0) {
        await tx.supplierCharge.updateMany({
          where: { id: { in: openCharges.map((c) => c.id) }, status: 'OPEN' },
          data: { status: 'SETTLED', payoutRequestId: request.id, settledAt: new Date() },
        });
      }

      await tx.booking.updateMany({
        where: { id: { in: group.map((b) => b.id) } },
        data: { payoutStatus: 'REQUESTED' },
      });

      created.push({ ...request, feesDeducted: feeTotal });
    }
    return created;
  });

  return {
    requests,
    feesDeducted: requests.reduce((s, r) => s + (r.feesDeducted || 0), 0),
  };
}

// ── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Generate every payout run that is due today. Idempotent: safe to run on any
 * cadence. Returns a small report for logging/tests.
 */
async function generateDuePayoutRuns(now = new Date()) {
  if (!(await autoRunsEnabled())) {
    return { generated: 0, skipped: 'disabled' };
  }

  const applied = await promoteDueCycles(now);

  const dueCycles = VALID_CYCLES.filter((c) => isRunDate(c, now));
  if (dueCycles.length === 0) {
    return { generated: 0, applied, dueCycles: [] };
  }

  const profiles = await prisma.supplierProfile.findMany({
    where: { payoutCycle: { in: dueCycles }, status: 'APPROVED' },
    select: {
      id: true,
      userId: true,
      payoutCycle: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  const threshold = await getMinThreshold();
  const report = { generated: 0, requests: 0, applied, dueCycles, skippedNoMethod: 0, skippedNoFunds: 0, skippedBlocked: 0 };

  for (const profile of profiles) {
    const cycle = profile.payoutCycle;
    const cycleWindow = withLabel(cyclePeriodFor(cycle, now));

    const method = await resolvePayoutMethod({ supplierId: profile.userId });
    if (!method) {
      // Can't pay without a destination — tell them once per run day.
      report.skippedNoMethod += 1;
      await notifyMissingPayoutMethod(profile, cycle).catch(() => {});
      continue;
    }

    const bookings = await selectEligibleBookings({ supplierId: profile.userId });
    if (bookings.length === 0) {
      report.skippedNoFunds += 1;
      continue;
    }

    const total = bookings.reduce((s, b) => s + toNumber(b.supplierPayout), 0);
    if (threshold > 0 && total < threshold) {
      report.skippedBlocked += 1; // below threshold — rolls into the next run
      continue;
    }

    try {
      const { requests } = await createRequestsForBookings({
        supplierId: profile.userId,
        bookings,
        method,
        cycleWindow,
        notes: `Automatically generated on your ${CYCLE_META[cycle].shortLabel.toLowerCase()} payout schedule`,
        autoGenerated: true,
      });

      report.generated += 1;
      report.requests += requests.length;

      await logActivity({
        action: 'payout_request.auto_generated',
        resource: 'PayoutRequest',
        resourceId: requests[0].id,
        metadata: {
          cycle,
          cycleLabel: cycleWindow.label,
          requests: requests.map((r) => ({ id: r.id, currency: r.currency, amount: toNumber(r.amount), bookings: r.bookingCount })),
        },
      });

      await notifyPayoutRequestsCreated({
        requests,
        supplierId: profile.userId,
        autoGenerated: true,
        cycle,
      }).catch((err) => console.error('[Finance] Auto payout notification failed:', err.message));
    } catch (err) {
      // Most likely: open fees >= payout amount. Skip this supplier; the funds
      // roll into their next run rather than blocking the whole sweep.
      report.skippedBlocked += 1;
      console.warn(`[Finance] Auto payout run skipped for supplier ${profile.userId}: ${err.message}`);
    }
  }

  console.log(
    `[Finance] Auto payout runs (${dueCycles.join(', ')}): ${report.generated} supplier(s), ${report.requests} request(s); skipped ${report.skippedNoFunds} without funds, ${report.skippedNoMethod} without a payout method, ${report.skippedBlocked} blocked`
  );
  return report;
}

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * Notify the supplier + the finance team that payout requests were created.
 * Shared by the manual endpoint and the scheduler so wording is identical.
 */
async function notifyPayoutRequestsCreated({ requests, supplierId, autoGenerated = false, cycle = null }) {
  const { enqueueNotification, enqueueEmail } = require('./queue');
  const { notifyAdmin } = require('./adminNotificationService');
  const { notifyDiscord } = require('./discordNotifier');

  if (!requests || requests.length === 0) return;

  const total = requests.reduce((s, r) => s + toNumber(r.amount), 0);
  const bookingCount = requests.reduce((s, r) => s + r.bookingCount, 0);
  const currency = requests[0].currency;
  const scheduleWord = autoGenerated && cycle ? `${CYCLE_META[cycle].shortLabel.toLowerCase()} ` : '';
  const feesDeducted = requests.reduce((s, r) => s + (r.feesDeducted || 0), 0);
  const feeNote = feesDeducted > 0
    ? ` ${feesDeducted.toFixed(2)} ${currency} in cancellation fees was deducted.`
    : '';

  await enqueueNotification({
    userId: supplierId,
    type: 'PAYOUT_REQUEST_SUBMITTED',
    title: autoGenerated ? 'Payout Scheduled' : 'Payout Request Submitted',
    message: autoGenerated
      ? `Your ${scheduleWord}payout of ${total.toFixed(2)} ${currency} (${bookingCount} booking${bookingCount === 1 ? '' : 's'}) has been generated and is being processed.${feeNote}`
      : `Your payout request for ${total.toFixed(2)} ${currency} (${bookingCount} bookings) is being processed.${feeNote}`,
    data: { payoutRequestId: requests[0].id, autoGenerated, feesDeducted },
  });

  await notifyAdmin({
    type: 'PAYOUT_NEEDS_APPROVAL',
    title: autoGenerated ? 'Automated Payout Run' : 'New Payout Request',
    message: autoGenerated
      ? `The payout scheduler generated a ${scheduleWord}request for ${total.toFixed(2)} ${currency} (${bookingCount} booking${bookingCount === 1 ? '' : 's'}) and it is waiting for approval.`
      : `Supplier submitted a payout request for ${total.toFixed(2)} ${currency} (${bookingCount} bookings).`,
    data: { payoutRequestId: requests[0].id, supplierId, autoGenerated },
  });

  const { approvalPayoutRequest } = require('./channelEmbeds');
  const embed = approvalPayoutRequest({
    requestNumber: requests[0].requestNumber,
    amount: total,
    currency,
    bookingCount,
    requestId: requests[0].id,
  });
  notifyDiscord('approvals', embed.content, embed.opts);

  await enqueueEmail({ type: 'payout-request-submitted', payoutRequestId: requests[0].id });
}

/** Nudge a supplier who has a schedule but no verified payout destination. */
async function notifyMissingPayoutMethod(profile, cycle) {
  const { enqueueNotification } = require('./queue');
  await enqueueNotification({
    userId: profile.userId,
    type: 'PAYOUT_REQUEST_SUBMITTED',
    title: 'Add a payout method',
    message: `Your ${CYCLE_META[cycle].shortLabel.toLowerCase()} payout couldn't be generated because you have no verified payout method. Add one to get paid.`,
    data: { action: 'add-payout-method' },
  });
}

module.exports = {
  VALID_CYCLES,
  CYCLE_META,
  isRunDate,
  nextRunAt,
  lastRunAt,
  cyclePeriodFor,
  withLabel,
  nextEffectiveDate,
  resolveEffectiveCycle,
  buildPayoutPlan,
  getDefaultCycle,
  autoRunsEnabled,
  getMinThreshold,
  getSupplierPayoutPlan,
  updateSupplierPayoutPlan,
  promoteDueCycles,
  selectEligibleBookings,
  resolvePayoutMethod,
  createRequestsForBookings,
  notifyPayoutRequestsCreated,
  generateDuePayoutRuns,
};
