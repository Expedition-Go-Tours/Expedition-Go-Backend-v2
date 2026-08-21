const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const u = await p.user.findUnique({ where: { email: 'kwarteon08@gmail.com' }, select: { id: true, email: true, name: true, roles: true } });
  console.log(u ? JSON.stringify(u) : 'NOT FOUND');
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });