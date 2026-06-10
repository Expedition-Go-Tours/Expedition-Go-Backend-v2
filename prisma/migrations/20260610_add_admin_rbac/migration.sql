-- Add adminRoleId to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "adminRoleId" TEXT;

-- CreateTable AdminPermission
CREATE TABLE IF NOT EXISTS "AdminPermission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdminRole
CREATE TABLE IF NOT EXISTS "AdminRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable AdminRolePermission
CREATE TABLE IF NOT EXISTS "AdminRolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    CONSTRAINT "AdminRolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateIndexes
CREATE UNIQUE INDEX IF NOT EXISTS "AdminPermission_key_key" ON "AdminPermission"("key");
CREATE INDEX IF NOT EXISTS "AdminPermission_category_idx" ON "AdminPermission"("category");
CREATE INDEX IF NOT EXISTS "AdminPermission_key_idx" ON "AdminPermission"("key");
CREATE UNIQUE INDEX IF NOT EXISTS "AdminRole_name_key" ON "AdminRole"("name");
CREATE INDEX IF NOT EXISTS "AdminRole_name_idx" ON "AdminRole"("name");
CREATE INDEX IF NOT EXISTS "AdminRolePermission_roleId_idx" ON "AdminRolePermission"("roleId");
CREATE INDEX IF NOT EXISTS "AdminRolePermission_permissionId_idx" ON "AdminRolePermission"("permissionId");

-- Foreign Keys
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_adminRoleId_fkey";
ALTER TABLE "User" ADD CONSTRAINT "User_adminRoleId_fkey" FOREIGN KEY ("adminRoleId") REFERENCES "AdminRole"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdminRolePermission" DROP CONSTRAINT IF EXISTS "AdminRolePermission_roleId_fkey";
ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminRolePermission" DROP CONSTRAINT IF EXISTS "AdminRolePermission_permissionId_fkey";
ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "AdminPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
