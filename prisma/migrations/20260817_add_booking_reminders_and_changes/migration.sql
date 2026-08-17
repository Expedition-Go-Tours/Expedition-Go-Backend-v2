-- BookingReminder: idempotent tracking of scheduled/transactional emails sent
-- for a booking (payment reminders, booking reminders, review requests, etc.).
-- The unique(bookingId, type) constraint prevents duplicate sends even when a
-- scheduler sweep runs concurrently across multiple app instances.

CREATE TABLE "BookingReminder" (
    "id"          TEXT        NOT NULL,
    "bookingId"   TEXT        NOT NULL,
    "type"        TEXT        NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt"      TIMESTAMP(3),
    "status"      TEXT        NOT NULL DEFAULT 'PENDING',
    "error"       TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingReminder_pkey" PRIMARY KEY ("id")
);

-- BookingChange: audit trail of booking modifications (date/time/travelers/
-- pickup changes) so change emails can render a before/after diff.

CREATE TABLE "BookingChange" (
    "id"          TEXT        NOT NULL,
    "bookingId"   TEXT        NOT NULL,
    "changedBy"   TEXT        NOT NULL,
    "reason"      TEXT,
    "previous"    JSONB       NOT NULL,
    "updated"     JSONB       NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingChange_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BookingReminder_bookingId_type_key" ON "BookingReminder"("bookingId", "type");
CREATE INDEX "BookingReminder_type_status_scheduledFor_idx" ON "BookingReminder"("type", "status", "scheduledFor");
CREATE INDEX "BookingChange_bookingId_idx" ON "BookingChange"("bookingId");
CREATE INDEX "BookingChange_changedBy_idx" ON "BookingChange"("changedBy");

ALTER TABLE "BookingReminder" ADD CONSTRAINT "BookingReminder_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "BookingChange" ADD CONSTRAINT "BookingChange_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
