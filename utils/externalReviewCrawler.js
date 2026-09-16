/**
 * External Review Crawler
 *
 * Scrapes reviews from external platforms and stores them for a tour.
 *
 * Platform strategy:
 *   - tripadvisor / viator → Puppeteer + TripAdvisor DOM selectors
 *   - getyourguide        → Puppeteer + GetYourGuide DOM selectors
 *   - google              → Puppeteer + Google Maps DOM selectors
 *   - other               → fetch + MiMo AI extraction (generic fallback)
 *
 * All imported reviews are filtered to 4+ stars. Scraping runs through a real
 * headless Chromium because every one of these platforms renders reviews
 * client-side (the static HTML is an empty SPA shell), and TripAdvisor serves a
 * DataDome CAPTCHA to plain fetch requests.
 *
 * @module utils/externalReviewCrawler
 */

const crypto = require('crypto');
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
const MAX_PAGES = 50; // pagination depth per URL
const DELAY_BETWEEN_PAGES_MS = 4000;
const PAGE_TIMEOUT_MS = 30000;
const SELECTOR_TIMEOUT_MS = 10000;

// Platform detection regexes
const PLATFORM_PATTERNS = {
  google: /google\.com|goo\.gl|maps\.google/i,
  viator: /viator\.com|tripadvisor\.com/i,
  getyourguide: /getyourguide\.com/i,
};

// Platform-specific review card selectors (battle-tested against the live sites)
const REVIEW_CARD_SELECTORS = {
  tripadvisor: '[data-automation="reviewCard"], .review-container, .biGQs._P.pZUbB.KxBGd',
  getyourguide: '[data-activity-review-card], .review-card, .review',
  google: '.jftiEf, .review-container, [class*="review-item"], [data-review-id]',
};

// ─── Platform Detection ─────────────────────────────────────────────

function detectPlatform(url) {
  for (const [platform, pattern] of Object.entries(PLATFORM_PATTERNS)) {
    if (pattern.test(url)) return platform;
  }
  return 'other';
}

/** Map the raw platform to the scraper key (viator → tripadvisor). */
function scraperKeyFor(platform) {
  if (platform === 'viator') return 'tripadvisor';
  return platform;
}

// ─── Helpers ────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashString(str) {
  return crypto.createHash('md5').update(str).digest('hex').slice(0, 12);
}

function clampRating(rating) {
  const r = parseInt(rating, 10);
  if (isNaN(r)) return 5;
  return Math.max(1, Math.min(5, r));
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  // Reject implausible dates (before 2010 or in the future)
  if (d < new Date('2010-01-01') || d > new Date()) return null;
  return d;
}

function truncate(str, len) {
  if (!str) return null;
  const s = String(str).trim();
  return s.length > len ? s.slice(0, len) : s;
}

// ─── Challenge Page Detection ───────────────────────────────────────

function isChallengePage(html) {
  const indicators = [
    'captcha-delivery.com',
    'cf-browser-verification',
    'challenge-platform',
    'DataDome CAPTCHA',
    'geo.captcha-delivery.com',
    'hcaptcha.com/recaptcha',
    'grecaptcha',
  ];
  const lower = html.toLowerCase();
  return indicators.some((i) => lower.includes(i.toLowerCase()));
}

// ─── Browser Management ─────────────────────────────────────────────

let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.connected) return sharedBrowser;
  const puppeteer = require('puppeteer');
  sharedBrowser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });
  return sharedBrowser;
}

async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
}

async function newStealthPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1920, height: 1080 });
  // Hide the webdriver flag — the single most effective anti-detection tweak
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return page;
}

// ─── TripAdvisor Scraper ────────────────────────────────────────────

