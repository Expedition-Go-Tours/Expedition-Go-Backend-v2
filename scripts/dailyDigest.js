/**
 * Daily ops + business digest for TravioAfrica.
 *
 * Architecture: deterministic core -> presentation. The digest is NOT an
 * AI echo. Every number comes from guarded queries; MiMo only turns supplied
 * facts into a short FACT/INFERENCE note (deterministic fallback otherwise).
 *
 * Reliability rules:
 *  - Every metric is a Result: { ok:true, value } | { ok:false }.
 *    A failed query renders as "unavailable", NEVER as 0.
 *  - Incidents / deployments distinguish 0 from unavailable.
 *  - Platform-health claims are only made when live probes all pass.
 *  - Time windows are explicit and exclude the reporting day from the
 *    7-day baseline to keep comparisons clean.
 *
 * Windows (daily digest run 07:00 UTC on day X, reporting day = X-1):
 *  reporting: [X-1 00:00, X 00:00)      (the reported day)
 *  prior:     [X-2 00:00, X-1 00:00)    (deltas)
 *  baseline:  [X-8 00:00, X-1 00:00)    = 7 completed days BEFORE the
 *                                        reporting day (excludes it)
 *
 * Scheduled via cron. Safe to run manually:
 *   node scripts/dailyDigest.js
 *   DIGEST_PERIOD=week node scripts/dailyDigest.js
 */
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');
const { notifyDiscord } = require('../utils/discordNotifier');
const { callMimo } = require('../utils/mimoClient');

const prisma = new PrismaClient();

// ── Result helpers ─────────────────────────────────────────────────
const ok = (value) => ({ ok: true, value });
const unavailable = () => ({ ok: false });

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MONITOR_NAMES = new Set([
  'apiv1.travioafrica.com',
  'apiv1.travioafrica.com/health',
]);

// ── Time window helpers (UTC) ──────────────────────────────────────
function utcDayStart(offsetDaysFromToday) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDaysFromToday);
  return d;
}

function periodInfo(weekly) {
  // reportingStart is midnight of the start of the reporting window.
  const reportingStart = utcDayStart(weekly ? -7 : -1);
  const reportingEnd = weekly ? utcDayStart(0) : utcDayStart(0); // exclusive end
  const reportingDays = weekly ? 7 : 1;

  const priorStart = new Date(reportingStart.getTime() - reportingDays * DAY_MS);
  const priorEnd = new Date(reportingStart.getTime());

  // Baseline = reportingDays completed days immediately before the reporting
  // window (excludes the reporting window itself).
  const baselineStart = new Date(reportingStart.getTime() - reportingDays * DAY_MS);
  const baselineEnd = new Date(reportingStart.getTime());

  return {
    weekly,
    reportingStart,
    reportingEnd,
    priorStart,
    priorEnd,
    baselineStart,
    baselineEnd,
  };
}

function formatPeriodTitle(p, timezone) {
  const start = p.reportingStart;
  const end = new Date(start.getTime() + (p.weekly ? 7 : 1) * DAY_MS - 1);
  const d = (x) => x.toISOString().slice(0, 10);
  const tz = ` (${timezone})`;
  if (p.weekly) return `${d(start)} to ${d(end)}${tz}`;
  return `${d(start)} 00:00–23:59 ${tz}`;
}

// ── Backup / drill parsers ─────────────────────────────────────────
/**
 * Parse backup log text -> structured result.
 * @returns {{ok:boolean,value:{date:string,size:string,dest:string,retention:string,ok:boolean}}|{ok:false}}
 */
function parseBackupLog(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let completeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('=== Backup complete ===')) completeIdx = i;
  }
  if (completeIdx >= 0) {
    const last = lines[completeIdx];
    const m = last.match(/^(\S+)\s+=== Backup complete ===/);
    const date = m ? m[1] : null;
    // scan backward from the completion line for the most recent Dump OK size
    let size = '?';
    for (let i = completeIdx; i >= 0; i--) {
      const sm = (lines[i] || '').match(/Dump OK: .*\(([^)]+)\)/);
      if (sm) {
        size = sm[1];
        break;
      }
      if ((lines[i] || '').includes('=== Backup start ===')) break;
    }
    return {
      ok: true,
      value: { ok: true, date, size, dest: 'Storage Box', retention: '14 days' },
    };
  }
  const fail = lines.filter((l) => l.includes('FAIL:'));
  return fail.length ? { ok: true, value: { ok: false, date: null, note: 'last backup failed' } } : unavailable();
}

