const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient({
  datasources: {
    db: { url: "postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require" }
  }
});
(async () => {
  await p.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = NOW(), applied_steps_count = 1, logs = 'Manually applied via $executeRawUnsafe' WHERE migration_name = '20260826100406_add_tour_attractions'`);
  console.log("Marked 20260826100406_add_tour_attractions as finished");

  await p.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = NOW(), applied_steps_count = 1, logs = 'Manually applied via $executeRawUnsafe' WHERE migration_name = '20260814_remove_mobile_money' AND finished_at IS NULL`);
  console.log("Marked 20260814_remove_mobile_money as finished");

  const rows = await p.$queryRawUnsafe(`SELECT migration_name, finished_at FROM "_prisma_migrations" WHERE finished_at IS NULL`);
  console.log("Remaining unfinished:", JSON.stringify(rows));
  await p.$disconnect();
})();