async function scrapeTripAdvisor(page, url, tourTitle) {
  const reviews = [];

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const pageUrl = pageNum === 1
      ? url
      : url.replace('-Review-', `-Review-or${(pageNum - 1) * 10}-`);

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });
      await page.waitForSelector(REVIEW_CARD_SELECTORS.tripadvisor, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => {});

      const pageReviews = await page.evaluate((selector) => {
        const cards = document.querySelectorAll(selector);
        return Array.from(cards).map((card) => {
          const ratingEl = card.querySelector('[class*="bubble_"]');
          const ratingMatch = (ratingEl?.className || '').match(/bubble_(\d+)/);
          const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : 5;

          const nameEl = card.querySelector('.info_text .default_name, a[href*="/Profile/"] span');
          const titleEl = card.querySelector('.noQuotes, .cRVSd span');
          const textEl = card.querySelector('.partial_entry, .glasR4aX');
          const dateEl = card.querySelector('.rating .relativeDate, span[class*="eventDate"]');
          const avatarEl = card.querySelector('.avatar, img[src*="avatar"]');
          const idEl = card.querySelector('[id]');

          return {
            externalId: idEl?.id?.replace('review_', '') || null,
            author: nameEl?.textContent?.trim() || '',
            rating,
            title: titleEl?.textContent?.trim() || '',
            text: textEl?.textContent?.trim() || '',
            date: dateEl?.getAttribute('title') || dateEl?.textContent?.trim() || '',
            authorPhoto: avatarEl?.getAttribute('src') || null,
          };
        }).filter((r) => r.author || r.text);
      }, REVIEW_CARD_SELECTORS.tripadvisor);

      if (pageReviews.length === 0 && pageNum > 1) break;
      reviews.push(...pageReviews);
      logger.info(`[ExternalReview] TripAdvisor page ${pageNum}: ${pageReviews.length} reviews`);
    } catch (err) {
      logger.warn(`[ExternalReview] TripAdvisor page ${pageNum} failed: ${err.message}`);
      if (pageNum === 1) throw err;
      break;
    }

    if (pageNum < MAX_PAGES) await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  return reviews;
}

// ─── GetYourGuide Scraper ───────────────────────────────────────────

async function scrapeGetYourGuide(page, url, tourTitle) {
  const reviews = [];
  const baseUrl = url.split('?')[0];

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
    const pageUrl = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

    try {
      await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });
      await page.waitForSelector(REVIEW_CARD_SELECTORS.getyourguide, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => {});

      const pageReviews = await page.evaluate((selector) => {
        const cards = document.querySelectorAll(selector);
        return Array.from(cards).map((card) => {
          const nameEl = card.querySelector('.reviewer-name, .user-profile-name, [class*="userName"]');
          const titleEl = card.querySelector('.review-title, h3, [class*="reviewTitle"]');
          const textEl = card.querySelector('.review-text, .review-body, [class*="reviewText"]');
          const ratingEl = card.querySelector('[class*="rating"], [data-rating]');
          const dateEl = card.querySelector('.review-date, time, [class*="date"]');
          const avatarEl = card.querySelector('img[class*="avatar"], img[class*="profile"]');

          const ratingAttr = ratingEl?.getAttribute('data-rating') || ratingEl?.className || '';
          const ratingMatch = ratingAttr.match(/(\d+)/);
          const rating = ratingMatch ? parseInt(ratingMatch[1], 10) : 5;

          return {
            externalId: null,
            author: nameEl?.textContent?.trim() || 'Anonymous',
            rating,
            title: titleEl?.textContent?.trim() || '',
            text: textEl?.textContent?.trim() || '',
            date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '',
            authorPhoto: avatarEl?.getAttribute('src') || null,
          };
        }).filter((r) => r.author !== 'Anonymous' || r.text);
      }, REVIEW_CARD_SELECTORS.getyourguide);

      if (pageReviews.length === 0 && pageNum > 1) break;
      reviews.push(...pageReviews);
      logger.info(`[ExternalReview] GetYourGuide page ${pageNum}: ${pageReviews.length} reviews`);
    } catch (err) {
      logger.warn(`[ExternalReview] GetYourGuide page ${pageNum} failed: ${err.message}`);
      if (pageNum === 1) throw err;
      break;
    }

    if (pageNum < MAX_PAGES) await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  return reviews;
}

// ─── Google Maps Scraper ────────────────────────────────────────────

