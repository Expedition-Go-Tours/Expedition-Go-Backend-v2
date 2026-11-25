#!/usr/bin/env node
/**
 * Backfill menuUrl + mealTypes on existing restaurant venues.
 *
 * The original catalogue import predates these columns, so the data is still
 * in the source payload under `sourceMeta`. This script touches only the two
 * menu fields; it does not rewrite descriptions, photos or review aggregates.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-restaurant-menu.js \
 *     --file data/ghana-restaurants-2026-11-24.json
 *   ... --dry-run
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../src/core/services/prismaClient');

function parseArgs(argv) {
  const args = { file: null, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function toUrlOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  return /^https?:\/\//i.test(text) ? text : null;
}

function toMealTypes(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.file) {
    console.log(
      'Usage: node scripts/backfill-restaurant-menu.js --file <path.json> [--dry-run]',
    );
    process.exit(args.help ? 0 : 1);
  }

  const payload = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), args.file), 'utf8'));
  const venues = Array.isArray(payload) ? payload : payload.venues;
  if (!Array.isArray(venues)) throw new Error('Payload must contain a venues array');

  let updated = 0;
  let skipped = 0;

  for (const raw of venues) {
    const slug = String(raw.slug || '').trim();
    if (!slug) {
      skipped += 1;
      continue;
    }

    const menuUrl = toUrlOrNull(raw.menuUrl || raw.sourceMeta?.menuUrl);
    const mealTypes = toMealTypes(raw.mealTypes || raw.sourceMeta?.mealTypes);
    if (!menuUrl && mealTypes.length === 0) {
      skipped += 1;
      continue;
    }

    if (args.dryRun) {
      console.log(`would update ${slug}: ${menuUrl || '(no menu link)'} ${mealTypes.join(', ')}`);
      updated += 1;
      continue;
    }

    const result = await prisma.restaurantVenue.updateMany({
      where: { slug },
      data: { menuUrl, mealTypes },
    });
    if (result.count > 0) {
      updated += result.count;
    } else {
      skipped += 1;
    }
  }

  console.log(
    `${args.dryRun ? 'Would update' : 'Updated'} ${updated} venue(s); skipped ${skipped}.`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