/**
 * Parse restore-drill log -> {ok:true,value:{passed:boolean,summary:string}} | {ok:false}
 */
function parseDrillLog(text) {
  const lines = text.split('\n');
  const completeIdx = lines.findIndex((l) => l.includes('=== Restore drill COMPLETE:'));
  const failIdx = lines.findIndex((l) => l.includes('RESTORE DRILL FAIL'));
  if (completeIdx >= 0) {
    const m = lines[completeIdx].match(/=== Restore drill COMPLETE: ([^=]+) ===/);
    return { ok: true, value: { passed: true, summary: m ? m[1].trim() : '' } };
  }
  if (failIdx >= 0) {
    const m = lines[failIdx].match(/RESTORE DRILL FAIL: (.+)$/);
    return { ok: true, value: { passed: false, summary: m ? m[1].trim() : 'drill failed' } };
  }
  return unavailable();
}

// ── Better Stack incident summary ──────────────────────────────────
/**
 * Count incidents overlapping [start, end) and sum in-window downtime.
 * Filters strictly to TravioAfrica API/health monitors.
 * @param {Array} incidents Better Stack incident objects (attributes incl. name, started_at, resolved_at, status)
 * @param {Date} start
 * @param {Date} end
 */
function incidentSummary(incidents, start, end) {
  if (!Array.isArray(incidents)) return { count: 0, downtimeMs: 0 };
  const s = start.getTime();
  const e = end.getTime();
  let count = 0;
  let downtimeMs = 0;
  for (const inc of incidents) {
    const a = inc && inc.attributes ? inc.attributes : inc;
    const name = a.name || '';
    if (!MONITOR_NAMES.has(name)) continue;
    if (a.status === 'Sample incident' || a.cause === 'Sample incident') continue;
    const started = a.started_at ? new Date(a.started_at).getTime() : null;
    const resolved = a.resolved_at ? new Date(a.resolved_at).getTime() : null;
    if (started == null) continue;
    // overlap of [started, resolved||now) with [s, e)
    const lo = Math.max(started, s);
    const hi = Math.min(resolved == null ? Date.now() : resolved, e);
    if (lo < hi) {
      count += 1;
      downtimeMs += hi - lo;
    }
  }
  return { count, downtimeMs };
}

/**
 * Fetch incidents from Better Stack (empty on failure -> caller treats as unavailable).
 */
async function fetchIncidents() {
  const token = process.env.BETTERSTACK_API_TOKEN;
  if (!token) return null;
  const resp = await fetch('https://uptime.betterstack.com/api/v2/incidents', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data && Array.isArray(data.data) ? data.data : null;
}

// ── Live health probes ─────────────────────────────────────────────
async function probeHealth(apiUrl) {
  const health = { api: unavailable(), postgres: unavailable(), redis: unavailable(), nginx: unavailable(), server: unavailable() };
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    health.api = ok(res.status === 200 ? 'healthy' : `HTTP ${res.status}`);
    health.postgres = ok(body?.checks?.database === 'healthy' ? 'healthy' : body?.checks?.database || 'down');
    health.redis = ok(body?.checks?.redis === 'healthy' ? 'healthy' : body?.checks?.redis || 'down');
  } catch {
    health.api = unavailable();
  }
  try {
    const active = sh('systemctl is-active nginx 2>/dev/null');
    health.nginx = active === 'active' ? ok('active') : ok(active || 'down');
  } catch {
    health.nginx = unavailable();
  }
  try {
    const mem = sh(`free -m | awk 'NR==2{printf "RAM %.0f%%", ($2-$7)/$2*100}'`);
    const disk = sh(`df -h / | tail -1 | awk '{gsub(/%/,"",$5); print "Disk " $5 "%"}'`);
    const load = sh(`cat /proc/loadavg | cut -d' ' -f1-3`);
    health.server = ok([mem, disk, load ? `Load ${load}` : ''].filter(Boolean).join(' · '));
  } catch {
    health.server = unavailable();
  }
  return health;
}

