-- CreateTable
CREATE TABLE IF NOT EXISTS "DailyTourStats" (
    "id" TEXT NOT NULL,
    "tourId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "totalViews" INTEGER NOT NULL DEFAULT 0,
    "uniqueVisitors" INTEGER NOT NULL DEFAULT 0,
    "topCountry" VARCHAR(2),
    "topReferrer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyTourStats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "DailyTourStats_tourId_date_key" ON "DailyTourStats"("tourId", "date");
CREATE INDEX IF NOT EXISTS "DailyTourStats_tourId_date_idx" ON "DailyTourStats"("tourId", "date");
CREATE INDEX IF NOT EXISTS "DailyTourStats_date_idx" ON "DailyTourStats"("date");

-- AddForeignKey
ALTER TABLE "DailyTourStats" ADD CONSTRAINT "DailyTourStats_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "Tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable (Booking retry tracking)
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "chargeRetries" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "nextRetryAt" TIMESTAMP(3);
