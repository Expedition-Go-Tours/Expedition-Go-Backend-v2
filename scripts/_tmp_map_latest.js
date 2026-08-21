const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' } });
  const bs = await p.booking.findMany({
    where: { customerId: u.id },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: { id: true, bookingNumber: true, status: true, paymentStatus: true, paymentTiming: true },
  });
  for (const b of bs) console.log(b.id, b.bookingNumber, b.paymentTiming, b.status + '/' + b.paymentStatus);
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });