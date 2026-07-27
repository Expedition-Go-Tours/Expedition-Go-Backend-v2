const prisma = require('../utils/prismaClient');
const { deleteCloudinaryImage } = require('../utils/cloudinaryHelper');

async function cleanupOrphanedMedia() {
  console.log('[Media Cleanup] Starting...');

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const orphaned = await prisma.media.findMany({
    where: { status: 'PENDING', createdAt: { lt: cutoff } },
  });

  if (orphaned.length === 0) {
    console.log('[Media Cleanup] No orphaned media found.');
    return { cleaned: 0 };
  }

  console.log(`[Media Cleanup] Found ${orphaned.length} orphaned media records.`);

  const results = await Promise.allSettled(
    orphaned.map(m => deleteCloudinaryImage(m.url))
  );

  const failed = results.filter(r => r.status === 'rejected').length;

  await prisma.media.updateMany({
    where: { id: { in: orphaned.map(m => m.id) } },
    data: { status: 'ORPHANED' },
  });

  console.log(`[Media Cleanup] Done. Deleted ${orphaned.length - failed} from Cloudinary, ${failed} failed.`);
  return { cleaned: orphaned.length, failed };
}

if (require.main === module) {
  cleanupOrphanedMedia()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[Media Cleanup] Fatal:', err);
      process.exit(1);
    });
}

module.exports = cleanupOrphanedMedia;
