const { computeOfferStatus } = require('../../src/core/services/offerStatus');

const day = (offset) => new Date(Date.now() + offset * 24 * 60 * 60 * 1000);

describe('computeOfferStatus', () => {
  it('reports a past end date as expired even when the switch is off', () => {
    expect(computeOfferStatus({ isActive: false, endDate: day(-1) })).toBe('expired');
  });

  it('reports a switched-off offer with a live window as inactive', () => {
    expect(computeOfferStatus({ isActive: false, startDate: day(-1), endDate: day(1) })).toBe('inactive');
  });

  it('reports a future start as scheduled only while the switch is on', () => {
    expect(computeOfferStatus({ isActive: true, startDate: day(1), endDate: day(5) })).toBe('scheduled');
    // Off, with dates ahead: nothing will switch it on automatically, so
    // "scheduled" would promise a launch the switch prevents.
    expect(computeOfferStatus({ isActive: false, startDate: day(1), endDate: day(5) })).toBe('inactive');
  });

  it('reports a live window as active', () => {
    expect(computeOfferStatus({ isActive: true, startDate: day(-1), endDate: day(1) })).toBe('active');
  });

  it('treats an offer with no dates as active or inactive purely on the switch', () => {
    expect(computeOfferStatus({ isActive: true })).toBe('active');
    expect(computeOfferStatus({ isActive: false })).toBe('inactive');
  });

  // The whole reason for checking the end date first is that the nightly
  // expire-special-offers job writes isActive:false as soon as a date passes.
  // Under the old switch-first order that short-circuited the date check, so
  // 'expired' was unreachable outside the few hours before the job ran.
  it('does not let the nightly job hide a dead offer behind "inactive"', () => {
    const afterJob = { isActive: false, startDate: day(-30), endDate: day(-1) };
    expect(computeOfferStatus(afterJob)).toBe('expired');
  });

  it('selects the same set of active offers as the old switch-first order', () => {
    // activeOnly queries, tour listings and the homepage offer badge all key
    // off 'active'. Reordering may only relabel expired/inactive rows — it
    // must never move a row into or out of the active set.
    const legacy = (o) => {
      if (!o.isActive) return 'inactive';
      if (o.startDate && new Date() < new Date(o.startDate)) return 'scheduled';
      if (o.endDate && new Date() > new Date(o.endDate)) return 'expired';
      return 'active';
    };

    const rows = [
      { isActive: true, startDate: day(-1), endDate: day(1) },
      { isActive: true, startDate: day(1), endDate: day(5) },
      { isActive: false, startDate: day(-1), endDate: day(1) },
      { isActive: false, startDate: day(-1), endDate: day(-1) },
      { isActive: true, startDate: day(-1), endDate: day(-1) },
      { isActive: false, startDate: day(1), endDate: day(5) },
      { isActive: true },
      { isActive: false },
      {},
    ];

    const mismatches = rows
      .map((o, i) => ({ i, nowActive: computeOfferStatus(o) === 'active', wasActive: legacy(o) === 'active' }))
      .filter((r) => r.nowActive !== r.wasActive);
    expect(mismatches).toEqual([]);
  });

  it('accepts string dates as well as Date objects', () => {
    expect(computeOfferStatus({ isActive: true, endDate: new Date(day(-1)).toISOString() })).toBe('expired');
    expect(computeOfferStatus({ isActive: true, endDate: new Date(day(1)).toISOString() })).toBe('active');
  });
});
