jest.mock('../../utils/prismaClient', () => ({
  specialOffer: { findMany: jest.fn() },
  booking: { count: jest.fn() },
}));

const prisma = require('../../utils/prismaClient');
const { findApplicableOffers, findBestDiscount } = require('../../utils/specialOfferEngine');

function makeOffer(overrides = {}) {
  return {
    id: 'offer-1',
    name: 'Test Offer',
    offerType: 'PROMO_CODE',
    discountType: 'PERCENTAGE',
    discountPercentage: 20,
    fixedDiscountValue: null,
    isActive: true,
    startDate: null,
    endDate: null,
    timeSlotMode: 'ANY',
    specificWeekdays: [],
    capacityType: 'UNCAPPED',
    maxSpots: null,
    spotsSold: 0,
    stackable: false,
    minQuantity: null,
    minSpendAmount: null,
    maxRedemptionsPerCustomer: null,
    promoCode: null,
    earlyBirdAdvanceDays: null,
    lastMinuteWindowHours: null,
    targets: [{ tourId: 'tour-1', tourOptionKey: null }],
    ...overrides,
  };
}

describe('specialOfferEngine', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('findApplicableOffers', () => {
    it('returns offers matching tourId', async () => {
      const offer = makeOffer();
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('offer-1');
    });

    it('filters out expired offers', async () => {
      const offer = makeOffer({ endDate: '2026-01-01' });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(0);
    });

    it('filters out future offers', async () => {
      const offer = makeOffer({ startDate: '2027-01-01' });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(0);
    });

    it('filters by specific weekdays', async () => {
      const offer = makeOffer({ timeSlotMode: 'SPECIFIC_WEEKDAYS', specificWeekdays: ['monday', 'tuesday'] });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      // 2026-07-01 is a Wednesday
      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(0);
    });

    it('includes offers when weekday matches', async () => {
      const offer = makeOffer({ timeSlotMode: 'SPECIFIC_WEEKDAYS', specificWeekdays: ['wednesday'] });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(1);
    });

    it('filters out capped offers with no spots left', async () => {
      const offer = makeOffer({ capacityType: 'CAPPED', maxSpots: 10, spotsSold: 10 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(0);
    });

    it('includes capped offers with spots remaining', async () => {
      const offer = makeOffer({ capacityType: 'CAPPED', maxSpots: 10, spotsSold: 5 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01' });
      expect(result).toHaveLength(1);
    });

    it('filters by promoCode when provided', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([]);
      await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01', promoCode: 'SAVE20' });
      expect(prisma.specialOffer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ promoCode: 'SAVE20' }) })
      );
    });

    it('filters by customer redemptions', async () => {
      const offer = makeOffer({ maxRedemptionsPerCustomer: 2 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);
      prisma.booking.count.mockResolvedValue(2);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01', customerId: 'cust-1' });
      expect(result).toHaveLength(0);
    });

    it('includes offers when customer has not exceeded redemptions', async () => {
      const offer = makeOffer({ maxRedemptionsPerCustomer: 2 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);
      prisma.booking.count.mockResolvedValue(1);

      const result = await findApplicableOffers({ tourId: 'tour-1', selectedDate: '2026-07-01', customerId: 'cust-1' });
      expect(result).toHaveLength(1);
    });
  });

  describe('findBestDiscount', () => {
    it('returns zero discount when no offers', async () => {
      prisma.specialOffer.findMany.mockResolvedValue([]);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(0);
      expect(result.finalPrice).toBe(100);
      expect(result.appliedOffer).toBeNull();
    });

    it('applies percentage discount', async () => {
      const offer = makeOffer({ discountType: 'PERCENTAGE', discountPercentage: 20 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(20);
      expect(result.finalPrice).toBe(80);
      expect(result.discountType).toBe('PERCENTAGE');
    });

    it('applies fixed discount', async () => {
      const offer = makeOffer({ discountType: 'FIXED', fixedDiscountValue: 15 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(15);
      expect(result.finalPrice).toBe(85);
    });

    it('caps fixed discount at basePrice', async () => {
      const offer = makeOffer({ discountType: 'FIXED', fixedDiscountValue: 200 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(100);
      expect(result.finalPrice).toBe(0);
    });

    it('selects best discount from multiple non-stackable offers', async () => {
      const offer1 = makeOffer({ id: 'o1', discountType: 'PERCENTAGE', discountPercentage: 10 });
      const offer2 = makeOffer({ id: 'o2', discountType: 'PERCENTAGE', discountPercentage: 30 });
      prisma.specialOffer.findMany.mockResolvedValue([offer1, offer2]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(30);
      expect(result.appliedOffer.id).toBe('o2');
    });

    it('stacks multiple stackable offers', async () => {
      const offer1 = makeOffer({ id: 'o1', discountType: 'PERCENTAGE', discountPercentage: 10, stackable: true });
      const offer2 = makeOffer({ id: 'o2', discountType: 'FIXED', fixedDiscountValue: 5, stackable: true });
      prisma.specialOffer.findMany.mockResolvedValue([offer1, offer2]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountType).toBe('STACKED');
      expect(result.discountAmount).toBe(15);
      expect(result.finalPrice).toBe(85);
    });

    it('filters EARLY_BIRD offers by advance days', async () => {
      const offer = makeOffer({ offerType: 'EARLY_BIRD', earlyBirdAdvanceDays: 30 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      // Date is tomorrow — less than 30 days ahead
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: tomorrow.toISOString(), basePrice: 100 });
      expect(result.discountAmount).toBe(0);
    });

    it('includes EARLY_BIRD offers when far enough in advance', async () => {
      const offer = makeOffer({ offerType: 'EARLY_BIRD', earlyBirdAdvanceDays: 7 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const future = new Date();
      future.setDate(future.getDate() + 14);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: future.toISOString(), basePrice: 100 });
      expect(result.discountAmount).toBe(20);
    });

    it('filters LAST_MINUTE offers by hour window', async () => {
      const offer = makeOffer({ offerType: 'LAST_MINUTE', lastMinuteWindowHours: 24 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      // Date is 48 hours from now — beyond 24h window
      const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: future.toISOString(), basePrice: 100 });
      expect(result.discountAmount).toBe(0);
    });

    it('includes LAST_MINUTE offers within hour window', async () => {
      const offer = makeOffer({ offerType: 'LAST_MINUTE', lastMinuteWindowHours: 72 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const soon = new Date(Date.now() + 12 * 60 * 60 * 1000);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: soon.toISOString(), basePrice: 100 });
      expect(result.discountAmount).toBe(20);
    });

    it('filters by minQuantity', async () => {
      const offer = makeOffer({ minQuantity: 3 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100, quantity: 2 });
      expect(result.discountAmount).toBe(0);
    });

    it('includes when minQuantity met', async () => {
      const offer = makeOffer({ minQuantity: 3 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100, quantity: 3 });
      expect(result.discountAmount).toBe(20);
    });

    it('filters by minSpendAmount', async () => {
      const offer = makeOffer({ minSpendAmount: 200 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: '2026-07-01', basePrice: 100 });
      expect(result.discountAmount).toBe(0);
    });

    it('returns zero when all offers filtered out by validity checks', async () => {
      const offer = makeOffer({ offerType: 'EARLY_BIRD', earlyBirdAdvanceDays: 30 });
      prisma.specialOffer.findMany.mockResolvedValue([offer]);

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const result = await findBestDiscount({ tourId: 'tour-1', selectedDate: tomorrow.toISOString(), basePrice: 100 });
      expect(result.discountAmount).toBe(0);
      expect(result.appliedOffer).toBeNull();
    });
  });
});