async function scrapeGoogle(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT_MS });
    await sleep(3000);

    // Open the reviews tab when present
    const reviewsTab = await page.$('[data-tab-id="reviews"], [role="tab"][aria-label*="Reviews"], button[jsaction*="reviews"]');
    if (reviewsTab) {
      await reviewsTab.click();
      await sleep(3000);
    }

    // Scroll to load more reviews
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => {
        const scrollable = document.querySelector('[class*="m6QErb"][class*="DxyBCb"], .section-scrollbox, [role="main"]');
        if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
      });
      await sleep(2000);
    }

    const reviews = await page.evaluate((selector) => {
      const els = document.querySelectorAll(selector);
      return Array.from(els).map((el) => {
        const nameEl = el.querySelector('.d4r55, .reviewer-name, [class*="userName"], span[class*="fontBodyMedium"] span:first-child');
        const ratingEl = el.querySelector('[role="img"][aria-label*="star"], .kvMYJc, [class*="rating"]');
        const textEl = el.querySelector('.wiI7pd, .review-text, [class*="reviewText"], span[class*="fontBodyMedium"]');
        const dateEl = el.querySelector('.rsqaWe, .review-date, [class*="date"]');

        let rating = 5;
        if (ratingEl) {
          const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d+)/);
          if (m) rating = parseInt(m[1], 10);
        }

        return {
          externalId: el.getAttribute('data-review-id') || null,
          author: nameEl?.textContent?.trim() || '',
          rating,
          title: '',
          text: textEl?.textContent?.trim() || '',
          date: dateEl?.textContent?.trim() || '',
          authorPhoto: null,
        };
      }).filter((r) => r.author && r.text);
    }, REVIEW_CARD_SELECTORS.google);

    logger.info(`[ExternalReview] Google Maps: ${reviews.length} reviews`);
    return reviews;
  } catch (err) {
    logger.warn(`[ExternalReview] Google scrape failed: ${err.message}`);
    throw err;
  }
}

// ─── Generic AI Fallback ────────────────────────────────────────────

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.text();
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

function extractReviewSection(html, platform) {
  if (!html) return '';
  const markers = ['review', 'Review', 'rating', 'testimonial'];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const start = Math.max(0, idx - 2000);
      return html.slice(start, start + MAX_HTML_SIZE);
    }
  }
  return html.slice(0, MAX_HTML_SIZE);
}

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
- Only actual customer reviews, not ads, tour descriptions, or navigation
- Normalize rating to a 1-5 scale
- date should be in ISO format (YYYY-MM-DD)
- Return [] if no reviews found

