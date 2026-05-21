jest.mock('../../utils/prismaClient', () => ({
  user: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  booking: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn(), delete: jest.fn() },
  cartItem: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
  tour: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  review: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), count: jest.fn() },
  notification: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), delete: jest.fn(), count: jest.fn() },
  supplierProfile: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  stripeEvent: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  tourEvent: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), delete: jest.fn(), count: jest.fn() },
  auditLog: { create: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  $transaction: jest.fn(),
  $disconnect: jest.fn(),
}));

const prisma = require('../../utils/prismaClient');
const { enqueueNotification, enqueueEmail } = require('../../utils/queue');
const event = require('../../utils/eventEmitter');
const { createPaymentIntent, calculateCommission } = require('../../utils/stripeHelpers');
jest.mock('../../utils/queue', () => ({
  enqueueNotification: jest.fn(() => Promise.resolve()),
  enqueueEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
}));
jest.mock('../../utils/stripeHelpers', () => ({
  createPaymentIntent: jest.fn(),
  calculateCommission: jest.fn(),
}));
jest.mock('../../utils/bookingHelpers', () => ({
  generateBookingNumber: jest.fn(() => 'BK-TEST-001'),
  validateTravelerInfo: jest.fn(() => ({ isValid: true, errors: [] })),
}));
jest.mock('../../utils/auditLogger', () => ({
  logActivity: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../utils/emailService', () => ({
  generatePrintableTicketHtml: jest.fn(() => '<html>ticket</html>'),
}));

const bookingHelpers = require('../../utils/bookingHelpers');
const bookingController = require('../../controllers/bookingController');

