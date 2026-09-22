describe('notification recipient branded links', () => {
  let emailUrls;

  beforeAll(() => {
    process.env.SUPPLIER_DASHBOARD_URL = 'https://supplier.travioafrica.com';
    process.env.GHANA_SUPPLIER_DASHBOARD_URL = 'https://supplier.travioghana.com';
    // Fresh require so the env is picked up.
    jest.resetModules();
    emailUrls = require('../../config/emailUrls');
  });

  it('routes Ghana suppliers to the Ghana dashboard domain', () => {
    const ghana = { roles: ['supplier', 'ghana'] };
    expect(emailUrls.supplierNotificationRecipientVerifyForUser(ghana, 'tok123'))
      .toBe('https://supplier.travioghana.com/confirm/tok123');
    expect(emailUrls.supplierNotificationRecipientUnsubscribeForUser(ghana, 'rid', 'tok123'))
      .toBe('https://supplier.travioghana.com/unsubscribe/rid/tok123');
  });

  it('routes other suppliers to the default (Africa) dashboard domain', () => {
    const africa = { roles: ['supplier'] };
    expect(emailUrls.supplierNotificationRecipientVerifyForUser(africa, 'tok123'))
      .toBe('https://supplier.travioafrica.com/confirm/tok123');
  });

  it('URL-encodes the token', () => {
    expect(emailUrls.supplierNotificationRecipientVerifyForUser({ roles: ['ghana'] }, 'a/b'))
      .toBe('https://supplier.travioghana.com/confirm/a%2Fb');
  });
});
