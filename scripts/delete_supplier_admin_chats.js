const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const count = await prisma.conversation.count({ where: { type: 'SUPPLIER_ADMIN' } });
  console.log(`Found ${count} SUPPLIER_ADMIN conversations`);

  if (count === 0) {
    console.log('Nothing to delete.');
    return;
  }

  if (!process.argv.includes('--confirm')) {
    console.log('Dry run — pass --confirm to actually delete');
    console.log('This will also cascade-delete all messages and participants.');
    return;
  }

  const result = await prisma.conversation.deleteMany({ where: { type: 'SUPPLIER_ADMIN' } });
  console.log(`Deleted ${result.count} conversations (messages + participants cascaded)`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
