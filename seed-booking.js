const https = require('https');

// Test the expedition bookings endpoint
const data = JSON.stringify({});

// First, we need to get a JWT token for the user. Let's check the auth flow.
// Actually, let's just test via direct DB query to confirm the booking shows up
const p = require('./utils/prismaClient');

(async () => {
  // The expedition getMyBookings query:
  const customerId = 'cmqqjzdkw0005ivj4xakt9a6n';
  const where = { customerId, source: 'EXPEDITION' };

  const bookings = await p.booking.findMany({
    where,
    include: {
      tour: {
        select: {
          id: true,
          title: true,
          slug: true,
          coverPhoto: true,
          photos: true,
          category: true,
          durationMinutes: true,
          city: true,
          country: true,
          supplier: { select: { id: true, name: true, photoURL: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`Found ${bookings.length} bookings for customerId=${customerId} with source=EXPEDITION`);
  bookings.forEach(b => {
    console.log(`  ${b.bookingNumber} | ${b.status} | ${b.paymentStatus} | tour: ${b.tour?.title}`);
  });

  // Also check if user has a different ID they might be logged in as
  const user = await p.user.findUnique({
    where: { email: 'guyritchie94@gmail.com' },
    select: { id: true, name: true, email: true, firebaseUid: true },
  });
  console.log('\nUser:', JSON.stringify(user));

  await p.$disconnect();
})();
