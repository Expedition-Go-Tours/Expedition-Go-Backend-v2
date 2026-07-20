const catchAsync = require('../utils/catchAsync');
const prisma = require('../utils/prismaClient');
const AppError = require('../utils/appError');

const PRE_APPROVED_KEYWORDS = [
  'Adventure', 'Cultural', 'Nature', 'Wildlife', 'Food & drink',
  'Shopping', 'Sightseeing', 'Walking', 'Hiking', 'Cycling',
  'Water sports', 'Winter sports', 'Wellness', 'Photography',
  'Art', 'History', 'Music', 'Nightlife', 'Family friendly',
  'Romance', 'Luxury', 'Budget', 'Beach', 'Mountain',
  'Desert', 'Island', 'City tour', 'Countryside', 'Market',
  'Temple', 'Castle', 'Palace', 'Museum', 'Garden',
  'Park', 'Zoo', 'Aquarium', 'Safari', 'Trekking',
  'Climbing', 'Diving', 'Snorkeling', 'Surfing', 'Sailing',
  'Kayaking', 'Rafting', 'Horseback riding', 'Cooking class',
  'Wine tasting', 'Craft workshop', 'Festival', 'Theater',
  'Concert', 'Sports', 'Yoga', 'Meditation', 'Spa',
  'Sunrise', 'Sunset', 'Morning', 'Afternoon', 'Evening',
  'Full-day', 'Half-day', 'Multi-day', 'Skip the line',
  'Small group', 'Private tour', 'Pickup included',
  'Free cancellation', 'Audio guide', 'Live guide',
  'Wheelchair accessible', 'Pet friendly', 'Couples',
  'Solo travelers', 'Groups', 'Seniors', 'Students',
  'Helicopter', 'Boat tour', 'Cruise', 'Train', 'Cable car',
  'Rooftop', 'Hidden gem', 'Local experience', 'Off the beaten path',
  'VIP access', 'Photography tour', 'Street food', 'Brunch',
];

exports.listKeywords = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: { keywords: PRE_APPROVED_KEYWORDS },
  });
});

exports.requestKeyword = catchAsync(async (req, res) => {
  const { keyword } = req.body;

  if (!keyword || typeof keyword !== 'string' || !keyword.trim()) {
    throw new AppError('Please provide a valid keyword', 400);
  }

  const trimmed = keyword.trim();

  if (trimmed.length > 50) {
    throw new AppError('Keyword must be 50 characters or less', 400);
  }

  const exists = PRE_APPROVED_KEYWORDS.some(
    (kw) => kw.toLowerCase() === trimmed.toLowerCase(),
  );

  if (exists) {
    throw new AppError(`"${trimmed}" is already a pre-approved keyword`, 400);
  }

  const existing = await prisma.keywordRequest.findFirst({
    where: {
      keyword: trimmed,
      supplierId: req.user.id,
      status: 'PENDING',
    },
  });

  if (existing) {
    throw new AppError('You have already requested this keyword', 400);
  }

  const request = await prisma.keywordRequest.create({
    data: {
      keyword: trimmed,
      supplierId: req.user.id,
    },
  });

  res.status(201).json({
    status: 'success',
    data: { request },
    message: `"${trimmed}" has been submitted for review.`,
  });
});
