/**
 * External Review Crawler
 *
 * Fetches review pages from external platforms (Google, Viator, GetYourGuide)
 * and uses AI (MiMo) to extract structured review data. Only imports reviews
 * with 4+ star ratings.
 *
 * Flow:
 *   1. fetchPage(url) → raw HTML
 *   2. extractReviewSection(html, platform) → trimmed reviews HTML
 *   3. extractReviewsWithAI(html, platform, tourTitle) → Review[]
 *   4. filterAndNormalize(reviews) → filtered Review[]
 *   5. syncTourReviews(tourId) → upsert into ExternalReview table
 *
 * @module utils/externalReviewCrawler
 */

const prisma = require('./prismaClient');
const cache = require('./cacheHelper');
const { callMimo, parseJson } = require('./mimoClient');
const logger = require('./logger');

// ─── Constants ──────────────────────────────────────────────────────

const MIN_RATING = 4;
const MAX_HTML_SIZE = 40000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_CONCURRENT_SYNCS = 3;
const SYNC_CACHE_TTL = 300; // 5 min

// Platform detection regexes
const PLATFORM_PATTERNS = {
  google: /google\.com|goo\.gl|maps\.google/i,
  viator: /viator\.com/i,
  getyourguide: /getyourguide\.com/i,
};

// Platform-specific review section selectors (used for HTML trimming)
const REVIEW_SELECTORS = {
  viator: [
    '[data-test="review"]',
    '.review-card',
    '[class*="ReviewCard"]',
    '[class*="review-item"]',
  ],
  getyourguide: [
    '[data-test="review"]',
    '.review-item',
    '[class*="ReviewCard"]',
    '[class*="review-entry"]',
  ],
  google: [
    '.jftiEf',
    '.WMbnJc',
    '[data-review-id]',
    '[class*="review"]',
  ],
};

// ─── Platform Detection ─────────────────────────────────────────────

function detectPlatform(url) {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(url)) return platform;
  }
  return 'other';
}

// ─── HTML Fetching ──────────────────────────────────────────────────

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    return { html, finalUrl: response.url };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`Fetch timeout after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  }
}

// ─── Smart HTML Extraction ──────────────────────────────────────────

function extractReviewSection(html, platform) {
  // Try platform-specific selectors to extract just the reviews section
  const selectors = REVIEW_SELECTORS[platform] || [];

  for (const selector of selectors) {
    // Simple regex-based extraction for common patterns
    // This avoids requiring a full DOM parser dependency
    const classMatch = selector.match(/\[class\*="([^"]+)"\]/);
    if (classMatch) {
      const className = classMatch[1];
      // Find the first occurrence of this class and extract surrounding content
      const idx = html.indexOf(className);
      if (idx !== -1) {
        // Extract a chunk around the reviews section (40KB)
        const start = Math.max(0, idx - 2000);
        const end = Math.min(html.length, start + MAX_HTML_SIZE);
        return html.slice(start, end);
      }
    }

    // data-test attribute matching
    const dataTestMatch = selector.match(/\[data-test="([^"]+)"\]/);
    if (dataTestMatch) {
      const attr = `data-test="${dataTestMatch[1]}"`;
      const idx = html.indexOf(attr);
      if (idx !== -1) {
        const start = Math.max(0, idx - 2000);
        const end = Math.min(html.length, start + MAX_HTML_SIZE);
        return html.slice(start, end);
      }
    }
  }

  // Fallback: look for common review-related strings
  const fallbackMarkers = ['review', 'Review', 'rating', 'Rating', 'testimonial', 'Testimonial'];
  for (const marker of fallbackMarkers) {
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const start = Math.max(0, idx - 2000);
      const end = Math.min(html.length, start + MAX_HTML_SIZE);
      return html.slice(start, end);
    }
  }

  // Final fallback: truncate to MAX_HTML_SIZE
  return html.slice(0, MAX_HTML_SIZE);
}

// ─── AI Review Extraction ───────────────────────────────────────────

async function extractReviewsWithAI(html, platform, tourTitle) {
  const truncated = html.slice(0, MAX_HTML_SIZE);

  const systemPrompt = `You are a review extractor. Given HTML from a ${platform} review page, extract all customer reviews as a JSON array. Return ONLY the JSON array, no other text.`;

  const userPrompt = `Extract all customer reviews from this ${platform} page HTML for the tour "${tourTitle}".

