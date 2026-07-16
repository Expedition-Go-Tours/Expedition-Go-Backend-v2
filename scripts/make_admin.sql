UPDATE "User"
SET
  "roles" = ARRAY['customer'::"UserRole", 'admin'::"UserRole"],
  "adminRoleId" = (SELECT id FROM "AdminRole" WHERE name = 'super_admin' LIMIT 1)
WHERE email = 'admin@test.com';
