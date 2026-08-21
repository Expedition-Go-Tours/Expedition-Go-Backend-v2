const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedPickupBookings() {
  console.log('Seeding 3 pickup planner bookings...\n');

  // Find the supplier's ID (rxsieon@gmail.com / Gideon Wilson)
  const supplier = await prisma.user.findUnique({
    where: { email: 'rxsieon@gmail.com' },
    select: { id: true, name: true }
  });
  if (!supplier) { console.error('Supplier not found'); return; }
  console.log(`Supplier: ${supplier.name} (${supplier.id})`);

  // Find an active tour owned by this supplier
  const tour = await prisma.tour.findFirst({
    where: { supplierId: supplier.id, status: 'ACTIVE' },
    select: { id: true, title: true }
  });
  if (!tour) { console.error('No active tour found'); return; }
  console.log(`Tour: ${tour.title} (${tour.id})`);

  // Find a customer to use
  const customer = await prisma.user.findFirst({
    where: { roles: { has: 'customer' } },
    select: { id: true, name: true, email: true }
  });
  if (!customer) { console.error('No customer found'); return; }
  console.log(`Customer: ${customer.name} (${customer.id})\n`);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const bookings = [
    {
      customerId: customer.id,
      tourId: tour.id,
      source: 'TRAVIO',
      status: 'CONFIRMED',
      travelers: {
        adults: 1,
        children: 0,
        infants: 0,
        phoneNumber: '+233 24 000 0001',
        location: 'Accra Mall, Spintex Road, Ghana',
        details: [{ name: customer.name, age: 30, ageGroup: 'adult' }],
      },
      travelDate: new Date(today.getTime() + 1 * 24 * 60 * 60 * 1000),
      selectedTime: '09:00',
      subtotal: 150.00,
      taxes: 15.00,
      fees: 10.00,
      discounts: 0,
      grossAmount: 175.00,
      currency: 'USD',
      commissionRate: 0.15,
      platformCommission: 26.25,
      supplierPayout: 148.75,
      paymentStatus: 'SUCCEEDED',
      paymentTiming: 'now',
      paidAt: new Date(),
      pickup: {
        mode: 'area',
        areaName: 'Kumasi City Centre',
        place: 'Kejetia Market, Kumasi',
        time: '09:00 AM',
        instructions: 'Look for the green umbrella near the main entrance',
        address: { name: 'Kejetia Market', address: 'Kejetia, Kumasi, Ghana' },
        lat: 6.6949,
        lng: -1.6244
      }
    },
    {
      customerId: customer.id,
      tourId: tour.id,
      source: 'TRAVIO',
      status: 'CONFIRMED',
      travelers: {
        adults: 2,
        children: 0,
        infants: 0,
        phoneNumber: '+233 24 000 0002',
        location: 'Airport Residential Area, Accra',
        details: [
          { name: 'Alice Johnson', age: 28, ageGroup: 'adult' },
          { name: 'Bob Johnson', age: 32, ageGroup: 'adult' },
        ],
      },
      travelDate: new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000),
      selectedTime: '08:30',
      subtotal: 300.00,
      taxes: 30.00,
      fees: 20.00,
      discounts: 0,
      grossAmount: 350.00,
      currency: 'USD',
      commissionRate: 0.15,
      platformCommission: 52.50,
      supplierPayout: 297.50,
      paymentStatus: 'SUCCEEDED',
      paymentTiming: 'now',
      paidAt: new Date(),
      pickup: {
        mode: 'hotel',
        place: 'Golden Tulip Kumasi City',
        locationName: 'Golden Tulip Kumasi',
        time: '08:30 AM',
        instructions: 'Reception lobby, 10 minutes before departure',
        address: { name: 'Golden Tulip Kumasi', address: 'Ahodwo, Kumasi, Ghana' },
        lat: 6.6885,
        lng: -1.6236
      }
    },
    {
      customerId: customer.id,
      tourId: tour.id,
      source: 'TRAVIO',
      status: 'CONFIRMED',
      travelers: {
        adults: 1,
        children: 0,
        infants: 0,
        phoneNumber: '+233 24 000 0003',
        location: 'Manhyia, Kumasi',
        details: [{ name: 'Samuel Mensah', age: 45, ageGroup: 'adult' }],
      },
      travelDate: new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000),
      selectedTime: '10:00',
      subtotal: 120.00,
      taxes: 12.00,
      fees: 8.00,
      discounts: 10.00,
      grossAmount: 130.00,
      currency: 'USD',
      commissionRate: 0.15,
      platformCommission: 19.50,
      supplierPayout: 110.50,
      paymentStatus: 'SUCCEEDED',
      paymentTiming: 'now',
      paidAt: new Date(),
      pickup: {
        mode: 'landmark',
        place: 'Manhyia Palace Museum',
        locationName: 'Manhyia Palace',
        time: '10:00 AM',
        instructions: 'Meet at the parking lot, guide will have a sign',
        address: { name: 'Manhyia Palace', address: 'Manhyia, Kumasi, Ghana' },
        lat: 6.6921,
        lng: -1.6198
      }
    }
  ];

  // Remove previous runs so re-running the script is idempotent
  const cleared = await prisma.booking.deleteMany({
    where: { bookingNumber: { startsWith: 'PICKUP-SEED-' } }
  });
  if (cleared.count > 0) console.log(`Cleared ${cleared.count} previous pickup seed bookings\n`);

  for (let i = 0; i < bookings.length; i++) {
    const booking = bookings[i];
    const bookingNumber = `PICKUP-SEED-${String(i + 1).padStart(3, '0')}`;
    const created = await prisma.booking.create({
      data: { ...booking, bookingNumber },
      include: { tour: { select: { title: true } } }
    });
    const pickup = typeof created.pickup === 'string' ? JSON.parse(created.pickup) : created.pickup;
    console.log(`✅ Booking ${created.bookingNumber} created`);
    console.log(`   Tour: ${created.tour.title}`);
    console.log(`   Date: ${created.travelDate.toISOString().split('T')[0]} at ${created.selectedTime}`);
    console.log(`   Pickup: ${pickup.place} (${pickup.time})`);
    console.log(`   Total: $${created.grossAmount}\n`);
  }

  console.log('Done! 3 pickup planner bookings seeded.');
}

seedPickupBookings()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
