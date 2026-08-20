/**
 * One-time data fix: repair the `commission.default_rate` SystemConfig value.
 *
 * The Booking.commissionRate column is Decimal(5,4) (max 9.9999). If the
 * config was saved as a percentage (e.g. "15" for 15%) instead of a fraction
 * ("0.15"), every booking.create() fails with Postgres error 22003
 * ("numeric field overflow ... precision 5, scale 4").
 *
 * This script rewrites any percentage-style value to the expected fraction.
 * Idempotent and safe to re-run.
 *
 * Usage: node scripts/fixCommissionRateConfig.js
 */
const { PrismaClient } = require('@prisma/client');
const { normalizeCommissionRate } = require('../utils/commission');

const prisma = new PrismaClient();

async function main() {
  const key = 'commission.default_rate';
  const config = await prisma.systemConfig.findUnique({ where: { key } });

  if (!config) {
    console.log(`[fix] No "${key}" row found — nothing to fix.`);
    return;
  }

  const raw = config.value;
  const num = parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) {
    console.log(`[fix] "${key}" has an unusable value (${JSON.stringify(raw)}).`);
    return;
  }

  if (num <= 1) {
    console.log(`[fix] "${key}" is already a valid fraction (${raw}) — nothing to do.`);
    return;
  }

  const normalized = normalizeCommissionRate(raw);
  await prisma.systemConfig.update({
    where: { key },
    data: { value: String(normalized) },
  });
  console.log(`[fix] Rewrote "${key}" from ${JSON.stringify(raw)} -> ${normalized} (fraction).`);
  console.log('[fix] getConfig cache clears itself within 60s; a restart applies it immediately.');
}

main()
  .catch((err) => {
    console.error('[fix] Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());