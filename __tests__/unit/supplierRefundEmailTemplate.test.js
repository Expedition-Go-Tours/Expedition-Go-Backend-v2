/**
 * The compiled supplier refund decision email.
 *
 * The template is generated from scripts/buildEmailTemplates.js into
 * sendgrid-templates/generated/ (committed, so the SendGrid sync and the tests
 * read the same bytes). Rendering it here with Handlebars-style data catches
 * the mistakes a browser preview hides: a conditional that never fires, a
 * variable the service forgot to pass, or the wrong tone on a failure.
 */

const fs = require('fs');
const path = require('path');

const { render } = require('../../src/core/services/emailRenderer');
const { SHELL, SAMPLE } = require('../../src/core/services/emailPreviews');

const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../../sendgrid-templates/generated/supplier-refund-decision.html'),
  'utf8',
);

const BASE = {
  ...SHELL,
  ...SAMPLE,
  requestNumber: 'SR-20261105-E2AD',
  refundAmountLabel: '$35.00',
  chargeLabel: '$29.75',
  reversedChargeLabel: '$29.75',
  balanceAfterLabel: '$2,728.84',
  bookingStatusLabel: 'Completed',
  refundKindLabel: 'Full booking refund',
  reasonLabel: 'Guide issue',
  operatedLabel: 'Yes',
  attendedLabel: 'No',
  filedAtLabel: '5 November 2026',
  decisionNote: '',
  supplierBookingUrl: 'https://supplier.travioghana.com/bookings?bookingId=b1',
  chargesUrl: 'https://supplier.travioghana.com/finance?tab=payouts',
};

const renderVariant = (overrides) => render(TEMPLATE, { ...BASE, ...overrides });

const approved = () => renderVariant({
  approved: true,
  rejected: false,
  failed: false,
  chargeApplied: true,
  hadCharge: true,
  decisionTitle: 'Refund approved',
  decisionBody: 'We approved refund request <strong>SR-20261105-E2AD</strong>. $35.00 has been returned to the traveller.',
  chargeTitle: 'Netted off your next payout',
  chargeBody: '$29.75 appears in your charges and settles against your next payout.',
});

const declined = () => renderVariant({
  approved: false,
  rejected: true,
  failed: false,
  chargeApplied: false,
  hadCharge: false,
  decisionTitle: 'Refund request declined',
  decisionBody: 'We decided not to approve this refund.',
  chargeTitle: 'Your balance is unchanged',
  chargeBody: 'Nothing was refunded and nothing was charged.',
});

const failed = () => renderVariant({
  approved: false,
  rejected: false,
  failed: true,
  chargeApplied: false,
  hadCharge: true,
  decisionTitle: 'We couldn’t complete this refund',
  decisionBody: 'The refund did not go through with our payment provider.',
  chargeTitle: 'Charge reversed',
  chargeBody: 'The charge is no longer owed.',
});

describe('supplier-refund-decision email', () => {
  it('leads with the amount on a full-bleed band when approved', () => {
    const html = approved();
    expect(html).toContain('Refund approved');
    expect(html).toContain('Traveller refund');
    expect(html).toContain('$35.00');
    expect(html).toContain('$29.75');
    expect(html).toContain('Netted off your next payout');
    expect(html).toContain('Balance available now');
    expect(html).toContain('What happens next');
    expect(html).toContain('View booking');
    // No declined-copy bleed-through.
    expect(html).not.toContain('Nothing has changed');
    expect(html).not.toContain('Refund request declined');
  });

  it('says nothing moved when declined, and never claims a charge', () => {
    const html = declined();
    expect(html).toContain('Refund request declined');
    expect(html).toContain('Nothing has changed');
    expect(html).not.toContain('Traveller refund');
    expect(html).not.toContain('Netted off your next payout');
    expect(html).not.toContain('Charged to your balance');
  });

  it('wears the warning band, not the success band, when the provider failed', () => {
    const html = failed();
    expect(html).toContain('Refund not completed');
    expect(html).toContain('Charge reversed');
    expect(html).toContain('#FFF7E8'); // warning band background
    expect(html).not.toContain('Netted off your next payout');
    // A failed refund must never read as approved.
    expect(html).not.toContain('Refund approved');
  });

  it('surfaces the decision note only when one was left', () => {
    const withNote = renderVariant({
      ...{ approved: false, rejected: true, failed: false, chargeApplied: false, hadCharge: false },
      decisionTitle: 'Refund request declined',
      decisionBody: 'We decided not to approve this refund.',
      chargeTitle: 'Your balance is unchanged',
      chargeBody: 'Nothing was refunded.',
      decisionNote: 'The tour operated as booked.',
    });
    expect(withNote).toContain('The tour operated as booked.');
    expect(declined()).not.toContain('Note from our team');
  });

  it('links the supplier to the booking and the charges tab', () => {
    const html = approved();
    expect(html).toContain('bookings?bookingId=b1');
    expect(html).toContain('finance?tab=payouts');
  });
});
