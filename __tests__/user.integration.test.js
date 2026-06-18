const prisma = require('../utils/prismaClient');

describe('User model', () => {
  const testEmail = `integration-${Date.now()}@test.com`;

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { email: { startsWith: 'integration-' } },
    });
    await prisma.$disconnect();
  });

  test('creates a user in the database', async () => {
    const user = await prisma.user.create({
      data: {
        name: 'Integration Test User',
        email: testEmail,
        roles: ['customer'],
      },
    });

    expect(user).toBeDefined();
    expect(user.id).toBeDefined();
    expect(user.name).toBe('Integration Test User');
    expect(user.roles).toContain('customer');
    expect(user.active).toBe(true);
  });

  test('finds a user by email', async () => {
    const user = await prisma.user.findUnique({
      where: { email: testEmail },
    });

    expect(user).toBeDefined();
    expect(user.name).toBe('Integration Test User');
    expect(user.email).toBe(testEmail);
  });

  test('fails when email is duplicated', async () => {
    const dupEmail = `dup-${Date.now()}@test.com`;

    await prisma.user.create({
      data: {
        name: 'Duplicate Email User',
        email: dupEmail,
        roles: ['customer'],
      },
    });

    await expect(
      prisma.user.create({
        data: {
          name: 'Duplicate Email User 2',
          email: dupEmail,
          roles: ['customer'],
        },
      }),
    ).rejects.toThrow();
  });
});