Return a JSON array. Each review object:
{
  "author": "customer name",
  "rating": 4.5,
  "title": "review title or null",
  "text": "the review text content",
  "date": "YYYY-MM-DD or null",
  "platformReviewId": "unique ID from the platform if visible, or null"
}

Rules:
- Only extract actual customer reviews, not ads, tour descriptions, or navigation
- Normalize rating to a 1-5 scale (if the platform uses percentages, divide by 20)
- date should be in ISO format (YYYY-MM-DD)
- platformReviewId: use the platform's unique review ID if visible in the HTML
- Return [] if no reviews found
- Be thorough — extract ALL reviews visible in the HTML

HTML:
${truncated}`;

  try {
    const response = await callMimo({
      system: systemPrompt,
      user: userPrompt,
      maxTokens: 4096,
      temperature: 0.1, // Low temperature for consistent extraction
    });

    const reviews = parseJson(response);

    if (!Array.isArray(reviews)) {
      logger.warn('[ExternalReview] AI returned non-array:', typeof reviews);
      return [];
    }

    return reviews;
  } catch (err) {
    logger.error('[ExternalReview] AI extraction failed:', err.message);
    return [];
  }
}

// ─── Filtering & Normalization ──────────────────────────────────────

function filterAndNormalize(reviews) {
  return reviews
    .filter((r) => {
      // Must have rating >= MIN_RATING
      const rating = Number(r.rating);
      return !isNaN(rating) && rating >= MIN_RATING;
    })
    .map((r) => ({
      authorName: r.author ? String(r.author).trim().slice(0, 200) : null,
      authorPhoto: r.authorPhoto || null,
      rating: Math.min(5, Math.max(1, Number(r.rating))),
      title: r.title ? String(r.title).trim().slice(0, 500) : null,
      text: r.text ? String(r.text).trim().slice(0, 5000) : null,
      reviewDate: r.date ? parseDate(r.date) : null,
      language: r.language ? String(r.language).trim().slice(0, 10) : null,
      externalId: r.platformReviewId ? String(r.platformReviewId).trim() : null,
    }))
    .filter((r) => r.text || r.title); // Must have at least text or title
}

function parseDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    // Don't accept future dates or dates before 2010
    if (d > new Date() || d < new Date('2010-01-01')) return null;
    return d;
  } catch {
    return null;
  }
}

// ─── Single URL Crawl ───────────────────────────────────────────────

async function crawlReviews(url, platform, tourTitle) {
  const errors = [];
  let reviews = [];

  try {
    // 1. Fetch page
    const { html } = await fetchPage(url);

    // 2. Extract review section (smart trimming)
    const sectionHtml = extractReviewSection(html, platform);

    // 3. AI extraction
    const rawReviews = await extractReviewsWithAI(sectionHtml, platform, tourTitle);

    // 4. Filter and normalize
    reviews = filterAndNormalize(rawReviews);

    logger.info(`[ExternalReview] Crawled ${url}: ${rawReviews.length} raw → ${reviews.length} filtered (4+ stars)`);
  } catch (err) {
    logger.error(`[ExternalReview] Failed to crawl ${url}:`, err.message);
    errors.push(`${platform}: ${err.message}`);
  }

  return { reviews, errors };
}

// ─── Tour Sync ──────────────────────────────────────────────────────

async function syncTourReviews(tourId) {
  const tour = await prisma.tour.findUnique({
    where: { id: tourId },
    select: { id: true, title: true, externalReviewUrls: true },
  });

  if (!tour) throw new Error(`Tour ${tourId} not found`);
  if (!tour.externalReviewUrls || !Array.isArray(tour.externalReviewUrls) || tour.externalReviewUrls.length === 0) {
    return { imported: 0, skipped: 0, errors: [], total: 0 };
  }

  let totalImported = 0;
  let totalSkipped = 0;
  const allErrors = [];

  for (const { platform, url } of tour.externalReviewUrls) {
    try {
      const detectedPlatform = platform || detectPlatform(url);
      const { reviews, errors } = await crawlReviews(url, detectedPlatform, tour.title);

      allErrors.push(...errors);

      for (const review of reviews) {
        try {
          const externalId = review.externalId || `${detectedPlatform}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          await prisma.externalReview.upsert({
            where: {
              tourId_platform_externalId: {
                tourId: tour.id,
                platform: detectedPlatform,
                externalId,
              },
            },
            create: {
              tourId: tour.id,
              platform: detectedPlatform,
              platformUrl: url,
              externalId,
              authorName: review.authorName,
              authorPhoto: review.authorPhoto,
              rating: review.rating,
              title: review.title,
              text: review.text,
              reviewDate: review.reviewDate,
              language: review.language,
            },
            update: {
              authorName: review.authorName,
              authorPhoto: review.authorPhoto,
              rating: review.rating,
              title: review.title,
              text: review.text,
              reviewDate: review.reviewDate,
              language: review.language,
              importedAt: new Date(),
            },
          });
          totalImported++;
        } catch (err) {
          // Unique constraint violation = duplicate, skip
          if (err.code === 'P2002') {
            totalSkipped++;
          } else {
            logger.error(`[ExternalReview] Upsert failed for review:`, err.message);
            allErrors.push(`Upsert: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[ExternalReview] Platform ${platform} sync failed:`, err.message);
      allErrors.push(`${platform}: ${err.message}`);
    }
  }

  // Invalidate review caches after sync
  try {
    cache.invalidateReviewCaches(tourId);
  } catch (err) {
    logger.warn('[ExternalReview] Cache invalidation failed:', err.message);
  }

  return {
    imported: totalImported,
    skipped: totalSkipped,
    errors: allErrors,
    total: totalImported + totalSkipped,
  };
}

