process.env.CLIENT_URL = 'https://travioafrica.com';
// The supplier dashboards resolve from dedicated env vars, not CLIENT_URL.
// Pin them here so these assertions are hermetic: CI runs without a .env
// file, and without this the default dashboard would collapse to CLIENT_URL.
process.env.SUPPLIER_DASHBOARD_URL = 'https://supplier.travioafrica.com';
process.env.GHANA_SUPPLIER_DASHBOARD_URL = 'https://supplier.travioghana.com';
process.env.ADMIN_DASHBOARD_URL = 'https://admin.travioafrica.com';
process.env.GHANA_ADMIN_DASHBOARD_URL = 'https://admin.travioghana.com';
process.env.GHANA_STOREFRONT_URL = 'https://www.travioghana.com';
process.env.AFRICA_STOREFRONT_URL = 'https://travioafrica.com';
process.env.EXPEDITION_STOREFRONT_URL = 'https://www.expeditiongotours.com';
process.env.ALLOWED_ORIGINS = 'https://expeditiongotours.vercel.app,https://www.travioghana.com';

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
    expect(emailUrls.writeReview('b1', legacy, 'tour-slug')).toBe('https://travioafrica.com/review/tour-slug?bookingId=b1');
    expect(emailUrls.viewCancellation('b1', legacy)).toBe('https://travioafrica.com/booking/b1/cancellation');
  });

  it('routes expedition links through the dashboard workspace (no ticket page yet)', () => {
    expect(emailUrls.viewBooking('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.manageBooking('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.downloadVoucher('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.managePaymentMethod('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.viewCancellation('b1', expedition)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
    expect(emailUrls.addPickupLocation('b1', expedition)).toBe(`${expedition}/booking/b1/pickup`);
    expect(emailUrls.writeReview('b1', expedition, 'tour-slug')).toBe(`${expedition}/review/tour-slug?bookingId=b1`);
  });

  it('carries bookingId and tourId into the guided /review deep link', () => {
    const legacy = 'https://travioafrica.com';
    expect(emailUrls.writeReview('b1', legacy, 'tour-slug', 'tour-9')).toBe(
      'https://travioafrica.com/review/tour-slug?bookingId=b1&tourId=tour-9'
    );
  });

  it('strips a trailing slash from the origin', () => {
    expect(emailUrls.downloadVoucher('b1', `${expedition}/`)).toBe(`${expedition}/dashboard/bookings?booking=b1`);
  });
});

describe('viewTour — canonical experience deep link', () => {
  const legacy = 'https://travioafrica.com';
  const expedition = 'https://expeditiongotours.vercel.app';

  it('builds the /tour/{id}/{slug} route on the booking origin', () => {
    expect(emailUrls.viewTour('tour-1', 'accra-flying-dress', legacy)).toBe(
      'https://travioafrica.com/tour/tour-1/accra-flying-dress'
    );
    expect(emailUrls.viewTour('tour-1', 'accra-flying-dress', expedition)).toBe(
      `${expedition}/tour/tour-1/accra-flying-dress`
    );
  });

  it('falls back to the bare slug route, then the browse listing', () => {
    expect(emailUrls.viewTour('', 'accra-flying-dress', legacy)).toBe(
      'https://travioafrica.com/tour/accra-flying-dress'
    );
    expect(emailUrls.viewTour('', '', legacy)).toBe('https://travioafrica.com/tours');
  });

  it('defaults to CLIENT_URL when no origin is supplied', () => {
    expect(emailUrls.viewTour('tour-1', 'slug-x')).toBe('https://travioafrica.com/tour/tour-1/slug-x');
  });
});

describe('dashboardBaseForBrand — brand-key dashboard resolution', () => {
  const GHANA = 'https://supplier.travioghana.com';
  const AFRICA = expect.stringMatching(/supplier\.travioafrica\.com/);

  it('routes ghana to the Ghana dashboard', () => {
    expect(emailUrls.dashboardBaseForBrand('ghana')).toBe(GHANA);
  });

  it('routes expedition to the Ghana dashboard (sub-store shares Ghana)', () => {
    expect(emailUrls.dashboardBaseForBrand('expedition')).toBe(GHANA);
  });

  it('routes africa to the default dashboard', () => {
    expect(emailUrls.dashboardBaseForBrand('africa')).toEqual(AFRICA);
  });

  it('falls back to the default dashboard for unknown or null keys', () => {
    expect(emailUrls.dashboardBaseForBrand(null)).toEqual(AFRICA);
    expect(emailUrls.dashboardBaseForBrand(undefined)).toEqual(AFRICA);
    expect(emailUrls.dashboardBaseForBrand('unknown')).toEqual(AFRICA);
  });
});

describe('chat deep links — customer storefront and admin app resolution', () => {
  it('routes a Ghana customer to the Ghana storefront', () => {
    expect(emailUrls.customerChatLink({
      brandKey: 'ghana',
      type: 'USER_SUPPORT',
      conversationId: 'c-1',
    })).toBe('https://www.travioghana.com/dashboard/chat?conversation=c-1');
  });

  it('routes an Expedition support thread to Expedition even though it is branded Ghana', () => {
    expect(emailUrls.customerChatLink({
      brandKey: 'ghana',
      type: 'EXPEDITION_CUSTOMER',
      conversationId: 'c-1',
    })).toBe('https://www.expeditiongotours.com/dashboard/chat?conversation=c-1');
  });

  it('routes an Africa customer to the Africa storefront', () => {
    expect(emailUrls.customerChatLink({
      brandKey: 'africa',
      type: 'USER_SUPPORT',
      conversationId: 'c-1',
    })).toBe('https://travioafrica.com/dashboard/chat?conversation=c-1');
  });

  it('uses the booking origin when it is explicit and allow-listed', () => {
    expect(emailUrls.customerChatLink({
      brandKey: 'ghana',
      type: 'SUPPLIER_CUSTOMER',
      conversationId: 'c-1',
      bookingOrigin: 'https://expeditiongotours.vercel.app',
    })).toBe('https://expeditiongotours.vercel.app/dashboard/chat?conversation=c-1');
  });

  it('ignores an unlisted booking origin and falls back to the brand', () => {
    expect(emailUrls.customerChatLink({
      brandKey: 'ghana',
      type: 'SUPPLIER_CUSTOMER',
      conversationId: 'c-1',
      bookingOrigin: 'https://evil.example',
    })).toBe('https://www.travioghana.com/dashboard/chat?conversation=c-1');
  });

  it('only returns an explicit allow-listed booking origin', () => {
    expect(emailUrls.bookingClientOriginOrNull({
      clientOrigin: 'https://www.travioghana.com',
    })).toBe('https://www.travioghana.com');
    expect(emailUrls.bookingClientOriginOrNull({
      clientOrigin: 'https://evil.example',
    })).toBeNull();
    expect(emailUrls.bookingClientOriginOrNull(null)).toBeNull();
  });

  it('routes Ghana admin chat to the Ghana admin app, others to the default', () => {
    expect(emailUrls.adminBaseForBrand('ghana')).toBe('https://admin.travioghana.com');
    expect(emailUrls.adminBaseForBrand('expedition')).toBe('https://admin.travioghana.com');
    expect(emailUrls.adminBaseForBrand('africa')).toBe('https://admin.travioafrica.com');
    expect(emailUrls.adminBaseForBrand(null)).toBe('https://admin.travioafrica.com');
  });
});
