const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://postgres:postgres@localhost:5433/travio' } }
});

const SUPPLIER_ID = 'cmr9daelz000wfvikmj21c7vs';

const productContent = {
  writingLanguage: 'en',
  shortSummary: 'A full-day journey through the Ashanti Region exploring royal palaces, Kente weaving villages, Adinkra stamping workshops, and Kumasi\'s legendary Kejetia Market.',
  highlights: [
    'Tour the historic Manhyia Palace Museum with an expert local guide',
    'Watch master weavers create authentic Kente cloth at Adanwomase Village',
    'Try your hand at traditional Adinkra stamping at Ntonso Village',
    'Explore the sprawling Kejetia Market — West Africa\'s largest open-air market',
    'Enjoy an authentic Ashanti lunch at a top-rated local restaurant',
  ],
  locations: [
    { name: 'Manhyia Palace Museum', city: 'Kumasi', country: 'Ghana', lat: 6.6920, lng: -1.6230, region: 'Ashanti' },
    { name: 'Adanwomase Kente Village', city: 'Kumasi', country: 'Ghana', lat: 6.7100, lng: -1.6500, region: 'Ashanti' },
    { name: 'Ntonso Adinkra Village', city: 'Kumasi', country: 'Ghana', lat: 6.7200, lng: -1.5800, region: 'Ashanti' },
    { name: 'Kejetia Market', city: 'Kumasi', country: 'Ghana', lat: 6.6940, lng: -1.6250, region: 'Ashanti' },
  ],
  attractions: [
    'Manhyia Palace Museum',
    'Adanwomase Kente Weaving Village',
    'Ntonso Adinkra Stamping Village',
    'Kejetia Market',
    'Prempeh II Jubilee Museum',
    'Okomfo Anokye Sword Site',
    'Kumasi Fort and Military Museum',
  ],
  activitiesIncluded: [
    'Palace museum guided tour',
    'Kente weaving demonstration',
    'Adinkra stamping workshop',
    'Market exploration',
    'Cultural dance performance',
    'Local lunch experience',
  ],
  pickupTransportTypes: ['Hotel pickup', '4x4 Vehicle'],
  included: [
    'Professional English-speaking cultural guide',
    'Hotel pickup and drop-off in Kumasi',
    'Air-conditioned 4x4 vehicle for all transfers',
    'Manhyia Palace Museum entrance fee',
    'Adanwomase Kente Village entrance fee',
    'Ntonso Adinkra Village entrance fee',
    'Authentic Ashanti lunch at local restaurant',
    'Bottled water throughout the tour',
    'Adinkra stamping workshop materials',
    'All taxes and service charges',
  ],
  excluded: [
    'Gratuities for guide and driver',
    'Personal shopping at Kejetia Market',
    'Travel insurance',
    'Hotel accommodation',
    'Additional snacks and beverages',
    'Camera fees at certain locations',
  ],
  guideType: 'professional',
  guideMaterials: { audioGuide: false, infoBooklet: true },
  foodProvided: true,
  meals: ['Lunch'],
  mealType: 'sit-down',
  showDietaryRestrictions: true,
  drinksIncluded: true,
  dietaryOptions: ['Vegetarian available', 'Vegan available', 'Halal available', 'Gluten-free on request'],
  transportationProvided: true,
  transportationType: '4x4/Jeep',
  healthRestrictions: [
    'Not suitable for guests with severe mobility issues',
    'Moderate walking involved at market and village sites',
    'Wheelchair accessibility is limited at some stops',
  ],
  notAllowed: [
    'No drones permitted at palace grounds',
    'No flash photography inside museums',
    'No outside food at restaurant stops',
  ],
  petFriendly: false,
  whatToBring: [
    'Comfortable walking shoes',
    'Sunscreen and hat',
    'Camera or smartphone',
    'Small daypack',
    'Cash for market shopping (GHS or USD)',
    'Light rain jacket (seasonal)',
  ],
  additionalInfo: 'This tour operates rain or shine. The Ashanti Region is hot and humid — wear lightweight, breathable clothing. Modest dress is required when visiting the palace (shoulders and knees covered). Tour operates with a minimum of 2 guests. Children under 12 must be accompanied by an adult at all times.',
  emergencyCountryCode: '233',
  emergencyPhone: '+233302221234',
  voucherInfo: 'Present your digital voucher or booking confirmation to your guide at pickup. A physical copy is also accepted. Voucher is valid for the booked date only.',
  copyrightConfirmed: true,
  options: [
    { name: 'Standard Tour', description: 'Full-day guided cultural tour with lunch' },
    { name: 'Premium Private Tour', description: 'Private guide, luxury vehicle, and premium restaurant lunch' },
  ],
  meetingInstructions: 'Meet your guide at the lobby of your Kumasi hotel or at the designated meeting point: Kumasi Cultural Centre main entrance (near the Prempeh II Jubilee Museum). Look for the guide holding a Travio sign.',
  meetingMode: 'pickup',
  meetingPointPicture: 'https://res.cloudinary.com/travio/image/upload/v1/tours/kumasi-cultural-centre-entrance.jpg',
  arrivalTime: '10 minutes before scheduled pickup',
  arrivalTimeType: 'custom',
  arrivalTimeCustom: '10 minutes before scheduled pickup',
  isPrivateActivity: false,
  passportRequired: false,
  flightInfoRequired: false,
  shipInfoRequired: false,
  trainInfoRequired: false,
  hotelInfoRequired: true,
  contactPhone: '+233241234567',
  crossCityTravel: true,
  planPickupTimes: true,
  pickupStartTime: '08:00',
  pickupProvided: true,
  pickupAvailable: true,
  pickupType: 'area',
  pickupDescription: 'Complimentary pickup from any hotel or accommodation in central Kumasi. Pickups begin at 8:00 AM. Please confirm your exact pickup location when booking.',
  pickupTiming: 'at_start',
  pickupFinalLocationTiming: 'day_before',
  referenceStartTime: '08:00',
  pickupAreas: ['Kumasi City Centre', 'Adum', 'Bantama', 'Ahodwo', 'Nhyiaeso', 'Patipoka'],
  pickupLocations: [
    { name: 'Kumasi Cultural Centre', address: 'Prempeh II Street, Kumasi', lat: 6.6940, lng: -1.6240 },
    { name: 'Golden Tulip Kumasi City', address: 'Ahodwo, Kumasi', lat: 6.6880, lng: -1.6120 },
  ],
  dropoffProvided: true,
  dropoffAvailable: true,
  dropoffOption: 'same_as_pickup',
  dropoffLocation: { name: 'Return to hotel', address: 'Same as pickup location' },
  dropoffDescription: 'Return to your hotel or accommodation in central Kumasi by approximately 6:00 PM.',
};

