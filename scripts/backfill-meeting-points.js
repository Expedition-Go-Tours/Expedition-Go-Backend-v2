/**
 * Backfill Meeting Points
 *
 * The product builder stores the meeting point in `meetingPoints[]` (plural),
 * while legacy consumers read the singular `meetingPoint`. This fills the
 * singular from the first valid plural entry wherever it is missing, for both
 * the live row and the pending draft snapshot.
 *
 * Usage:
 *   node scripts/backfill-meeting-points.js            # dry run
 *   node scripts/backfill-meeting-points.js --apply
 */

const prisma = require('../utils/prismaClient');

const APPLY = process.argv.includes('--apply');

/** First valid meeting point from a blob ({ meetingPoint, meetingPoints[] }). */
function pickMeetingPoint(blob) {
  if (!blob || typeof blob !== 'object') return null;
  const single = blob.meetingPoint;
  if (single && (single.name || single.address)) return single;
  const list = Array.isArray(blob.meetingPoints) ? blob.meetingPoints : [];
  return list.find((m) => m && (m.name || m.address)) || null;
}

async function main() {
  console.log('=== Meeting-point backfill ===');
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const tours = await prisma.tour.findMany({
    select: { id: true, title: true, status: true, productContent: true, bookingAndTickets: true },
  });

  let fixed = 0;

  for (const tour of tours) {
    const pc = tour.productContent && typeof tour.productContent === 'object' ? { ...tour.productContent } : null;
    const bt = tour.bookingAndTickets && typeof tour.bookingAndTickets === 'object' ? { ...tour.bookingAndTickets } : null;
    if (!pc && !bt) continue;

    let changed = false;

    if (pc) {
      const mp = pickMeetingPoint(pc);
      if (mp && (!pc.meetingPoint || !pc.meetingPoint.name)) {
        pc.meetingPoint = mp;
        changed = true;
      }
    }
    if (bt) {
      const mp = pickMeetingPoint(bt);
      if (mp && (!bt.meetingPoint || !bt.meetingPoint.name)) {
        bt.meetingPoint = mp;
        changed = true;
      }
    }
    if (!changed) continue;

    fixed += 1;
    console.log(`  + ${tour.title || tour.id} (${tour.status})`);
    if (APPLY) {
      await prisma.tour.update({
        where: { id: tour.id },
        data: {
          ...(pc ? { productContent: pc } : {}),
          ...(bt ? { bookingAndTickets: bt } : {}),
        },
      });
    }
  }

  console.log('');
  console.log(APPLY ? `Updated ${fixed} tours.` : `Would update ${fixed} tours.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