// ─── Weekly Bulk Sync ───────────────────────────────────────────────

async function runWeeklyReviewSync() {
  const startTime = Date.now();
  logger.info('[ExternalReview] Starting weekly review sync...');

  // Find all tours with external review URLs
  const tours = await prisma.tour.findMany({
    where: {
      externalReviewUrls: { not: null },
      status: 'ACTIVE',
    },
    select: { id: true, title: true },
  });

  if (tours.length === 0) {
    logger.info('[ExternalReview] No tours with external review URLs found');
    return { toursProcessed: 0, totalImported: 0, totalErrors: 0 };
  }

  let totalImported = 0;
  let totalErrors = 0;
  let processed = 0;

  // Process in batches of MAX_CONCURRENT_SYNCS
  for (let i = 0; i < tours.length; i += MAX_CONCURRENT_SYNCS) {
    const batch = tours.slice(i, i + MAX_CONCURRENT_SYNCS);
    const results = await Promise.allSettled(
      batch.map((tour) => syncTourReviews(tour.id))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        totalImported += result.value.imported;
        totalErrors += result.value.errors.length;
      } else {
        totalErrors++;
        logger.error('[ExternalReview] Batch sync failed:', result.reason?.message);
      }
      processed++;
    }

    // Small delay between batches to avoid overwhelming external sites
    if (i + MAX_CONCURRENT_SYNCS < tours.length) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[ExternalReview] Weekly sync complete: ${processed} tours, ${totalImported} imported, ${totalErrors} errors in ${duration}s`);

  return { toursProcessed: processed, totalImported, totalErrors };
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  detectPlatform,
  fetchPage,
  extractReviewSection,
  extractReviewsWithAI,
  filterAndNormalize,
  crawlReviews,
  syncTourReviews,
  runWeeklyReviewSync,
  MIN_RATING,
  MAX_HTML_SIZE,
  FETCH_TIMEOUT_MS,
};