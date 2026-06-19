const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
async function main() {
  const hash = await bcrypt.hash('Admin1', 12);
  await prisma.user.update({
    where: { email: 'expeditiongotravelandtoursltd@gmail.com' },
    data: { passwordHash: hash },
  });
  console.log('Password hash set successfully for expeditiongotravelandtoursltd@gmail.com');
}
main().catch(console.error).finally(() => prisma.$disconnect());
