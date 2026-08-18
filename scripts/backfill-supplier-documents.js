/**
 * Backfill: migrate legacy SupplierProfile.businessDocuments (JSON blob) into
 * granular SupplierDocument rows. Idempotent — skips suppliers that already
 * have SupplierDocument records.
 *
 * Document status follows the supplier's current status: already APPROVED/ACTIVE
 * suppliers are backfilled as APPROVED (they keep their verified state);
 * everyone else is backfilled as PENDING.
 *
 * Usage: node scripts/backfill-supplier-documents.js
 */

const prisma = require('../utils/prismaClient');

const LEGACY_TYPE_MAP = {
  registrationDocument: 'BUSINESS_CERTIFICATE',
  taxDocument: 'OTHER',
  proofOfAddress: 'PROOF_OF_ADDRESS',
  idDocument: 'NATIONAL_ID',
};

async function main() {
  const profiles = await prisma.supplierProfile.findMany({
    select: { id: true, status: true, businessDocuments: true },
  });

  const approvedStatuses = ['ACTIVE', 'APPROVED'];
  let createdDocs = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const docs = profile.businessDocuments || {};
    if (!docs || Object.keys(docs).length === 0) continue;

    const existingCount = await prisma.supplierDocument.count({ where: { supplierId: profile.id } });
    if (existingCount > 0) {
      skipped += 1;
      continue;
    }

    const status = approvedStatuses.includes(profile.status) ? 'APPROVED' : 'PENDING';
    const rows = [];

    for (const [key, type] of Object.entries(LEGACY_TYPE_MAP)) {
      if (docs[key]) rows.push({ key, type, url: docs[key] });
    }
    if (Array.isArray(docs.licenses)) {
      docs.licenses.forEach((url) => rows.push({ key: 'licenses', type: 'OTHER', url }));
    }

    for (const row of rows) {
      if (!row.url) continue;
      await prisma.supplierDocument.create({
        data: {
          supplierId: profile.id,
          ownerType: 'SUPPLIER',
          ownerId: profile.id,
          type: row.type,
          url: row.url,
          status,
        },
      });
      createdDocs += 1;
    }
  }

  console.log(`Backfill complete: ${createdDocs} document rows created, ${skipped} suppliers skipped (already migrated).`);
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());