-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'TOUR_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'TOUR_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'TOUR_FLAGGED';

-- AlterEnum
ALTER TYPE "AdminNotificationType" ADD VALUE 'TOUR_SUBMITTED_FOR_REVIEW';
ALTER TYPE "AdminNotificationType" ADD VALUE 'BOOKING_CREATED';
ALTER TYPE "AdminNotificationType" ADD VALUE 'BOOKING_CONFIRMED';

-- AlterEnum
ALTER TYPE "TourStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "TourStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "Tour" ADD COLUMN "submittedAt" TIMESTAMP(3),
ADD COLUMN "reviewedBy" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewNote" TEXT;

-- CreateIndex
CREATE INDEX "Tour_status_submittedAt_idx" ON "Tour"("status", "submittedAt");
