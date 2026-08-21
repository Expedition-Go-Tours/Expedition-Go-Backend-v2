const { Queue } = require('bullmq');
const { getConnection } = require('../utils/redisClient');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const nums = process.argv.slice(2);
  const bookings = nums.length
    ? await prisma.booking.findMany({ where: { bookingNumber: { in: nums } }, select: { id: true, bookingNumber: true } })
    : [];
  const ids = new Set(bookings.map((b) => b.id));
  const label = new Map(bookings.map((b) => [b.id, b.bookingNumber]));

  const q = new Queue('communications-emails', { connection: getConnection() });
  const [waiting, completed] = await Promise.all([q.getWaiting(0, 50), q.getJobs(['completed'], 0, 60, true)]);
  console.log('--- WAITING ---');
  for (const j of waiting) {
    const d = j.data || {};
    if (!ids.size || ids.has(d.bookingId)) console.log('WAIT', 'type=' + d.type, 'booking=' + (label.get(d.bookingId) || d.bookingId));
  }
  console.log('--- COMPLETED ---');
  for (const j of completed.reverse()) {
    const d = j.data || {};
    if (!ids.size || ids.has(d.bookingId)) console.log('DONE', 'type=' + d.type, 'booking=' + (label.get(d.bookingId) || d.bookingId));
  }
  await q.close();
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });