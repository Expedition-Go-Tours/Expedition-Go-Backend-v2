#!/usr/bin/env node
/**
 * Seed commonly-searched Ghanaian cities/towns into the Attraction table.
 *
 * They are stored with `category: 'City / Town'` so searchController surfaces
 * them as Place/Destination suggestions (and excludes them from Attraction
 * suggestions). This gives the dropdown autofill for places that have no tours
 * yet — clicking one resolves the region and falls back to nearby tours.
 *
 * Idempotent: rows are matched by `name` and updated in place.
 *
 * Usage:
 *   node scripts/seed-ghana-places.js --dry-run   # preview
 *   node scripts/seed-ghana-places.js --apply     # write
 */

'use strict';

const { GHANA_PLACES, REGION_CAPITALS, REGION_PRIORITY } = require('./data/ghana-places');

const APPLY = process.argv.includes('--apply');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRow(region, name) {
  const capital = REGION_CAPITALS[region];
  const isCapital = !!capital && name.toLowerCase() === capital.toLowerCase();
  return {
    name,
    slug: slugify(name),
    town: name,
    region,
    category: 'City / Town',
    aliases: null,
    priority: REGION_PRIORITY[region] || 'Standard',
    placeType: isCapital ? 'Major City' : 'Town',
    status: 'ACTIVE',
  };
}

async function main() {
  const total = Object.values(GHANA_PLACES).reduce((n, l) => n + l.length, 0);
  console.log('=== Ghana Places Seed ===');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Regions: ${Object.keys(GHANA_PLACES).length}   Places: ${total}`);
  console.log('');

  const prisma = require('../src/core/services/prismaClient');

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const [region, places] of Object.entries(GHANA_PLACES)) {
    for (const name of places) {
      const data = buildRow(region, name);
      try {
        const existing = await prisma.attraction.findUnique({
          where: { name },
          select: { id: true, category: true, town: true, region: true },
        });

        if (existing) {
          if (existing.category === data.category && existing.town === data.town && existing.region === data.region) {
            skipped++;
            continue;
          }
          if (APPLY) {
            await prisma.attraction.update({
              where: { name },
              data: {
                town: data.town,
                region: data.region,
                category: data.category,
                priority: data.priority,
                placeType: data.placeType,
                status: data.status,
              },
            });
          }
          updated++;
        } else {
          if (APPLY) {
            await prisma.attraction.create({ data });
          }
          created++;
        }
      } catch (err) {
        errors.push({ name, error: err.message });
      }
    }
  }

  console.log('=== Results ===');
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Unchanged: ${skipped}`);
  if (errors.length) {
    console.log(`  Errors: ${errors.length}`);
    errors.forEach((e) => console.log(`    - ${e.name}: ${e.error}`));
  }
  if (!APPLY) console.log('\n(dry run — nothing written)');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
