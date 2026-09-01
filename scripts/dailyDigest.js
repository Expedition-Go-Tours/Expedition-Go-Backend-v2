/**
 * Daily ops digest for TravioAfrica.
 * Summarizes yesterday's activity (bookings, revenue, signups, suppliers,
 * top tours, disputes, reviews, payouts, pay-later, refunds) plus
 * backup/restore-drill status, then posts a Discord embed.
 *
 * Scheduled via cron (07:00 daily, 08:00 Sunday weekly). Safe to run manually:
 *   node scripts/dailyDigest.js
 *   DIGEST_PERIOD=week node scripts/dailyDigest.js
 */
require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');
const { notifyDiscord } = require('../utils/discordNotifier');
const { callMimo } = require('../utils/mimoClient');

const prisma = new PrismaClient();

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

async function collectDigest() {
  const weekly = process.env.DIGEST_PERIOD === 'week';
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (weekly ? 7 : 1));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  const where = { createdAt: { gte: start, lt: end }, isSimulated: false, status: 'CONFIRMED' };

  // ── Core bookings + revenue ───────────────────────────────────────
  const bookings = await prisma.booking.aggregate({
    where,
    _count: true,
    _sum: { grossAmount: true, platformCommission: true, supplierPayout: true },
  });

  const signups = await prisma.user.count({ where: { createdAt: { gte: start, lt: end } } });
  const suppliers = await prisma.supplierProfile.count({ where: { createdAt: { gte: start, lt: end } } });

  // ── Booking status breakdown for the period (all statuses) ────────
  const statusGroups = await prisma.booking.groupBy({
    by: ['status'],
    where: { createdAt: { gte: start, lt: end }, isSimulated: false },
    _count: true,
  });
  const statusMap = {};
  for (const g of statusGroups) statusMap[g.status] = g._count;

  // ── Refunds (period) ──────────────────────────────────────────────
  const refundAgg = await prisma.booking.aggregate({
    where: { createdAt: { gte: start, lt: end }, isSimulated: false, status: 'REFUNDED' },
    _count: true,
    _sum: { refundAmount: true },
  }).catch(() => null);

  // ── Pay-later (period) ────────────────────────────────────────────
  const payLater = await prisma.booking.count({
    where: { createdAt: { gte: start, lt: end }, isSimulated: false, paymentTiming: { not: 'now' } },
  }).catch(() => 0);

  // ── Top tours by revenue ──────────────────────────────────────────
  const byTour = await prisma.booking.groupBy({
    by: ['tourId'],
    where,
    _sum: { grossAmount: true },
    orderBy: { _sum: { grossAmount: 'desc' } },
    take: 5,
  });

  const topTours = [];
  for (const row of byTour) {
    const t = await prisma.tour.findUnique({ where: { id: row.tourId }, select: { title: true } }).catch(() => null);
    topTours.push(`${t?.title || row.tourId} — ${money(row._sum.grossAmount)}`);
  }

  // ── Reviews (period) ──────────────────────────────────────────────
  const reviews = await prisma.review.aggregate({
    where: { createdAt: { gte: start, lt: end } },
    _count: true,
    _avg: { rating: true },
  }).catch(() => null);

  // ── Payouts (period: approved or paid) ────────────────────────────
  const payouts = await prisma.payout.aggregate({
    where: { createdAt: { gte: start, lt: end }, status: { in: ['APPROVED', 'PAID', 'PROCESSING'] } },
    _count: true,
    _sum: { amount: true },
  }).catch(() => null);

  // ── Supplier pipeline (current status split) ──────────────────────
  const supplierStatus = await prisma.supplierProfile.groupBy({
    by: ['status'],
    _count: true,
  }).catch(() => []);

  // ── Backup + restore drill ────────────────────────────────────────
  const lastBackup = sh("grep 'Backup complete' /var/log/travio-backup.log | tail -1") || 'no backups recorded';
  const lastDrill = sh("grep 'Restore drill COMPLETE\\|RESTORE DRILL FAIL' /var/log/travio-backup.log | tail -1") || 'no drills recorded';

  // ── Disputes ──────────────────────────────────────────────────────
  const disputesOpened = await prisma.dispute.count({
    where: { createdAt: { gte: start, lt: end } },
  }).catch(() => 0);
  const openDisputes = await prisma.dispute.count({
    where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  }).catch(() => 0);

  // ── Assemble stats for the AI summary ─────────────────────────────
  const period = weekly ? '7 days' : 'yesterday';
  const label = weekly ? 'Weekly' : 'Daily';

  const statusBreakdown = Object.entries(statusMap)
    .map(([s, c]) => `${s}=${c}`)
    .join(', ') || 'none';

  const supplierPipeline = supplierStatus.length
    ? supplierStatus.map((s) => `${s.status}=${s._count}`).join(', ')
    : 'none';

  const stats = [
    `Period: ${period}`,
    `Bookings: ${bookings._count}`,
    `Gross revenue: ${money(bookings._sum.grossAmount)}`,
    `Platform commission: ${money(bookings._sum.platformCommission)}`,
    `Supplier payout: ${money(bookings._sum.supplierPayout)}`,
    `Booking statuses: ${statusBreakdown}`,
    `Refunds: ${refundAgg ? `${refundAgg._count} (${money(refundAgg._sum.refundAmount)})` : 'n/a'}`,
    `Pay-later bookings: ${payLater}`,
    `New signups: ${signups}`,
    `New suppliers: ${suppliers}`,
    `Supplier pipeline: ${supplierPipeline}`,
    `New reviews: ${reviews ? `${reviews._count} (avg ${(reviews._avg.rating || 0).toFixed(1)})` : 'n/a'}`,
    `Payouts processed: ${payouts ? `${payouts._count} (${money(payouts._sum.amount)})` : 'n/a'}`,
    `Disputes opened: ${disputesOpened}`,
    `Open disputes: ${openDisputes}`,
    `Top tours: ${topTours.join(', ') || 'none'}`,
    `Backup: ${lastBackup.slice(0, 120)}`,
    `Restore drill: ${lastDrill.slice(0, 120)}`,
  ].join('\n');

  let description;
  if (process.env.MIMO_API_KEY) {
    try {
      description = await callMimo({
        system: 'You are a travel-platform ops analyst. Summarize this digest data in 4-6 concise bullet points. Highlight notable changes, risks, or action items. Do not repeat raw numbers — interpret them. Return ONLY the summary text, no JSON, no markdown.',
        user: stats,
        maxTokens: 1024,
        temperature: 0.2,
      });
    } catch { /* fallback below */ }
  }

  if (!description) {
    description = `Bookings (${period}): ${bookings._count} · Revenue: ${money(bookings._sum.grossAmount)} · Signups: ${signups} · Suppliers: ${suppliers}`;
  }

  const fields = [
    { name: `Bookings (${period})`, value: `${bookings._count}`, inline: true },
    { name: `Revenue (${period})`, value: money(bookings._sum.grossAmount), inline: true },
    { name: 'Commission', value: money(bookings._sum.platformCommission), inline: true },
    { name: 'Supplier payout', value: money(bookings._sum.supplierPayout), inline: true },
    { name: 'Statuses', value: statusBreakdown.slice(0, 180), inline: false },
    { name: 'New signups', value: `${signups}`, inline: true },
    { name: 'New suppliers', value: `${suppliers}`, inline: true },
    { name: 'Supplier pipeline', value: supplierPipeline.slice(0, 180), inline: false },
    { name: 'Refunds', value: refundAgg ? `${refundAgg._count} · ${money(refundAgg._sum.refundAmount)}` : 'n/a', inline: true },
    { name: 'Pay-later', value: `${payLater}`, inline: true },
    { name: 'New reviews', value: reviews ? `${reviews._count} · avg ${(reviews._avg.rating || 0).toFixed(1)}` : 'n/a', inline: true },
    { name: 'Payouts', value: payouts ? `${payouts._count} · ${money(payouts._sum.amount)}` : 'n/a', inline: true },
    { name: 'Disputes opened', value: `${disputesOpened}`, inline: true },
    { name: 'Open disputes', value: `${openDisputes}`, inline: true },
    { name: 'Top tours', value: topTours.length ? topTours.join('\n') : 'none', inline: false },
    { name: 'Last backup', value: lastBackup.slice(0, 180), inline: false },
    { name: 'Last restore drill', value: lastDrill.slice(0, 180), inline: false },
  ];

  return {
    title: `TravioAfrica ${label} Digest — ${start.toISOString().slice(0, 10)}`,
    description: description.slice(0, 2000),
    fields,
    color: 0x00bcd4,
  };
}

async function main() {
  const payload = await collectDigest();
  await notifyDiscord('digest', payload.description, {
    title: payload.title,
    fields: payload.fields,
    color: payload.color,
  });

  console.log(`[digest] done: title=${payload.title}`);
  return payload;
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

module.exports = { main, collectDigest };

