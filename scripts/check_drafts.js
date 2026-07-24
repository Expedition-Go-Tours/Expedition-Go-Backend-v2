const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const count = await p.tour.count({ where: { title: 'towerwhats b', status: 'DRAFT' } });
  console.log('Remaining towerwhats b drafts:', count);
  await p.$disconnect();
})();
