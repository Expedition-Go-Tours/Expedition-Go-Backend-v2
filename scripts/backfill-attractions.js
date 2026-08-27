/**
 * Backfill Attraction Entities
 *
 * Processes all ACTIVE tours with attractions to:
 * 1. Run MiMo AI analysis on images (with attraction tagging)
 * 2. Create/update Attraction entities with AI-curated images
 *
 * Usage:
 *   node scripts/backfill-attractions.js [--dry-run] [--batch-size=10] [--delay=5000]
 *
 * Run with MIMO_API_KEY set in .env
 */

const prisma = require('../utils/prismaClient');
const { processTourAI, upsertAttraction } = require('../utils/aiContentAnalyzer');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '10', 10);
const DELAY_MS = parseInt(args.find(a => a.startsWith('--delay='))?.split('=')[1] || '5000', 10);

async function main() {
  console.log('=== Attraction Backfill ===');
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Batch size: ${BATCH_SIZE}`);
  console.log(`Delay between batches: ${DELAY_MS}ms`);
  console.log('');

  // Step 1: Process tours through AI pipeline
  console.log('Step 1: Processing tours through AI pipeline...');
  const tours = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      attractions: { isEmpty: false },
      aiProcessingStatus: { in: ['PENDING', 'FAILED'] },
    },
    select: { id: true, title: true, attractions: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Found ${tours.length} unprocessed tours with attractions`);

  if (DRY_RUN) {
    console.log('DRY RUN — would process:');
    tours.slice(0, 10).forEach(t => console.log(`  - ${t.title} (${t.attractions.join(', ')})`));
    if (tours.length > 10) console.log(`  ... and ${tours.length - 10} more`);
  } else {
    let processed = 0;
    let failed = 0;

    for (let i = 0; i < tours.length; i += BATCH_SIZE) {
      const batch = tours.slice(i, i + BATCH_SIZE);
      console.log(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1}: processing ${batch.length} tours...`);

      for (const tour of batch) {
        try {
          const result = await processTourAI(tour.id);
          if (result.success) {
            processed++;
            console.log(`  ✓ ${tour.title} (${result.imagesProcessed} images)`);
          } else {
            failed++;
            console.log(`  ✗ ${tour.title}: ${result.error}`);
          }
        } catch (err) {
          failed++;
          console.log(`  ✗ ${tour.title}: ${err.message}`);
        }
      }

      if (i + BATCH_SIZE < tours.length) {
        console.log(`  Waiting ${DELAY_MS}ms before next batch...`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }

    console.log(`\nAI processing complete: ${processed} processed, ${failed} failed`);
  }

  // Step 2: Create Attraction entities from all tours (even those already processed)
  console.log('\nStep 2: Creating/updating Attraction entities...');
  const allToursWithAttractions = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      attractions: { isEmpty: false },
    },
    select: { id: true, title: true, attractions: true },
  });

  const attractionNames = new Set();
  for (const tour of allToursWithAttractions) {
    if (Array.isArray(tour.attractions)) {
      for (const name of tour.attractions) {
        if (name && name.trim()) attractionNames.add(name.trim());
      }
    }
  }

  console.log(`Found ${attractionNames.size} unique attraction names`);

  if (DRY_RUN) {
    console.log('DRY RUN — would create attractions:');
    [...attractionNames].slice(0, 10).forEach(n => console.log(`  - ${n}`));
    if (attractionNames.size > 10) console.log(`  ... and ${attractionNames.size - 10} more`);
  } else {
    let created = 0;
    let updated = 0;

    for (const name of attractionNames) {
      try {
        const existing = await prisma.attraction.findUnique({ where: { name } });
        await upsertAttraction(name, {});
        if (existing) {
          updated++;
          console.log(`  ↻ ${name}`);
        } else {
          created++;
          console.log(`  + ${name}`);
        }
      } catch (err) {
        console.log(`  ✗ ${name}: ${err.message}`);
      }
    }

    console.log(`\nAttraction entities: ${created} created, ${updated} updated`);
  }

  // Summary
  console.log('\n=== Summary ===');
  const totalAttractions = await prisma.attraction.count();
  const withHeroImage = await prisma.attraction.count({ where: { heroImage: { not: null } } });
  const withAI = await prisma.attraction.count({ where: { heroImageSource: 'ai_selected' } });
  console.log(`Total attractions: ${totalAttractions}`);
  console.log(`With hero image: ${withHeroImage}`);
  console.log(`AI-selected images: ${withAI}`);
}

main()
  .catch(err => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
