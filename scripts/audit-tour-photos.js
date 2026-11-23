#!/usr/bin/env node
/**
 * Report every stored tour photo that is too small to render sharply.
 *
 *   node scripts/audit-tour-photos.js                  # all active tours
 *   node scripts/audit-tour-photos.js --supplier <id>  # one supplier
 *   node scripts/audit-tour-photos.js --json report.json
 *
 * Exit code is 0 even when it finds problems: this is a report, not a gate.
 * The upload gate (`photoQuality.js`) is what stops new ones.
 */

const fs = require('fs');
const path = require('path');
const prisma = require('../src/core/services/prismaClient');
const { auditTourPhotos, MIN_PHOTO_WIDTH } = require('../src/core/services/photoAudit');

function parseArgs(argv) {
  const args = { supplier: null, json: null, status: 'ACTIVE', limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--supplier') args.supplier = argv[(i += 1)];
    else if (arg === '--json') args.json = argv[(i += 1)];
    else if (arg === '--status') args.status = argv[(i += 1)];
    else if (arg === '--limit') args.limit = parseInt(argv[(i += 1)], 10) || 0;
  }
  return args;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = { status: args.status };
  if (args.supplier) where.supplierId = args.supplier;

  const tours = await prisma.tour.findMany({
    where,
    select: {
      id: true,
      title: true,
      slug: true,
      photos: true,
      coverPhoto: true,
      supplierId: true,
      supplier: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(args.limit > 0 ? { take: args.limit } : {}),
  });

  console.log(`Auditing ${tours.length} ${args.status.toLowerCase()} tours...\n`);

  const rows = [];
  const summary = new Map();

  for (const tour of tours) {
    const audit = await auditTourPhotos(tour);
    for (const issue of audit.issues) {
      rows.push({
        supplier: tour.supplier?.name || tour.supplierId,
        tour: audit.title,
        slug: audit.slug,
        width: issue.width,
        height: issue.height,
        problem: issue.problem,
        url: issue.url,
      });

      const key = tour.supplier?.name || tour.supplierId;
      const current = summary.get(key) || { tours: new Set(), photos: 0 };
      current.tours.add(audit.tourId);
      current.photos += 1;
      summary.set(key, current);
    }
  }

  if (rows.length === 0) {
    console.log(`No photos under ${MIN_PHOTO_WIDTH}px found.`);
  } else {
    console.log(pad('SUPPLIER', 26), pad('TOUR', 40), pad('SIZE', 12), 'PROBLEM');
    for (const row of rows) {
      console.log(
        pad(row.supplier.slice(0, 25), 26),
        pad(row.tour.slice(0, 39), 40),
        pad(`${row.width}x${row.height}`, 12),
        row.problem
      );
    }
  }

  const byProblem = rows.reduce((acc, row) => {
    acc[row.problem] = (acc[row.problem] || 0) + 1;
    return acc;
  }, {});

  console.log('\n--- summary ---');
  console.log('photos to replace:', rows.length);
  console.log('tours affected:', new Set(rows.map((r) => r.slug)).size);
  console.log('by problem:', JSON.stringify(byProblem));

  if (summary.size > 0) {
    console.log('\nsuppliers affected:');
    for (const [name, info] of [...summary.entries()].sort((a, b) => b[1].photos - a[1].photos)) {
      console.log(`  ${name}: ${info.photos} photos across ${info.tours.size} tours`);
    }
  }

  if (args.json) {
    const out = path.resolve(args.json);
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
    console.log('\nwrote', out);
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('audit failed:', error.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
