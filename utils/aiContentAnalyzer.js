/**
 * AI Content Analyzer
 *
 * Integrates with Xiaomi MiMo API to analyze tour images and classify
 * tour content. Results are stored durably in PostgreSQL (TourImageAnalysis
 * and Tour AI fields), not Redis.
 *
 * Architecture:
 *   Supplier uploads → PostgreSQL → BullMQ → MiMo → PostgreSQL
 *
 * MiMo is an async enricher, NOT a critical dependency.
 * If MiMo is down, tours still work with traditional signals.
 *
 * @version 1.0.0
 */

const prisma = require('./prismaClient');
const logger = require('./logger');

// ─── MiMo API Configuration ─────────────────────────────────────────
const MIMO_API_URL = 'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions';
const MIMO_MODEL = 'mimo-v2.5';
const MIMO_MAX_RETRIES = 3;
const MIMO_RETRY_DELAY_MS = 2000;

// Category name mapping: KEYWORD_CATEGORIES name → AI category slug
const CATEGORY_SLUG_MAP = {
  'Sports & Adventure': 'sports_adventure',
  'Food & Drink': 'food_drink',
  'Art & Museums': 'art_museums',
  'Architecture': 'architecture',
  'Music & Shows': 'music_shows',
  'Culture & Heritage': 'culture_heritage',
  'Animals & Nature': 'animals_nature',
  'Water Activities': 'water_activities',
  'Winter & Snow': 'winter_snow',
  'Desert & Safari': 'desert_safari',
  'Nature & Outdoors': 'nature_outdoors',
  'City & Walking Tours': 'city_walking',
  'Seasonal & Events': 'seasonal_events',
  'Wellness & Relaxation': 'wellness_relaxation',
  'Royalty & History': 'royalty_history',
  'Pop Culture & Media': 'pop_culture',
  'Mystery & Horror': 'mystery_horror',
  'Nightlife & Party': 'nightlife_party',
  'Religion & Spirituality': 'religion_spirituality',
  'Transportation': 'transportation',
};

// Reverse map: AI slug → KEYWORD_CATEGORIES name
const SLUG_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_SLUG_MAP).map(([name, slug]) => [slug, name])
);

const VALID_CATEGORY_SLUGS = Object.values(CATEGORY_SLUG_MAP);

// ─── MiMo API Call ──────────────────────────────────────────────────

/**
 * Call MiMo API with retry logic.
 * Uses the Token Plan (Singapore) endpoint with Bearer auth.
 */
async function callMiMo(messages, maxTokens = 100000) {
  const apiKey = process.env.MIMO_API_KEY;
  if (!apiKey) {
    throw new Error('MIMO_API_KEY not set in environment');
  }

  for (let attempt = 1; attempt <= MIMO_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(MIMO_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MIMO_MODEL,
          messages,
          max_completion_tokens: maxTokens,
        }),
      });

      if (response.status === 429) {
        // Rate limited — wait and retry
        const retryAfter = parseInt(response.headers.get('retry-after') || '5', 10);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`MiMo API error ${response.status}: ${body.slice(0, 200)}`);
      }

      const data = await response.json();
      const message = data.choices?.[0]?.message;
      // MiMo v2.5 is a reasoning model — content may be empty while
      // the actual answer lives in reasoning_content when max_tokens is low.
      const content = message?.content || message?.reasoning_content;
      if (!content) {
        throw new Error('MiMo returned empty content');
      }

      return content;
    } catch (err) {
      if (attempt === MIMO_MAX_RETRIES) throw err;
      await new Promise(r => setTimeout(r, MIMO_RETRY_DELAY_MS * attempt));
    }
  }
}

/**
 * Parse JSON from MiMo response, handling markdown code fences.
 */
function parseJsonResponse(text) {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  return JSON.parse(cleaned);
}

// ─── Image Analysis ─────────────────────────────────────────────────

/**
 * Analyze a single tour image via MiMo.
 *
 * @param {string} imageUrl - Cloudinary URL of the image
 * @param {Object} tourContext - Tour metadata for context
 * @param {string} tourContext.title - Tour title
 * @param {string} tourContext.category - Supplier-set category
 * @param {string[]} tourContext.tags - Supplier-set tags
 * @param {string[]} tourContext.attractions - Candidate attraction names for this tour
 * @returns {Object} AI analysis results
 */
