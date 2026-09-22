jest.mock('../../src/core/services/prismaClient', () => ({}));

const { generateEmailContent } = require('../../src/core/services/emailService');

describe('notification recipient confirmation email', () => {
  it('renders the confirm button, chosen types and safety note', () => {
    const { html, text } = generateEmailContent('notification-recipient-verify', {
      supplierName: 'Acme Tours',
      confirmUrl: 'https://apiv1.travioafrica.com/api/suppliers/settings/notification-recipients/verify?token=abc123',
      types: ['Bookings & operations', 'Payments & payouts'],
      expiresInDays: 7,
      recipientEmail: 'finance@acme.com',
    });

    expect(html).toContain('Confirm your email address');
    expect(html).toContain('Confirm email address');
    expect(html).toContain('token=abc123');
    expect(html).toContain('Acme Tours');
    expect(html).toContain('Bookings &amp; operations');
    expect(html).toContain('Payments &amp; payouts');
    expect(html).toContain('finance@acme.com');
    expect(html).toContain('expires in 7 days');

    expect(text).toContain('token=abc123');
    expect(text).toContain('- Bookings & operations');
  });

  it('escapes supplier names injected into the email', () => {
    const { html } = generateEmailContent('notification-recipient-verify', {
      supplierName: 'A & B <Tours>',
      confirmUrl: 'https://x/y',
      types: [],
      expiresInDays: 7,
      recipientEmail: 'x@y.com',
    });
    expect(html).toContain('A &amp; B &lt;Tours&gt;');
    expect(html).not.toContain('<Tours>');
  });
});
