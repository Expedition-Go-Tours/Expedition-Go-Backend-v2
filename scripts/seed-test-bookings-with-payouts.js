const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function generateBookingNumber() {
  const prefix = 'TB';
  const ts = Date.now().toString().slice(-8);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

async function main() {
  const customers = await prisma.user.findMany({ where: { roles: { has: 'customer' } }, take: 5 });
  const tours = await prisma.tour.findMany({ take: 3, include: { supplier: true } });

  if (customers.length === 0 || tours.length === 0) {
    console.log('Need at least one customer and one tour');
    return;
  }

  console.log(`Found ${customers.length} customers, ${tours.length} tours`);

  const existing = await prisma.payout.count();
  if (existing > 0) {
    const payouts = await prisma.payout.findMany({ select: { bookingId: true } });
    const bookingIds = [...new Set(payouts.map(p => p.bookingId))];
    await prisma.payout.deleteMany();
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    console.log(`Cleaned ${existing} payouts and ${bookingIds.length} bookings`);
  }

  const payoutStatuses = [
    'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING',
    'APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'APPROVED',
    'PAID', 'PAID', 'PAID', 'PAID', 'PAID',
  ];

  let created = 0;
  for (let i = 0; i < payoutStatuses.length; i++) {
    const customer = customers[i % customers.length];
    const tour = tours[i % tours.length];
    const bookingNum = generateBookingNumber();

    const existingBN = await prisma.booking.findUnique({ where: { bookingNumber: bookingNum } });
    const finalBN = existingBN ? `TB${Date.now()}${i}` : bookingNum;

    const basePrice = 80 + i * 15;
    const totalPrice = 95 + i * 15;

    const booking = await prisma.booking.create({
      data: {
        bookingNumber: finalBN,
        customerId: customer.id,
        tourId: tour.id,
        isSimulated: true,
        status: 'COMPLETED',
        paymentStatus: 'SUCCEEDED',
        travelers: [{ firstName: customer.name?.split(' ')[0] || 'Guest', lastName: customer.name?.split(' ').slice(1).join(' ') || '' }],
        travelDate: new Date(Date.now() - (i + 1) * 86400000 * 7),
        subtotal: basePrice,
        taxes: 10,
        fees: 5,
        discounts: 0,
        grossAmount: totalPrice,
        currency: 'USD',
        commissionRate: 0.15,
        platformCommission: Math.round(totalPrice * 0.15 * 100) / 100,
        supplierPayout: Math.round(totalPrice * 0.85 * 100) / 100,
        paidAt: new Date(Date.now() - (i + 1) * 86400000 * 7),
      },
    });

    const payoutStatus = payoutStatuses[i];
    await prisma.payout.create({
      data: {
        supplierId: tour.supplierId,
        bookingId: booking.id,
        amount: booking.supplierPayout,
        currency: 'USD',
        commissionAmount: booking.platformCommission,
        status: payoutStatus,
        ...(payoutStatus === 'PAID' ? { paidAt: new Date(Date.now() - (i + 1) * 86400000 * 7) } : {}),
        ...(payoutStatus === 'APPROVED' ? { approvedAt: new Date(Date.now() - (i + 1) * 86400000 * 7) } : {}),
      },
    });

    created++;
    console.log(`[${i + 1}/${payoutStatuses.length}] Booking ${finalBN} → Payout ${payoutStatus} (${booking.supplierPayout} USD)`);
  }

  const counts = await prisma.payout.groupBy({ by: ['status'], _count: true });
  console.log(`\nDone! Created ${created} bookings with payouts.`);
  for (const c of counts) {
    console.log(`  ${c.status}: ${c._count}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