async function analyzeImage(imageUrl, tourContext) {
  const clip = require('./clipClient');

  // 1. CLIP zero-shot classification
  let classification;
  try {
    classification = await clip.classifyImage(imageUrl);
  } catch (err) {
    logger.warn('CLIP classification failed, falling back to MiMo', { imageUrl: imageUrl.slice(0, 80), error: err.message });
    // Fallback to MiMo text-only analysis using tour metadata
    return analyzeImageFallback(tourContext);
  }

  // 2. CLIP quality scoring
  let quality = { score: 0.5, issues: [] };
  try {
    quality = await clip.scoreQuality(imageUrl);
  } catch (err) {
    logger.warn('CLIP quality scoring failed', { error: err.message });
  }

  // 3. Build labels from CLIP subjects + category
  const labels = [classification.label, ...(classification.subjects || [])];
  const uniqueLabels = [...new Set(labels)].filter(Boolean);

  // 4. Map CLIP category to our slug format
  const categoryHint = classification.label || null;

  return {
    labels: uniqueLabels.slice(0, 8),
    qualityScore: quality.score ?? 0.5,
    subjects: classification.subjects || [],
    description: null, // CLIP doesn't generate descriptions
    categoryHint,
    isRelevantToTour: classification.confidence >= 0.3,
    attractionRelevance: {}, // CLIP can't detect specific attractions
    primaryAttraction: null,
    clipConfidence: classification.confidence,
    clipAllScores: classification.allScores,
  };
}

/**
 * Fallback: use MiMo text-only analysis when CLIP fails.
 * Analyzes tour metadata instead of the image.
 */
async function analyzeImageFallback(tourContext) {
  const messages = [
    {
      role: 'system',
      content: 'You are a travel tour classifier. Based on tour metadata, predict what the tour images likely show. Return structured JSON.',
    },
    {
      role: 'user',
      content: `Tour title: "${tourContext.title || 'Unknown'}"
Category: "${tourContext.category || 'Unknown'}"
Tags: ${JSON.stringify(tourContext.tags || [])}

Based on this metadata, predict what images of this tour would show.

Return JSON:
{
  "labels": ["adventure", "outdoor"],
  "qualityScore": 0.5,
  "subjects": ["nature", "people"],
  "description": "Likely shows outdoor adventure activities",
  "categoryHint": "${VALID_CATEGORY_SLUGS[0]}",
  "isRelevantToTour": true,
  "attractionRelevance": {},
  "primaryAttraction": null
}

Rules:
- categoryHint must be one of: ${VALID_CATEGORY_SLUGS.join(', ')}
- Return ONLY the JSON object.`,
    },
  ];

  const response = await callMiMo(messages, 5000);
  return parseJsonResponse(response);
}

// ─── Tour Classification ────────────────────────────────────────────

/**
 * Classify a tour's overall content based on its metadata and image analyses.
 *
 * @param {Object} tour - Tour record from database
 * @param {Object[]} imageAnalyses - Array of TourImageAnalysis records
 * @returns {Object} Classification results
 */
async function classifyTour(tour, imageAnalyses) {
  const allLabels = imageAnalyses.flatMap(a => a.aiLabels || []);
  const allSubjects = imageAnalyses.flatMap(a => a.aiSubjects || []);
  const avgQuality = imageAnalyses.length > 0
    ? imageAnalyses.reduce((sum, a) => sum + (a.aiQualityScore || 0), 0) / imageAnalyses.length
    : null;

  const messages = [
    {
      role: 'system',
      content: 'You are a travel tour classifier for TravioAfrica/Expedition-Go. Return structured JSON.',
    },
    {
      role: 'user',
      content: `Classify this tour based on its metadata and image analysis.

Title: "${tour.title || 'Unknown'}"
Description: "${(tour.description || '').slice(0, 500)}"
Supplier category: "${tour.category || 'Unknown'}"
Tags: ${JSON.stringify(tour.tags || [])}
City: "${tour.city || 'Unknown'}"
Country: "${tour.country || 'Unknown'}"

Image labels from photos: ${JSON.stringify(allLabels)}
Image subjects from photos: ${JSON.stringify(allSubjects)}
Average image quality: ${avgQuality ? avgQuality.toFixed(2) : 'unknown'}

Return JSON with exactly these fields:
{
  "primaryCategory": "sports_adventure",
  "secondaryCategories": ["nature_outdoors"],
  "moodTags": ["adventurous", "outdoor", "exciting"],
  "activityLevel": "high",
  "confidence": 0.88
}

Rules:
- primaryCategory: must be one of: ${VALID_CATEGORY_SLUGS.join(', ')}
- secondaryCategories: 0–3 additional categories from the same list
- moodTags: 2–5 descriptive mood/vibe words (lowercase)
- activityLevel: "low", "medium", or "high"
- confidence: 0.0–1.0, how confident you are in this classification
- Return ONLY the JSON object, no other text.`,
    },
  ];

  const response = await callMiMo(messages, 100000);
  return parseJsonResponse(response);
}

