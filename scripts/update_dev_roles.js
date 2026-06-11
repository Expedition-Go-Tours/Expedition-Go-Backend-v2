const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const user = await prisma.user.findFirst({ where: { firebaseUid: 'dev-uid' } });
  if (user) {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { roles: { set: [...new Set([...user.roles, 'supplier'])] } }
    });
    console.log('Updated roles:', updated.roles);
  } else {
    console.log('No dev user found');
  }
  await prisma.$disconnect();
})();
