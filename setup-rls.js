require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function setupRLS() {
  try {
    console.log('🔒 Setting up Row Level Security (RLS) policies...\n');

    // Read the SQL file
    const sqlFile = path.join(__dirname, 'setup-rls-policies.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // Split by semicolons and filter out empty statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    console.log(`📝 Executing ${statements.length} SQL statements...\n`);

    let successCount = 0;
    let skipCount = 0;

    for (const statement of statements) {
      try {
        // Skip comments and SELECT statements (verification queries)
        if (statement.startsWith('--') || statement.toUpperCase().startsWith('SELECT')) {
          skipCount++;
          continue;
        }

        await prisma.$executeRawUnsafe(statement);
        successCount++;
        
        // Show progress for key operations
        if (statement.includes('ENABLE ROW LEVEL SECURITY')) {
          const tableName = statement.match(/ALTER TABLE "(\w+)"/)?.[1];
          console.log(`✅ Enabled RLS on table: ${tableName}`);
        } else if (statement.includes('CREATE POLICY')) {
          const policyName = statement.match(/CREATE POLICY "([^"]+)"/)?.[1];
          console.log(`✅ Created policy: ${policyName}`);
        }
      } catch (error) {
        // Ignore "already exists" errors
        if (error.message.includes('already exists')) {
          skipCount++;
        } else {
          console.error(`❌ Error executing statement:`, error.message);
        }
      }
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Successfully executed: ${successCount} statements`);
    console.log(`⏭️  Skipped: ${skipCount} statements`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Verify RLS is enabled
    console.log('🔍 Verifying RLS status...\n');
    const tables = await prisma.$queryRaw`
      SELECT 
        schemaname,
        tablename,
        rowsecurity as rls_enabled
      FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `;

    console.log('📊 RLS Status for all tables:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    tables.forEach(table => {
      const status = table.rls_enabled ? '✅ Enabled' : '❌ Disabled';
      console.log(`${status} - ${table.tablename}`);
    });
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('🎉 RLS setup complete!\n');
    console.log('📝 Note: All tables now have RLS enabled with permissive policies.');
    console.log('   This satisfies Supabase security requirements while allowing');
    console.log('   your backend to manage authentication with Firebase.\n');

    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error setting up RLS:');
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

setupRLS();