const schedulesAndPricing = {
  travelerDetails: {
    pricingModel: 'perPerson',
    pricingApproach: 'dependsOnAge',
    uniformPrice: null,
    pricingCategories: [
      { name: 'Adult', price: 89.00, minAge: 13, maxAge: 99 },
      { name: 'Child', price: 59.00, minAge: 6, maxAge: 12 },
      { name: 'Infant', price: 0, minAge: 0, maxAge: 5 },
    ],
    ageGroups: [
      { label: 'Adult', minAge: 13, maxAge: 99 },
      { label: 'Child', minAge: 6, maxAge: 12 },
      { label: 'Infant', minAge: 0, maxAge: 5 },
    ],
    minParticipants: 1,
    maxParticipants: 15,
    groupSizes: [],
    additionalPersonsEnabled: false,
    additionalPersonPrice: null,
    maxGroupsPerTimeSlot: 2,
  },
  pricingSchedules: {
    currency: 'USD',
    schedules: [
      {
        name: 'Peak Season',
        startDate: '2026-05-01',
        hasEndDate: true,
        endDate: '2026-09-30',
        timeSlots: [],
        dateExceptions: [],
        daysOfWeek: [1, 2, 3, 4, 5, 6, 0],
        prices: [
          { ageGroup: 'Adult', retailPrice: 89.00, ourPrice: 89.00 },
          { ageGroup: 'Child', retailPrice: 59.00, ourPrice: 59.00 },
          { ageGroup: 'Infant', retailPrice: 0, ourPrice: 0 },
        ],
      },
      {
        name: 'Off-Season',
        startDate: '2026-10-01',
        hasEndDate: true,
        endDate: '2026-12-31',
        timeSlots: [],
        dateExceptions: [],
        daysOfWeek: [1, 2, 3, 4, 5, 6],
        prices: [
          { ageGroup: 'Adult', retailPrice: 79.00, ourPrice: 79.00 },
          { ageGroup: 'Child', retailPrice: 49.00, ourPrice: 49.00 },
          { ageGroup: 'Infant', retailPrice: 0, ourPrice: 0 },
        ],
      },
    ],
  },
  availability: {
    scheduleType: 'operatingHours',
    operatingHoursStart: '08:00',
    operatingHoursEnd: '18:00',
    daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    weeklySchedule: {
      Monday: [{ startTime: '08:00', endTime: '18:00' }],
      Tuesday: [{ startTime: '08:00', endTime: '18:00' }],
      Wednesday: [{ startTime: '08:00', endTime: '18:00' }],
      Thursday: [{ startTime: '08:00', endTime: '18:00' }],
      Friday: [{ startTime: '08:00', endTime: '18:00' }],
      Saturday: [{ startTime: '08:00', endTime: '18:00' }],
    },
    timeSlots: [],
    startDate: '2026-05-01',
    endDate: '2026-12-31',
    timezone: 'Africa/Accra',
  },
};

