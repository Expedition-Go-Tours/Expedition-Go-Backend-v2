-- Create TeamMember model for supplier team management
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeamMember_supplierId_email_key" UNIQUE ("supplierId", "email")
);

CREATE INDEX "TeamMember_supplierId_idx" ON "TeamMember"("supplierId");
CREATE INDEX "TeamMember_email_idx" ON "TeamMember"("email");

ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
