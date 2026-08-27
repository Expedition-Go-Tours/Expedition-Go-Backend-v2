const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const sellOut = await p.tour.findMany({
    where: { status: "ACTIVE", totalBookings: { gte: 2 } },
    select: { title: true, totalBookings: true },
    orderBy: { totalBookings: "desc" },
    take: 10
  });
  console.log("LIKELY TO SELL OUT (tours with totalBookings >= 2):");
  sellOut.forEach(t => console.log("  " + t.title + ": " + t.totalBookings + " bookings"));

  const topRated = await p.tour.findMany({
    where: { status: "ACTIVE", reviewCount: { gte: 1 }, averageRating: { not: null } },
    select: { title: true, averageRating: true, reviewCount: true },
    orderBy: { averageRating: "desc" },
    take: 10
  });
  console.log("\nTOP RATED (tours with reviews):");
  topRated.forEach(t => console.log("  " + t.title + ": " + t.averageRating + " avg (" + t.reviewCount + " reviews)"));

  await p.$disconnect();
})();
