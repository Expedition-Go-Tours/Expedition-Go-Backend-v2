const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  try {
    await p.$executeRawUnsafe(`ALTER TABLE "Tour" ADD COLUMN IF NOT EXISTS "attractions" TEXT[] NOT NULL DEFAULT '{}'`);
    console.log("Added attractions column");
  } catch(e) {
    console.log("Column may already exist:", e.message?.slice(0, 100));
  }
  try {
    await p.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Tour_attractions_idx" ON "Tour" USING GIN ("attractions")`);
    console.log("Created GIN index");
  } catch(e) {
    console.log("Index may already exist:", e.message?.slice(0, 100));
  }
  await p.$executeRawUnsafe(`
    UPDATE "Tour" SET "attractions" = (
      SELECT COALESCE(
        array_agg(DISTINCT elem->>'name') FILTER (WHERE elem->>'name' IS NOT NULL AND elem->>'name' != ''),
        '{}'
      )
      FROM jsonb_array_elements("productContent"->'locations') AS elem
      WHERE elem->>'name' IS NOT NULL AND elem->>'name' != ''
    )
  `);
  console.log("Backfilled attractions");
  const tours = await p.tour.findMany({ select: { title: true, attractions: true } });
  tours.forEach(t => console.log(`  ${t.title}: [${t.attractions.join(", ")}]`));
  await p._disconnect();
})();
