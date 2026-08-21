/**
 * One-off: link migrated (pre finance-v2) payout requests to the supplier's
 * default verified payout method. The finance-v2 migration backfilled
 * PayoutRequests with payoutMethodId: null, which made the admin UI show
 * "No payout method on file" even when the supplier had a verified method.
 *
 * Usage: node scripts/backfill-payout-request-methods.js [--dry]
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const DRY = process.argv.includes('--dry');

async function main() {
  const requests = await prisma.payoutRequest.findMany({
    where: { payoutMethodId: null, status: { in: ['PROCESSING', 'APPROVED'] } },
    select: { id: true, requestNumber: true, supplierId: true },
  });

  console.log(`Found ${requests.length} active payout request(s) without a payout method.`);

  const supplierIds = [...new Set(requests.map((r) => r.supplierId))];
  const methods = await prisma.payoutMethod.findMany({
    where: { supplierId: { in: supplierIds }, verified: true },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
  });

  const bySupplier = {};
  for (const m of methods) {
    if (!bySupplier[m.supplierId]) bySupplier[m.supplierId] = m;
  }

  let patched = 0;
  for (const r of requests) {
    const method = bySupplier[r.supplierId];
    if (!method) {
      console.log(`  SKIP ${r.requestNumber} — supplier ${r.supplierId} has no verified payout method`);
      continue;
    }
    if (DRY) {
      console.log(`  [DRY] ${r.requestNumber} → ${method.type}${method.isDefault ? ' (default)' : ''}`);
    } else {
      await prisma.payoutRequest.update({
        where: { id: r.id },
        data: { payoutMethodId: method.id },
      });
      console.log(`  PATCHED ${r.requestNumber} → ${method.type}${method.isDefault ? ' (default)' : ''}`);
    }
    patched++;
  }

  console.log(`Done. ${patched} request(s) ${DRY ? 'would be' : ''} linked to a payout method.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