// ─── Main Processing Pipeline ───────────────────────────────────────

/**
 * Process AI analysis for a single tour.
 *
 * Flow:
 * 1. Mark tour as PROCESSING
 * 2. Analyze each image (skip already-completed)
 * 3. Classify the tour based on image analyses
 * 4. Store results in PostgreSQL
 * 5. Invalidate homepage caches
 *
 * @param {string} tourId - Tour ID to process
 * @returns {Object} Processing result
 */
async function processTourAI(tourId) {
  const startTime = Date.now();

  try {
    // 1. Mark as PROCESSING
    await prisma.tour.update({
      where: { id: tourId },
      data: { aiProcessingStatus: 'PROCESSING' },
    });

    // 2. Get tour data
    const tour = await prisma.tour.findUnique({ where: { id: tourId } });
    if (!tour) {
      logger.warn('AI processing: tour not found', { tourId });
      return { success: false, error: 'Tour not found' };
    }

    const images = [tour.coverPhoto, ...(tour.photos || [])].filter(Boolean);
    if (images.length === 0) {
      // No images to analyze — still classify based on text metadata
      await classifyAndUpdateTour(tour, []);
      return { success: true, imagesProcessed: 0, duration: Date.now() - startTime };
    }

    // 3. Analyze each image (skip already-completed)
    const imageAnalyses = [];
    for (const imageUrl of images) {
      const existing = await prisma.tourImageAnalysis.findUnique({
        where: { imageUrl },
      });

      if (existing?.aiStatus === 'COMPLETED') {
        imageAnalyses.push(existing);
        continue;
      }

      try {
        const result = await analyzeImage(imageUrl, {
          title: tour.title,
          category: tour.category,
          tags: tour.tags,
          attractions: tour.attractions || [],
        });

        const saved = await prisma.tourImageAnalysis.upsert({
          where: { imageUrl },
          create: {
            tourId,
            imageUrl,
            aiLabels: result.labels || [],
            aiQualityScore: result.qualityScore ?? null,
            aiSubjects: result.subjects || [],
            aiDescription: result.description || null,
            aiCategoryHint: result.categoryHint || null,
            attractionRelevance: result.attractionRelevance || {},
            primaryAttraction: result.primaryAttraction || null,
            aiModelVersion: MIMO_MODEL,
            aiProcessedAt: new Date(),
            aiStatus: 'COMPLETED',
          },
          update: {
            aiLabels: result.labels || [],
            aiQualityScore: result.qualityScore ?? null,
            aiSubjects: result.subjects || [],
            aiDescription: result.description || null,
            aiCategoryHint: result.categoryHint || null,
            attractionRelevance: result.attractionRelevance || {},
            primaryAttraction: result.primaryAttraction || null,
            aiModelVersion: MIMO_MODEL,
            aiProcessedAt: new Date(),
            aiStatus: 'COMPLETED',
            aiRetryCount: 0,
          },
        });

        imageAnalyses.push(saved);
      } catch (err) {
        logger.warn('AI image analysis failed', {
          tourId,
          imageUrl: imageUrl.slice(0, 80),
          error: err.message,
        });

        const retryCount = (existing?.aiRetryCount || 0) + 1;
        await prisma.tourImageAnalysis.upsert({
          where: { imageUrl },
          create: {
            tourId,
            imageUrl,
            aiRetryCount: retryCount,
            aiStatus: retryCount >= MIMO_MAX_RETRIES ? 'FAILED' : 'PENDING',
          },
          update: {
            aiRetryCount: retryCount,
            aiStatus: retryCount >= MIMO_MAX_RETRIES ? 'FAILED' : 'PENDING',
          },
        });
      }
    }

    // 4. Compute CLIP embeddings for the tour
    let tourClipEmbedding = null;
    try {
      const clip = require('./clipClient');
      const embeddings = [];

      // Get embedding for each image
      for (const analysis of imageAnalyses) {
        if (analysis.clipEmbedding) {
          embeddings.push(analysis.clipEmbedding);
        } else {
          try {
            const { embedding } = await clip.embedImage(analysis.imageUrl);
            embeddings.push(embedding);
            // Store on the image analysis record
            await prisma.tourImageAnalysis.update({
              where: { id: analysis.id },
              data: { clipEmbedding: embedding, clipModelVersion: 'ViT-B/32', clipProcessedAt: new Date() },
            });
          } catch (err) {
            logger.warn('CLIP embedding failed for image', { imageUrl: analysis.imageUrl?.slice(0, 80), error: err.message });
          }
        }
      }

      // Average embeddings across all images
      if (embeddings.length > 0) {
        const dim = embeddings[0].length;
        const avg = new Array(dim).fill(0);
        for (const emb of embeddings) {
          for (let i = 0; i < dim; i++) avg[i] += emb[i];
        }
        for (let i = 0; i < dim; i++) avg[i] /= embeddings.length;
        // Normalize
        const norm = Math.sqrt(avg.reduce((s, v) => s + v * v, 0));
        tourClipEmbedding = avg.map(v => v / norm);
      }

      // Get text embedding for the tour
      let tourTextEmbedding = null;
      try {
        const text = `${tour.title} ${tour.description || ''} ${(tour.tags || []).join(' ')}`.slice(0, 500);
        const { embedding } = await clip.embedText(text);
        tourTextEmbedding = embedding;
      } catch (err) {
        logger.warn('CLIP text embedding failed', { tourId, error: err.message });
      }

      // Store embeddings on tour
      await prisma.tour.update({
        where: { id: tourId },
        data: {
          clipEmbedding: tourClipEmbedding,
          clipTextEmbedding: tourTextEmbedding,
        },
      });
    } catch (err) {
      logger.warn('CLIP embedding pipeline failed', { tourId, error: err.message });
    }

    // 5. Classify tour based on all image analyses (MiMo text-based)
    await classifyAndUpdateTour(tour, imageAnalyses);

    // 6. Upsert Attraction entities for this tour's attractions
    if (Array.isArray(tour.attractions)) {
      for (const name of tour.attractions) {
        if (!name || !name.trim()) continue;
        try {
          await upsertAttraction(name.trim(), tour);
        } catch (err) {
          logger.warn('Attraction upsert failed', { attraction: name, tourId, error: err.message });
        }
      }
    }

    // 7. Invalidate homepage caches
    try {
      const { invalidateHomepageCaches } = require('./cacheHelper');
      await invalidateHomepageCaches();
    } catch (err) {
      // Non-fatal — caches will expire naturally
      logger.warn('Cache invalidation failed after AI processing', { tourId, error: err.message });
    }

    const duration = Date.now() - startTime;
    logger.info('AI processing complete', {
      tourId,
      imagesProcessed: imageAnalyses.length,
      duration,
    });

    return { success: true, imagesProcessed: imageAnalyses.length, duration };
  } catch (err) {
    // Mark as FAILED so reconciliation can retry
    await prisma.tour.update({
      where: { id: tourId },
      data: { aiProcessingStatus: 'FAILED' },
    }).catch(() => {});

    logger.error('AI processing failed', { tourId, error: err.message });
    return { success: false, error: err.message, duration: Date.now() - startTime };
  }
}

