jest.mock('../../src/core/services/prismaClient', () => ({ $disconnect: jest.fn() }));
jest.mock('../../src/core/services/queue', () => ({ closeAll: jest.fn(async () => {}) }));
jest.mock('../../src/core/services/stripeHelpers', () => ({ notifyBookingsSettled: jest.fn() }));

const { parseArgs } = require('../../scripts/backfill-settled-notifications');

describe('backfill-settled-notifications parseArgs', () => {
  it('takes the first positional booking number (regression: index 0 was dropped)', () => {
    expect(parseArgs(['TRG-64945817-2026-13'])).toEqual({
      since: null,
      numbers: ['TRG-64945817-2026-13'],
    });
  });

  it('takes multiple booking numbers', () => {
    expect(parseArgs(['BK-001', 'BK-002'])).toEqual({
      since: null,
      numbers: ['BK-001', 'BK-002'],
    });
  });

  it('parses --since and leaves numbers empty', () => {
    expect(parseArgs(['--since', '2026-10-01'])).toEqual({
      since: '2026-10-01',
      numbers: [],
    });
  });

  it('supports a booking number alongside --since', () => {
    expect(parseArgs(['BK-001', '--since', '2026-10-01'])).toEqual({
      since: '2026-10-01',
      numbers: ['BK-001'],
    });
  });

  it('throws when --since has no value', () => {
    expect(() => parseArgs(['--since'])).toThrow(/ISO date/);
  });

  it('throws on an unknown option', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
  });
});
