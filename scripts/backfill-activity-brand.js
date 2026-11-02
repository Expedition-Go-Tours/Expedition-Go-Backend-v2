#!/usr/bin/env node
/**
 * Backfill `brand` on Event and AuditLog rows written before the column
 * existed.
 *
 * Safe to run repeatedly: it only touches rows whose brand is still null and
 * whose brand can be resolved from data that already exists. Anything
 * genuinely ambiguous is left null rather than guessed, because showing an
 * Africa customer in the Ghana admin feed is worse than omitting a legacy row.
 *
 * Usage:
 *   node scripts/backfill-activity-brand.js
 *   node scripts/backfill-activity-brand.js --batch=2000
 */

const prisma = require('../src/core/services/prismaClient');

const BATCH = (() => {
  const arg = process.argv.find((value) => value.startsWith('--batch='));
  const parsed = arg ? parseInt(arg.split('=')[1], 10) : 1000;
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10000) : 1000;
})();

async function backfillEvents() {
  let total = 0;
  for (;;) {
    const moved = await prisma.$executeRaw`
      WITH batch AS (
        SELECT id
        FROM "Event"
        WHERE "brand" IS NULL
          AND (
            "properties"->>'source' IN ('ghana', 'africa', 'expedition')
            OR "name" LIKE 'ghana.%'
            OR "name" LIKE 'africa.%'
            OR "name" LIKE 'expedition.%'
          )
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH}
      )
      UPDATE "Event" e
      SET "brand" = CASE
        WHEN e."properties"->>'source' IN ('ghana', 'africa', 'expedition')
          THEN e."properties"->>'source'
        WHEN e."name" LIKE 'ghana.%' THEN 'ghana'
        WHEN e."name" LIKE 'africa.%' THEN 'africa'
        WHEN e."name" LIKE 'expedition.%' THEN 'expedition'
        ELSE NULL
      END
      FROM batch
      WHERE e.id = batch.id
    `;
    if (!moved) break;
    total += moved;
    process.stdout.write(`\rEvent rows backfilled: ${total}`);
  }
  process.stdout.write('\n');
  return total;
}

async function backfillAudits() {
  let total = 0;
  for (;;) {
    const moved = await prisma.$executeRaw`
      WITH batch AS (
        SELECT a.id, u."roles"
        FROM "AuditLog" a
        LEFT JOIN "User" u ON u.id = a."userId"
        WHERE a."brand" IS NULL
          AND (
            a."metadata"->>'brand' IN ('ghana', 'africa', 'expedition')
            OR ('ghana' = ANY(u."roles"::text[]))
            OR ('travioafrica' = ANY(u."roles"::text[]))
          )
        ORDER BY a."createdAt" ASC
        LIMIT ${BATCH}
      )
      UPDATE "AuditLog" a
      SET "brand" = CASE
        WHEN a."metadata"->>'brand' IN ('ghana', 'africa', 'expedition')
          THEN a."metadata"->>'brand'
        WHEN 'ghana' = ANY(batch."roles"::text[]) THEN 'ghana'
        WHEN 'travioafrica' = ANY(batch."roles"::text[]) THEN 'africa'
        ELSE NULL
      END
      FROM batch
      WHERE a.id = batch.id
    `;
    if (!moved) break;
    total += moved;
    process.stdout.write(`\rAudit rows backfilled: ${total}`);
  }
  process.stdout.write('\n');
  return total;
}

async function main() {
  console.log(`Backfilling activity brand in batches of ${BATCH}…`);
  const events = await backfillEvents();
  const audits = await backfillAudits();
  console.log(`Done. Events: ${events}, audits: ${audits}.`);
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