/**
 * Classify a tour and update its AI fields in PostgreSQL.
 */
async function classifyAndUpdateTour(tour, imageAnalyses) {
  try {
    const classification = await classifyTour(tour, imageAnalyses);

    await prisma.tour.update({
      where: { id: tour.id },
      data: {
        aiPrimaryCategory: classification.primaryCategory || null,
        aiSecondaryCategories: classification.secondaryCategories || [],
        aiMoodTags: classification.moodTags || [],
        aiActivityLevel: classification.activityLevel || null,
        aiConfidence: classification.confidence ?? null,
        aiScoredAt: new Date(),
        aiProcessingStatus: 'COMPLETED',
      },
    });
  } catch (err) {
    logger.warn('Tour classification failed, marking as FAILED', {
      tourId: tour.id,
      error: err.message,
    });

    await prisma.tour.update({
      where: { id: tour.id },
      data: { aiProcessingStatus: 'FAILED' },
    }).catch(() => {});
  }
}

// ─── Attraction Entity Management ──────────────────────────────────────

/**
 * Slugify a string for URL-safe attraction names.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Select the best hero image for an attraction from AI-tagged tour images.
 *
 * Priority:
 * 1. Manual override (locked) — skip entirely
 * 2. AI-selected with highest attractionRelevance score
 * 3. Best-rated tour's coverPhoto (fallback)
 * 4. null (no suitable image)
 *
 * @param {string} attractionName
 * @returns {Object} { heroImage, heroImageSource, heroImageTourId, imageRelevance }
 */
