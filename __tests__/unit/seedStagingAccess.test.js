const {
  DEMO_USERS,
  VENUE_ROLE,
  assertNonProduction,
  mergeRoles,
} = require('../../scripts/seed-staging-access');

describe('seed-staging-access', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('refuses to grant demo access outside development/staging', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertNonProduction()).toThrow(/refuses NODE_ENV=production/);
  });

  it('allows the demo grant in staging and development', () => {
    for (const env of ['staging', 'development']) {
      process.env.NODE_ENV = env;
      expect(() => assertNonProduction()).not.toThrow();
    }
  });

  it('covers both demo accounts with owner-level venue access', () => {
    expect(DEMO_USERS.map((user) => user.email)).toEqual([
      'expdeveloper2@gmail.com',
      'expeditiongotravelandtoursltd@gmail.com',
    ]);
    expect(VENUE_ROLE).toBe('OWNER');
  });

  it('preserves existing platform roles when granting admin access', () => {
    expect(mergeRoles(['supplier', 'ghana', 'expedition'])).toEqual([
      'supplier',
      'ghana',
      'expedition',
      'customer',
      'admin',
    ]);
    expect(mergeRoles(['customer', 'admin'])).toEqual(['customer', 'admin']);
  });
});