HTML:
${truncated}`;

  try {
    const response = await callMimo({ system: systemPrompt, user: userPrompt, maxTokens: 4096, temperature: 0.1 });
    const reviews = parseJson(response);
    if (!Array.isArray(reviews)) return [];
    return reviews.map((r) => ({
      externalId: r.platformReviewId ? String(r.platformReviewId).trim() : null,
      author: r.author ? String(r.author).trim() : null,
      rating: Number(r.rating),
      title: r.title ? String(r.title).trim() : null,
      text: r.text ? String(r.text).trim() : null,
      date: r.date || null,
      authorPhoto: null,
    }));
  } catch (err) {
    logger.error('[ExternalReview] AI extraction failed:', err.message);
    return [];
  }
}

// ─── Normalization ──────────────────────────────────────────────────

function filterAndNormalize(reviews) {
  return reviews
    .filter((r) => {
      const rating = Number(r.rating);
      return !isNaN(rating) && rating >= MIN_RATING;
    })
    .map((r) => ({
      externalId: r.externalId || null,
      authorName: truncate(r.author, 200),
      authorPhoto: r.authorPhoto || null,
      rating: clampRating(r.rating),
      title: truncate(r.title, 500),
      text: truncate(r.text, 5000),
      reviewDate: normalizeDate(r.date),
      language: null,
    }))
    .filter((r) => r.text || r.title);
}

// ─── Single URL Crawl ───────────────────────────────────────────────

async function crawlReviews(url, platform, tourTitle) {
  const errors = [];
  let reviews = [];

  try {
    const scraperKey = scraperKeyFor(platform);

    if (scraperKey === 'tripadvisor' || scraperKey === 'getyourguide' || scraperKey === 'google') {
      const browser = await getBrowser();
      const page = await newStealthPage(browser);
      try {
        let raw;
        if (scraperKey === 'tripadvisor') raw = await scrapeTripAdvisor(page, url, tourTitle);
        else if (scraperKey === 'getyourguide') raw = await scrapeGetYourGuide(page, url, tourTitle);
        else raw = await scrapeGoogle(page, url);
        reviews = filterAndNormalize(raw);
      } finally {
        await page.close().catch(() => {});
      }
    } else {
      // Generic fallback: fetch + AI extraction
      const html = await fetchPage(url);
      if (isChallengePage(html)) {
        throw new Error('Bot protection challenge detected — this platform needs its official API or a captcha-solving service.');
      }
      const section = extractReviewSection(html, platform);
      const raw = await extractReviewsWithAI(section, platform, tourTitle);
      reviews = filterAndNormalize(raw);
    }

    logger.info(`[ExternalReview] ${platform} ${url}: ${reviews.length} reviews imported (4+ stars)`);
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
          const externalId = review.externalId
            || `${detectedPlatform}-${hashString(review.authorName + (review.text || '').slice(0, 100))}`;

          await prisma.externalReview.upsert({
            where: {
              tourId_platform_externalId: { tourId: tour.id, platform: detectedPlatform, externalId },
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
              importedAt: new Date(),
            },
          });
          totalImported++;
        } catch (err) {
          if (err.code === 'P2002') {
            totalSkipped++;
          } else {
            logger.error('[ExternalReview] Upsert failed:', err.message);
            allErrors.push(`Upsert: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[ExternalReview] Platform ${platform} sync failed:`, err.message);
      allErrors.push(`${platform}: ${err.message}`);
    }
  }

  try {
    cache.invalidateReviewCaches(tourId);
  } catch (err) {
    logger.warn('[ExternalReview] Cache invalidation failed:', err.message);
  }

  return { imported: totalImported, skipped: totalSkipped, errors: allErrors, total: totalImported + totalSkipped };
}

// ─── Weekly Bulk Sync ───────────────────────────────────────────────

async function runWeeklyReviewSync() {
  const startTime = Date.now();
  logger.info('[ExternalReview] Starting weekly review sync...');

  const tours = await prisma.tour.findMany({
    where: { externalReviewUrls: { not: null }, status: 'ACTIVE' },
    select: { id: true, title: true },
  });

  if (tours.length === 0) {
    logger.info('[ExternalReview] No tours with external review URLs found');
    return { toursProcessed: 0, totalImported: 0, totalErrors: 0 };
  }

  let totalImported = 0;
  let totalErrors = 0;
  let processed = 0;

  try {
    for (let i = 0; i < tours.length; i += MAX_CONCURRENT_SYNCS) {
      const batch = tours.slice(i, i + MAX_CONCURRENT_SYNCS);
      const results = await Promise.allSettled(batch.map((t) => syncTourReviews(t.id)));

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

      if (i + MAX_CONCURRENT_SYNCS < tours.length) await sleep(2000);
    }
  } finally {
    await closeBrowser();
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(`[ExternalReview] Weekly sync complete: ${processed} tours, ${totalImported} imported, ${totalErrors} errors in ${duration}s`);

  return { toursProcessed: processed, totalImported, totalErrors };
}

// ─── Exports ────────────────────────────────────────────────────────

module.exports = {
  detectPlatform,
  scraperKeyFor,
  fetchPage,
  extractReviewSection,
  extractReviewsWithAI,
  filterAndNormalize,
  isChallengePage,
  crawlReviews,
  syncTourReviews,
  runWeeklyReviewSync,
  getBrowser,
  closeBrowser,
  MIN_RATING,
  MAX_HTML_SIZE,
  FETCH_TIMEOUT_MS,
  MAX_PAGES,
  SYNC_CACHE_TTL,
};
