const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const user = await prisma.user.findFirst({ where: { firebaseUid: 'dev-uid' } });
  if (!user) { console.log('No dev user'); return; }
  const existing = await prisma.supplierProfile.findUnique({ where: { userId: user.id } });
  if (existing) { console.log('Profile already exists'); return; }
  const profile = await prisma.supplierProfile.create({
    data: {
      userId: user.id,
      businessInfo: {},
      operatingInfo: {},
      representativeInfo: {},
      businessDocuments: {},
      payoutInfo: {},
      compliance: { taxInfo: {} }
    }
  });
  console.log('Created profile:', profile.id);
  await prisma.$disconnect();
})();
