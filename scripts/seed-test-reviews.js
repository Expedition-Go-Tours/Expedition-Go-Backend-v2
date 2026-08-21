const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function generateBookingNumber() {
  const prefix = 'TB';
  const ts = Date.now().toString().slice(-8);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

async function main() {
  // Check that we have customers and tours
  const customers = await prisma.user.findMany({ where: { roles: { has: 'customer' } }, take: 5 });
  const tours = await prisma.tour.findMany({ take: 3, include: { supplier: true } });

  if (customers.length === 0) {
    console.log('No customer users found. Create a customer first.');
    return;
  }
  if (tours.length === 0) {
    console.log('No tours found. Create a tour first.');
    return;
  }

  console.log(`Found ${customers.length} customers, ${tours.length} tours`);

  // Delete existing reviews to start clean
  const existing = await prisma.review.count();
  if (existing > 0) {
    console.log(`Deleting ${existing} existing reviews + their bookings...`);
    const reviews = await prisma.review.findMany({ select: { bookingId: true } });
    const bookingIds = reviews.map(r => r.bookingId);
    await prisma.review.deleteMany();
    await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
  }

  const reviewData = [
    { rating: 5, title: 'Amazing experience!', comment: 'This was an absolutely fantastic tour! Our guide was knowledgeable and friendly. Highly recommend to anyone visiting the area.', status: 'APPROVED', verified: true },
    { rating: 4, title: 'Great tour, minor issues', comment: 'Overall a wonderful experience. The only downside was the meeting point was a bit hard to find. Otherwise perfect.', status: 'APPROVED', verified: true, supplierResponse: 'Thank you for your feedback! We have added clearer signage at the meeting point.', supplierResponseAt: new Date() },
    { rating: 3, title: 'Decent but overpriced', comment: 'The tour was okay but I expected more for the price. Guide was nice but the route felt rushed towards the end.', status: 'PENDING', verified: true },
    { rating: 2, title: 'Not what I expected', comment: 'The description promised a lot more than what was delivered. Several key stops were skipped due to time constraints.', status: 'FLAGGED', verified: true, flagReason: 'Customer seems unhappy, investigate further' },
    { rating: 1, title: 'Very disappointed', comment: 'Tour was cancelled last minute and rebooking was a nightmare. Would not recommend this to anyone.', status: 'PENDING', verified: true },
    { rating: 5, title: 'Highlights of the region!', comment: 'Saw everything I wanted and more. The local lunch spot they took us to was absolutely incredible.', status: 'APPROVED', verified: true },
    { rating: 4, title: 'Solid experience', comment: 'Good value for money. Well organized and the guide spoke excellent English. Would book again for sure.', status: 'APPROVED', verified: true },
    { rating: 3, title: 'Average at best', comment: 'It was fine but nothing special. The transport was comfortable but the guide seemed distracted at times.', status: 'PENDING', verified: true },
    { rating: 5, title: 'Perfect day out!', comment: 'From start to finish everything was seamless. Booking was easy and the tour itself was absolutely magical.', status: 'APPROVED', verified: true, supplierResponse: 'We are thrilled you had such a great time! Hope to see you again soon.', supplierResponseAt: new Date() },
    { rating: 1, title: 'Waste of money', comment: 'Showed up and the tour was overbooked. Had to wait an extra 2 hours for another group to finish first.', status: 'REJECTED', verified: true },
    { rating: 4, title: 'Really enjoyed it', comment: 'The guide was passionate and knowledgeable. Learned so much about the local culture and history.', status: 'APPROVED', verified: true },
    { rating: 5, title: 'Exceeded expectations', comment: 'Booked this as a surprise for my partner and it was incredible. Every detail was well thought out.', status: 'APPROVED', verified: true },
    { rating: 2, title: 'Mediocre guide', comment: 'The guide was hard to understand and seemed unprepared. The locations were nice but commentary was lacking.', status: 'FLAGGED', verified: true, flagReason: 'Multiple complaints about this guide' },
    { rating: 4, title: 'Great family activity', comment: 'Took the kids and they loved it. Educational and entertaining. The guide was great with children.', status: 'APPROVED', verified: true },
    { rating: 5, title: 'Life-changing experience', comment: 'This tour completely changed my perspective. The guide shared incredible stories and the views were breathtaking.', status: 'PENDING', verified: true },
  ];

  let created = 0;
  for (let i = 0; i < reviewData.length; i++) {
    const d = reviewData[i];
    const customer = customers[i % customers.length];
    const tour = tours[i % tours.length];
    const bookingNum = generateBookingNumber();

    // Ensure unique booking number
    const existingBN = await prisma.booking.findUnique({ where: { bookingNumber: bookingNum } });
    const finalBN = existingBN ? `TB${Date.now()}${i}` : bookingNum;

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
        subtotal: 80 + i * 15,
        taxes: 10,
        fees: 5,
        discounts: 0,
        grossAmount: 95 + i * 15,
        currency: 'USD',
        commissionRate: 0.15,
        platformCommission: (95 + i * 15) * 0.15,
        supplierPayout: (95 + i * 15) * 0.85,
        paidAt: new Date(Date.now() - (i + 1) * 86400000 * 7),
      },
    });

    await prisma.review.create({
      data: {
        bookingId: booking.id,
        customerId: customer.id,
        tourId: tour.id,
        rating: d.rating,
        title: d.title,
        comment: d.comment,
        status: d.status,
        flagReason: d.flagReason,
        verified: d.verified,
        supplierResponse: d.supplierResponse,
        supplierResponseAt: d.supplierResponseAt,
      },
    });

    created++;
    console.log(`[${i + 1}/${reviewData.length}] ${d.status}: "${d.title}" (${d.rating}★) - ${customer.name} on "${tour.title}"`);
  }

  console.log(`\nDone! Created ${created} test reviews.`);
  const counts = await prisma.review.groupBy({ by: ['status'], _count: true });
  for (const c of counts) {
    console.log(`  ${c.status}: ${c._count}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
