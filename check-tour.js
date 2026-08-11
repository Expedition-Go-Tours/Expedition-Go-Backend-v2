const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const rows = await p.$queryRawUnsafe(
    `SELECT id, title, status, "draftStatus", "draftSubmittedAt", "draftContent" IS NOT NULL AS has_draft FROM "Tour" WHERE id = 'cmsna5vn2002oxqj8eba3jcad'`
  );
  console.log(JSON.stringify(rows, null, 2));
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
