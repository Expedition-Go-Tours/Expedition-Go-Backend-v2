/**
 * Customer-facing refund emails.
 *
 * Two moments the traveller must hear about:
 *   1. a supplier has asked us to refund their booking (under review, no money
 *      promised yet),
 *   2. the decision — refund issued, or not approved.
 * Plus the cancellation email that already carried their refund when they
 * cancel the tour themselves.
 *
 * Rendering the committed templates with representative data catches copy that
 * never fires, a missing variable and a refund promise in the wrong email.
 */

const fs = require('fs');
const path = require('path');

const { render } = require('../../src/core/services/emailRenderer');
const { SHELL, SAMPLE } = require('../../src/core/services/emailPreviews');

const read = (key) =>
  fs.readFileSync(
    path.join(__dirname, `../../sendgrid-templates/generated/${key}.html`),
    'utf8',
  );

const BASE = {
  ...SHELL,
  ...SAMPLE,
  refundAmountLabel: '$35.00',
  manageUrl: 'https://www.travioghana.com/bookings/b1/manage',
  bookingUrl: 'https://www.travioghana.com/bookings/b1',
};

describe('customer refund emails', () => {
  it('tells the traveller a refund is under review — without promising money', () => {
    const html = render(read('customer-refund-requested'), BASE);

    expect(html).toContain('reviewing your refund');
    expect(html).toContain('$35.00');
    expect(html).toContain('nothing has moved yet');
    // It must not read like an approval.
    expect(html).not.toContain('has been issued');
    expect(html).not.toContain('Your refund is complete');
    expect(html).toContain('What happens next');
  });

  it('closes the loop when the refund is not approved', () => {
    const html = render(read('customer-refund-declined'), BASE);

    expect(html).toContain('Refund review complete');
    expect(html).toContain('not able to approve it');
    expect(html).not.toContain('$35.00'); // no amount to dispute
    expect(html).toContain('reply to this email');
  });

  it('still sends the cancellation-with-refund email when the customer cancels', () => {
    const html = render(
      read('customer-cancelled-full-refund'),
      {
        ...BASE,
        refundDestinationNote: 'Back to your original payment method.',
        refundStatusLabel: 'Refund issued',
        refundTimeline: 'Usually within 5–10 business days.',
        refundFailed: false,
      },
    );

    expect(html).toContain('Your booking is cancelled');
    expect(html).toContain('$35.00');
    expect(html).toContain('Refund status');
  });
});
