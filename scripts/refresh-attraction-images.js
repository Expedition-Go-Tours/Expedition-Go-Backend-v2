#!/usr/bin/env node
/**
 * Re-select attraction hero images.
 *
 * Fixes duplicated images (e.g. several attractions all showing the same tour
 * photo) by clearing the affected rows first, then re-running the AI selector —
 * which now refuses to reuse an image already assigned elsewhere and widens the
 * pool to other tours in the same city.
 *
 *   node scripts/refresh-attraction-images.js          # only duplicated images
 *   node scripts/refresh-attraction-images.js --all    # every attraction with an image
 *
 * Manually-curated attractions (manualOverride) are never touched.
 */

const prisma = require('../utils/prismaClient');
const logger = require('../utils/logger');
const { selectHeroImage } = require('../utils/aiContentAnalyzer');

async function main() {
  const all = process.argv.includes('--all');

  const rows = await prisma.attraction.findMany({
    where: { heroImage: { not: null }, manualOverride: false },
    select: { id: true, name: true, heroImage: true },
  });

  const counts = new Map();
  for (const r of rows) counts.set(r.heroImage, (counts.get(r.heroImage) || 0) + 1);

  const targets = all ? rows : rows.filter((r) => counts.get(r.heroImage) > 1);

  logger.info(
    `[refresh-attraction-images] ${targets.length} attraction(s) to re-select${all ? ' (all)' : ' (duplicates only)'}`
  );
  if (targets.length === 0) return;

  // Clear first: otherwise the selector's global "already used" set counts each
  // target's own stale image as taken and no one can keep the best match.
  await prisma.attraction.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { heroImage: null, heroImageSource: null, heroImageTourId: null, imageRelevance: null },
  });

  let changed = 0;
  for (const a of targets) {
    try {
      const sel = await selectHeroImage(a.name);
      await prisma.attraction.update({
        where: { id: a.id },
        data: { ...sel, lastComputedAt: new Date() },
      });
      changed += 1;
      logger.info(`  ${a.name} -> ${sel.heroImageSource}${sel.heroImage ? '' : ' (no image)'}`);
    } catch (err) {
      logger.warn(`  ${a.name} failed: ${err.message}`);
    }
  }
  logger.info(`[refresh-attraction-images] done — ${changed} updated`);
}

main()
  .catch((err) => {
    logger.error(`[refresh-attraction-images] failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // aiContentAnalyzer's dependencies keep handles open; exit explicitly.
    process.exit(process.exitCode || 0);
  });
