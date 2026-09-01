/**
 * Daily ops digest for TravioAfrica.
 * Summarizes yesterday's activity (bookings, revenue, signups, suppliers,
 * top tours) plus backup/restore-drill status, then posts a Discord embed.
 *
 * Scheduled via cron (07:00). Safe to run manually:
 *   node scripts/dailyDigest.js
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

async function main() {
  const weekly = process.env.DIGEST_PERIOD === 'week';
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (weekly ? 7 : 1));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);

  const where = { createdAt: { gte: start, lt: end }, isSimulated: false, status: 'CONFIRMED' };

  const bookings = await prisma.booking.aggregate({
    where,
    _count: true,
    _sum: { grossAmount: true },
  });

  const signups = await prisma.user.count({ where: { createdAt: { gte: start, lt: end } } });
  const suppliers = await prisma.supplierProfile.count({ where: { createdAt: { gte: start, lt: end } } });

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
    topTours.push(`${t?.title || row.tourId} — ${Number(row._sum.grossAmount || 0).toFixed(2)}`);
  }

  const lastBackup = sh("grep 'Backup complete' /var/log/travio-backup.log | tail -1") || 'no backups recorded';
  const lastDrill = sh("grep 'Restore drill COMPLETE\\|RESTORE DRILL FAIL' /var/log/travio-backup.log | tail -1") || 'no drills recorded';

  // Disputes + pay-later failures opened in the period
  const disputesOpened = await prisma.dispute.count({
    where: { createdAt: { gte: start, lt: end } },
  }).catch(() => 0);
  const openDisputes = await prisma.dispute.count({
    where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  }).catch(() => 0);

  const period = weekly ? '7 days' : 'yesterday';
  const label = weekly ? 'Weekly' : 'Daily';
  const stats = `Period: ${period}\nBookings: ${bookings._count}\nRevenue: ${Number(bookings._sum.grossAmount || 0).toFixed(2)}\nNew signups: ${signups}\nNew suppliers: ${suppliers}\nDisputes opened: ${disputesOpened}\nOpen disputes: ${openDisputes}\nTop tours: ${topTours.join(', ') || 'none'}\nBackup: ${lastBackup.slice(0, 120)}\nRestore drill: ${lastDrill.slice(0, 120)}`;

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
    description = `Bookings (${period}): ${bookings._count} · Revenue: ${Number(bookings._sum.grossAmount || 0).toFixed(2)} · Signups: ${signups} · Suppliers: ${suppliers}`;
  }

  const fields = [
    { name: `Bookings (${period})`, value: `${bookings._count}`, inline: true },
    { name: `Revenue (${period})`, value: `${Number(bookings._sum.grossAmount || 0).toFixed(2)}`, inline: true },
    { name: 'New signups', value: `${signups}`, inline: true },
    { name: 'New suppliers', value: `${suppliers}`, inline: true },
    { name: 'Disputes opened', value: `${disputesOpened}`, inline: true },
    { name: 'Open disputes', value: `${openDisputes}`, inline: true },
    { name: 'Top tours', value: topTours.length ? topTours.join('\n') : 'none', inline: false },
    { name: 'Last backup', value: lastBackup.slice(0, 180), inline: false },
    { name: 'Last restore drill', value: lastDrill.slice(0, 180), inline: false },
  ];

  await notifyDiscord(
    'digest',
    description.slice(0, 2000),
    { title: `TravioAfrica ${label} Digest — ${start.toISOString().slice(0, 10)}`, fields, color: 0x00bcd4 }
  );

  console.log(`[digest:${label.toLowerCase()}] done: bookings=${bookings._count} revenue=${Number(bookings._sum.grossAmount || 0).toFixed(2)} signups=${signups} suppliers=${suppliers}`);
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

module.exports = { main };
