/**
 * One-off (idempotent) data migration for the wishlist feature.
 *
 * The legacy `User.wishlist` column stored a plain array of tour IDs with no
 * per-item timestamp. WishlistItem is now the source of truth (real
 * "added at" dates, stable ordering, compound-unique add/remove). This
 * script copies any non-empty legacy arrays into WishlistItem so existing
 * accounts don't lose their saved tours on deploy.
 *
 * Safe to run repeatedly: rows are created with skipDuplicates and users
 * already present in the table are left untouched.
 *
 * Run AFTER `npx prisma db push` (which creates the table and regenerates
 * the client) and BEFORE starting the server:
 *   node scripts/backfill-wishlist.js
 */
const prisma = require('../utils/prismaClient');

async function backfill() {
  const users = await prisma.user.findMany({
    where: { wishlist: { isEmpty: false } },
    select: { id: true, wishlist: true },
  });

  let created = 0;
  let alreadySynced = 0;
  let withLegacyData = 0;

  for (const u of users) {
    withLegacyData += 1;

    const existing = await prisma.wishlistItem.findMany({
      where: { userId: u.id },
      select: { tourId: true },
    });
    const have = new Set(existing.map((e) => e.tourId));

    const toAdd = [...new Set(u.wishlist)].filter((tourId) => !have.has(tourId));
    if (toAdd.length === 0) {
      alreadySynced += 1;
      continue;
    }

    const res = await prisma.wishlistItem.createMany({
      data: toAdd.map((tourId) => ({ userId: u.id, tourId })),
      skipDuplicates: true,
    });
    created += res.count;
  }

  console.log(
    `[backfill-wishlist] usersWithLegacyData=${withLegacyData} rowsCreated=${created} alreadySynced=${alreadySynced}`
  );

  await prisma.$disconnect();
}

backfill().catch(async (e) => {
  console.error('[backfill-wishlist] failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
