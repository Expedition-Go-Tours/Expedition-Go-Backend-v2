const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: {
    db: { url: 'postgresql://neondb_owner:npg_n9JNuzCdwTW2@ep-patient-thunder-a6rit4fo.us-west-2.aws.neon.tech/neondb?sslmode=require' }
  }
});

function generateBookingNumber() {
  const prefix = 'TB';
  const ts = Date.now().toString().slice(-8);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const CUSTOMERS = [
  { name: 'Ama Serwaa', email: 'ama.serwaa.seed@gmail.com' },
  { name: 'Kwame Asante', email: 'kwame.asante.seed@gmail.com' },
  { name: 'Efua Mensah', email: 'efua.mensah.seed@gmail.com' },
  { name: 'Sarah Johnson', email: 'sarah.johnson.seed@gmail.com' },
  { name: 'Marcus Chen', email: 'marcus.chen.seed@gmail.com' },
  { name: 'Isabella Rossi', email: 'isabella.rossi.seed@gmail.com' },
  { name: 'David Kim', email: 'david.kim.seed@gmail.com' },
  { name: 'Emma Williams', email: 'emma.williams.seed@gmail.com' },
];

const REVIEW_TEMPLATES = {
  'Accra Culture Walk': [
    { rating: 5, title: 'An unforgettable cultural immersion', comment: 'The fantasy coffin workshop was unlike anything I have ever seen — the craftsmanship is incredible. Our guide explained the history behind each design with such passion. The art gallery stop was a perfect complement, and ending at the beach with the sunset was just magical. Highly recommend for anyone wanting to see a different side of Accra.', companions: ['Partner'] },
    { rating: 4, title: 'Fascinating but could use more time', comment: 'Really enjoyed learning about the Ga tradition of fantasy coffins. The gallery had some stunning pieces. Only giving 4 stars because I wished we had more time at each stop — felt a bit rushed at the beach. Still, a unique experience you won\'t find anywhere else.', companions: ['Friends'] },
    { rating: 5, title: 'Best tour in Accra, hands down', comment: 'This was the highlight of my trip to Ghana. The coffin makers are true artists, and hearing the stories behind each piece gave me chills. The art gallery had contemporary works that blew my mind. Our guide Kofi was funny, knowledgeable, and made sure everyone was comfortable. Don\'t skip this one.', companions: ['Solo'] },
  ],
  'Accra Food Tasting Tour': [
    { rating: 5, title: 'A feast for all the senses', comment: 'Oh my goodness, where do I even start? The kelewele was perfectly spiced, the banku with tilapia was divine, and the fresh coconut water at the market was the perfect finish. Our food guide knew every vendor by name and shared stories about each dish. I left completely full and completely in love with Ghanaian food.', companions: ['Partner'] },
    { rating: 4, title: 'Delicious food, great guide', comment: 'We tried so many dishes I never would have found on my own — hausa koko, koose, and the best jollof rice I\'ve ever tasted. The market section was chaotic but in the best way. Lost half a star because one of the stops had a long wait, but the food made up for it.', companions: ['Friends'] },
    { rating: 5, title: 'Foodie heaven in Accra', comment: 'As someone who travels specifically for food, this tour exceeded all expectations. The variety of flavors and textures was incredible. I loved that we got to try both street food and restaurant dishes. The guide also gave us tips on where to eat for the rest of our trip. Book this immediately.', companions: ['Solo'] },
    { rating: 5, title: 'Canadian foodie — best food tour I\'ve done worldwide', comment: 'I\'ve done food tours in Bangkok, Istanbul, Mexico City, and Oaxaca. This one ranks right at the top. The kelewele alone was worth the price of admission — perfectly spiced, crispy outside, soft inside. The guide took us to places I never would have found alone, and each stop told a story about Ghanaian culture. The jollof rice debate is real — Ghanaian jollof is incredible.', companions: ['Partner'] },
  ],
  'Accra Guided City Tour': [
    { rating: 5, title: 'The perfect introduction to Accra', comment: 'If you\'re visiting Accra for the first time, start here. We covered Independence Square, the National Museum, James Town, and the fishing harbor. Our guide brought history to life in a way that no guidebook could. I left feeling like I truly understood the soul of this city.', companions: ['Partner'] },
    { rating: 4, title: 'Informative and well-paced', comment: 'Great overview of Accra\'s history and culture. The National Museum was fascinating, and walking through James Town gave me a real sense of the city\'s roots. The guide was patient with all our questions. Only suggestion would be to add a lunch stop at a local chop bar.', companions: ['Family'] },
  ],
  'Accra Night Live Experience': [
    { rating: 5, title: 'Accra comes alive at night', comment: 'This tour showed me a completely different side of Accra. The live music venue was incredible — the energy of the band and the crowd was infectious. We danced for hours! Then the rooftop bar with the city lights below was the perfect way to end the night. If you want to experience Accra\'s nightlife safely and with a local guide, this is it.', companions: ['Friends'] },
    { rating: 4, title: 'Great night out', comment: 'Really fun evening exploring Accra\'s music scene. The live band was phenomenal, and I loved how the guide explained the different genres of Ghanaian music. The only reason for 4 stars is that it ended a bit late for me — but that\'s a personal preference, not a flaw in the tour.', companions: ['Partner'] },
  ],
  'Sankofa Art Gallery': [
    { rating: 5, title: 'Art, history, and creativity combined', comment: 'The candle-making workshop was the most unique experience of my trip. Making a candle while learning about Sankofa philosophy was such a beautiful way to connect with Ghanaian culture. The art gallery had stunning pieces, and I left with a handmade candle and a deep appreciation for the concept of Sankofa.', companions: ['Solo'] },
    { rating: 5, title: 'A must-do in Accra', comment: 'I came in not knowing what to expect and left completely inspired. The gallery owner\'s passion for preserving Ghanaian art was evident in every story he told. The candle-making was therapeutic and fun — my candle turned out beautifully. This is the kind of tour that stays with you long after you leave.', companions: ['Partner'] },
  ],
  'African Dance and Drumming': [
    { rating: 5, title: 'The rhythm will move your soul', comment: 'I have done drumming workshops before but nothing like this. The master drummers were incredibly skilled, and when they started teaching us the traditional dance moves, everyone was laughing and moving together. By the end, even the shy members of our group were on their feet. Pure joy.', companions: ['Family'] },
    { rating: 4, title: 'Incredible energy', comment: 'The drummers were phenomenal — you could feel the vibrations in your chest. The dance instruction was fun and the teacher was patient with us beginners. Would have loved a longer session but what we got was absolutely worth it.', companions: ['Friends'] },
  ],
  'Cape Coast Castle': [
    { rating: 5, title: 'A deeply moving experience', comment: 'This tour changed me. Standing in the slave dungeons at Cape Coast Castle, reading the names on the memorial wall, walking through the Door of No Return — it was emotional beyond words. Our guide handled the history with such respect and sensitivity. The Kakum canopy walk afterward felt like a celebration of survival and resilience. Everyone should do this at least once.', companions: ['Partner'] },
    { rating: 5, title: 'Powerful and essential', comment: 'The historical depth of this tour is unmatched. Cape Coast and Elmina castles are preserved beautifully, and the guides share the history with both accuracy and emotion. The canopy walk at Kakum was a breathtaking contrast. Long day but every minute is worth it.', companions: ['Solo'] },
    { rating: 4, title: 'Important history, long day', comment: 'The castle tours were incredibly powerful — I cried multiple times. The history is heavy but essential. Kakum canopy walk was a nice change of pace. Deducted one star only because the day is very long and the drive back to Accra was tiring. Consider staying overnight in Cape Coast if you can.', companions: ['Friends'] },
    { rating: 5, title: 'From London — this was the highlight of my Africa trip', comment: 'I\'ve traveled extensively but this was the most profound experience of my life. The dungeons, the history, the Door of No Return — I was not prepared for how emotional it would be. Our guide was exceptional, sensitive yet informative. The canopy walk at Kakum was the perfect counterbalance. If you visit Ghana, this is non-negotiable.', companions: ['Solo'] },
  ],
  'Waterfalls, Aburi Gardens': [
    { rating: 5, title: 'Nature at its finest', comment: 'The waterfall was stunning — we hiked through lush forest to reach it and the swim at the base was refreshing and exactly what I needed. Aburi Gardens were peaceful and beautiful, with plants I\'d never seen before. The cocoa farm stop was fascinating — I had no idea how chocolate was made from the bean. Perfect day trip from Accra.', companions: ['Partner'] },
    { rating: 4, title: 'Beautiful but bring good shoes', comment: 'The waterfall hike was gorgeous but moderately challenging — make sure you wear proper shoes. The gardens were serene and the cocoa farm was a great educational stop. Our guide was friendly and knowledgeable. A wonderful escape from the city.', companions: ['Family'] },
  ],
  'Nature Escape Adventure': [
    { rating: 5, title: 'Exactly what the name promises', comment: 'I needed to escape the city and this delivered completely. The adventure activities were thrilling — zip-lining through the canopy, the rope bridges, and the nature walk through pristine forest. The air was fresh, the views were spectacular, and I came back to Accra feeling completely recharged.', companions: ['Friends'] },
    { rating: 5, title: 'Thrilling and refreshing', comment: 'This was the adventure I was looking for in Ghana. The zip-line was incredible, the guides were professional and safety-conscious, and the scenery was breathtaking. A perfect combination of adrenaline and nature.', companions: ['Solo'] },
  ],
  'Cape Coast Day Tour': [
    { rating: 5, title: 'History and culture in one day', comment: 'The Assin Manso Slave River bath was a profoundly moving experience — bathing in the same river where enslaved people had their last bath before the castles gave me chills. Combined with Cape Coast Castle, this tour tells the full story of the journey. Our guide was exceptional.', companions: ['Partner'] },
    { rating: 4, title: 'Emotional and educational', comment: 'The slave river stop was incredibly powerful. Cape Coast Castle was heartbreaking but essential. The tour was well-organized and our guide was knowledgeable and sensitive. A full but meaningful day.', companions: ['Solo'] },
  ],
  'Despite Automobile Museum': [
    { rating: 5, title: 'A hidden gem of Ghana', comment: 'I had no idea this museum existed and it turned out to be one of the highlights of my trip. The collection of vintage and luxury cars is impressive, and the story behind the museum and its founder is inspiring. A unique attraction that shows a different side of Ghana.', companions: ['Family'] },
    { rating: 4, title: 'Unique and impressive', comment: 'The car collection is remarkable — everything from vintage classics to modern luxury vehicles. The museum is well-maintained and the guides explain the history of each car. A must-visit for car enthusiasts and anyone looking for something different.', companions: ['Friends'] },
  ],
  'Ghana Naming Ceremony': [
    { rating: 5, title: 'I finally have a Ghanaian name!', comment: 'This was the most personal and meaningful experience of my entire trip. Being welcomed into the community, learning the traditions, and receiving my Ghanaian name brought tears to my eyes. The ceremony was beautiful, the food was delicious, and I felt genuinely accepted. I will treasure this forever.', companions: ['Partner'] },
    { rating: 5, title: 'A once-in-a-lifetime experience', comment: 'Words cannot describe how special this was. The elders performed the ceremony with such warmth and dignity. Learning about the naming tradition and its significance in Ghanaian culture was fascinating. I now have a name that connects me to this beautiful country forever.', companions: ['Solo'] },
    { rating: 5, title: 'From New York — brought tears to my eyes', comment: 'As an African American visiting Ghana for the first time, this ceremony meant everything to me. The elders welcomed me into the community, explained the meaning behind each name, and I left with a Ghanaian name that connects me to my roots. I cried. My travel companion cried. Even the guide got emotional. This is not just a tour — it\'s a homecoming.', companions: ['Solo'] },
  ],
  'Ghanaian Cultural Heritage': [
    { rating: 5, title: 'A journey through Ghana\'s soul', comment: 'This tour weaves together so many threads of Ghanaian culture — from traditional crafts to music, food, and storytelling. Every stop felt authentic and meaningful. Our guide was a walking encyclopedia of Ghanaian culture and made every moment engaging. This is not just a tour, it\'s an experience.', companions: ['Friends'] },
    { rating: 4, title: 'Rich cultural experience', comment: 'A wonderful overview of Ghanaian culture and heritage. The craft demonstrations were impressive, the food stops were delicious, and the historical context provided was invaluable. Would recommend to anyone wanting to understand Ghana beyond the surface.', companions: ['Family'] },
  ],
  'Kumasi Cultural Heritage': [
    { rating: 5, title: 'The heart of Ashanti culture', comment: 'Kumasi is the cultural capital of Ghana and this tour proves it. The Ashanti Palace Museum was fascinating — the history of the Ashanti kingdom is incredible. The Kejetia Market was overwhelming in the best way, and watching the kente weavers at work was mesmerizing. An essential day trip.', companions: ['Solo'] },
    { rating: 5, title: 'Kumasi is a must-visit', comment: 'If you only do one day trip from Accra, make it Kumasi. The cultural depth here is unmatched. The palace museum, the craft villages, the market — every stop was a revelation. Our guide was Ashanti and shared personal stories that brought the history to life.', companions: ['Partner'] },
    { rating: 5, title: 'German traveler — cultural immersion at its best', comment: 'I\'ve visited many cultural sites across Asia and Europe, but Kumasi was something entirely different. The Ashanti kingdom\'s history is fascinating — the gold weights, the kente cloth, the stool room. The Kejetia Market is one of the largest in West Africa and it\'s an experience in itself. Our guide was Ashanti royalty and his personal stories made the history come alive. This is not a tourist trap — it\'s real culture.', companions: ['Solo'] },
  ],
  'Mole National Park': [
    { rating: 5, title: 'Safari in Ghana — yes, it\'s real', comment: 'I never imagined I\'d be watching elephants in Ghana, but here we are. The walking safari with armed rangers was thrilling — we got within 30 meters of a herd of elephants and it was one of the most magical moments of my life. The park is beautiful, the wildlife is abundant, and the guides are excellent.', companions: ['Partner'] },
    { rating: 5, title: 'Elephants in Ghana!', comment: 'This tour completely changed my perception of Ghana. Mole National Park is stunning — the landscape, the birds, and of course the elephants. Walking safari is more intimate than a jeep safari. The lodge overlooking the waterhole where animals come to drink at sunset was unforgettable.', companions: ['Friends'] },
    { rating: 5, title: 'American tourist — exceeded all expectations', comment: 'I\'ve done safaris in Kenya and Tanzania, but Mole was something completely different. Walking on foot among elephants? That\'s next level. The guides are armed and experienced, so you feel safe, but the proximity to wildlife is incredible. The park itself is gorgeous — baobab trees, savanna, and birds everywhere. This was the highlight of my two weeks in West Africa.', companions: ['Partner'] },
  ],
  'Shia Hills Safari': [
    { rating: 5, title: 'Adrenaline and scenery combined', comment: 'The quad-bike safari through the Shia Hills was the most fun I\'ve had in years. The terrain varies from flat savanna to rocky hills, and the views from the top are spectacular. We saw wildlife along the way and the guides kept us safe while letting us push our limits. Pure adventure.', companions: ['Friends'] },
    { rating: 4, title: 'Thrilling ride with great views', comment: 'The quad bikes were powerful and the terrain was challenging in the best way. The hilltop views were worth every bump. The guides were experienced and made sure everyone was comfortable with their bikes before we set off. A fantastic half-day adventure.', companions: ['Solo'] },
  ],
  'Waterfalls Massage Aburi': [
    { rating: 5, title: 'Spa day in nature', comment: 'The waterfall massage was the most unique spa experience of my life. Getting a massage with the sound of cascading water in the background was pure bliss. The Aburi Gardens were a beautiful bonus, and the cocoa farm activity was surprisingly relaxing. This is self-care at its finest.', companions: ['Partner'] },
    { rating: 5, title: 'Pure relaxation', comment: 'I came to Ghana stressed from work and this tour healed me. The waterfall massage was incredible — the natural setting, the skilled therapists, the sound of water. Combined with the peaceful gardens and the interesting cocoa farm, it was the perfect day of relaxation and discovery.', companions: ['Solo'] },
  ],
  'Kotoka Airport Lounge': [
    { rating: 4, title: 'Much better than the terminal', comment: 'The lounge access was a lifesaver for my early morning flight. Comfortable seating, decent food options, free Wi-Fi, and a quiet atmosphere compared to the terminal. The shower facilities were a nice bonus. Good value for a long layover.', companions: ['Solo'] },
  ],
  'Airport Pickup Dropoff': [
    { rating: 5, title: 'Seamless airport transfer', comment: 'Our driver was waiting at arrivals with a sign, helped with our luggage, and had cold water and towels ready. The car was clean and comfortable, and the driver knew exactly where to go. After a long flight, this stress-free start to our trip was exactly what we needed.', companions: ['Family'] },
    { rating: 4, title: 'Reliable and professional', comment: 'Driver was on time, car was clean, and the ride was smooth. Good communication via WhatsApp before arrival. The only reason for 4 stars is I wish there was an option for a larger vehicle — we had a lot of luggage. But the service itself was excellent.', companions: ['Partner'] },
  ],
  'Transport to Cape Coast': [
    { rating: 4, title: 'Comfortable and punctual', comment: 'The transport was comfortable, air-conditioned, and the driver was professional. We arrived in Cape Coast on time and the driver even pointed out landmarks along the way. Good option if you\'re arranging your own Cape Coast trip.', companions: ['Family'] },
  ],
};

const TOUR_PRICES = {
  'Accra Culture Walk': { min: 45, max: 80 },
  'Accra Food Tasting': { min: 55, max: 95 },
  'Accra Guided City': { min: 40, max: 75 },
  'Accra Night Live': { min: 60, max: 100 },
  'Sankofa Art Gallery': { min: 50, max: 85 },
  'African Dance and Drumming': { min: 35, max: 65 },
  'Cape Coast Castle': { min: 120, max: 200 },
  'Waterfalls, Aburi': { min: 80, max: 140 },
  'Nature Escape Adventure': { min: 90, max: 160 },
  'Kotoka Airport Lounge': { min: 25, max: 50 },
  'Airport Pickup': { min: 30, max: 60 },
  'Cape Coast Day Tour': { min: 100, max: 180 },
  'Despite Automobile Museum': { min: 20, max: 45 },
  'Ghana Naming Ceremony': { min: 70, max: 120 },
  'Ghanaian Cultural Heritage': { min: 85, max: 150 },
  'Kumasi Cultural Heritage': { min: 150, max: 250 },
  'Mole National Park': { min: 180, max: 300 },
  'Shia Hills Safari': { min: 95, max: 170 },
  'Waterfalls Massage Aburi': { min: 75, max: 130 },
  'Transport to Cape Coast': { min: 35, max: 65 },
};

function findTourPriceKey(tourTitle) {
  for (const key of Object.keys(TOUR_PRICES)) {
    if (tourTitle.includes(key.split(' ').slice(0, 2).join(' '))) return key;
  }
  return null;
}

function getTourPrice(tourTitle) {
  const key = findTourPriceKey(tourTitle);
  if (key) {
    const { min, max } = TOUR_PRICES[key];
    return randomInt(min, max);
  }
  return randomInt(50, 120);
}

function findReviewTemplates(tourTitle) {
  for (const [key, templates] of Object.entries(REVIEW_TEMPLATES)) {
    if (tourTitle.includes(key.split(' ').slice(0, 3).join(' '))) return templates;
  }
  return null;
}

function daysAgoDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(randomInt(8, 18), randomInt(0, 59), 0, 0);
  return d;
}