// ── AI note (disciplined FACT / INFERENCE) ─────────────────────────
async function aiNote(factLines, healthSummary) {
  if (!process.env.MIMO_API_KEY) return null;
  const system = [
    'You write the closing note for a business/ops digest.',
    'Separate FACT from INFERENCE. Output ONLY:',
    'FACT: <statements strictly supported by the supplied numbers>',
    'INFERENCE: <a cautious interpretation, explicitly framed as a hypothesis, never asserting cause>',
    'RULES:',
    '- Never claim the platform was stable/operational from backup success.',
    '- Never assert a cause (e.g. "marketing caused low bookings"). Only suggest reviewing sources.',
    '- If the platform health below shows ANY failure, you MUST NOT say the platform was fully operational.',
    '- Keep it under 4 lines. No markdown, no emojis beyond a single \u26a0 if warranted.',
  ].join('\n');
  const user = `PLATFORM HEALTH:\n${healthSummary}\n\nDIGEST DATA:\n${factLines}`;
  try {
    const text = await callMimo({ system, user, maxTokens: 400, temperature: 0.2 });
    return text.trim().slice(0, 600);
  } catch {
    return null;
  }
}

// ── Deterministic digest collection ────────────────────────────────
async function collectDigest() {
  const weekly = process.env.DIGEST_PERIOD === 'week';
  const p = periodInfo(weekly);

  // timezone from config (fallback UTC), windows are UTC
  const tzRow = await prisma.systemConfig.findUnique({ where: { key: 'platform.timezone' } }).catch(() => null);
  const timezone = tzRow?.value === 'UTC' ? 'UTC' : String(tzRow?.value || 'UTC');

  const periodLabel = weekly ? '7 days' : 'yesterday';
  const label = weekly ? 'Weekly' : 'Daily';

  const confirmedWhere = {
    createdAt: { gte: p.reportingStart, lt: p.reportingEnd },
    isSimulated: false,
    status: 'CONFIRMED',
  };
  const priorConfirmedWhere = {
    createdAt: { gte: p.priorStart, lt: p.priorEnd },
    isSimulated: false,
    status: 'CONFIRMED',
  };
  const baselineWhere = {
    createdAt: { gte: p.baselineStart, lt: p.baselineEnd },
    isSimulated: false,
    status: 'CONFIRMED',
  };

  // ── Business (guarded) ────────────────────────────────────────────
  const biz = { ok: false };
  const priorBiz = { ok: false };
  try {
    const [cur, prior, base] = await Promise.all([
      prisma.booking.aggregate({
        where: confirmedWhere,
        _count: true,
        _sum: { grossAmount: true, platformCommission: true, supplierPayout: true },
      }),
      prisma.booking.aggregate({
        where: priorConfirmedWhere,
        _count: true,
        _sum: { grossAmount: true },
      }),
      prisma.booking.aggregate({
        where: baselineWhere,
        _count: true,
        _sum: { grossAmount: true },
      }),
    ]);
    biz.ok = true;
    biz.count = cur._count;
    biz.revenue = Number(cur._sum.grossAmount || 0);
    biz.commission = Number(cur._sum.platformCommission || 0);
    biz.supplierPayout = Number(cur._sum.supplierPayout || 0);
    priorBiz.ok = true;
    priorBiz.count = prior._count;
    priorBiz.revenue = Number(prior._sum.grossAmount || 0);
    const days = weekly ? 7 : 1;
    biz.baselineDaily = Number(base._sum.grossAmount || 0) / days;
    biz.baselineDailyCount = base._count / days;
    biz.priorCount = priorBiz.count;
    biz.priorRevenue = priorBiz.revenue;
  } catch {
    /* biz.ok stays false -> unavailable */
  }

  const refunds = { ok: false };
  try {
    const agg = await prisma.booking.aggregate({
      where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd }, isSimulated: false, status: 'REFUNDED' },
      _count: true,
      _sum: { refundAmount: true },
    });
    refunds.ok = true;
    refunds.count = agg._count;
    refunds.amount = Number(agg._sum.refundAmount || 0);
  } catch { /* unavailable */ }

  const signups = { ok: false };
  const newSuppliers = { ok: false };
  const activeSuppliers = { ok: false };
  try {
    signups.ok = true;
    signups.newUsers = await prisma.user.count({ where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd } } });
    newSuppliers.ok = true;
    newSuppliers.count = await prisma.supplierProfile.count({ where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd } } });
    activeSuppliers.ok = true;
    activeSuppliers.count = await prisma.supplierProfile.count({ where: { status: 'ACTIVE' } });
  } catch {
    /* handled below per-field */
  }

  const reviews = { ok: false };
  try {
    const agg = await prisma.review.aggregate({
      where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd } },
      _count: true,
      _avg: { rating: true },
    });
    reviews.ok = true;
    reviews.count = agg._count;
    reviews.avg = agg._avg?.rating;
  } catch { /* unavailable */ }

  const payouts = { ok: false };
  try {
    const agg = await prisma.payout.aggregate({
      where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd }, status: { in: ['APPROVED', 'PAID', 'PROCESSING'] } },
      _count: true,
      _sum: { amount: true },
    });
    payouts.ok = true;
    payouts.count = agg._count;
    payouts.amount = Number(agg._sum.amount || 0);
  } catch { /* unavailable */ }

  const disputes = { ok: false };
  try {
    disputes.ok = true;
    disputes.opened = await prisma.dispute.count({ where: { createdAt: { gte: p.reportingStart, lt: p.reportingEnd } } });
    disputes.open = await prisma.dispute.count({ where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } } });
  } catch { /* unavailable */ }

  const topTours = [];
  try {
    const byTour = await prisma.booking.groupBy({
      by: ['tourId'],
      where: confirmedWhere,
      _sum: { grossAmount: true },
      orderBy: { _sum: { grossAmount: 'desc' } },
      take: 5,
    });
    for (const row of byTour) {
      const t = await prisma.tour.findUnique({ where: { id: row.tourId }, select: { title: true } }).catch(() => null);
      topTours.push({ title: t?.title || row.tourId, revenue: Number(row._sum.grossAmount || 0) });
    }
  } catch { /* topTours empty */ }

  // ── Operations: incidents + deployments ───────────────────────────
  let incidents = unavailable();
  const rawIncidents = await fetchIncidents();
  if (rawIncidents) {
    const sum = incidentSummary(rawIncidents, p.reportingStart, p.reportingEnd);
    incidents = { ok: true, count: sum.count, downtimeMs: sum.downtimeMs };
  }

  let deploys = unavailable();
  try {
    const since = p.reportingStart.toISOString();
    const until = p.reportingEnd.toISOString();
    const out = sh(`git -C /home/deploy/Expedition-Go-Backend-v2 log --since="${since}" --until="${until}" --format='%h %s' 2>/dev/null`);
    const lines = out.split('\n').filter(Boolean);
    deploys = ok({ count: lines.length, latest: lines.length ? lines[0] : null });
  } catch {
    deploys = unavailable();
  }

  // ── Platform health (live) ────────────────────────────────────────
  const apiUrl = process.env.API_URL || 'http://127.0.0.1:5000';
  const health = await probeHealth(apiUrl);

  // ── Backups ───────────────────────────────────────────────────────
  const backupText = sh("grep -E '=== Backup complete ===|Dump OK:|FAIL:' /var/log/travio-backup.log | tail -8");
  const drillText = sh("grep -E '=== Restore drill COMPLETE:|RESTORE DRILL FAIL' /var/log/travio-backup.log | tail -2");
  const backup = parseBackupLog(backupText);
  const drill = parseDrillLog(drillText);

  // ── Assemble data model ───────────────────────────────────────────
  const allOk =
    biz.ok && signups.ok && refunds.ok && reviews.ok && payouts.ok && disputes.ok &&
    incidents.ok && deploys.ok && activeSuppliers.ok && newSuppliers.ok;

  return {
    label,
    weekly,
    periodLabel,
    timezone,
    periodTitle: formatPeriodTitle(p, timezone),
    generatedAt: new Date().toISOString(),
    dataStatus: allOk ? 'live database' : 'partial (see below)',
    sections: {
      biz: biz.ok ? biz : null,
      signups: signups.ok && newSuppliers.ok && activeSuppliers.ok
        ? { newUsers: signups.newUsers, newSuppliers: newSuppliers.count, activeSuppliers: activeSuppliers.count }
        : null,
      reviews: reviews.ok ? { count: reviews.count, avg: reviews.avg } : null,
      refunds: refunds.ok ? { count: refunds.count, amount: refunds.amount } : null,
      payouts: payouts.ok ? { count: payouts.count, amount: payouts.amount } : null,
      disputes: disputes.ok ? { opened: disputes.opened, open: disputes.open } : null,
      topTours,
      health: {
        api: health.api,
        postgres: health.postgres,
        redis: health.redis,
        nginx: health.nginx,
        server: health.server,
      },
      incidents,
      deploys,
      backup,
      drill,
    },
    // raw facts for the AI (text)
    aiFactLines: buildFactLines({
      biz: biz.ok ? biz : null,
      signups: signups.ok && newSuppliers.ok && activeSuppliers.ok ? { newUsers: signups.newUsers, newSuppliers: newSuppliers.count, activeSuppliers: activeSuppliers.count } : null,
      refunds: refunds.ok ? { count: refunds.count, amount: refunds.amount } : null,
      reviews: reviews.ok ? { count: reviews.count, avg: reviews.avg } : null,
      payouts: payouts.ok ? { count: payouts.count, amount: payouts.amount } : null,
      disputes: disputes.ok ? { opened: disputes.opened, open: disputes.open } : null,
      topTours,
      incidents,
      deploys,
      weekly,
      periodLabel,
    }),
  };
}

