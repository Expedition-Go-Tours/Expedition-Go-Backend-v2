const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const tours = await p.tour.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, title: true, tags: true, category: true }
  });
  // Check which tours match "Nature & Outdoors" keywords
  const natureKeywords = ['camping','picnic','campfire','glamping','ecotourism','geyser','glacier','hiking','hot springs','ice cave','jungle','mountain biking','national park','natural site','volcano','sea','mountains','waterfalls','landscape','shore excursion','ocean','natural pool','flowers','alpine lakes','blue lagoon','nature walk','mangrove','sea caves','gorge','lava','mountain','cliffs','protected nature','nature baths','ancient rainforest','mountain views','swamp','lake','nature tours','nature adventures','cherry blossom','nature based tour','cenote','nature reserve','natural park','tulips','dunes','nature tour','lagoons','nature adventure','lakes','black beach','natural landscapes','rain forest','island hopping','flowerfields','natural habitat','fjord','mangroves','bamboo forest','farming','nature lovers','coral reef','pearl farm','lagoon','black sand beach','turquoise waters','trail','flora & fauna','natural pools','bioluminescence','natural reserve','rice fields','fruit picking','heli hike','organic farm','canyon','syöte nature guide','arctic nature','nature & adventure','sunflower','nature spots','sea and landscapes','trekking','outdoor recreation','bushwalking','treetop walk'];
  const cityKeywords = ['urban exploration','city tour','walking tour','underground','city sightseeing','city views','class','workshops & classes'];
  console.log("NATURE & OUTDOORS tours:");
  let natureCount = 0;
  for (const t of tours) {
    const tagsLower = t.tags.map(tag => tag.toLowerCase());
    const match = tagsLower.some(tag => natureKeywords.includes(tag));
    if (match) { natureCount++; console.log("  " + t.title + " -> tags: " + t.tags.join(", ")); }
  }
  console.log("Total matching: " + natureCount + " / " + tours.length);
  
  console.log("\nCITY & WALKING TOURS tours:");
  let cityCount = 0;
  for (const t of tours) {
    const tagsLower = t.tags.map(tag => tag.toLowerCase());
    const match = tagsLower.some(tag => cityKeywords.includes(tag));
    if (match) { cityCount++; console.log("  " + t.title + " -> tags: " + t.tags.join(", ")); }
  }
  console.log("Total matching: " + cityCount + " / " + tours.length);
  
  console.log("\nALL TOUR tags:");
  for (const t of tours) {
    console.log("  " + t.title + ": [" + t.tags.join(", ") + "]");
  }
  
  await p.$disconnect();
})();
