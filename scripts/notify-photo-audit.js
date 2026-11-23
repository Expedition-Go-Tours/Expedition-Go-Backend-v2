#!/usr/bin/env node
/**
 * Email affected suppliers their own photo-replacement list.
 *
 *   node scripts/notify-photo-audit.js             # dry run: who would get what
 *   node scripts/notify-photo-audit.js --send      # actually send
 *   node scripts/notify-photo-audit.js --supplier <id> [--send]
 *
 * Dry run is the default. Sending is one email per supplier, listing every
 * affected listing with the specific problem, because "improve your photos" is
 * not something anyone can act on.
 */

const prisma = require('../src/core/services/prismaClient');
const { auditTourPhotos } = require('../src/core/services/photoAudit');
const { sendSupplierPhotoAuditEmail } = require('../src/core/services/emailService');
const { sendNotification } = require('../src/core/services/notificationService');

function parseArgs(argv) {
  const args = { send: false, inApp: false, supplier: null, limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--send') args.send = true;
    else if (arg === '--in-app') args.inApp = true;
    else if (arg === '--supplier') args.supplier = argv[(i += 1)];
    else if (arg === '--limit') args.limit = parseInt(argv[(i += 1)], 10) || 0;
  }
  return args;
}

function emptyCounts() {
  return { portrait: 0, tooSmall: 0, soft: 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = { status: 'ACTIVE' };
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
      supplier: { select: { id: true, name: true, email: true, roles: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(args.limit > 0 ? { take: args.limit } : {}),
  });

  console.log(`Auditing ${tours.length} active tours...\n`);

  // supplierId -> { supplier, tours: [{ title, issueCount, ... }], total }
  const bySupplier = new Map();

  for (const tour of tours) {
    const audit = await auditTourPhotos(tour);
    if (audit.issues.length === 0) continue;

    const key = tour.supplierId;
    if (!bySupplier.has(key)) {
      bySupplier.set(key, {
        supplier: tour.supplier || { id: tour.supplierId, name: 'Unknown supplier', email: null },
        tours: [],
        total: 0,
      });
    }

    const entry = bySupplier.get(key);
    const counts = emptyCounts();
    for (const issue of audit.issues) {
      if (issue.problem === 'portrait') counts.portrait += 1;
      else if (issue.problem === 'too-small') counts.tooSmall += 1;
      else counts.soft += 1;
    }

    entry.tours.push({
      tourId: audit.tourId,
      title: audit.title || tour.title,
      issueCount: audit.issues.length,
      ...counts,
    });
    entry.total += audit.issues.length;
  }

  if (bySupplier.size === 0) {
    console.log('No photos need replacing.');
    await prisma.$disconnect();
    return;
  }

  for (const [, entry] of bySupplier) {
    const { supplier, tours: affected, total } = entry;
    console.log(`${supplier.name} <${supplier.email || 'NO EMAIL'}>`);
    console.log(`  ${total} photos across ${affected.length} tours`);
    for (const tour of affected) {
      const bits = [];
      if (tour.portrait) bits.push(`${tour.portrait} portrait`);
      if (tour.tooSmall) bits.push(`${tour.tooSmall} under 1280px`);
      if (tour.soft) bits.push(`${tour.soft} under 2048px`);
      console.log(`    - ${tour.title}: ${bits.join(', ')}`);
    }
    console.log('');
  }

  const totals = [...bySupplier.values()].reduce((n, e) => n + e.total, 0);
  console.log(`--- ${bySupplier.size} suppliers, ${totals} photos ---\n`);

  if (!args.send) {
    console.log('Dry run. Re-run with --send to email these suppliers, or --in-app to only notify in the dashboard.');
    await prisma.$disconnect();
    return;
  }

  let sent = 0;
  let notified = 0;
  let skipped = 0;
  for (const [, entry] of bySupplier) {
    const { supplier, tours: affected, total } = entry;

    // In-app first: it is the durable channel. The email is the nudge; the bell
    // entry is what a supplier sees the next time they open the dashboard.
    try {
      await sendNotification({
        userId: supplier.id,
        type: 'SYSTEM_ALERT',
        title: 'Some tour photos need replacing',
        message: `${total} photos on ${affected.length} listing${
          affected.length === 1 ? '' : 's'
        } are portrait or below 1280px, so they look soft on the storefront.`,
        data: { path: '/products', linkLabel: 'Review photos' },
        dedupeKey: `photo-audit:${total}`,
      });
      notified += 1;
    } catch (error) {
      console.error(`notification failed ${supplier.name}:`, error.message);
    }

    if (!supplier.email) {
      console.log(`skipped email for ${supplier.name}: no address`);
      skipped += 1;
      continue;
    }
    if (args.inApp) {
      console.log(`in-app only for ${supplier.name}`);
      continue;
    }
    try {
      const result = await sendSupplierPhotoAuditEmail({
        supplier: entry.supplier,
        tours: entry.tours,
        brandKey: 'ghana',
      });
      if (result) {
        sent += 1;
        console.log(`sent ${entry.supplier.name} (${entry.total} photos)`);
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error(`failed ${entry.supplier.name}:`, error.message);
    }
  }

  console.log(`\ndone: ${sent} emails sent, ${notified} in-app notifications, ${skipped} skipped`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('notify failed:', error.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
