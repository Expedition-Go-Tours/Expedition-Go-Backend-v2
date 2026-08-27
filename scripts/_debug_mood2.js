const { PrismaClient } = require("@prisma/client");
const { KEYWORD_CATEGORIES } = require("../utils/homepageRanking");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const mood = "Nature & Outdoors";
  const keywords = KEYWORD_CATEGORIES[mood].map(k => k.toLowerCase());
  console.log("Keywords count:", keywords.length);
  
  const matchingTours = await p.tour.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, title: true, tags: true },
  });
  const matched = matchingTours.filter(t => t.tags.some(tag => keywords.includes(tag.toLowerCase())));
  console.log("\nNature & Outdoors matched:");
  matched.forEach(t => console.log("  " + t.title));
  console.log("Total matched:", matched.length);
  
  const cityMood = "City & Walking Tours";
  const cityKeywords = KEYWORD_CATEGORIES[cityMood].map(k => k.toLowerCase());
  const cityMatched = matchingTours.filter(t => t.tags.some(tag => cityKeywords.includes(tag.toLowerCase())));
  console.log("\nCity & Walking Tours matched:");
  cityMatched.forEach(t => console.log("  " + t.title));
  console.log("Total matched:", cityMatched.length);
  
  await p.$disconnect();
})();