const mockReq = (overrides = {}) => ({
  user: { id: 'customer-1', roles: ['customer'], stripeCustomerId: 'cus_123' },
  body: {},
  params: {},
  query: {},
  originalUrl: '/api/bookings',
  ip: '127.0.0.1',
  ...overrides,
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
};

const activeTour = {
  id: 'tour-1',
  title: 'Grand Canyon Tour',
  status: 'ACTIVE',
  supplierId: 'supplier-1',
  schedulesAndPricing: {
    currency: 'USD',
    schedules: [{ prices: [{ retailPrice: 175 }] }],
  },
  productContent: {},
  bookingAndTickets: {},
  supplier: {
    id: 'supplier-1',
    name: 'Canyon Explorers',
    email: 'supplier@test.com',
    supplierProfile: { status: 'ACTIVE', totalBookings: 30, averageRating: 4.5 },
  },
};

const mockCartItem = {
  id: 'cart-1',
  customerId: 'customer-1',
  tourId: 'tour-1',
  selectedDate: new Date('2026-07-01'),
  selectedTime: '',
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 350,
  total: 385,
  currency: 'USD',
  expiresAt: new Date(Date.now() + 3600000),
  tour: activeTour,
};

const mockBooking = {
  id: 'booking-1',
  bookingNumber: 'BK-TEST-001',
  customerId: 'customer-1',
  tourId: 'tour-1',
  status: 'PENDING',
  selectedDate: new Date('2026-07-01'),
  selectedTime: null,
  travelers: { adults: 2, children: 0, infants: 0 },
  subtotal: 350,
  taxes: 0,
  fees: 0,
  discounts: 0,
  total: 385,
  currency: 'USD',
  commissionRate: 0.15,
  commissionAmount: 57.75,
  supplierPayout: 327.25,
  stripePaymentIntentId: 'pi_123',
  paymentStatus: 'PROCESSING',
  specialRequests: null,
  tour: {
    title: 'Grand Canyon Tour',
    supplier: { id: 'supplier-1', name: 'Canyon Explorers' },
  },
  customer: { id: 'customer-1', name: 'John Doe', email: 'john@test.com' },
};

const mockTx = {
  booking: {
    create: jest.fn().mockResolvedValue(mockBooking),
    update: jest.fn().mockResolvedValue({ ...mockBooking, status: 'CANCELLED' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([mockBooking]),
  },
  notification: { create: jest.fn().mockResolvedValue({}) },
  supplierProfile: { update: jest.fn().mockResolvedValue({}) },
  tour: { update: jest.fn().mockResolvedValue({}) },
  cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.$transaction.mockImplementation((cb) => cb(mockTx));
  calculateCommission.mockReturnValue({ rate: 0.15, amount: 57.75, supplierPayout: 327.25 });
  createPaymentIntent.mockResolvedValue({ id: 'pi_123', client_secret: 'secret_123' });
});

describe('Booking Controller', () => {
  describe('addToCart', () => {
    it('adds a tour to the cart', async () => {
      prisma.tour.findFirst.mockResolvedValue(activeTour);
      prisma.cartItem.upsert.mockResolvedValue(mockCartItem);
      const req = mockReq({ body: { tourId: 'tour-1', selectedDate: '2026-07-01', travelers: { adults: 2 } } });
      const res = mockRes();

      await bookingController.addToCart(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({ cartItem: mockCartItem }),
      }));
      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'cart.added' }));
    });

    it('returns 404 if tour not found or inactive', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);
      const req = mockReq({ body: { tourId: 'nonexistent', selectedDate: '2026-07-01', travelers: { adults: 1 } } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.addToCart(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404, message: expect.stringContaining('not found') }));
    });

    it('returns 400 if pricing calculation fails', async () => {
      prisma.tour.findFirst.mockResolvedValue({ ...activeTour, schedulesAndPricing: {} });
      const req = mockReq({ body: { tourId: 'tour-1', selectedDate: '2026-07-01', travelers: { adults: 1 } } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.addToCart(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('getCart', () => {
    it('returns cart items with summary', async () => {
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
      prisma.cartItem.findMany.mockResolvedValue([mockCartItem]);

      const req = mockReq();
      const res = mockRes();

      await bookingController.getCart(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({
          summary: expect.objectContaining({ itemCount: 1, cartTotal: 385 }),
        }),
      }));
    });

    it('handles empty cart', async () => {
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
      prisma.cartItem.findMany.mockResolvedValue([]);

      const req = mockReq();
      const res = mockRes();

      await bookingController.getCart(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          summary: expect.objectContaining({ itemCount: 0, cartTotal: 0 }),
        }),
      }));
    });
  });

  describe('removeFromCart', () => {
    it('removes a cart item', async () => {
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
      const req = mockReq({ params: { id: 'cart-1' } });
      const res = mockRes();

      await bookingController.removeFromCart(req, res);

      expect(res.status).toHaveBeenCalledWith(204);
    });

    it('returns 404 if item not found', async () => {
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
      const req = mockReq({ params: { id: 'nonexistent' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.removeFromCart(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('clearCart', () => {
    it('clears all cart items', async () => {
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 3 });
      const req = mockReq();
      const res = mockRes();

      await bookingController.clearCart(req, res);

      expect(res.status).toHaveBeenCalledWith(204);
      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'cart.cleared' }));
    });
  });

  describe('createBooking', () => {
    it('creates a booking from direct request', async () => {
      prisma.tour.findFirst.mockResolvedValue(activeTour);
      const req = mockReq({
        body: {
          tourId: 'tour-1',
          selectedDate: '2026-07-01',
          travelers: { adults: 2, children: 0, infants: 0 },
          paymentMethodId: 'pm_123',
        },
      });
      const res = mockRes();

      await bookingController.createBooking(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        status: 'success',
        data: expect.objectContaining({
          bookings: expect.arrayContaining([expect.objectContaining({ id: 'booking-1' })]),
          paymentIntent: expect.objectContaining({ id: 'pi_123' }),
        }),
      }));
      expect(enqueueNotification).toHaveBeenCalled();
      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.initiated' }));
    });

    it('creates bookings from cart items when useCart=true', async () => {
      prisma.cartItem.findMany.mockResolvedValue([mockCartItem]);
      const req = mockReq({
        body: {
          useCart: true,
          paymentMethodId: 'pm_123',
        },
      });
      const res = mockRes();

      await bookingController.createBooking(req, res);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(prisma.cartItem.findMany).toHaveBeenCalled();
      expect(mockTx.cartItem.deleteMany).toHaveBeenCalled();
    });

    it('returns 400 if cart is empty when useCart=true', async () => {
      prisma.cartItem.findMany.mockResolvedValue([]);
      const req = mockReq({ body: { useCart: true, paymentMethodId: 'pm_123' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.createBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 if traveler info is invalid', async () => {
      bookingHelpers.validateTravelerInfo.mockReturnValueOnce({ isValid: false, errors: ['Phone number is required'] });
      prisma.tour.findFirst.mockResolvedValue(activeTour);
      const req = mockReq({ body: { tourId: 'tour-1', selectedDate: '2026-07-01', travelers: {}, paymentMethodId: 'pm_123' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.createBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('returns 400 if tour is not available', async () => {
      prisma.tour.findFirst.mockResolvedValue(null);
      const req = mockReq({ body: { tourId: 'nonexistent', selectedDate: '2026-07-01', travelers: { adults: 1 }, paymentMethodId: 'pm_123' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.createBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 if supplier is not active', async () => {
      const inactiveTour = {
        ...activeTour,
        supplier: {
          ...activeTour.supplier,
          supplierProfile: { ...activeTour.supplier.supplierProfile, status: 'SUSPENDED' },
        },
      };
      prisma.tour.findFirst.mockResolvedValue(inactiveTour);
      const req = mockReq({ body: { tourId: 'tour-1', selectedDate: '2026-07-01', travelers: { adults: 1 }, paymentMethodId: 'pm_123' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.createBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('not active') }));
    });
  });

  describe('cancelBooking', () => {
    it('cancels a pending booking with full refund', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 3600000);
      const bookableBooking = {
        ...mockBooking,
        status: 'CONFIRMED',
        paymentStatus: 'SUCCEEDED',
        selectedDate: futureDate,
        tour: { ...mockBooking.tour, bookingAndTickets: { cancellationPolicy: { cancellationWindowHours: 24 } } },
      };
      prisma.booking.findFirst.mockResolvedValue(bookableBooking);
      const req = mockReq({ params: { id: 'booking-1' }, body: { reason: 'Change of plans' } });
      const res = mockRes();

      await bookingController.cancelBooking(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(enqueueEmail).toHaveBeenCalledWith(expect.objectContaining({ type: 'booking-cancellation', bookingId: 'booking-1' }));
      expect(enqueueNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'BOOKING_CANCELLED' }));
      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.cancelled' }));
    });

    it('returns 404 if booking not found or cannot be cancelled', async () => {
      prisma.booking.findFirst.mockResolvedValue(null);
      const req = mockReq({ params: { id: 'nonexistent' }, body: { reason: 'test' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.cancelBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('returns 400 if cancellation is within the window period', async () => {
      const soonDate = new Date(Date.now() + 3600000);
      const soonBooking = {
        ...mockBooking,
        selectedDate: soonDate,
        status: 'CONFIRMED',
        tour: { ...mockBooking.tour, bookingAndTickets: { cancellationPolicy: { cancellationWindowHours: 48 } } },
      };
      prisma.booking.findFirst.mockResolvedValue(soonBooking);
      const req = mockReq({ params: { id: 'booking-1' }, body: { reason: 'test' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.cancelBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('allows cancellation when no policy defined', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 3600000);
      const noPolicyBooking = {
        ...mockBooking,
        status: 'CONFIRMED',
        paymentStatus: 'PENDING',
        selectedDate: futureDate,
        tour: { ...mockBooking.tour, bookingAndTickets: {} },
      };
      prisma.booking.findFirst.mockResolvedValue(noPolicyBooking);
      const req = mockReq({ params: { id: 'booking-1' }, body: { reason: 'test' } });
      const res = mockRes();

      await bookingController.cancelBooking(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getMyBookings', () => {
    it('returns paginated bookings', async () => {
      prisma.booking.findMany.mockResolvedValue([mockBooking]);
      prisma.booking.count.mockResolvedValue(1);
      const req = mockReq({ query: { page: '1', limit: '10' } });
      const res = mockRes();

      await bookingController.getMyBookings(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          pagination: expect.objectContaining({ currentPage: 1, totalPages: 1, totalCount: 1 }),
        }),
      }));
    });

    it('filters by status', async () => {
      prisma.booking.findMany.mockResolvedValue([mockBooking]);
      prisma.booking.count.mockResolvedValue(1);
      const req = mockReq({ query: { status: 'CONFIRMED' } });
      const res = mockRes();

      await bookingController.getMyBookings(req, res);

      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'CONFIRMED' }) }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  describe('getBooking', () => {
    it('returns a single booking', async () => {
      prisma.booking.findFirst.mockResolvedValue(mockBooking);
      const req = mockReq({ params: { id: 'booking-1' } });
      const res = mockRes();

      await bookingController.getBooking(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ booking: mockBooking }),
      }));
    });

    it('returns 404 if booking not found', async () => {
      prisma.booking.findFirst.mockResolvedValue(null);
      const req = mockReq({ params: { id: 'nonexistent' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.getBooking(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('getBookingTicket', () => {
    it('returns printable ticket HTML', async () => {
      prisma.booking.findUnique.mockResolvedValue(mockBooking);
      const req = mockReq({ params: { id: 'booking-1' } });
      const res = mockRes();

      await bookingController.getBookingTicket(req, res);

      expect(res.type).toHaveBeenCalledWith('html');
      expect(res.send).toHaveBeenCalled();
    });

    it('returns 404 if booking not found', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);
      const req = mockReq({ params: { id: 'nonexistent' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.getBookingTicket(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });
  });

  describe('getSupplierBookings', () => {
    it('returns bookings for the supplier', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ userId: 'supplier-1', status: 'ACTIVE' });
      prisma.booking.findMany.mockResolvedValue([mockBooking]);
      prisma.booking.count.mockResolvedValue(1);
      const supplierReq = mockReq({ user: { id: 'supplier-1', roles: ['supplier'] }, query: { page: '1', limit: '10' } });
      const res = mockRes();

      await bookingController.getSupplierBookings(supplierReq, res);

      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('returns 403 if supplier not active', async () => {
      prisma.supplierProfile.findUnique.mockResolvedValue({ userId: 'supplier-1', status: 'PENDING' });
      const req = mockReq({ user: { id: 'supplier-1', roles: ['supplier'] } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.getSupplierBookings(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });
  });

  describe('updateBookingStatus', () => {
    it('updates booking status by supplier', async () => {
      const supplierBooking = { ...mockBooking, tour: { supplierId: 'supplier-1', title: 'Tour' }, customer: { id: 'c-1' } };
      prisma.booking.findFirst.mockResolvedValue(supplierBooking);
      prisma.booking.update.mockResolvedValue({ ...supplierBooking, status: 'CONFIRMED' });
      const req = mockReq({
        user: { id: 'supplier-1', roles: ['supplier'] },
        params: { id: 'booking-1' },
        body: { status: 'CONFIRMED', supplierNotes: 'All good' },
      });
      const res = mockRes();

      await bookingController.updateBookingStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(enqueueNotification).toHaveBeenCalled();
      expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ name: 'booking.status_confirmed' }));
    });

    it('returns 404 if booking not found for supplier', async () => {
      prisma.booking.findFirst.mockResolvedValue(null);
      const req = mockReq({ user: { id: 'supplier-1' }, params: { id: 'nonexistent' }, body: { status: 'CONFIRMED' } });
      const res = mockRes();
      const next = jest.fn();

      await bookingController.updateBookingStatus(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('skips notification for status without message', async () => {
      const supplierBooking = { ...mockBooking, tour: { supplierId: 'supplier-1', title: 'Tour' }, customer: { id: 'c-1' } };
      prisma.booking.findFirst.mockResolvedValue(supplierBooking);
      prisma.booking.update.mockResolvedValue({ ...supplierBooking, status: 'REFUNDED' });
      const req = mockReq({
        user: { id: 'supplier-1' },
        params: { id: 'booking-1' },
        body: { status: 'REFUNDED' },
      });
      const res = mockRes();

      await bookingController.updateBookingStatus(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(enqueueNotification).not.toHaveBeenCalled();
    });
  });

});
