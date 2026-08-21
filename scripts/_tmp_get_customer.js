const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' } });
  console.log(JSON.stringify({ id: u.id, stripeCustomerId: u.stripeCustomerId }, null, 2));
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });