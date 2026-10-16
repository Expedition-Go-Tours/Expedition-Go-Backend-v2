/**
 * Supplier "new confirmed booking" email.
 *
 * Operational notification to the supplier when a booking is confirmed. It
 * links to the booked experience (so the supplier can see what was sold) but,
 * unlike the customer confirmation, it must NOT carry a "Similar activities"
 * upsell rail — recommendations are customer-facing. These tests pin that
 * distinction plus the standard hygiene checks (no em dashes, no emoji).
 *
 * Assertions run against the compiled artifact the send path delivers.
 */

const fs = require('fs');
const path = require('path');

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const html = fs.readFileSync(path.join(GENERATED, 'supplier-new-booking.html'), 'utf8');

describe('supplier-new-booking artifact', () => {
  it('links to the booked experience', () => {
    expect(html).toContain('View the experience');
    expect(html).toContain('href="{{tourUrl}}"');
  });

  it('does NOT carry the customer-facing Similar activities rail', () => {
    expect(html).not.toContain('Similar activities');
    expect(html).not.toContain('{{#each similarTours}}');
    expect(html).not.toContain('{{ratingLabel}}');
  });

  it('still names the lead traveller and the payout', () => {
    expect(html).toContain('Lead traveller');
    expect(html).toContain('{{leadTravelerName}}');
    expect(html).toContain('{{payoutAmountLabel}}');
  });

  it('presents the payout as the navy Payment & payout panel', () => {
    // Mirrors the supplier-reserve-later / payout emails: a titled money panel
    // with retail and commission rows above the prominent payout total.
    expect(html).toContain('Payment & payout');
    expect(html).toContain('Retail value');
    expect(html).toContain('Platform commission');
    expect(html).toContain('Your payout');
    expect(html).toContain('{{payoutAmountLabel}}');
    // The old light "Supplier payout" summary block is gone.
    expect(html).not.toContain('Supplier payout');
    expect(html).not.toContain('Payout status');
  });

  it('contains no em dashes and no emoji codepoints', () => {
    expect(html).not.toContain('\u2014');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(html)).toBe(false);
  });
});
