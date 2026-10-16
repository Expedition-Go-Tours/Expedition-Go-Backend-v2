/**
 * Supplier "reservation payment collected / booking confirmed" email.
 *
 * Sent when a reserve-now-pay-later card charge clears. It mirrors the
 * confirmed-booking email's navy "Payment & payout" money panel (retail,
 * commission, prominent payout total, Scheduled pill) and adds a guarded
 * "Payment collected" date row. Like every supplier email it must NOT carry
 * the customer-facing "Similar activities" upsell rail.
 *
 * Assertions run against the compiled artifact the send path delivers.
 */

const fs = require('fs');
const path = require('path');

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const html = fs.readFileSync(path.join(GENERATED, 'supplier-pay-later-charged.html'), 'utf8');

describe('supplier-pay-later-charged artifact', () => {
  it('presents the payout as the navy Payment & payout panel', () => {
    expect(html).toContain('Payment & payout');
    expect(html).toContain('Retail value');
    expect(html).toContain('Platform commission');
    expect(html).toContain('Your payout');
    expect(html).toContain('{{payoutAmountLabel}}');
    // The old light "Supplier payout" summary block is gone.
    expect(html).not.toContain('Supplier payout');
    expect(html).not.toContain('Payout status');
  });

  it('keeps the collected date as a guarded panel row', () => {
    expect(html).toContain('Payment collected');
    expect(html).toContain('{{#if chargedAtLabel}}');
    expect(html).toContain('{{chargedAtLabel}}');
  });

  it('does NOT carry the customer-facing Similar activities rail', () => {
    expect(html).not.toContain('Similar activities');
    expect(html).not.toContain('{{#each similarTours}}');
    expect(html).not.toContain('{{ratingLabel}}');
  });

  it('contains no em dashes and no emoji codepoints', () => {
    expect(html).not.toContain('\u2014');
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(html)).toBe(false);
  });
});
