process.env.CLIENT_URL = 'https://travioafrica.com';
process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app';

const emailUrls = require('../../config/emailUrls');

describe('emailUrls brand-aware deep links', () => {
  const legacy = 'https://travioafrica.com';
  const expedition = 'https://expeditiongotours.vercel.app';

  it('resolves the allow-listed booking origin, else CLIENT_URL', () => {
    expect(emailUrls.bookingClientOrigin({ id: 'b1', clientOrigin: expedition })).toBe(expedition);
    expect(emailUrls.bookingClientOrigin({ booking: { id: 'b1', clientOrigin: expedition } })).toBe(expedition);
    expect(emailUrls.bookingClientOrigin({ id: 'b1', clientOrigin: 'https://evil.example' })).toBe(legacy);
    expect(emailUrls.bookingClientOrigin({ id: 'b1' })).toBe(legacy);
  });

  it('keeps legacy deep-link paths on the legacy origin', () => {
    expect(emailUrls.viewBooking('b1', legacy)).toBe('https://travioafrica.com/booking/b1');
    expect(emailUrls.manageBooking('b1', legacy)).toBe('https://travioafrica.com/booking/b1/manage');
    expect(emailUrls.downloadVoucher('b1', legacy)).toBe('https://travioafrica.com/booking/b1/ticket');
    expect(emailUrls.addPickupLocation('b1', legacy)).toBe('https://travioafrica.com/booking/b1/pickup');
    expect(emailUrls.writeReview('b1', legacy, 'tour-slug')).toBe('https://travioafrica.com/booking/b1/review');
    expect(emailUrls.viewCancellation('b1', legacy)).toBe('https://travioafrica.com/booking/b1/cancellation');
  });

  it('routes expedition links through the dashboard workspace (no ticket page yet)', () => {
    expect(emailUrls.viewBooking('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.manageBooking('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.downloadVoucher('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.managePaymentMethod('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.viewCancellation('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.addPickupLocation('b1', expedition)).toBe(`${expedition}/booking/b1/pickup`);
    expect(emailUrls.writeReview('b1', expedition, 'tour-slug')).toBe(`${expedition}/review/tour-slug`);
  });

  it('strips a trailing slash from the origin', () => {
    expect(emailUrls.downloadVoucher('b1', `${expedition}/`)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
  });
});
