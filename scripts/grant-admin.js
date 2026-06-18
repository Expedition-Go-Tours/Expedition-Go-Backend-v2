// Run: node scripts/grant-admin.js <email>
// Grants admin role to a user by email

const prisma = require('../utils/prismaClient');

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/grant-admin.js <email>');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`User not found: ${email}`);
    console.error('Sign in with Google first, then run this script.');
    process.exit(1);
  }

  let adminRole = await prisma.adminRole.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!adminRole) {
    adminRole = await prisma.adminRole.create({
      data: {
        name: 'super_admin',
        description: 'Full system access',
        isSystem: true,
      },
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      roles: { set: ['customer', 'admin'] },
      adminRoleId: adminRole.id,
    },
  });

  console.log(`Admin role granted to ${email}`);
  console.log(`Assigned admin role: ${adminRole.name}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect();
  process.exit(1);
});