async function selectHeroImage(attractionName) {
  // Find all image analyses where this attraction has relevance > 0.3
  const analyses = await prisma.tourImageAnalysis.findMany({
    where: {
      aiStatus: 'COMPLETED',
      attractionRelevance: { path: [attractionName], gt: 0.3 },
    },
    orderBy: { aiQualityScore: 'desc' },
    take: 20,
  });

  if (analyses.length > 0) {
    // Pick the image with the highest relevance × quality score
    let best = null;
    let bestScore = 0;
    for (const a of analyses) {
      const relevance = a.attractionRelevance?.[attractionName] || 0;
      const quality = a.aiQualityScore || 0.5;
      const score = relevance * 0.7 + quality * 0.3;
      if (score > bestScore) {
        bestScore = score;
        best = a;
      }
    }
    if (best) {
      return {
        heroImage: best.imageUrl,
        heroImageSource: 'ai_selected',
        heroImageTourId: best.tourId,
        imageRelevance: best.attractionRelevance?.[attractionName] || null,
      };
    }
  }

  // Fallback: find the best-rated tour that visits this attraction
  const bestTour = await prisma.tour.findFirst({
    where: {
      status: 'ACTIVE',
      attractions: { has: attractionName },
      coverPhoto: { not: null },
    },
    orderBy: { averageRating: 'desc' },
    select: { id: true, coverPhoto: true },
  });

  if (bestTour?.coverPhoto) {
    return {
      heroImage: bestTour.coverPhoto,
      heroImageSource: 'fallback',
      heroImageTourId: bestTour.id,
      imageRelevance: null,
    };
  }

  return { heroImage: null, heroImageSource: null, heroImageTourId: null, imageRelevance: null };
}

/**
 * Upsert an Attraction entity from tour data + AI analysis.
 * Called after tour AI processing to keep attraction records current.
 *
 * @param {string} attractionName - The attraction name to upsert
 * @param {Object} tour - The tour record (for coordinates, pricing, ratings)
 */
async function upsertAttraction(attractionName, _tour) {
  if (!attractionName || !attractionName.trim()) return;

  const name = attractionName.trim();
  const slug = slugify(name);

  // Check for existing manual override
  const existing = await prisma.attraction.findUnique({ where: { name } });
  if (existing?.manualOverride) {
    // Don't touch manually curated attractions — just refresh metadata
    await refreshAttractionMetadata(existing.id, name);
    return;
  }

  // Select best hero image via AI
  const imageSelection = await selectHeroImage(name);

  // Compute centroid coordinates from tours visiting this attraction
  const visitingTours = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      attractions: { has: name },
    },
    select: {
      latitude: true,
      longitude: true,
      averageRating: true,
      totalBookings: true,
      schedulesAndPricing: true,
    },
  });

  let latSum = 0, lngSum = 0, coordCount = 0;
  let totalRating = 0, ratingCount = 0, totalBookings = 0;
  let minPrice = Infinity;

  for (const t of visitingTours) {
    if (t.latitude && t.longitude) {
      latSum += t.latitude;
      lngSum += t.longitude;
      coordCount++;
    }
    if (t.averageRating) {
      totalRating += parseFloat(t.averageRating);
      ratingCount++;
    }
    totalBookings += t.totalBookings || 0;
    const price = extractStartingPriceFromSchedules(t.schedulesAndPricing);
    if (price != null && price < minPrice) minPrice = price;
  }

  const attractionData = {
    name,
    slug,
    ...imageSelection,
    tourCount: visitingTours.length,
    avgRating: ratingCount > 0 ? Math.round((totalRating / ratingCount) * 10) / 10 : null,
    totalBookings,
    startingPrice: minPrice === Infinity ? null : minPrice,
    latitude: coordCount > 0 ? Math.round((latSum / coordCount) * 10000) / 10000 : null,
    longitude: coordCount > 0 ? Math.round((lngSum / coordCount) * 10000) / 10000 : null,
    lastComputedAt: new Date(),
  };

  await prisma.attraction.upsert({
    where: { name },
    create: attractionData,
    update: {
      ...imageSelection,
      tourCount: visitingTours.length,
      avgRating: attractionData.avgRating,
      totalBookings,
      startingPrice: attractionData.startingPrice,
      latitude: attractionData.latitude,
      longitude: attractionData.longitude,
      lastComputedAt: new Date(),
    },
  });
}

