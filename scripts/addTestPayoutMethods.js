/**
 * Development Script: Add Verified Payout Methods to All Suppliers
 * 
 * This script adds a default verified payout method to all supplier accounts
 * that don't already have one. Useful for development/testing environments.
 * 
 * Usage:
 *   node scripts/addTestPayoutMethods.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function addTestPayoutMethods() {
  console.log('🔍 Finding suppliers without verified payout methods...\n');

  try {
    // Get all suppliers
    const suppliers = await prisma.user.findMany({
      where: {
        roles: {
          has: 'supplier'
        },
        supplierProfile: {
          isNot: null
        }
      },
      include: {
        payoutMethods: true,
        supplierProfile: true
      }
    });

    console.log(`📊 Found ${suppliers.length} supplier accounts\n`);

    let addedCount = 0;
    let skippedCount = 0;

    for (const supplier of suppliers) {
      const hasVerified = supplier.payoutMethods.some(pm => pm.verified === true);

      if (hasVerified) {
        console.log(`✓ ${supplier.name} (${supplier.email}) - Already has verified payout method`);
        skippedCount++;
        continue;
      }

      // Add a test payout method
      const payoutMethod = await prisma.payoutMethod.create({
        data: {
          supplierId: supplier.id,
          type: 'BANK_TRANSFER',
          accountName: supplier.name || 'Test Account',
          bankName: 'Test Bank (Dev)',
          accountNumber: '0011223344',
          routingNumber: '110000000',
          swiftCode: 'TESTUS33',
          currency: 'USD',
          bankCountry: supplier.supplierProfile?.country || 'US',
          isDefault: true,
          verified: true
        }
      });

      console.log(`✅ ${supplier.name} (${supplier.email}) - Added verified payout method (${payoutMethod.id})`);
      addedCount++;
    }

    console.log('\n' + '='.repeat(60));
    console.log(`\n📈 Summary:`);
    console.log(`   ✅ Added: ${addedCount}`);
    console.log(`   ⏭️  Skipped: ${skippedCount}`);
    console.log(`   📊 Total: ${suppliers.length}`);
    console.log('\n✨ All suppliers now have verified payout methods!\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
addTestPayoutMethods()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
