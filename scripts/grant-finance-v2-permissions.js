/* One-off: grant finance v2 permissions to existing roles.
 * Rule: role has payouts.view  -> + disputes.view
 *       role has payouts.approve -> + disputes.resolve
 * Idempotent. Also prints a summary of affected roles.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const GRANTS = [
  { requires: 'payouts.view', grants: 'disputes.view' },
  { requires: 'payouts.approve', grants: 'disputes.resolve' },
];

async function main() {
  const roles = await prisma.adminRole.findMany({
    include: { permissions: { include: { permission: true } } },
  });

  for (const rule of GRANTS) {
    const perm = await prisma.adminPermission.findUnique({ where: { key: rule.grants } });
    if (!perm) {
      console.log(`SKIP: permission ${rule.grants} not found — run the seed first`);
      continue;
    }

    for (const role of roles) {
      const keys = role.permissions.map((l) => l.permission.key);
      if (!keys.includes(rule.requires) || keys.includes(rule.grants)) continue;
      await prisma.adminRolePermission.create({ data: { roleId: role.id, permissionId: perm.id } });
      console.log(`+ ${rule.grants} -> ${role.name}`);
    }
  }

  const after = await prisma.adminRole.findMany({
    include: { permissions: { include: { permission: true } } },
  });
  console.log('\nFinal state:');
  for (const r of after) {
    const fin = r.permissions.map((l) => l.permission.key).filter((k) => k.startsWith('payout') || k.startsWith('disputes')).sort();
    if (fin.length) console.log(`  ${r.name}: ${fin.join(', ')}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