async function main() {
  console.log('=== Seeding Production Data for Homepage Sections ===\n');

  // 0) Clean up previous seed data
  console.log('0. Cleaning up previous seed data...');
  const seedEmails = CUSTOMERS.map(c => c.email);
  const seedUsers = await prisma.user.findMany({ where: { email: { in: seedEmails } }, select: { id: true } });
  const seedUserIds = seedUsers.map(u => u.id);
  if (seedUserIds.length > 0) {
    const seedBookings = await prisma.booking.findMany({ where: { customerId: { in: seedUserIds } }, select: { id: true } });
    const seedBookingIds = seedBookings.map(b => b.id);
    if (seedBookingIds.length > 0) {
      await prisma.review.deleteMany({ where: { bookingId: { in: seedBookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: seedBookingIds } } });
      console.log(`   Deleted ${seedBookingIds.length} previous bookings and their reviews`);
    }
    await prisma.user.deleteMany({ where: { email: { in: seedEmails } } });
    console.log(`   Deleted ${seedUserIds.length} previous seed users`);
  }

  // 1) Create new customer users
  console.log('1. Creating customer users...');
  const customers = [];
  for (const c of CUSTOMERS) {
    const user = await prisma.user.upsert({
      where: { email: c.email },
      update: {},
      create: {
        email: c.email,
        name: c.name,
        roles: ['customer'],
        authProvider: 'email',
      },
    });
    customers.push(user);
    console.log(`   + ${user.name} (${user.email})`);
  }

  // 2) Get all active tours
  const tours = await prisma.tour.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { title: 'asc' },
  });
  console.log(`\n2. Found ${tours.length} active tours`);

  // 3) Define booking distribution
  // Top 5 tours: 4-5 bookings (high velocity)
  // Next 5 tours: 2-3 bookings (medium)
  // Rest: 0-1 bookings
  const bookingDistribution = [
    { tourIndex: 0, bookings: 5 },   // Accra Culture Walk
    { tourIndex: 1, bookings: 5 },   // Accra Food Tasting
    { tourIndex: 6, bookings: 5 },   // Cape Coast Castle
    { tourIndex: 16, bookings: 4 },  // Mole National Park
    { tourIndex: 15, bookings: 4 },  // Kumasi Cultural Heritage
    { tourIndex: 3, bookings: 3 },   // Accra Night Live
    { tourIndex: 7, bookings: 3 },   // Waterfalls, Aburi
    { tourIndex: 13, bookings: 3 },  // Ghana Naming Ceremony
    { tourIndex: 14, bookings: 3 },  // Ghanaian Cultural Heritage
    { tourIndex: 17, bookings: 3 },  // Shia Hills Safari
    { tourIndex: 2, bookings: 2 },   // Accra Guided City
    { tourIndex: 4, bookings: 2 },   // Sankofa Art Gallery
    { tourIndex: 8, bookings: 2 },   // Nature Escape
    { tourIndex: 19, bookings: 2 },  // Waterfalls Massage
    { tourIndex: 11, bookings: 1 },  // Cape Coast Day Tour
    { tourIndex: 12, bookings: 1 },  // Despite Museum
    { tourIndex: 18, bookings: 1 },  // Transport to Cape Coast
    { tourIndex: 9, bookings: 1 },   // Kotoka Airport
    { tourIndex: 10, bookings: 1 },  // Airport Pickup
  ];

  // 4) Create bookings and reviews
  console.log('\n3. Creating bookings and reviews...');
  let totalBookings = 0;
  let totalReviews = 0;

  for (const dist of bookingDistribution) {
    const tour = tours[dist.tourIndex];
    if (!tour) continue;

    const reviewTemplates = findReviewTemplates(tour.title);
    const reviewCount = reviewTemplates
      ? Math.min(dist.bookings, reviewTemplates.length)
      : Math.min(dist.bookings, 2);

    for (let i = 0; i < dist.bookings; i++) {
      const customer = pickRandom(customers);
      const price = getTourPrice(tour.title);
      const daysAgo = randomInt(1, 14);
      const isCompleted = daysAgo > 3;
      const status = isCompleted ? 'COMPLETED' : 'CONFIRMED';
      const paymentStatus = 'SUCCEEDED';
      const travelDate = daysAgoDate(daysAgo);

      const commissionRate = 0.15;
      const platformCommission = Math.round(price * commissionRate * 100) / 100;
      const supplierPayout = Math.round((price - platformCommission) * 100) / 100;

      const booking = await prisma.booking.create({
        data: {
          bookingNumber: generateBookingNumber(),
          customerId: customer.id,
          tourId: tour.id,
          source: 'EXPEDITION',
          isSimulated: true,
          status,
          paymentStatus,
          travelers: [{ firstName: customer.name.split(' ')[0], lastName: customer.name.split(' ').slice(1).join(' ') }],
          travelDate,
          selectedTime: pickRandom(['08:00', '09:00', '10:00', '14:00']),
          subtotal: price,
          taxes: Math.round(price * 0.1 * 100) / 100,
          fees: Math.round(price * 0.03 * 100) / 100,
          discounts: 0,
          grossAmount: Math.round((price + price * 0.1 + price * 0.03) * 100) / 100,
          currency: 'USD',
          commissionRate,
          platformCommission,
          supplierPayout,
          paidAt: isCompleted ? travelDate : null,
        },
      });
      totalBookings++;

      // Create review for some bookings (skip some for realism)
      if (i < reviewCount && isCompleted && reviewTemplates) {
        const template = reviewTemplates[i % reviewTemplates.length];
        const reviewDate = daysAgoDate(daysAgo + randomInt(1, 3));

        await prisma.review.create({
          data: {
            bookingId: booking.id,
            customerId: customer.id,
            tourId: tour.id,
            rating: template.rating,
            title: template.title,
            comment: template.comment,
            valueForMoneyRating: Math.max(1, template.rating + randomInt(-1, 0)),
            guideRating: Math.max(1, template.rating + randomInt(-1, 0)),
            meetingRating: Math.max(1, template.rating + randomInt(-1, 0)),
            travelMonth: new Date(Date.now() - daysAgo * 86400000).toLocaleString('en-US', { month: 'long' }),
            companions: [pickRandom(template.companions)],
            status: 'APPROVED',
            verified: true,
            helpfulCount: randomInt(0, 12),
            reportCount: 0,
            createdAt: reviewDate,
          },
        });
        totalReviews++;
      }
    }
    console.log(`   ${tour.title}: ${dist.bookings} bookings, ${Math.min(reviewCount, dist.bookings)} reviews`);
  }

  // 5) Update tour aggregates
  console.log('\n4. Updating tour aggregates...');
  for (const tour of tours) {
    const bookingCount = await prisma.booking.count({
      where: { tourId: tour.id, status: { in: ['CONFIRMED', 'COMPLETED'] } },
    });

    const agg = await prisma.review.aggregate({
      where: { tourId: tour.id, status: 'APPROVED' },
      _count: { id: true },
      _avg: { rating: true },
    });

    await prisma.tour.update({
      where: { id: tour.id },
      data: {
        totalBookings: bookingCount,
        reviewCount: agg._count.id,
        averageRating: agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : null,
      },
    });

    if (bookingCount > 0 || agg._count.id > 0) {
      console.log(`   ${tour.title}: ${bookingCount} bookings, ${agg._count.id} reviews, avg ${agg._avg.rating ? Number(agg._avg.rating.toFixed(2)) : 'null'}`);
    }
  }

  console.log(`\n=== Done! ===`);
  console.log(`Created ${customers.length} new customers`);
  console.log(`Created ${totalBookings} bookings`);
  console.log(`Created ${totalReviews} reviews`);
  console.log(`\nSections that should now populate:`);
  console.log(`  - Likely to Sell Out (needs bookings in last 14 days)`);
  console.log(`  - Top Rated (needs reviews with avgRating)`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
