-- PayPal as a second payment provider, added alongside Stripe.
--
-- Additive only: every new column is nullable or has a safe default, no
-- existing column is retyped, and the only constraint relaxed is
-- BookingPaymentReconciliation.stripePaymentIntentId, which becomes nullable
-- because a PayPal reconciliation row has no PaymentIntent. Existing rows keep
-- their values and continue to be treated as STRIPE.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'PAYPAL');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "paypalCaptureId" TEXT,
ADD COLUMN     "paypalOrderId" TEXT,
ADD COLUMN     "paypalRefundId" TEXT,
ADD COLUMN     "paypalRefundStatus" TEXT;

-- AlterTable
ALTER TABLE "BookingPaymentAttempt" ADD COLUMN     "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "paypalCaptureId" TEXT,
ADD COLUMN     "paypalOrderId" TEXT,
ADD COLUMN     "paypalRefundId" TEXT;

-- AlterTable
ALTER TABLE "BookingPaymentReconciliation" ADD COLUMN     "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "paypalCaptureId" TEXT,
ADD COLUMN     "paypalRefundId" TEXT,
ALTER COLUMN "stripePaymentIntentId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "CheckoutDraft" ADD COLUMN     "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "paypalOrderId" TEXT;

-- CreateTable
CREATE TABLE "PaypalEvent" (
    "id" TEXT NOT NULL,
    "paypalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "resourceId" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "PaypalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaypalEvent_paypalEventId_key" ON "PaypalEvent"("paypalEventId");

-- CreateIndex
CREATE INDEX "PaypalEvent_paypalEventId_idx" ON "PaypalEvent"("paypalEventId");

-- CreateIndex
CREATE INDEX "PaypalEvent_processed_idx" ON "PaypalEvent"("processed");

-- CreateIndex
CREATE INDEX "PaypalEvent_eventType_createdAt_idx" ON "PaypalEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "PaypalEvent_resourceId_idx" ON "PaypalEvent"("resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_paypalCaptureId_key" ON "Booking"("paypalCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentAttempt_paypalOrderId_key" ON "BookingPaymentAttempt"("paypalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingPaymentReconciliation_paypalCaptureId_key" ON "BookingPaymentReconciliation"("paypalCaptureId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutDraft_paypalOrderId_key" ON "CheckoutDraft"("paypalOrderId");
