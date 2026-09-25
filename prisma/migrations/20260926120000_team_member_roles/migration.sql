-- Team members can hold up to two roles (see MAX_TEAM_ROLES in config/teamPermissions.js);
-- effective permissions are the union of the selected roles.
--
-- `role` is kept as a deprecated mirror of roles[0] so a rollback to the previous
-- deploy still reads a sensible value. New code reads/writes `roles` only.
ALTER TABLE "TeamMember" ADD COLUMN     "roles" TEXT[] DEFAULT ARRAY['editor']::TEXT[];

-- Backfill existing members from the single-role column.
UPDATE "TeamMember" SET "roles" = ARRAY["role"] WHERE "role" IS NOT NULL;
