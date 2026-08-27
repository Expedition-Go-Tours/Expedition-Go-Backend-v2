const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const tours = await p.tour.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, title: true, totalBookings: true, averageRating: true, reviewCount: true },
    orderBy: { title: "asc" }
  });
  console.log(JSON.stringify(tours));
  await p._disconnect();
})();