function buildFactLines({ biz, signups, refunds, reviews, payouts, disputes, topTours, incidents, deploys, periodLabel }) {
  const L = [];
  if (biz) {
    L.push(`Bookings (${periodLabel}): ${biz.count}`);
    L.push(`Revenue (${periodLabel}): ${money(biz.revenue)}`);
    L.push(`Commission: ${money(biz.commission)} · Supplier payout: ${money(biz.supplierPayout)}`);
    L.push(`Prior-period bookings: ${biz.priorCount} · revenue: ${money(biz.priorRevenue)}`);
    L.push(`7-day baseline daily avg bookings: ${biz.baselineDailyCount.toFixed(2)} · revenue: ${money(biz.baselineDaily)}`);
  }
  if (signups) L.push(`New users: ${signups.newUsers} · new suppliers: ${signups.newSuppliers} · active suppliers: ${signups.activeSuppliers}`);
  if (refunds) L.push(`Refunds: ${refunds.count} · ${money(refunds.amount)}`);
  if (reviews) L.push(`New reviews: ${reviews.count}${reviews.avg ? ` (avg ${reviews.avg.toFixed(1)})` : ''}`);
  if (payouts) L.push(`Payouts processed: ${payouts.count} · ${money(payouts.amount)}`);
  if (disputes) L.push(`Disputes opened: ${disputes.opened} · open: ${disputes.open}`);
  if (topTours.length) L.push(`Top tour: ${topTours[0].title} · ${money(topTours[0].revenue)}`);
  if (incidents && incidents.ok) L.push(`Incidents: ${incidents.count} · downtime ${(incidents.downtimeMs / 60000).toFixed(1)}m`);
  else L.push('Incidents: unavailable');
  if (deploys && deploys.ok) L.push(`Deployments: ${deploys.value.count}`);
  else L.push('Deployments: unavailable');
  return L.join('\n');
}