/**
 * Refresh metadata for an attraction without changing its hero image.
 */
async function refreshAttractionMetadata(attractionId, attractionName) {
  const visitingTours = await prisma.tour.findMany({
    where: {
      status: 'ACTIVE',
      attractions: { has: attractionName },
    },
    select: {
      averageRating: true,
      totalBookings: true,
      schedulesAndPricing: true,
    },
  });

  let totalRating = 0, ratingCount = 0, totalBookings = 0;
  let minPrice = Infinity;

  for (const t of visitingTours) {
    if (t.averageRating) {
      totalRating += parseFloat(t.averageRating);
      ratingCount++;
    }
    totalBookings += t.totalBookings || 0;
    const price = extractStartingPriceFromSchedules(t.schedulesAndPricing);
    if (price != null && price < minPrice) minPrice = price;
  }

  await prisma.attraction.update({
    where: { id: attractionId },
    data: {
      tourCount: visitingTours.length,
      avgRating: ratingCount > 0 ? Math.round((totalRating / ratingCount) * 10) / 10 : null,
      totalBookings,
      startingPrice: minPrice === Infinity ? null : minPrice,
      lastComputedAt: new Date(),
    },
  });
}

/**
 * Extract starting price from schedulesAndPricing JSON.
 */
function extractStartingPriceFromSchedules(schedulesAndPricing) {
  if (!schedulesAndPricing) return null;
  try {
    const schedules = Array.isArray(schedulesAndPricing)
      ? schedulesAndPricing
      : schedulesAndPricing.schedules || [];
    let min = null;
    for (const s of schedules) {
      const price = parseFloat(s.price || s.basePrice || s.amount);
      if (!isNaN(price) && price > 0 && (min === null || price < min)) min = price;
    }
    return min;
  } catch {
    return null;
  }
}

// ─── Batch Processing ───────────────────────────────────────────────

/**
 * Process all unprocessed tours (for initial backfill or batch retry).
 * Processes in batches to avoid overwhelming MiMo rate limits.
 *
 * @param {number} batchSize - Tours per batch
 * @param {number} delayMs - Delay between batches
 */
async function batchProcessTours(batchSize = 10, delayMs = 5000) {
  let processed = 0;
  let failed = 0;

  while (true) {
    const tours = await prisma.tour.findMany({
      where: {
        status: 'ACTIVE',
        aiProcessingStatus: { in: ['PENDING', 'FAILED'] },
      },
      take: batchSize,
      orderBy: { createdAt: 'desc' },
    });

    if (tours.length === 0) break;

    for (const tour of tours) {
      const result = await processTourAI(tour.id);
      if (result.success) processed++;
      else failed++;
    }

    if (tours.length === batchSize) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  logger.info('Batch AI processing complete', { processed, failed });
  return { processed, failed };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Get the reverse mapping from AI category slug to display name.
 */
function slugToCategoryName(slug) {
  return SLUG_TO_CATEGORY[slug] || slug;
}

/**
 * Get the forward mapping from display name to AI category slug.
 */
function categoryNameToSlug(name) {
  return CATEGORY_SLUG_MAP[name] || name;
}

module.exports = {
  processTourAI,
  classifyTour,
  analyzeImage,
  batchProcessTours,
  upsertAttraction,
  selectHeroImage,
  slugToCategoryName,
  categoryNameToSlug,
  CATEGORY_SLUG_MAP,
  SLUG_TO_CATEGORY,
  VALID_CATEGORY_SLUGS,
};
