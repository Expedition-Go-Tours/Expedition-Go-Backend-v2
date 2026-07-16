-- CreateTable
CREATE TABLE "BookingCounter" (
    "prefix" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BookingCounter_pkey" PRIMARY KEY ("prefix", "year")
);