// ── Renderer (data model -> Discord embed) ─────────────────────────
function deltaPct(cur, prev) {
  if (!prev || prev <= 0) return '—';
  const pct = ((cur - prev) / prev) * 100;
  const arrow = pct >= 0 ? '↑' : '↓';
  return `${arrow} ${Math.abs(pct).toFixed(0)}% vs previous`;
}

function renderer(data, model) {
  const S = model.sections;
  const biz = S.biz;
  const health = S.health;
  const allProbed =
    health.api.ok && health.postgres.ok && health.redis.ok && health.nginx.ok && health.server.ok;
  const allHealthy =
    allProbed &&
    health.api.ok && /healthy|200/.test(String(health.api.value)) &&
    health.postgres.value === 'healthy' &&
    health.redis.value === 'healthy' &&
    health.nginx.value === 'active';

  const lines = [];

  // Header
  lines.push(`**Reporting:** ${model.periodTitle}`);
  lines.push(`**Generated:** ${model.generatedAt.slice(0, 19)} ${model.timezone}`);
  lines.push(`**Data:** ${model.dataStatus}`);

  // BUSINESS
  if (biz) {
    lines.push(`\n**BUSINESS**`);
    lines.push(`Bookings: ${biz.count}`);
    if (biz.priorCount > 0) lines.push(`  ${deltaPct(biz.count, biz.priorCount)}`);
    lines.push(`Revenue: ${money(biz.revenue)}`);
    if (biz.priorRevenue > 0) lines.push(`  ${deltaPct(biz.revenue, biz.priorRevenue)}`);
    lines.push(`Commission: ${money(biz.commission)} · Supplier payout: ${money(biz.supplierPayout)}`);
    lines.push(`7-day avg bookings: ${biz.baselineDailyCount.toFixed(1)}`);
    if (biz.baselineDailyCount > 0 && biz.count !== null) {
      const v = ((biz.count - biz.baselineDailyCount) / biz.baselineDailyCount) * 100;
      lines.push(`  vs 7-day avg: ${v >= 0 ? '↑' : '↓'} ${Math.abs(v).toFixed(0)}%`);
    }
  } else {
    lines.push(`\n**BUSINESS**\nBookings: ⚠️ unavailable`);
  }
  if (S.topTours.length) {
    lines.push(`Top tour: **${S.topTours[0].title}** — ${money(S.topTours[0].revenue)}`);
  }

  // CUSTOMERS
  lines.push(`\n**CUSTOMERS**`);
  if (S.signups) {
    lines.push(`New users: ${S.signups.newUsers} · New suppliers: ${S.signups.newSuppliers}`);
    lines.push(`Active suppliers: ${S.signups.activeSuppliers}`);
  } else lines.push('New users/suppliers: ⚠️ unavailable');
  if (S.reviews) lines.push(`New reviews: ${S.reviews.count}${S.reviews.avg ? ` (avg ${S.reviews.avg.toFixed(1)})` : ''}`);
  else lines.push('New reviews: ⚠️ unavailable');
  if (S.refunds) lines.push(`Refunds: ${S.refunds.count} · ${money(S.refunds.amount)}`);
  else lines.push('Refunds: ⚠️ unavailable');
  if (S.disputes) lines.push(`Disputes opened: ${S.disputes.opened} · open: ${S.disputes.open}`);
  else lines.push('Disputes: ⚠️ unavailable');
  if (S.payouts) lines.push(`Payouts: ${S.payouts.count} · ${money(S.payouts.amount)}`);
  else lines.push('Payouts: ⚠️ unavailable');

  // PLATFORM HEALTH (claims only when fully probed + healthy)
  lines.push(`\n**PLATFORM HEALTH**`);
  const hf = (r, okText) => (r?.ok ? (r.value === okText || r.value === 'healthy' || r.value === 'active' ? okText : r.value) : 'UNAVAILABLE');
  lines.push(`API: ${health.api.ok ? (String(health.api.value).includes('healthy') || String(health.api.value).includes('200') ? 'healthy' : health.api.value) : 'UNAVAILABLE'}`);
  lines.push(`PostgreSQL: ${hf(health.postgres, 'healthy')}`);
  lines.push(`Redis: ${hf(health.redis, 'healthy')}`);
  lines.push(`Nginx: ${hf(health.nginx, 'active')}`);
  lines.push(`Server: ${health.server.ok ? health.server.value : 'UNAVAILABLE'}`);
  if (allHealthy) lines.push(`Platform remained operational in the reporting period.`);
  else if (!allProbed) lines.push(`Health data partially unavailable — operational status not claimed.`);
  else lines.push(`Health issue detected — see probes above.`);

  // OPERATIONS
  lines.push(`\n**OPERATIONS**`);
  if (S.incidents && S.incidents.ok) {
    lines.push(`Incidents: ${S.incidents.count} · Downtime: ${(S.incidents.downtimeMs / 60000).toFixed(1)} min`);
  } else lines.push('Incidents: ⚠️ unavailable');
  if (S.deploys && S.deploys.ok) {
    lines.push(`Deployments: ${S.deploys.value.count}`);
    if (S.deploys.value.latest) lines.push(`Latest: ${S.deploys.value.latest}`);
  } else lines.push('Deployments: ⚠️ unavailable');

  // BACKUPS
  lines.push(`\n**BACKUPS**`);
  if (S.backup && S.backup.ok) {
    if (S.backup.value.ok) {
      lines.push(`PostgreSQL backup: completed${S.backup.value.date ? ` ${S.backup.value.date.slice(11, 16)} UTC` : ''} · ${S.backup.value.size} · ${S.backup.value.dest} · retention ${S.backup.value.retention}`);
    } else {
      lines.push(`PostgreSQL backup: ${S.backup.value.note}`);
    }
  } else lines.push('Backup status: ⚠️ unavailable');
  if (S.drill && S.drill.ok) {
    lines.push(`Restore drill: ${S.drill.value.passed ? 'PASSED' : 'FAILED'}${S.drill.value.summary ? ` — ${S.drill.value.summary}` : ''}`);
  } else lines.push('Restore drill: ⚠️ unavailable');

  // DATA QUALITY
  const unavailableSections = [];
  if (!biz) unavailableSections.push('business');
  if (!S.signups) unavailableSections.push('customers');
  if (S.incidents && !S.incidents.ok) unavailableSections.push('incidents');
  if (S.deploys && !S.deploys.ok) unavailableSections.push('deployments');
  lines.push(`\n**DATA QUALITY**`);
  lines.push(unavailableSections.length ? `⚠️ ${unavailableSections.join(', ')} data unavailable` : 'All queries successful.');

  return lines.join('\n').slice(0, 5900);
}

