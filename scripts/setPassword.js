const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const prisma = new PrismaClient();
async function main() {
  const hash = await bcrypt.hash('Admin...', 12);
  await prisma.user.update({
    where: { email: 'rxsieon@gmail.com' },
    data: { passwordHash: hash },
  });
  console.log('Password hash set successfully for rxsieon@gmail.com');
}
main().catch(console.error).finally(() => prisma.$disconnect());
