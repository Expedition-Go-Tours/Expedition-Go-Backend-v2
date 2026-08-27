const { PrismaClient } = require("@prisma/client");
const { KEYWORD_CATEGORIES } = require("../utils/homepageRanking");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const mood = "City & Walking Tours";
  const keywords = KEYWORD_CATEGORIES[mood].map(k => k.toLowerCase());
  const matchingTours = await p.tour.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, tags: true },
  });
  let moodTourIds = matchingTours
    .filter(t => t.tags.some(tag => keywords.includes(tag.toLowerCase())))
    .map(t => t.id);
  console.log("moodTourIds:", moodTourIds.length);
  
  const tourWhere = {
    status: "ACTIVE",
    supplier: { supplierProfile: { status: "ACTIVE" } },
    id: { in: moodTourIds },
  };
  
  try {
    const records = await p.expeditionTour.findMany({
      where: { isActive: true, tour: tourWhere },
      take: 5,
      include: { tour: { select: { id: true, title: true } } },
    });
    console.log("SUCCESS:", records.length);
    records.forEach(r => console.log("  " + r.tour.title));
  } catch (e) {
    console.log("ERROR:", e.message.slice(0, 500));
  }
  await p.$disconnect();
})();
