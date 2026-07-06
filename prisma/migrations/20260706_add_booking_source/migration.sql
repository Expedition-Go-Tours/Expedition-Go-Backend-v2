-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('TRAVIO', 'EXPEDITION');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "source" "BookingSource" NOT NULL DEFAULT 'TRAVIO';