const bookingAndTickets = {
  meetingPoint: {
    type: 'pickup',
    address: 'Hotel pickup in central Kumasi',
    coordinates: { lat: 6.6940, lng: -1.6240 },
    instructions: 'Meet your guide at your hotel lobby. Guide will arrive 10 minutes before scheduled pickup time.',
  },
  arrivalTime: '10 minutes before scheduled pickup',
  pickupProvided: true,
  pickupType: 'area',
  pickupDescription: 'Complimentary hotel pickup from central Kumasi',
  pickupTiming: 'at_start',
  pickupAreas: ['Kumasi City Centre', 'Adum', 'Bantama', 'Ahodwo'],
  pickupLocations: [
    { name: 'Kumasi Cultural Centre', address: 'Prempeh II Street, Kumasi', lat: 6.6940, lng: -1.6240 },
  ],
  dropoffOption: 'same_as_pickup',
  dropoffProvided: true,
  dropoffLocation: { name: 'Return to hotel', address: 'Same as pickup' },
  ticketType: 'standard',
  instantBooking: true,
  instantConfirmation: true,
  maxQuantity: 15,
  bookingWindow: 24,
  minAdvanceBookingHours: 24,
  travelerRequiredInfo: ['Hotel name and address', 'Dietary requirements', 'Number of children and ages'],
  cancellationPolicy: {
    type: 'standard',
    label: 'Free cancellation up to 24 hours before',
    cancellationWindowHours: 24,
    refundPercentage: 100,
  },
  cutoffMinutes: 60,
  lastMinuteBookings: false,
  perSlotCutoff: false,
  perSlotCutoffs: {},
  timezone: 'Africa/Accra',
};

const categorization = {
  category: 'Cultural',
  subcategory: 'Heritage Tours',
  activityType: 'Guided Tour',
  difficulty: 'Easy',
  duration: { value: 10, unit: 'hours' },
  transportMode: 'Vehicle',
  transportModes: ['4x4/Jeep', 'Walking'],
  transportServices: ['Hotel pickup and drop-off', 'Air-conditioned vehicle'],
  accommodationIncluded: false,
};

