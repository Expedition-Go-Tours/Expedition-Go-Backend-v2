#!/usr/bin/env node
/**
 * Re-select attraction hero images.
 *
 * Fixes duplicated images (e.g. several attractions all showing the same tour
 * photo) by clearing the affected rows first, then re-running the AI selector —
 * which now refuses to reuse an image already assigned elsewhere and widens the
 * pool to other tours in the same city.
 *
 *   node scripts/refresh-attraction-images.js           # only duplicated images
 *   node scripts/refresh-attraction-images.js --all     # every attraction with an image
 *   node scripts/refresh-attraction-images.js --missing # no-image attractions that have tours
 *
 * Manually-curated attractions (manualOverride) are never touched.
 */

const prisma = require('../src/core/services/prismaClient');
const logger = require('../src/core/services/logger');
const { selectHeroImage } = require('../src/core/services/aiContentAnalyzer');
const { variantsFor } = require('../src/core/services/attractionMatch');

async function main() {
  const all = process.argv.includes('--all');
  const missing = process.argv.includes('--missing');

  const rows = await prisma.attraction.findMany({
    where: missing
      ? { heroImage: null, manualOverride: false, tourCount: { gte: 1 } }
      : { heroImage: { not: null }, manualOverride: false },
    select: { id: true, name: true, aliases: true, heroImage: true },
  });

  const counts = new Map();
  for (const r of rows) counts.set(r.heroImage, (counts.get(r.heroImage) || 0) + 1);

  const targets = all || missing ? rows : rows.filter((r) => counts.get(r.heroImage) > 1);

  const mode = all ? ' (all)' : missing ? ' (missing images)' : ' (duplicates only)';
  logger.info(`[refresh-attraction-images] ${targets.length} attraction(s) to re-select${mode}`);
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
      const sel = await selectHeroImage(a.name, null, variantsFor(a));
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
