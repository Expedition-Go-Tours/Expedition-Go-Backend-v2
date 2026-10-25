-- Hosted pay-later payment attempts, recovery episode state, delivery records,
-- and notification dedupe. Additive only: no existing column is dropped or
-- retyped, and every new booking field is nullable or has a safe default.

-- CreateEnum
CREATE TYPE "BookingPaymentAttemptStatus" AS ENUM ('CREATING', 'ACTIVE', 'COMPLETED', 'EXPIRED', 'SUPERSEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BookingPaymentAttemptSource" AS ENUM ('CUSTOMER_PAY_NOW', 'SUPPLIER_LINK', 'AUTO_RECOVERY');

-- CreateEnum
CREATE TYPE "BookingPaymentLinkChannel" AS ENUM ('EMAIL', 'CHAT');

-- CreateEnum
CREATE TYPE "BookingPaymentLinkSendStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "Booking"
  ADD COLUMN "paymentLinkHoldAt" TIMESTAMP(3),
  ADD COLUMN "recoveryEpisodeKey" TEXT,
  ADD COLUMN "recoveryEpisodeStartedAt" TIMESTAMP(3),
  ADD COLUMN "recoveryEmailCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recoveryLastSentAt" TIMESTAMP(3),
  ADD COLUMN "recoveryClosedAt" TIMESTAMP(3),
  ADD COLUMN "recoveryClosedReason" TEXT,
  ADD COLUMN "paymentFailureCode" TEXT,
  ADD COLUMN "paymentFailureAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- CreateTable
CREATE TABLE "BookingPaymentAttempt" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "source" "BookingPaymentAttemptSource" NOT NULL,
  "status" "BookingPaymentAttemptStatus" NOT NULL DEFAULT 'CREATING',
  "amount" DECIMAL(10,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "stripeCheckoutSessionId" TEXT,
  "stripePaymentIntentId" TEXT,
  "checkoutUrl" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT,
  "createdByRole" TEXT,
  "sendInChat" BOOLEAN NOT NULL DEFAULT false,
  "failureCode" TEXT,
  "failureReason" TEXT,
  "requiresAction" BOOLEAN NOT NULL DEFAULT false,
  "supersededByAttemptId" TEXT,
  "settledAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "refundStatus" TEXT,
  "stripeRefundId" TEXT,
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingPaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingPaymentLinkSend" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT NOT NULL,
  "attemptId" TEXT,
  "channel" "BookingPaymentLinkChannel" NOT NULL,
  "status" "BookingPaymentLinkSendStatus" NOT NULL DEFAULT 'QUEUED',
  "recipient" TEXT,
  "idempotencyKey" TEXT,
  "requestedByUserId" TEXT,
  "requestedByRole" TEXT,
  "providerMessageId" TEXT,
  "failureCode" TEXT,
  "errorMessage" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingPaymentLinkSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingPaymentAttempt_bookingId_createdAt_idx" ON "BookingPaymentAttempt"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingPaymentAttempt_bookingId_status_idx" ON "BookingPaymentAttempt"("bookingId", "status");

-- CreateIndex
CREATE INDEX "BookingPaymentAttempt_status_expiresAt_idx" ON "BookingPaymentAttempt"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "BookingPaymentAttempt_stripePaymentIntentId_idx" ON "BookingPaymentAttempt"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentAttempt_stripeCheckoutSessionId_key" ON "BookingPaymentAttempt"("stripeCheckoutSessionId");

-- One live hosted session per booking. This is a database invariant, not just
-- a service check: concurrent supplier/customer/auto-recovery calls can never
-- create two active sessions for the same booking.
CREATE UNIQUE INDEX "BookingPaymentAttempt_one_active_per_booking"
  ON "BookingPaymentAttempt"("bookingId")
  WHERE "status" IN ('CREATING', 'ACTIVE');

-- CreateIndex
CREATE INDEX "BookingPaymentLinkSend_bookingId_createdAt_idx" ON "BookingPaymentLinkSend"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingPaymentLinkSend_attemptId_idx" ON "BookingPaymentLinkSend"("attemptId");

-- CreateIndex
CREATE INDEX "BookingPaymentLinkSend_status_createdAt_idx" ON "BookingPaymentLinkSend"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentLinkSend_bookingId_channel_idempotencyKey_key"
  ON "BookingPaymentLinkSend"("bookingId", "channel", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "BookingPaymentAttempt" ADD CONSTRAINT "BookingPaymentAttempt_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPaymentLinkSend" ADD CONSTRAINT "BookingPaymentLinkSend_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingPaymentLinkSend" ADD CONSTRAINT "BookingPaymentLinkSend_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "BookingPaymentAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "BookingPaymentReconciliation" (
  "id" TEXT NOT NULL,
  "bookingId" TEXT,
  "stripePaymentIntentId" TEXT NOT NULL,
  "stripeCheckoutSessionId" TEXT,
  "amount" DECIMAL(10,2),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REFUND_PENDING',
  "stripeRefundId" TEXT,
  "failureCode" TEXT,
  "errorMessage" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "refundedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BookingPaymentReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingPaymentReconciliation_stripePaymentIntentId_key"
  ON "BookingPaymentReconciliation"("stripePaymentIntentId");
CREATE INDEX "BookingPaymentReconciliation_bookingId_idx"
  ON "BookingPaymentReconciliation"("bookingId");
CREATE INDEX "BookingPaymentReconciliation_status_idx"
  ON "BookingPaymentReconciliation"("status");
CREATE INDEX "BookingPaymentReconciliation_stripeRefundId_idx"
  ON "BookingPaymentReconciliation"("stripeRefundId");

ALTER TABLE "BookingPaymentReconciliation"
  ADD CONSTRAINT "BookingPaymentReconciliation_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