const theme = {
  primaryTheme: 'Culture & History',
  secondaryThemes: ['Art & Crafts', 'Family-Friendly', 'Photography', 'Food & Dining'],
};

const itinerary = [
  { day: 1, time: '08:00', title: 'Hotel Pickup', description: 'Your guide and driver will pick you up from your Kumasi hotel in an air-conditioned 4x4 vehicle.', duration: 15, durationUnit: 'min', locationName: 'Kumasi Hotel', visitType: 'pickup', importance: 'minor' },
  { day: 1, time: '08:30', title: 'Manhyia Palace Museum', description: 'Explore the historic seat of the Ashanti kingdom. Your guide will share the rich history of the Ashanti people, the Golden Stool, and the royal lineage. Visit the Prempeh II Jubilee Museum and see royal artifacts.', duration: 90, durationUnit: 'min', locationName: 'Manhyia Palace Museum', locationAddress: 'Manhyia, Kumasi', visitType: 'visit', importance: 'major' },
  { day: 1, time: '10:15', title: 'Okomfo Anokye Sword Site', description: 'Visit the legendary site where the sword of Okomfo Anokye is embedded in the ground — a key symbol of Ashanti unity and power.', duration: 20, durationUnit: 'min', locationName: 'Okomfo Anokye Sword Site', visitType: 'visit', importance: 'minor' },
  { day: 1, time: '10:45', title: 'Adanwomase Kente Weaving Village', description: 'Watch master weavers create stunning Kente cloth on traditional looms. Learn about the symbolism of different patterns and colors. Try your hand at weaving.', duration: 75, durationUnit: 'min', locationName: 'Adanwomase Kente Village', locationAddress: 'Adanwomase, Kumasi', visitType: 'visit', importance: 'major' },
  { day: 1, time: '12:15', title: 'Ashanti Lunch Experience', description: 'Enjoy a traditional Ashanti lunch at a top-rated local restaurant. Menu includes fufu with light soup, banku with grilled tilapia, or jollof rice. Dietary requirements accommodated.', duration: 60, durationUnit: 'min', locationName: 'Local Restaurant', visitType: 'visit', importance: 'major', additionalFee: false },
  { day: 1, time: '13:30', title: 'Ntonso Adinkra Stamping Village', description: 'Learn the ancient art of Adinkra cloth stamping. Each symbol carries deep meaning — your guide will explain the stories behind them. Create your own Adinkra cloth to take home.', duration: 60, durationUnit: 'min', locationName: 'Ntonso Adinkra Village', locationAddress: 'Ntonso, Kumasi', visitType: 'visit', importance: 'major' },
  { day: 1, time: '14:45', title: 'Kumasi Fort and Military Museum', description: 'Brief stop at the historic British colonial fort, now a military museum showcasing Ghana\'s armed forces history.', duration: 30, durationUnit: 'min', locationName: 'Kumasi Fort', visitType: 'visit', importance: 'minor' },
  { day: 1, time: '15:30', title: 'Kejetia Market Exploration', description: 'Dive into West Africa\'s largest open-air market. Browse hundreds of stalls selling textiles, crafts, spices, and local goods. Your guide will help navigate and find the best deals.', duration: 90, durationUnit: 'min', locationName: 'Kejetia Market', locationAddress: 'Kejetia, Kumasi', visitType: 'visit', importance: 'major' },
  { day: 1, time: '17:00', title: 'Return to Hotel', description: 'Your driver will take you back to your hotel. Your guide can recommend restaurants and activities for the evening.', duration: 30, durationUnit: 'min', locationName: 'Kumasi Hotel', visitType: 'dropoff', importance: 'minor' },
];

