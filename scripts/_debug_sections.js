const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  const offers = await p.specialOffer.findMany({
    select: { id: true, name: true, isActive: true, offerType: true, startDate: true, endDate: true }
  });
  console.log("SPECIAL OFFERS:", JSON.stringify(offers));

  const targets = await p.specialOfferTarget.findMany({
    select: { id: true, specialOfferId: true, tourId: true }
  });
  console.log("SPECIAL OFFER TARGETS:", JSON.stringify(targets));

  const toursWithAttractions = await p.tour.findMany({
    where: { status: "ACTIVE", attractions: { not: { isEmpty: true } } },
    select: { id: true, title: true, attractions: true, supplierId: true }
  });
  console.log("TOURS WITH ATTRACTIONS:", JSON.stringify(toursWithAttractions.map(t => ({ id: t.id, title: t.title, attractions: t.attractions, supplierId: t.supplierId }))));

  const suppliers = await p.supplierProfile.findMany({
    where: { userId: { in: toursWithAttractions.map(t => t.supplierId) } },
    select: { userId: true, status: true }
  });
  console.log("SUPPLIER PROFILES:", JSON.stringify(suppliers));

  await p.$disconnect();
})();
