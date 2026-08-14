const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function generateBookingNumber() {
  const prefix = 'TB';
  const ts = Date.now().toString().slice(-8);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

async function main() {
  // Use a real customer from the DB (prefer one with a photo so the profile panel looks good)
  const reviewer = await prisma.user.findFirst({
    where: { roles: { has: 'customer' }, photoURL: { not: '' } },
    orderBy: { createdAt: 'asc' },
  }) || await prisma.user.findFirst({
    where: { roles: { has: 'customer' } },
    orderBy: { createdAt: 'asc' },
  });
  if (!reviewer) {
    console.log('No customer users found. Create a customer first.');
    return;
  }

  const kakum = await prisma.tour.findFirst({ where: { title: { contains: 'Kakum' } } });
  const ashanti = await prisma.tour.findFirst({ where: { title: { contains: 'Ashanti' } } });
  if (!kakum || !ashanti) {
    console.log('Could not find the Kakum and Ashanti tours.');
    return;
  }

  console.log(`Customer: ${reviewer.name} (${reviewer.email})`);

  // Clean up anything previously created by this script for this customer on these tours
  const existingBookings = await prisma.booking.findMany({
    where: { customerId: reviewer.id, tourId: { in: [kakum.id, ashanti.id] } },
    select: { id: true },
  });
  if (existingBookings.length > 0) {
    const ids = existingBookings.map((b) => b.id);
    await prisma.review.deleteMany({ where: { bookingId: { in: ids } } });
    await prisma.booking.deleteMany({ where: { id: { in: ids } } });
    console.log(`Cleaned ${ids.length} previous demo booking(s)`);
  }

  const makeBooking = async ({ tour, daysAgo, status }) => {
    const bookingNum = generateBookingNumber();
    const selectedDate = new Date(Date.now() - daysAgo * 86400000);
    return prisma.booking.create({
      data: {
        bookingNumber: bookingNum,
        customerId: reviewer.id,
        tourId: tour.id,
        source: 'TRAVIO',
        status,
        paymentStatus: status === 'CONFIRMED' || status === 'COMPLETED' ? 'SUCCEEDED' : 'PENDING',
        travelers: [{ firstName: reviewer.name.split(' ')[0] || 'Guest', lastName: reviewer.name.split(' ').slice(1).join(' ') || '' }],
        selectedDate,
        selectedTime: '09:00',
        subtotal: 120,
        taxes: 12,
        fees: 3,
        discounts: 0,
        total: 135,
        currency: 'USD',
        commissionRate: 0.15,
        commissionAmount: 20.25,
        supplierPayout: 114.75,
        paidAt: status === 'CONFIRMED' || status === 'COMPLETED' ? selectedDate : null,
      },
    });
  };

  // 1) Kakum tour — PENDING review with photos (shows moderation actions + photo strip)
  const kakumBooking = await makeBooking({ tour: kakum, daysAgo: 34, status: 'COMPLETED' });
  await prisma.review.create({
    data: {
      bookingId: kakumBooking.id,
      customerId: reviewer.id,
      tourId: kakum.id,
      rating: 5,
      title: 'Breathtaking canopy walk!',
      comment:
        "Walking above the rainforest canopy was absolutely unreal. The suspension bridges sway just enough to get your heart racing, and the views from the top are incredible. The Kakum section of the tour was the highlight, and the guide made sure everyone felt safe the whole way across.",
      photos: [kakum.photos[0], kakum.photos[1]],
      valueForMoneyRating: 5,
      guideRating: 5,
      meetingRating: 4,
      travelMonth: new Date().toLocaleString('en-US', { month: 'long' }),
      companions: ['Partner'],
      status: 'PENDING',
      verified: true,
      helpfulCount: 3,
      reportCount: 0,
      createdAt: new Date(Date.now() - 1 * 86400000),
    },
  });
  console.log(`  Created PENDING review (5★) on "${kakum.title}"`);

  // 2) Kakum tour — APPROVED review with supplier response (shows response block + approved chip)
  const kakumBooking2 = await makeBooking({ tour: kakum, daysAgo: 61, status: 'COMPLETED' });
  await prisma.review.create({
    data: {
      bookingId: kakumBooking2.id,
      customerId: reviewer.id,
      tourId: kakum.id,
      rating: 4,
      title: 'Great history, long but worth it',
      comment:
        "The Cape Coast Castle part was moving and incredibly well explained — you really feel the weight of the history there. The canopy walk is a fun add-on too. Only reason for 4 stars is the day is quite long and the drive back to Accra was tiring. Would still recommend it.",
      photos: [kakum.photos[2]],
      valueForMoneyRating: 4,
      guideRating: 5,
      meetingRating: 4,
      travelMonth: 'May',
      companions: ['Friends'],
      status: 'APPROVED',
      verified: true,
      supplierResponse:
        'Thank you so much for the thoughtful review! We are glad the castle tour resonated with you. We are also looking at adding a lunch stop to break up the return drive.',
      supplierResponseAt: new Date(Date.now() - 0.5 * 86400000),
      helpfulCount: 7,
      reportCount: 0,
      createdAt: new Date(Date.now() - 4 * 86400000),
      moderatedBy: 'cmr9daell000vfvikhj3z9owi',
      moderatedAt: new Date(Date.now() - 3 * 86400000),
    },
  });
  console.log(`  Created APPROVED review (4★ + response) on "${kakum.title}"`);

  // 3) Ashanti tour — FLAGGED review (shows flag chip in the queue)
  const ashantiBooking = await makeBooking({ tour: ashanti, daysAgo: 20, status: 'COMPLETED' });
  await prisma.review.create({
    data: {
      bookingId: ashantiBooking.id,
      customerId: reviewer.id,
      tourId: ashanti.id,
      rating: 2,
      title: 'Disappointed with the timing',
      comment:
        'The kente weaving village was fascinating, but our pickup was over an hour late and that pushed everything back. We felt rushed at the palace and missed part of the craft demonstrations we were told we would see.',
      photos: [ashanti.photos[1]],
      valueForMoneyRating: 2,
      guideRating: 3,
      meetingRating: 2,
      travelMonth: 'June',
      companions: ['Solo'],
      status: 'FLAGGED',
      verified: true,
      flagReason: 'Customer unhappy about timing — verify with supplier before approving.',
      helpfulCount: 1,
      reportCount: 2,
      createdAt: new Date(Date.now() - 2 * 86400000),
    },
  });
  console.log(`  Created FLAGGED review (2★) on "${ashanti.title}"`);

  // 4-6) Extra bookings with no review so the customer profile "Bookings" tab has variety
  const extra = [
    { tour: ashanti, daysAgo: 9, status: 'CONFIRMED' },
    { tour: kakum, daysAgo: 45, status: 'COMPLETED' },
    { tour: ashanti, daysAgo: 2, status: 'CONFIRMED' },
  ];
  for (const e of extra) {
    const b = await makeBooking(e);
    console.log(`  Created ${e.status} booking on "${e.tour.title}"`);
  }

  // Refresh tour aggregates from actual review data
  for (const tour of [kakum, ashanti]) {
    const agg = await prisma.review.aggregate({
      where: { tourId: tour.id, status: { in: ['APPROVED', 'PENDING', 'FLAGGED'] } },
      _count: { id: true },
      _avg: { rating: true },
    });
    await prisma.tour.update({
      where: { id: tour.id },
      data: {
        reviewCount: agg._count.id,
        averageRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null,
      },
    });
  }

  console.log('\nDone! Open the Review Moderation page in the admin dashboard to see the queue.');
  console.log(`Click the customer avatar on any review to open the profile panel (bookings + reviews).`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
