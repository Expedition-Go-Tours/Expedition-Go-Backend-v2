#!/usr/bin/env node
/**
 * Grant dashboard/admin access to staging demo accounts.
 *
 * DEMO / STAGING ONLY. This script promotes real user accounts to admin and
 * makes them owners of a real restaurant listing so the owner dashboard can be
 * reviewed in staging. It refuses to run outside development/staging.
 *
 * Usage:
 *   NODE_ENV=staging node scripts/seed-staging-access.js
 *   NODE_ENV=staging STAGING_ACCESS_VENUE_SLUG=the-place node scripts/seed-staging-access.js
 *
 * Idempotent: users are keyed by email and venue membership by (venue, user),
 * so re-running updates the same rows instead of stacking grants.
 */

const prisma = require('../src/core/services/prismaClient');
const { logActivity } = require('../src/core/services/auditLogger');

const DEMO_ENVIRONMENTS = ['development', 'staging'];
const DEFAULT_VENUE_SLUG = 'the-place';
// Add these roles; preserve any roles the account already holds. A real
// supplier/admin account must not lose its platform roles when it is granted
// dashboard access.
const GRANTED_USER_ROLES = ['customer', 'admin'];
const VENUE_ROLE = 'OWNER';

const DEMO_USERS = [
  {
    email: 'expdeveloper2@gmail.com',
    name: 'EXP Developer',
    // Same Google identity pinned by prisma/seed.js. Keep the two in sync so
    // Google sign-in resolves to this account instead of creating a duplicate.
    firebaseUid: 'aIQDqPPv97hN5QtqLCd5MLpgoJD3',
  },
  {
    email: 'expeditiongotravelandtoursltd@gmail.com',
    name: 'EXP Travel and Tours',
    // No Firebase UID is committed for this account. Auth pre-approves Google
    // sign-in for this email and links the real `sub` on first login.
    firebaseUid: null,
  },
];

function assertNonProduction() {
  const env = process.env.NODE_ENV || 'development';
  if (!DEMO_ENVIRONMENTS.includes(env)) {
    throw new Error(
      `seed-staging-access is a demo grant and refuses NODE_ENV=${env}. ` +
        'Run it only with NODE_ENV=development or NODE_ENV=staging.',
    );
  }
}

async function findSuperAdminRole() {
  const role = await prisma.adminRole.findUnique({ where: { name: 'super_admin' } });
  if (!role) {
    throw new Error('super_admin role not found — run the base seed before granting staging access');
  }
  return role;
}

async function findVenue(slugOrId) {
  const venue = await prisma.restaurantVenue.findFirst({
    where: { OR: [{ slug: slugOrId }, { id: slugOrId }] },
    select: { id: true, slug: true, name: true },
  });
  if (!venue) {
    const sample = await prisma.restaurantVenue.findMany({
      select: { slug: true },
      orderBy: { slug: 'asc' },
      take: 10,
    });
    throw new Error(
      `Venue ${slugOrId} not found. Available slugs: ${sample.map((v) => v.slug).join(', ') || '(none)'}`,
    );
  }
  return venue;
}

function mergeRoles(existingRoles, grantedRoles = GRANTED_USER_ROLES) {
  return [...new Set([...(existingRoles || []), ...grantedRoles])];
}

async function upsertDemoUser(spec, superAdminRole) {
  const email = spec.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });

  if (spec.firebaseUid && existing && existing.firebaseUid !== spec.firebaseUid) {
    const collision = await prisma.user.findUnique({
      where: { firebaseUid: spec.firebaseUid },
      select: { id: true, email: true },
    });
    if (collision && collision.id !== existing.id) {
      throw new Error(
        `Cannot link ${email} to ${spec.firebaseUid}: already used by ${collision.email}`,
      );
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: { firebaseUid: spec.firebaseUid },
    });
  }

  // An admin must have a linked Google identity before Google sign-in will
  // resolve to it. The pre-approved Google account links its real sub on first
  // login; an account that already has a UID keeps its original provider.
  const authProvider = spec.firebaseUid
    ? undefined
    : existing?.firebaseUid
      ? undefined
      : 'google';

  return prisma.user.upsert({
    where: { email },
    update: {
      name: existing?.name || spec.name,
      roles: mergeRoles(existing?.roles),
      active: true,
      emailVerified: true,
      emailVerifiedAt: existing?.emailVerifiedAt || new Date(),
      adminRoleId: superAdminRole.id,
      authProvider,
    },
    create: {
      email,
      name: spec.name,
      photoURL: '',
      firebaseUid: spec.firebaseUid || null,
      authProvider: spec.firebaseUid ? 'local' : 'google',
      roles: GRANTED_USER_ROLES,
      active: true,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      adminRoleId: superAdminRole.id,
    },
  });
}

async function grantVenueOwnership(user, venue) {
  const membership = await prisma.restaurantVenueMember.upsert({
    where: {
      venueId_userId: { venueId: venue.id, userId: user.id },
    },
    update: { role: VENUE_ROLE, status: 'ACTIVE' },
    create: {
      venueId: venue.id,
      userId: user.id,
      role: VENUE_ROLE,
      status: 'ACTIVE',
    },
  });

  await logActivity({
    userId: user.id,
    userEmail: user.email,
    action: 'stagingAccess.granted',
    resource: 'RestaurantVenueMember',
    resourceId: membership.id,
    metadata: {
      source: 'seed-staging-access',
      email: user.email,
      venueId: venue.id,
      venueSlug: venue.slug,
      role: VENUE_ROLE,
    },
    brand: 'ghana',
  });

  return membership;
}

async function main() {
  assertNonProduction();

  const slugOrId = process.env.STAGING_ACCESS_VENUE_SLUG || DEFAULT_VENUE_SLUG;
  const [venue, superAdminRole] = await Promise.all([
    findVenue(slugOrId),
    findSuperAdminRole(),
  ]);

  console.log(`Granting staging access to ${venue.name} (${venue.slug})`);

  for (const spec of DEMO_USERS) {
    const user = await upsertDemoUser(spec, superAdminRole);
    await grantVenueOwnership(user, venue);
    console.log(
      `  ${user.email}: admin role + ${VENUE_ROLE} of ${venue.slug} (user ${user.id})`,
    );
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message || error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = {
  DEMO_USERS,
  VENUE_ROLE,
  assertNonProduction,
  mergeRoles,
  findSuperAdminRole,
  findVenue,
  upsertDemoUser,
  grantVenueOwnership,
  main,
};
