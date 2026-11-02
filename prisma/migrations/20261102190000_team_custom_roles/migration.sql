-- Custom supplier roles and per-member workspace overrides.
--
-- Additive only: existing TeamMember.roles/role rows keep working unchanged.
-- A member's effective permissions are the union of their built-in roles and
-- any assigned TeamRole rows.

CREATE TABLE "TeamRole" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] NOT NULL,
    "landingPath" TEXT,
    "notificationCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "uiPreferences" JSONB,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamRole_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeamMemberRole" (
    "memberId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "TeamMemberRole_pkey" PRIMARY KEY ("memberId","roleId")
);

ALTER TABLE "TeamMember" ADD COLUMN "landingPath" TEXT;
ALTER TABLE "TeamMember" ADD COLUMN "notificationCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "TeamMember" ADD COLUMN "uiPreferences" JSONB;

CREATE UNIQUE INDEX "TeamRole_supplierId_slug_key" ON "TeamRole"("supplierId", "slug");
CREATE INDEX "TeamRole_supplierId_isArchived_idx" ON "TeamRole"("supplierId", "isArchived");
CREATE INDEX "TeamMemberRole_roleId_idx" ON "TeamMemberRole"("roleId");

ALTER TABLE "TeamRole" ADD CONSTRAINT "TeamRole_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamMemberRole" ADD CONSTRAINT "TeamMemberRole_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "TeamMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamMemberRole" ADD CONSTRAINT "TeamMemberRole_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "TeamRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
