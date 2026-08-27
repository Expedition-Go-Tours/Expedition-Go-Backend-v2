const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const now = new Date();
  const targets = await p.specialOfferTarget.findMany({
    where: {
      specialOffer: {
        isActive: true,
        AND: [
          { OR: [{ startDate: null }, { startDate: { lte: now } }] },
          { OR: [{ endDate: null }, { endDate: { gte: now } }] },
        ],
      },
    },
    include: {
      specialOffer: true,
      tour: {
        select: { id: true, title: true, status: true },
      },
    },
  });
  const active = targets.filter(t => t.tour && t.tour.status === 'ACTIVE');
  console.log("Offer tour IDs:");
  active.forEach(t => console.log("  " + t.tour.id + " - " + t.tour.title));
  console.log("\nTotal:", active.length);
  
  // Check what the frontend page actually shows
  const allTours = await p.tour.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, title: true },
  });
  console.log("\nAll active tours:", allTours.length);
  
  await p.$disconnect();
})();
