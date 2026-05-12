-- Row Level Security (RLS) Setup for Backend-Managed Authentication
-- This enables RLS on all tables but allows all operations since authentication
-- is handled by your Node.js backend with Firebase, not Supabase Auth

-- Enable RLS on all tables
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupplierProfile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Tour" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Booking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CartItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Notification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "StripeEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SystemConfig" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- Create permissive policies (allow all operations)
-- Since your backend handles authentication, these policies allow all operations
-- from your backend service role

-- User table policies
CREATE POLICY "Allow all operations on User" ON "User" FOR ALL USING (true) WITH CHECK (true);

-- SupplierProfile table policies
CREATE POLICY "Allow all operations on SupplierProfile" ON "SupplierProfile" FOR ALL USING (true) WITH CHECK (true);

-- Tour table policies
CREATE POLICY "Allow all operations on Tour" ON "Tour" FOR ALL USING (true) WITH CHECK (true);

-- Booking table policies
CREATE POLICY "Allow all operations on Booking" ON "Booking" FOR ALL USING (true) WITH CHECK (true);

-- Review table policies
CREATE POLICY "Allow all operations on Review" ON "Review" FOR ALL USING (true) WITH CHECK (true);

-- CartItem table policies
CREATE POLICY "Allow all operations on CartItem" ON "CartItem" FOR ALL USING (true) WITH CHECK (true);

-- Notification table policies
CREATE POLICY "Allow all operations on Notification" ON "Notification" FOR ALL USING (true) WITH CHECK (true);

-- StripeEvent table policies
CREATE POLICY "Allow all operations on StripeEvent" ON "StripeEvent" FOR ALL USING (true) WITH CHECK (true);

-- SystemConfig table policies
CREATE POLICY "Allow all operations on SystemConfig" ON "SystemConfig" FOR ALL USING (true) WITH CHECK (true);

-- AuditLog table policies
CREATE POLICY "Allow all operations on AuditLog" ON "AuditLog" FOR ALL USING (true) WITH CHECK (true);

-- _prisma_migrations table policies
CREATE POLICY "Allow all operations on _prisma_migrations" ON "_prisma_migrations" FOR ALL USING (true) WITH CHECK (true);

-- Verify RLS is enabled
SELECT 
    schemaname,
    tablename,
    rowsecurity as rls_enabled
FROM pg_tables 
WHERE schemaname = 'public' 
ORDER BY tablename;
