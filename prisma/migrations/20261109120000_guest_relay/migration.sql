-- Working relay for unclaimed marketplace guest bookings.
--
-- A guest has no `User`, so the conversation relay (`c-…`) cannot mint an
-- address for them. Each guest booking gets its own `g-…` alias instead; the
-- real address stays on the booking and is resolved only when forwarding.

-- CreateEnum
CREATE TYPE "GuestRelayDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "GuestRelay" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "guestId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),

    CONSTRAINT "GuestRelay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestRelayMessage" (
    "id" TEXT NOT NULL,
    "relayId" TEXT NOT NULL,
    "direction" "GuestRelayDirection" NOT NULL,
    "messageId" TEXT,
    "providerId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "attachments" JSONB,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GuestRelayMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestRelay_bookingId_key" ON "GuestRelay"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestRelay_token_key" ON "GuestRelay"("token");

-- CreateIndex
CREATE UNIQUE INDEX "GuestRelay_address_key" ON "GuestRelay"("address");

-- CreateIndex
CREATE INDEX "GuestRelay_guestId_idx" ON "GuestRelay"("guestId");

-- CreateIndex
CREATE INDEX "GuestRelay_supplierId_idx" ON "GuestRelay"("supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "GuestRelayMessage_messageId_key" ON "GuestRelayMessage"("messageId");

-- CreateIndex
CREATE INDEX "GuestRelayMessage_relayId_createdAt_idx" ON "GuestRelayMessage"("relayId", "createdAt");

-- AddForeignKey
ALTER TABLE "GuestRelay" ADD CONSTRAINT "GuestRelay_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestRelayMessage" ADD CONSTRAINT "GuestRelayMessage_relayId_fkey" FOREIGN KEY ("relayId") REFERENCES "GuestRelay"("id") ON DELETE CASCADE ON UPDATE CASCADE;