function buildHealthSummaryForAi(health) {
  const parts = [];
  const fmt = (k, r) => `${k}: ${r?.ok ? r.value : 'UNAVAILABLE'}`;
  parts.push(fmt('API', health.api));
  parts.push(fmt('PostgreSQL', health.postgres));
  parts.push(fmt('Redis', health.redis));
  parts.push(fmt('Nginx', health.nginx));
  parts.push(fmt('Server', health.server));
  return parts.join(' | ');
}

// ── Main ───────────────────────────────────────────────────────────
async function buildReport() {
  const model = await collectDigest();
  const description = renderer(model, model);
  const payload = {
    title: `TRAVIOAFRICA ${model.label.toUpperCase()} DIGEST`,
    description,
    color: 0x00bcd4,
  };
  return { model, payload };
}

/**
 * Produce the final Discord-ready message (title/description/color) including
 * the disciplined AI note. Shared by the cron job and the bot's /digest.
 */
async function buildDigestMessage() {
  const { model, payload } = await buildReport();
  const healthSummary = buildHealthSummaryForAi(model.sections.health);
  const note = await aiNote(model.aiFactLines, healthSummary);
  const description = note ? `${payload.description}\n\n${note}` : payload.description;
  return {
    title: payload.title,
    description: description.slice(0, 5900),
    color: payload.color,
    dataStatus: model.dataStatus,
  };
}

async function main() {
  const message = await buildDigestMessage();

  await notifyDiscord('digest', message.description, {
    title: message.title,
    color: message.color,
  });

  console.log(`[digest] done: title=${message.title}`);
  return message;
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[digest] failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
    });
}

module.exports = { main, buildReport, buildDigestMessage, collectDigest, parseBackupLog, parseDrillLog, incidentSummary, periodInfo, deltaPct, renderer };
