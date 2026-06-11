-- Add inviteToken and tokenExpiresAt to TeamMember for invitation flow
ALTER TABLE "TeamMember" ADD COLUMN "inviteToken" TEXT;
ALTER TABLE "TeamMember" ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "TeamMember_inviteToken_key" ON "TeamMember"("inviteToken");
CREATE INDEX "TeamMember_inviteToken_idx" ON "TeamMember"("inviteToken");
