require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function fixUserRLS() {
  try {
    console.log('🔒 Enabling RLS on User table...\n');

    await prisma.$executeRaw`ALTER TABLE "User" ENABLE ROW LEVEL SECURITY`;
    console.log('✅ RLS enabled on User table');

    await prisma.$executeRaw`CREATE POLICY "Allow all operations on User" ON "User" FOR ALL USING (true) WITH CHECK (true)`;
    console.log('✅ Created permissive policy on User table\n');

    // Verify
    const result = await prisma.$queryRaw`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename = 'User'
    `;

    console.log('📊 Verification:', result);
    console.log('\n🎉 User table RLS setup complete!');

    await prisma.$disconnect();
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('✅ Policy already exists - all good!');
    } else {
      console.error('❌ Error:', error.message);
    }
    await prisma.$disconnect();
  }
}

fixUserRLS();
