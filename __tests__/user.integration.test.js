const prisma = require('../utils/prismaClient');

const testUid = `integration-test-${Date.now()}`;

describe('User model', () => {
  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { firebaseUid: { startsWith: 'integration-test-' } },
    });
    await prisma.$disconnect();
  });

  test('creates a user in the database', async () => {
    const user = await prisma.user.create({
      data: {
        firebaseUid: testUid,
        name: 'Integration Test User',
        email: `integration-${Date.now()}@test.com`,
        roles: ['customer'],
      },
    });

    expect(user).toBeDefined();
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Integration Test User');
    expect(user.roles).toContain('customer');
    expect(user.active).toBe(true);
  });

  test('finds a user by firebaseUid', async () => {
    const user = await prisma.user.findUnique({
      where: { firebaseUid: testUid },
    });

    expect(user).toBeDefined();
    expect(user.name).toBe('Integration Test User');
    expect(user.email).toBeDefined();
  });

  test('fails when email is duplicated', async () => {
    const dupEmail = `dup-${Date.now()}@test.com`;

    await prisma.user.create({
      data: {
        firebaseUid: `dup-user-${Date.now()}`,
        name: 'Duplicate Email User',
        email: dupEmail,
        roles: ['customer'],
      },
    });

    await expect(
      prisma.user.create({
        data: {
          firebaseUid: `dup-user-2-${Date.now()}`,
          name: 'Duplicate Email User 2',
          email: dupEmail,
          roles: ['customer'],
        },
      }),
    ).rejects.toThrow();
  });
});
