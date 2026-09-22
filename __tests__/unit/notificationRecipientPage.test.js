const { renderNotificationRecipientPage } = require('../../src/core/services/notificationRecipientPage');

describe('notificationRecipientPage', () => {
  it('renders a branded success page with the address, account and CTA', () => {
    const html = renderNotificationRecipientPage({
      state: 'verified',
      brandName: 'Travio Ghana',
      logoUrl: 'https://cdn.example.com/logo.png',
      supportEmail: 'support@travioghana.com',
      recipientEmail: 'finance@acme.com',
      supplierName: 'Acme Tours',
      dashboardUrl: 'https://supplier.travioghana.com/settings?tab=notifications',
    });

    expect(html).toContain('Email confirmed');
    expect(html).toContain('finance@acme.com');
    expect(html).toContain('Acme Tours');
    expect(html).toContain('https://supplier.travioghana.com/settings?tab=notifications');
    expect(html).toContain('Travio Ghana');
    // never indexable, and no external JS
    expect(html).toContain('noindex');
    expect(html).not.toContain('<script');
  });

  it('lists the confirmed email types on the success page', () => {
    const html = renderNotificationRecipientPage({
      state: 'verified',
      recipientEmail: 'finance@acme.com',
      types: ['Bookings & operations', 'Payments & payouts'],
    });
    expect(html).toContain('Emails this address will receive');
    expect(html).toContain('Bookings &amp; operations');
    expect(html).toContain('Payments &amp; payouts');
  });

  it('renders expired and invalid states without the manage CTA', () => {
    const expired = renderNotificationRecipientPage({ state: 'expired', brandName: 'Travio Africa' });
    expect(expired).toContain('This link has expired');
    expect(expired).not.toContain('Manage notification emails');

    const invalid = renderNotificationRecipientPage({ state: 'invalid' });
    expect(invalid).toContain('This link');
    expect(invalid).not.toContain('Manage notification emails');
  });

  it('gives the expired state a way back to settings when the account is known', () => {
    const html = renderNotificationRecipientPage({
      state: 'expired',
      recipientEmail: 'finance@acme.com',
      dashboardUrl: 'https://supplier.travioghana.com/settings?tab=notifications',
    });
    expect(html).toContain('Open notification settings');
    expect(html).toContain('https://supplier.travioghana.com/settings?tab=notifications');
    expect(html).toContain('finance@acme.com');
  });

  it('falls back to the invalid state for an unknown state', () => {
    const html = renderNotificationRecipientPage({ state: 'nonsense' });
    expect(html).toContain("This link isn&#39;t valid");
  });

  it('escapes untrusted values', () => {
    const html = renderNotificationRecipientPage({
      state: 'verified',
      recipientEmail: '<script>alert(1)</script>',
      supplierName: 'A & B <Tours>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B &lt;Tours&gt;');
  });
});