async function seed() {
  try {
    console.log('Deleting existing tours...');
    await prisma.tour.deleteMany();

    console.log('Creating Ashanti Cultural Heritage tour...');
    const tour = await prisma.tour.create({
      data: {
        supplierId: SUPPLIER_ID,
        title: 'Ashanti Cultural Heritage & Craftsmanship Full-Day Experience',
        description: 'Immerse yourself in the heart of Ghana\'s Ashanti Region on this comprehensive full-day cultural journey. Explore the historic Manhyia Palace Museum, witness master Kente weavers at Adanwomase, learn the ancient art of Adinkra stamping at Ntonso, and browse the vibrant Kejetia Market in Kumasi. This expert-led tour blends history, art, and authentic local cuisine for an unforgettable experience.',
        referenceCode: 'ASH-2026-001',
        status: 'PENDING_APPROVAL',
        submittedAt: new Date('2026-08-01T10:00:00Z'),
        photos: [
          'https://res.cloudinary.com/travio/image/upload/v1/tours/ashanti-palace-museum.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/kente-weaving-village.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/kejetia-market-kumasi.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/ntonso-adinkra-village.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/ashanti-royal-drummers.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/kente-cloth-closeup.jpg',
        ],
        coverPhoto: 'https://res.cloudinary.com/travio/image/upload/v1/tours/ashanti-palace-museum.jpg',
        tags: ['Cultural', 'Heritage', 'Kente', 'Kumasi', 'Full-Day', 'Guided', 'UNESCO', 'Art & Crafts', 'Family-Friendly'],
        latitude: 6.6885,
        longitude: -1.6244,
        city: 'Kumasi',
        country: 'Ghana',
        region: 'Ashanti',
        category: 'Cultural Tours',
        subcategory: 'Heritage & History',
        activityType: 'Guided Tour',
        difficulty: 'Easy',
        durationMinutes: 600,
        averageRating: 4.87,
        reviewCount: 124,
        totalBookings: 892,
        viewCount: 15430,
        metaTitle: 'Ashanti Cultural Heritage Tour | Full-Day Kumasi Experience',
        metaDescription: 'Explore Ghana\'s Ashanti Region with a full-day guided tour visiting Manhyia Palace, Adanwomase Kente Village, Ntonso Adinkra Village, and Kejetia Market. Includes lunch and hotel pickup.',
        slug: 'ashanti-cultural-heritage-craftsmanship-full-day-experience',
        theme,
        categorization,
        productContent: { ...productContent, itinerary },
        schedulesAndPricing,
        bookingAndTickets,
      },
    });

    console.log('First tour (PENDING_APPROVAL) created:', tour.id);

    // ── Second tour: ACTIVE with pending edits (draftContent diff) ──
    const liveProductContent = {
      writingLanguage: 'en',
      shortSummary: 'Walk beneath the rainforest canopy on Ghana\'s famous Kakum Canopy Walkway, spot exotic birds and butterflies, and explore the historic Cape Coast Castle on this immersive full-day adventure.',
      highlights: [
        'Walk 40 meters above the rainforest floor on the famous Kakum Canopy Walkway',
        'Spot rare birds, butterflies, and monkeys in the pristine Kakum National Park',
        'Explore the UNESCO-listed Cape Coast Castle and its dark history',
        'Learn about local culture from an expert Ghanaian guide',
      ],
      locations: [
        { name: 'Kakum National Park', city: 'Cape Coast', country: 'Ghana', lat: 5.3480, lng: -1.3830, region: 'Central' },
        { name: 'Cape Coast Castle', city: 'Cape Coast', country: 'Ghana', lat: 5.1050, lng: -1.2460, region: 'Central' },
      ],
      attractions: ['Kakum Canopy Walkway', 'Kakum National Park', 'Cape Coast Castle', 'Kokrobite Beach'],
      activitiesIncluded: ['Canopy walk', 'Nature hike', 'Castle tour', 'Bird watching'],
      pickupTransportTypes: ['Hotel pickup', 'Air-conditioned minibus'],
      included: [
        'Professional English-speaking guide',
        'Hotel pickup and drop-off',
        'Air-conditioned transport',
        'Kakum National Park entrance fee',
        'Canopy walkway access fee',
        'Cape Coast Castle entrance fee',
        'Bottled water',
        'Lunch at local restaurant',
      ],
      excluded: [
        'Gratuities',
        'Personal expenses',
        'Travel insurance',
        'Additional drinks',
      ],
      guideType: 'professional',
      guideMaterials: { audioGuide: false, infoBooklet: false },
      foodProvided: true,
      meals: ['Lunch'],
      mealType: 'buffet',
      drinksIncluded: true,
      dietaryOptions: ['Vegetarian available'],
      transportationProvided: true,
      transportationType: 'Minibus',
      healthRestrictions: [
        'Not suitable for those with vertigo or fear of heights',
        'Moderate walking on uneven forest trails',
      ],
      notAllowed: ['No flash photography inside the castle', 'No touching wildlife'],
      petFriendly: false,
      whatToBring: ['Comfortable walking shoes', 'Sunscreen', 'Camera', 'Insect repellent'],
      additionalInfo: 'The canopy walkway consists of 7 bridges suspended 40m above the forest floor. Each bridge is 20-40m long. Guides provide safety briefing before the walk.',
      emergencyCountryCode: '233',
      emergencyPhone: '+233332132456',
      voucherInfo: 'Show your digital voucher at the park entrance gate.',
      copyrightConfirmed: true,
      options: [],
      meetingInstructions: 'Your guide will meet you at your hotel lobby in Cape Coast or at Kakum National Park main entrance.',
      meetingMode: 'pickup',
      meetingPointPicture: '',
      arrivalTime: '15 minutes before',
      arrivalTimeType: 'custom',
      arrivalTimeCustom: '15 minutes before pickup',
      isPrivateActivity: false,
      passportRequired: false,
      flightInfoRequired: false,
      shipInfoRequired: false,
      trainInfoRequired: false,
      hotelInfoRequired: true,
      contactPhone: '+233244567890',
      crossCityTravel: true,
      pickupProvided: true,
      pickupAvailable: true,
      pickupType: 'area',
      pickupDescription: 'Pickup from any hotel in Cape Coast city centre.',
      pickupTiming: 'at_start',
      pickupAreas: ['Cape Coast Centre', 'Elmina', 'Ola'],
      pickupLocations: [{ name: 'Kakum Park Gate', address: 'Kakum National Park, Cape Coast', lat: 5.3480, lng: -1.3830 }],
      dropoffProvided: true,
      dropoffAvailable: true,
      dropoffOption: 'same_as_pickup',
      dropoffLocation: { name: 'Return to hotel', address: 'Same as pickup' },
      dropoffDescription: 'Return to your hotel by approximately 5:00 PM.',
    };

    const liveSchedulesAndPricing = {
      travelerDetails: {
        pricingModel: 'perPerson',
        pricingApproach: 'dependsOnAge',
        pricingCategories: [
          { name: 'Adult', price: 75.00, minAge: 13, maxAge: 99 },
          { name: 'Child', price: 45.00, minAge: 6, maxAge: 12 },
        ],
        ageGroups: [
          { label: 'Adult', minAge: 13, maxAge: 99 },
          { label: 'Child', minAge: 6, maxAge: 12 },
        ],
        minParticipants: 2,
        maxParticipants: 20,
        groupSizes: [],
        additionalPersonsEnabled: false,
        additionalPersonPrice: null,
        maxGroupsPerTimeSlot: 3,
      },
      pricingSchedules: {
        currency: 'USD',
        schedules: [{
          name: 'Regular',
          startDate: '2026-05-01',
          hasEndDate: true,
          endDate: '2026-12-31',
          timeSlots: [],
          dateExceptions: [],
          daysOfWeek: [1, 2, 3, 4, 5, 6],
          prices: [
            { ageGroup: 'Adult', retailPrice: 75.00, ourPrice: 75.00 },
            { ageGroup: 'Child', retailPrice: 45.00, ourPrice: 45.00 },
          ],
        }],
      },
      availability: {
        scheduleType: 'operatingHours',
        operatingHoursStart: '07:00',
        operatingHoursEnd: '17:00',
        daysOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        weeklySchedule: {},
        timeSlots: [],
        startDate: '2026-05-01',
        endDate: '2026-12-31',
        timezone: 'Africa/Accra',
      },
    };

    const liveBookingAndTickets = {
      meetingPoint: { type: 'pickup', address: 'Hotel pickup in Cape Coast', coordinates: { lat: 5.1050, lng: -1.2460 } },
      arrivalTime: '15 minutes before pickup',
      pickupProvided: true,
      pickupType: 'area',
      pickupDescription: 'Hotel pickup in Cape Coast',
      pickupTiming: 'at_start',
      pickupAreas: ['Cape Coast Centre', 'Elmina'],
      pickupLocations: [],
      dropoffOption: 'same_as_pickup',
      dropoffProvided: true,
      dropoffLocation: { name: 'Return to hotel', address: 'Same as pickup' },
      ticketType: 'standard',
      instantBooking: true,
      instantConfirmation: true,
      maxQuantity: 20,
      bookingWindow: 24,
      minAdvanceBookingHours: 12,
      travelerRequiredInfo: ['Hotel name'],
      cancellationPolicy: {
        type: 'standard',
        label: 'Free cancellation up to 24 hours before',
        cancellationWindowHours: 24,
        refundPercentage: 100,
      },
      cutoffMinutes: 30,
      lastMinuteBookings: false,
      perSlotCutoff: false,
      perSlotCutoffs: {},
      timezone: 'Africa/Accra',
    };

    // The DRAFT CONTENT is what the supplier "changed" — simulating edits
    const draftProductContent = {
      ...liveProductContent,
      shortSummary: 'Experience Ghana\'s breathtaking Kakum Canopy Walkway suspended 40m above the rainforest floor, then dive into history at the UNESCO World Heritage Cape Coast Castle. Full-day guided adventure with lunch included.',
      highlights: [
        'Walk 40 meters above the pristine rainforest on the legendary Kakum Canopy Walkway',
        'Spot hornbills, butterflies, and monkeys with expert birdwatching guidance',
        'Explore the haunting dungeons of UNESCO-listed Cape Coast Castle',
        'Savor traditional Ghanaian cuisine at a beachside restaurant',
        'Learn the history of the trans-Atlantic slave trade from a local historian',
      ],
      included: [
        'Professional English-speaking guide',
        'Hotel pickup and drop-off in Cape Coast',
        'Air-conditioned minibus transport',
        'Kakum National Park entrance fee',
        'Canopy walkway access fee',
        'Cape Coast Castle guided tour',
        'Bottled water throughout',
        'Traditional Ghanaian lunch at beachside restaurant',
        'Binoculars for birdwatching',
      ],
      additionalInfo: 'The canopy walkway consists of 7 bridges suspended 40m above the forest floor. Each bridge is 20-40m long. A safety briefing is provided. Best visited in the morning when wildlife is most active. The castle tour includes underground dungeons — be prepared for an emotional experience.',
    };

    const draftSchedulesAndPricing = {
      ...liveSchedulesAndPricing,
      travelerDetails: {
        ...liveSchedulesAndPricing.travelerDetails,
        maxParticipants: 12,
      },
      pricingSchedules: {
        currency: 'USD',
        schedules: [{
          name: 'Regular',
          startDate: '2026-05-01',
          hasEndDate: true,
          endDate: '2026-12-31',
          timeSlots: [],
          dateExceptions: [],
          daysOfWeek: [1, 2, 3, 4, 5, 6],
          prices: [
            { ageGroup: 'Adult', retailPrice: 82.00, ourPrice: 82.00 },
            { ageGroup: 'Child', retailPrice: 50.00, ourPrice: 50.00 },
          ],
        }],
      },
    };

    const tour2 = await prisma.tour.create({
      data: {
        supplierId: SUPPLIER_ID,
        title: 'Kakum Canopy Walk & Cape Coast Castle Full-Day Tour',
        description: 'Experience the best of Ghana\'s Central Region on this full-day adventure. Walk the famous Kakum Canopy Walkway suspended 40 meters above the rainforest floor, spot exotic wildlife, then explore the haunting UNESCO-listed Cape Coast Castle — one of the largest slave trading posts in West Africa.',
        referenceCode: 'KAK-2026-001',
        status: 'ACTIVE',
        submittedAt: new Date('2026-07-15T09:00:00Z'),
        reviewedAt: new Date('2026-07-16T14:30:00Z'),
        photos: [
          'https://res.cloudinary.com/travio/image/upload/v1/tours/kakum-canopy-walk.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/kakum-rainforest.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/cape-coast-castle.jpg',
          'https://res.cloudinary.com/travio/image/upload/v1/tours/cape-coast-dungeon.jpg',
        ],
        coverPhoto: 'https://res.cloudinary.com/travio/image/upload/v1/tours/kakum-canopy-walk.jpg',
        tags: ['Adventure', 'Nature', 'UNESCO', 'Wildlife', 'History', 'Full-Day'],
        latitude: 5.3480,
        longitude: -1.3830,
        city: 'Cape Coast',
        country: 'Ghana',
        region: 'Central',
        category: 'Adventure Tours',
        subcategory: 'Nature & Wildlife',
        activityType: 'Guided Tour',
        difficulty: 'Moderate',
        durationMinutes: 600,
        averageRating: 4.72,
        reviewCount: 87,
        totalBookings: 543,
        viewCount: 9820,
        metaTitle: 'Kakum Canopy Walk & Cape Coast Castle Tour | Ghana Adventure',
        metaDescription: 'Walk the famous Kakum Canopy Walkway and explore Cape Coast Castle on this full-day guided tour from Cape Coast, Ghana. Includes lunch, park fees, and hotel pickup.',
        slug: 'kakum-canopy-walk-cape-coast-castle-full-day-tour',
        // ── PENDING EDITS (draft) ──
        draftStatus: 'PENDING_APPROVAL',
        draftSubmittedAt: new Date('2026-08-05T11:20:00Z'),
        draftContent: {
          productContent: draftProductContent,
          schedulesAndPricing: draftSchedulesAndPricing,
          bookingAndTickets: liveBookingAndTickets,
        },
        theme: {
          primaryTheme: 'Nature & Wildlife',
          secondaryThemes: ['Adventure', 'History', 'Photography', 'Family-Friendly'],
        },
        categorization: {
          category: 'Adventure',
          subcategory: 'Nature & Wildlife',
          activityType: 'Guided Tour',
          difficulty: 'Moderate',
          duration: { value: 10, unit: 'hours' },
          transportMode: 'Vehicle',
          transportModes: ['Minibus', 'Walking'],
          transportServices: ['Hotel pickup and drop-off', 'Air-conditioned minibus'],
          accommodationIncluded: false,
        },
        productContent: liveProductContent,
        schedulesAndPricing: liveSchedulesAndPricing,
        bookingAndTickets: liveBookingAndTickets,
      },
    });

    console.log('Second tour (ACTIVE + pending edits) created:', tour2.id);
    console.log('Title:', tour2.title);
    console.log('Status:', tour2.status, '| Draft:', tour2.draftStatus);
    console.log('ID:', tour.id);
    console.log('Title:', tour.title);
    console.log('Status:', tour.status);
    console.log('Slug:', tour.slug);
    console.log('Category:', tour.category);
    console.log('City:', tour.city, tour.country);
  } catch (err) {
    console.error('Error creating tour:', err);
  } finally {
    await prisma.$disconnect();
  }
}

seed();
