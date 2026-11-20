jest.mock('../../src/core/services/prismaClient', () => ({
  user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
}));

const prisma = require('../../src/core/services/prismaClient');
const { resolveGoogleUser } = require('../../src/core/services/googleAccount');

describe('resolveGoogleUser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.user.update.mockImplementation(({ data }) => Promise.resolve({ id: 'u1', ...data }));
    prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'u2', ...data }));
  });

  it('links Google to an existing local account without changing authProvider', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'person@example.com',
      name: 'Person',
      photoURL: '',
      roles: ['customer'],
      active: true,
      passwordHash: 'hash',
      authProvider: 'local',
      firebaseUid: null,
    });

    await resolveGoogleUser({
      email: 'Person@Example.com',
      name: 'Person',
      photoURL: 'https://photo',
      googleId: 'google-1',
    });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.firebaseUid).toBe('google-1');
    expect(data).not.toHaveProperty('authProvider');
    expect(data.emailVerified).toBe(true);
  });

  it('keeps an existing Google identity instead of replacing it', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'person@example.com',
      name: 'Person',
      photoURL: 'https://old',
      roles: ['customer'],
      active: true,
      passwordHash: 'hash',
      authProvider: 'local',
      firebaseUid: 'google-old',
    });

    await resolveGoogleUser({
      email: 'person@example.com',
      name: 'Person',
      photoURL: 'https://new',
      googleId: 'google-new',
    });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.firebaseUid).toBe('google-old');
    expect(data.photoURL).toBe('https://old');
    expect(data).not.toHaveProperty('authProvider');
  });

  it('refuses to auto-link an admin that has no Google identity', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      roles: ['admin'],
      active: true,
      passwordHash: 'hash',
      authProvider: 'local',
      firebaseUid: null,
    });

    await expect(
      resolveGoogleUser({ email: 'admin@example.com', googleId: 'google-1' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('allows an admin created through Google before the UID was stored', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-2',
      email: 'legacy-admin@example.com',
      roles: ['admin'],
      active: true,
      passwordHash: 'hash',
      authProvider: 'google',
      firebaseUid: null,
    });

    await resolveGoogleUser({ email: 'legacy-admin@example.com', googleId: 'google-legacy' });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.firebaseUid).toBe('google-legacy');
    expect(data).not.toHaveProperty('authProvider');
  });

  it('allows an admin that already linked Google', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      roles: ['admin'],
      active: true,
      passwordHash: 'hash',
      authProvider: 'google',
      firebaseUid: 'google-1',
    });

    await resolveGoogleUser({ email: 'admin@example.com', googleId: 'google-1' });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'admin-1' } }),
    );
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('authProvider');
  });

  it('creates a new Google account with google as its signup provider', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await resolveGoogleUser({
      email: 'new@example.com',
      name: 'New Person',
      photoURL: 'https://photo',
      googleId: 'google-2',
    });

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'new@example.com',
          authProvider: 'google',
          firebaseUid: 'google-2',
          roles: ['customer'],
          emailVerified: true,
        }),
      }),
    );
  });

  it('refuses a deactivated account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'u1',
      email: 'off@example.com',
      roles: ['customer'],
      active: false,
      firebaseUid: 'google-1',
    });

    await expect(
      resolveGoogleUser({ email: 'off@example.com', googleId: 'google-1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('requires an email from Google', async () => {
    await expect(resolveGoogleUser({ googleId: 'google-1' })).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
