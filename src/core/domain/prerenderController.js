/**
 * Lightweight prerender endpoint for SEO.
 *
 * When a bot hits a storefront, its Vercel Edge Middleware proxies the request
 * here as `/api/prerender?url=<path>&host=<storefront host>`. It fetches the
 * page data from the internal API, builds a full HTML page with meta tags,
 * Open Graph, Twitter Cards and JSON-LD structured data, and returns it. No
 * headless browser needed — just API calls + string concatenation.
 *
 * This gives bots (Googlebot, Bingbot, social scrapers) fully rendered HTML
 * with all SEO markup, while users get the fast SPA.
 *
 * Brand-aware: the brand is resolved per REQUEST from `host`, so
 * www.travioghana.com gets Travio Ghana titles, canonicals, social profiles
 * and Ghana catalogue data — never another brand's domain. `host` is optional:
 * requests that omit it (older middleware, direct calls) fall back to
 * Expedition-Go Tours, exactly the behaviour every deployment had before this
 * parameter existed, so shipping this endpoint is safe in any order with the
 * storefront deploys.
 *
 * Failure modes are crawler-safe: an unknown URL answers a real 404, and an
 * upstream hiccup answers a retryable 503 *HTML* page (never JSON), so a bad
 * minute is retried instead of being indexed as a broken page.
 */

const https = require('https');
const http = require('http');

// ── Brands ──────────────────────────────────────────────────────────
// One prerender service backs several storefronts; keys are hosts with the
// leading `www.` stripped, the lookup normalises `www.`/port/origin away.
const BRANDS = {
  travioghana: {
    url: 'https://www.travioghana.com',
    name: 'Travio Ghana',
    // Catalogue namespace for this brand's listing/detail endpoints.
    apiBrand: 'travioghana',
    // Travio Ghana has no X/Twitter profile — omit twitter:site rather than
    // point at another brand's account.
    twitterSite: '',
    logo: { url: 'https://www.travioghana.com/logo.png', width: 512, height: 512 },
    // Branded 1200x630 social card shipped by the storefront; the Cloudinary
    // hero it replaces was404, so every non-tour page shared a dead card.
    defaultImage: { url: 'https://www.travioghana.com/og-default.png', width: 1200, height: 630 },
    sameAs: [
      'https://www.facebook.com/p/Travio%20Ghana-Tours-LTD-61567042001418/',
      'https://www.instagram.com/travioGhanatours',
      'https://www.tiktok.com/@expeditiongotours',
      'https://www.youtube.com/c/ExpeditionGoTravelandToursLTD',
    ],
  },
  expedition: {
    url: 'https://www.expeditiongotours.com',
    name: 'Expedition-Go Tours',
    apiBrand: 'expedition',
    twitterSite: '@ExpeditionGo',
    logo: { url: 'https://www.expeditiongotours.com/logo.png', width: 320, height: 320 },
    // Was a Cloudinary hero that now404s, which left every non-tour page
    // sharing a dead social card.
    defaultImage: { url: 'https://www.expeditiongotours.com/logo.png', width: 320, height: 320 },
    sameAs: ['https://www.facebook.com/expeditiongo', 'https://www.instagram.com/expeditiongo'],
  },
};

const HOST_BRANDS = {
  'travioghana.com': 'travioghana',
  'expeditiongotours.com': 'expedition',
};

/**
 * Default brand for requests that do not identify a storefront. Kept as
 * Expedition-Go Tours (the historical behaviour) and still overridable through
 * SITE_URL / SITE_NAME so existing deployments keep their config-driven host.
 */
const DEFAULT_BRAND = {
  ...BRANDS.expedition,
  url: (process.env.SITE_URL || BRANDS.expedition.url).replace(/\/+$/, ''),
  name: process.env.SITE_NAME || BRANDS.expedition.name,
};

/** Accepts `www.host`, `host:443` or a full origin and returns a bare host. */
function normalizeHost(value) {
  if (!value) return '';
  let v = String(value).trim().toLowerCase();
  const proto = v.indexOf('://');
  if (proto > -1) v = v.slice(proto + 3);
  v = v.split('/')[0].split('?')[0].split(':')[0];
  return v.startsWith('www.') ? v.slice(4) : v;
}

function resolveBrand(req) {
  const raw =
    (req.query && req.query.host) ||
    req.headers['x-forwarded-host'] ||
    req.headers['x-original-host'] ||
    req.headers.host ||
    '';
  const host = normalizeHost(Array.isArray(raw) ? raw[0] : raw);
  const key = host && HOST_BRANDS[host];
  return (key && BRANDS[key]) || DEFAULT_BRAND;
}

/** Every page copies may say `{brand}`; resolved per request. */
function brandify(text, site) {
  return String(text == null ? '' : text).replace(/\{brand\}/g, site.name);
}

class HttpError extends Error {
  constructor(statusCode, url) {
    super(`HTTP ${statusCode} for ${url}`);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        // A non-2xx must NOT resolve to null: the old behaviour silently
        // turned an API 429/500 into a 404 or an "0 experiences" page, which
        // a crawler would happily index.
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new HttpError(res.statusCode, url));
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new HttpError(res.statusCode, url));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function metaTag(name, content) {
  if (!content) return '';
  return `<meta name="${name}" content="${escapeHtml(content)}">`;
}

function ogTag(property, content) {
  if (!content) return '';
  return `<meta property="${property}" content="${escapeHtml(content)}">`;
}

// Site-wide internal links. Rendered into every prerendered page so crawlers
// can discover pages by following links, not just by reading the sitemap.
const NAV_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/tours', label: 'Tours' },
  { href: '/about-us', label: 'About Us' },
  { href: '/stories', label: 'Stories' },
  { href: '/reviews', label: 'Reviews' },
  { href: '/blog', label: 'Blog' },
  { href: '/faq', label: 'FAQ' },
  { href: '/contact-us', label: 'Contact' },
];

const FOOTER_LINKS = [
  { href: '/tours', label: 'All Tours' },
  { href: '/about-us', label: 'About Us' },
  { href: '/careers', label: 'Careers' },
  { href: '/partnerships', label: 'Partnerships' },
  { href: '/content-creators', label: 'Content Creators' },
  { href: '/travel-agents', label: 'Travel Agents' },
  { href: '/hotels', label: 'Hotels' },
  { href: '/transport', label: 'Transport' },
  { href: '/transport-providers', label: 'Transport Providers' },
  { href: '/foundation', label: 'Foundation' },
  { href: '/faq', label: 'FAQ' },
  { href: '/help-centre', label: 'Help Centre' },
  { href: '/contact-us', label: 'Contact Us' },
  { href: '/terms-and-conditions', label: 'Terms & Conditions' },
  { href: '/privacy-policy', label: 'Privacy Policy' },
  { href: '/cookies-policy', label: 'Cookie Policy' },
  { href: '/refund-policy', label: 'Refund Policy' },
  { href: '/supplier-terms', label: 'Supplier Terms' },
];

function linkList(links, site) {
  return links
    .map((l) => `<a href="${site.url}${l.href}">${escapeHtml(l.label)}</a>`)
    .join('\n        ');
}

function buildHtml(site, { title, description, keywords, image, url, canonical, type, jsonLd, price, rating, robots, bodyHtml }) {
  const SITE_URL = site.url;
  const SITE_NAME = site.name;
  const fullTitle = `${title} | ${SITE_NAME}`;
  const ogImage = image && String(image).startsWith('http') ? image : `${SITE_URL}${image || ''}`;
  // Declare dimensions only when they are ours to vouch for: the branded card
  // ships at a fixed 1200x630, tour photos and logo fallbacks are left alone.
  const isBrandCard = ogImage === site.defaultImage.url;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${metaTag('description', description)}
  ${keywords ? metaTag('keywords', keywords) : ''}
  <link rel="canonical" href="${canonical || url}">
  <meta name="robots" content="${robots || 'index, follow'}">
  ${ogTag('og:type', type || 'website')}
  ${ogTag('og:title', title)}
  ${ogTag('og:description', description)}
  ${ogTag('og:image', ogImage)}
  ${isBrandCard ? ogTag('og:image:width', String(site.defaultImage.width)) : ''}
  ${isBrandCard ? ogTag('og:image:height', String(site.defaultImage.height)) : ''}
  ${ogTag('og:url', url)}
  ${ogTag('og:site_name', SITE_NAME)}
  ${ogTag('og:locale', 'en_US')}
  ${price ? ogTag('og:price:amount', price.amount) : ''}
  ${price ? ogTag('og:price:currency', price.currency) : ''}
  <meta name="twitter:card" content="summary_large_image">
  ${site.twitterSite ? `<meta name="twitter:site" content="${escapeHtml(site.twitterSite)}">\n  ` : ''}
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <title>${escapeHtml(fullTitle)}</title>
  ${jsonLd ? jsonLd.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n  ') : ''}
</head>
<body>
  <header>
    <nav aria-label="Main">
        ${linkList(NAV_LINKS, site)}
    </nav>
  </header>
  <main>
    <div id="root">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${rating ? `<p>Rating: ${rating.value}/5 (${rating.count} reviews)</p>` : ''}
      <nav aria-label="Breadcrumb">
        <a href="${SITE_URL}">Home</a> &gt;
        <a href="${SITE_URL}/tours">Tours</a> &gt;
        <span>${escapeHtml(title)}</span>
      </nav>
      ${bodyHtml || ''}
    </div>
  </main>
  <footer>
    <nav aria-label="Footer">
        ${linkList(FOOTER_LINKS, site)}
    </nav>
    <p>&copy; ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved.</p>
  </footer>
  <script>window.__PRERENDERED__ = true;</script>
</body>
</html>`;
}

function buildOrganizationSchema(site) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: site.name,
    url: site.url,
    // Must be a real, crawlable asset: a source path (`/src/...`) is never
    // served by the build and404s for Google. ImageObject (not a bare URL) so
    // the knowledge panel gets an explicit intrinsic size.
    logo: {
      '@type': 'ImageObject',
      url: site.logo.url,
      width: site.logo.width,
      height: site.logo.height,
    },
    sameAs: site.sameAs,
    contactPoint: { '@type': 'ContactPoint', contactType: 'customer service', availableLanguage: ['English', 'French'] },
  };
}

function buildWebSiteSchema(site) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: site.name,
    url: site.url,
    potentialAction: {
      '@type': 'SearchAction',
      // /tours?place= is the site's real, prerendered search surface (the SPA
      // route /search never reaches a crawler), so this is the working target.
      target: `${site.url}/tours?place={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  };
}

function buildBreadcrumbSchema(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/**
 * Canonical tour URL: /tour/<id>/<slug>.
 *
 * The storefront links, canonicalises to and sitemaps this form (the id keeps
 * the URL alive across slug edits), so the prerendered copy must agree with it.
 * Older payloads without an id fall back to the slug-only form, which the SPA
 * still resolves and canonicalises upwards.
 */
function tourUrl(site, tour) {
  const id = tour && tour.id ? encodeURIComponent(tour.id) : '';
  const slug = tour && tour.slug ? encodeURIComponent(tour.slug) : '';
  if (id && slug) return `${site.url}/tour/${id}/${slug}`;
  return `${site.url}/tour/${id || slug}`;
}

function buildProductSchema(site, tour) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: tour.title,
    description: (tour.description || tour.title || '').slice(0, 500),
    image: tour.coverPhoto || (tour.photos && tour.photos[0]) || site.defaultImage.url,
    url: tourUrl(site, tour),
    brand: { '@type': 'Organization', name: site.name },
    offers: {
      '@type': 'Offer',
      price: tour.startingPrice || 0,
      priceCurrency: tour.currency || 'USD',
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: site.name },
    },
  };
  // Report the combined (in-app + external) standing when the API provides it,
  // falling back to the internal stats.
  const ratingValue = tour.combinedRating != null ? tour.combinedRating : tour.averageRating;
  const reviewCountValue = tour.combinedReviewCount != null ? tour.combinedReviewCount : tour.reviewCount;
  if (ratingValue && reviewCountValue) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue,
      reviewCount: reviewCountValue,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return schema;
}

// ── Page handlers ────────────────────────────────────────────────────

/** Internal API base. Brand lives in the path, not the host. */
function apiBase() {
  return (process.env.API_URL || 'http://localhost:5000').replace(/\/+$/, '');
}

async function handleTourPage(site, slugOrId) {
  const api = `${apiBase()}/api/${site.apiBrand}/tours/${encodeURIComponent(slugOrId)}`;
  let body;
  try {
    body = await fetchJson(api);
  } catch (err) {
    // Genuinely missing tour → let the caller answer a real 404.
    if (err instanceof HttpError && err.statusCode === 404) return null;
    throw err;
  }
  // API response is nested: data.tour.tour (brand listing -> tour)
  const listing = (body && body.data && body.data.tour) || (body && body.data);
  const tour = (listing && listing.tour) || listing;
  if (!tour || !tour.title) return null;

  const city = tour.city || (tour.location && tour.location.split(',')[0].trim()) || 'Ghana';
  const region = tour.location ? tour.location.split(',')[1].trim() : '';
  const image = tour.coverPhoto || (tour.photos && tour.photos[0]) || site.defaultImage.url;
  const durationLabel = tour.durationMinutes
    ? `${Math.floor(tour.durationMinutes / 60)}h${tour.durationMinutes % 60 ? ` ${tour.durationMinutes % 60}m` : ''}`
    : 'Experience';

  // Related tours — internal links so crawlers discover the rest of the
  // catalogue from any tour page. Best-effort: a failure never blocks the page.
  let relatedHtml = '';
  try {
    const listData = await fetchJson(`${apiBase()}/api/${site.apiBrand}/tours?limit=8`);
    const others = ((listData && listData.data && listData.data.tours) || [])
      .map((l) => l.tour || l)
      .filter((t) => t && t.slug && t.slug !== slugOrId)
      .slice(0, 6);
    if (others.length) {
      relatedHtml = `<section aria-label="Related tours">
        <h2>More tours in Ghana</h2>
        <ul>
          ${others.map((t) => `<li><a href="${tourUrl(site, t)}">${escapeHtml(t.title)}</a></li>`).join('\n          ')}
        </ul>
      </section>`;
    }
  } catch { /* related tours are non-critical */ }

  const highlights = Array.isArray(tour.highlights) ? tour.highlights.filter(Boolean).slice(0, 8) : [];

  const bodyHtml = `
      <p><strong>Duration:</strong> ${escapeHtml(durationLabel)}</p>
      ${tour.category ? `<p><strong>Category:</strong> ${escapeHtml(tour.category)}</p>` : ''}
      ${tour.startingPrice ? `<p><strong>From:</strong> $${escapeHtml(String(tour.startingPrice))} ${escapeHtml(tour.currency || 'USD')} per person</p>` : ''}
      ${tour.description ? `<section aria-label="Description"><h2>About this tour</h2><p>${escapeHtml(tour.description)}</p></section>` : ''}
      ${highlights.length ? `<section aria-label="Highlights"><h2>Highlights</h2><ul>${highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join('')}</ul></section>` : ''}
      <p><a href="${tourUrl(site, tour)}">Book this tour on ${escapeHtml(site.name)}</a></p>
      ${relatedHtml}`;

  return buildHtml(site, {
    title: `${tour.title} in ${city}`,
    description: `${tour.title} - ${durationLabel} in ${city}${region ? ', ' + region : ''}, Ghana. Book from $${tour.startingPrice || 0}. ${tour.averageRating ? `Rated ${tour.averageRating}/5` : ''} Free cancellation, instant confirmation.`,
    keywords: `${tour.title}, ${city} tours, ${tour.category || 'tours'} in ${city}, Ghana tours, book ${tour.title}, things to do in ${city}`,
    image,
    url: tourUrl(site, tour),
    canonical: tourUrl(site, tour),
    type: 'product',
    price: { amount: String(tour.startingPrice || 0), currency: tour.currency || 'USD' },
    rating: tour.averageRating && tour.reviewCount ? { value: tour.averageRating, count: tour.reviewCount } : undefined,
    bodyHtml,
    jsonLd: [
      buildProductSchema(site, tour),
      buildBreadcrumbSchema([
        { name: 'Home', url: `${site.url}/` },
        { name: region || 'Ghana', url: `${site.url}/tours` },
        { name: city, url: `${site.url}/tours?place=${encodeURIComponent(city)}` },
        { name: tour.title, url: tourUrl(site, tour) },
      ]),
    ],
  });
}

async function handleListingsPage(site, place) {
  const api = apiBase();
  const url = place
    ? `${api}/api/${site.apiBrand}/tours?limit=50&place=${encodeURIComponent(place)}`
    : `${api}/api/${site.apiBrand}/tours?limit=50`;
  // A failed catalogue fetch must not masquerade as an empty destination page.
  const data = await fetchJson(url);
  const listings = (data && data.data && data.data.tours) || [];
  const tours = listings.map((l) => l.tour || l).filter(Boolean);
  const count = tours.length;

  const title = place ? `Tours in ${place} | ${count} experiences` : 'Ghana Tours & Experiences';
  const description = place
    ? `Discover ${count} tours and experiences in ${place}, Ghana. Book cultural tours, food tours, wildlife safaris, and adventure activities. Free cancellation, best prices guaranteed.`
    : `Explore ${count} authentic Ghana tours and experiences. Book cultural tours, wildlife safaris, food tours, and adventure activities. Free cancellation.`;

  const keywords = place
    ? `${place} tours, things to do in ${place}, ${place} Ghana, ${place} activities, Ghana tours`
    : 'Ghana tours, things to do in Ghana, Ghana experiences, Accra tours, Cape Coast tours, Ghana safari';

  // ?place= accepts any string, so a typo or an invented town would otherwise
  // mint a crawlable near-duplicate of /tours. Empty results are a dead end:
  // keep them served (shareable URLs must keep working) but take them out of
  // the index.
  const robots = place && count === 0 ? 'noindex, follow' : undefined;

  return buildHtml(site, {
    title,
    description,
    keywords,
    robots,
    image: (tours[0] && tours[0].coverPhoto) || site.defaultImage.url,
    url: place ? `${site.url}/tours?place=${encodeURIComponent(place)}` : `${site.url}/tours`,
    canonical: place ? `${site.url}/tours?place=${encodeURIComponent(place)}` : `${site.url}/tours`,
    jsonLd: [
      buildBreadcrumbSchema([
        { name: 'Home', url: `${site.url}/` },
        ...(place ? [{ name: place, url: `${site.url}/tours?place=${encodeURIComponent(place)}` }] : []),
        { name: 'Tours', url: `${site.url}/tours` },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        numberOfItems: count,
        itemListElement: tours.slice(0, 20).map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: t.title,
          url: tourUrl(site, t),
        })),
      },
    ],
  });
}

/**
 * Customer-facing FAQs shown on the crawler homepage (and emitted as FAQPage
 * structured data). Copy is deliberately brand-neutral and policy-free beyond
 * what every brand guarantees, so one table serves all storefronts.
 */
const HOME_FAQS = [
  {
    q: 'How do I book a tour in Ghana?',
    a: 'Choose an experience, pick your date and group size, and pay online. You receive instant confirmation plus a booking voucher by email.',
  },
  {
    q: 'Who operates the tours listed here?',
    a: 'Vetted local tour operators, licensed guides and transport partners across Ghana. Every listing is reviewed by our team before it goes live.',
  },
  {
    q: 'Can I change or cancel my booking?',
    a: 'Each tour page shows its own change and cancellation policy before you pay, so you always know the terms that apply to your date.',
  },
  {
    q: 'Do tours include hotel or airport pickup?',
    a: 'Many experiences in Accra and the coastal towns offer pickup. The tour page and your confirmation email state the meeting or pickup details.',
  },
  {
    q: 'How do I get help with a booking?',
    a: 'Contact our support team and quote your booking reference — the contact link is in the footer of every page.',
  },
];

function buildFaqSchema(faqs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

/**
 * Crawler homepage.
 *
 * Used to be a title + one paragraph, which gave Google a thin page to rank
 * for the brand's own name ("Ghana tours" is impossible without content and
 * internal links). It now carries the real catalogue: popular tours, the
 * destination listings, trust points and FAQs (with FAQPage markup).
 *
 * A failing catalogue fetch must never take the homepage down or serve a
 * half-built page — it degrades to the previous static version.
 */
async function handleHomePage(site) {
  let tours = [];
  try {
    const api = apiBase();
    const data = await fetchJson(`${api}/api/${site.apiBrand}/tours?limit=50`);
    tours = ((data && data.data && data.data.tours) || [])
      .map((l) => l.tour || l)
      .filter((t) => t && t.title);
  } catch (err) {
    console.error(`[prerender] homepage catalogue fetch failed for ${site.host}: ${err.message}`);
  }

  const featured = tours.slice(0, 6);
  const destinations = [];
  for (const t of tours) {
    for (const place of [t.city, t.region]) {
      if (place && !destinations.includes(place)) destinations.push(place);
    }
  }
  const topDestinations = destinations.slice(0, 10);

  const sections = [];

  if (featured.length > 0) {
    const items = featured
      .map((t) => {
        const price = t.price ? ` &mdash; from ${escapeHtml(String(t.price.currency || 'USD'))} ${escapeHtml(String(t.price.amount))}` : '';
        const rating = t.averageRating
          ? ` &middot; rated ${escapeHtml(String(Number(t.averageRating).toFixed(1)))}/5${t.reviewCount ? ` (${escapeHtml(String(t.reviewCount))} reviews)` : ''}`
          : '';
        return `          <li><a href="${escapeHtml(tourUrl(site, t))}">${escapeHtml(t.title)}</a>${price}${rating}</li>`;
      })
      .join('\n');
    sections.push(`<section aria-label="Popular tours">
        <h2>Popular Ghana tours &amp; experiences</h2>
        <ul>
${items}
        </ul>
        <p><a href="${site.url}/tours">Browse all ${tours.length} tours</a></p>
      </section>`);
  }

  if (topDestinations.length > 0) {
    const items = topDestinations
      .map((p) => `          <li><a href="${site.url}/tours?place=${encodeURIComponent(p)}">Tours in ${escapeHtml(p)}</a></li>`)
      .join('\n');
    sections.push(`<section aria-label="Destinations">
        <h2>Explore Ghana by destination</h2>
        <ul>
${items}
        </ul>
      </section>`);
  }

  sections.push(`<section aria-label="Why book with us">
        <h2>Why book with ${escapeHtml(site.name)}</h2>
        <ul>
          <li>Book authentic Ghana tours, activities and transport in one place</li>
          <li>Instant confirmation and free cancellation on eligible experiences</li>
          <li>Vetted local operators and licensed guides</li>
          <li>Secure online payment and clear pricing in USD or GHS</li>
        </ul>
      </section>`);

  sections.push(`<section aria-label="Frequently asked questions">
        <h2>Frequently asked questions</h2>
        <dl>
${HOME_FAQS.map((f) => `          <dt>${escapeHtml(f.q)}</dt>\n          <dd>${escapeHtml(f.a)}</dd>`).join('\n')}
        </dl>
      </section>`);

  const jsonLd = [buildOrganizationSchema(site), buildWebSiteSchema(site), buildFaqSchema(HOME_FAQS)];
  if (featured.length > 0) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: `Popular tours on ${site.name}`,
      itemListElement: featured.map((t, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: tourUrl(site, t),
        name: t.title,
      })),
    });
  }

  return buildHtml(site, {
    title: 'Ghana Tours & Experiences | Book Authentic African Adventures',
    description: 'Discover authentic Ghana tours and experiences. Book cultural tours, wildlife safaris, food tours, and adventure activities across Accra, Cape Coast, Volta Region, and more. Free cancellation, best prices guaranteed.',
    keywords: 'Ghana tours, things to do in Ghana, Ghana experiences, Accra tours, Cape Coast tours, Ghana safari, Ghana food tour, Ghana cultural tour, West Africa tours, African vacation, Ghana travel',
    image: site.defaultImage.url,
    url: `${site.url}/`,
    canonical: `${site.url}/`,
    jsonLd,
    bodyHtml: sections.join('\n      '),
  });
}

function handleStaticPage(site, path) {
  // Copy is brand-neutral on purpose: `{brand}` resolves to the requesting
  // brand, so one table serves every storefront.
  const pages = {
    '/about-us': {
      title: 'About Us',
      description: 'Learn about {brand} — Ghana\'s premier tour platform. We connect travelers with authentic local experiences across Ghana.',
      keywords: '{brand}, about us, Ghana tour company, Ghana travel platform',
    },
    '/faq': {
      title: 'Frequently Asked Questions',
      description: 'Find answers to common questions about booking Ghana tours, cancellation policies, pickup details, and more.',
      keywords: 'Ghana tours FAQ, booking questions, cancellation policy, Ghana travel help',
    },
    '/help-centre': {
      title: 'Help Centre',
      description: 'Get help with your Ghana tour booking. Find answers about payments, cancellations, pickup, and more.',
      keywords: 'Ghana tours help, booking support, customer service',
    },
    '/contact-us': {
      title: 'Contact Us',
      description: 'Get in touch with {brand}. Contact us for booking inquiries, partnerships, and support.',
      keywords: 'contact {brand}, Ghana tours support',
    },
    '/stories': {
      title: 'Travel Stories from Ghana',
      description: 'Read inspiring travel stories from Ghana. Discover hidden gems, local culture, food, and adventure experiences.',
      keywords: 'Ghana travel stories, Ghana blog, travel experiences Ghana',
    },
    '/reviews': {
      title: 'Reviews & Testimonials',
      description: 'Read reviews from travelers who booked Ghana tours through {brand}.',
      keywords: 'Ghana tours reviews, {brand} reviews',
    },
    '/careers': {
      title: 'Careers',
      description: 'Join the {brand} team. Explore career opportunities in Ghana\'s growing tourism industry.',
      keywords: '{brand} careers, Ghana tourism jobs',
    },
    '/blog': {
      title: 'Travel Stories & Blog',
      description: 'Read inspiring travel stories from Ghana. Discover hidden gems, local culture, food experiences, wildlife adventures, and travel tips for your Ghana vacation.',
      keywords: 'Ghana travel blog, Ghana travel stories, Ghana travel guide, things to do in Ghana',
    },
    '/partnerships': {
      title: 'Partnerships',
      description: 'Partner with {brand}. We work with hotels, transport providers, travel agents, and content creators to grow Ghana tourism.',
      keywords: 'Ghana tourism partnership, travel partnership Ghana, {brand} partners',
    },
    '/content-creators': {
      title: 'Content Creators Programme',
      description: 'Join the {brand} content creators programme. Collaborate with us on Ghana travel content and experiences.',
      keywords: 'Ghana travel content creators, influencer programme Ghana, travel collaboration',
    },
    '/travel-agents': {
      title: 'For Travel Agents',
      description: '{brand} works with travel agents worldwide to book authentic Ghana tours and experiences for their clients.',
      keywords: 'Ghana travel agents, book Ghana tours for clients, Ghana tour operator B2B',
    },
    '/hotels': {
      title: 'For Hotels & Accommodation Providers',
      description: 'Partner with {brand} to offer your guests curated Ghana tours and experiences. Add value to every stay.',
      keywords: 'Ghana hotels tours, hotel partnership Ghana, guest experiences Ghana',
    },
    '/transport': {
      title: 'Transport & Airport Transfers',
      description: 'Book reliable airport transfers and transport across Ghana with {brand}. Private drivers, comfortable vehicles, punctual pickup.',
      keywords: 'Ghana airport transfer, Accra airport pickup, Ghana transport service, private driver Ghana',
    },
    '/transport-providers': {
      title: 'For Transport Providers',
      description: 'Partner with {brand} as a transport provider. Grow your Ghana transfer and transport business with qualified bookings.',
      keywords: 'Ghana transport providers, partner transport Ghana, Ghana driver partnership',
    },
    '/terms-and-conditions': {
      title: 'Terms & Conditions',
      description: 'Read the terms and conditions governing bookings and use of the {brand} platform.',
      keywords: '{brand} terms, booking terms Ghana tours',
    },
    '/privacy-policy': {
      title: 'Privacy Policy',
      description: 'Learn how {brand} collects, uses, and protects your personal data.',
      keywords: '{brand} privacy policy, data protection Ghana',
    },
    '/cookies-policy': {
      title: 'Cookie Policy',
      description: 'How {brand} uses cookies and similar technologies, and how you can control them.',
      keywords: '{brand} cookie policy, cookies Ghana tours',
    },
    '/refund-policy': {
      title: 'Refund Policy',
      description: 'Understand the cancellation and refund policy for tours booked through {brand}.',
      keywords: 'Ghana tours refund policy, cancellation policy Ghana tours',
    },
    '/foundation': {
      title: 'Expedition-Go Foundation',
      description: 'The Expedition-Go Foundation supports community, conservation, and education projects across Ghana.',
      keywords: 'Expedition-Go Foundation, Ghana community tourism, responsible travel Ghana',
    },
    '/supplier-terms': {
      title: 'Supplier Terms',
      description: 'Terms and conditions for suppliers listing tours and experiences on {brand}.',
      keywords: '{brand} supplier terms, list tours Ghana',
    },
  };

  const page = pages[path];
  if (!page) return null;

  return buildHtml(site, {
    title: page.title,
    description: brandify(page.description, site),
    keywords: brandify(page.keywords, site),
    image: site.defaultImage.url,
    url: `${site.url}${path}`,
    canonical: `${site.url}${path}`,
    jsonLd: [buildBreadcrumbSchema([
      { name: 'Home', url: `${site.url}/` },
      { name: page.title, url: `${site.url}${path}` },
    ])],
  });
}

/**
 * Real 404 page. Returned with HTTP 404 (never a 200 homepage duplicate) so
 * Google stops treating unknown URLs as soft duplicates of the homepage.
 */
function handleNotFoundPage(site) {
  return buildHtml(site, {
    title: 'Page not found',
    description: `The page you are looking for could not be found. Browse Ghana tours and experiences on ${site.name} instead.`,
    image: site.defaultImage.url,
    url: `${site.url}/404`,
    canonical: `${site.url}/404`,
    robots: 'noindex, follow',
    bodyHtml: '<p><a href="' + site.url + '/tours">Browse all Ghana tours</a></p>',
  });
}

/**
 * Branded holding page for an upstream failure. Sent with 503 + Retry-After so
 * crawlers come back instead of indexing an empty or wrong page, and never as
 * JSON (a crawler cannot read it).
 */
function handleUnavailablePage(site) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, follow">
  <title>${escapeHtml(site.name)} — please try again</title>
</head>
<body>
  <h1>${escapeHtml(site.name)}</h1>
  <p>This page is temporarily unavailable. Please try again in a moment.</p>
  <p><a href="${site.url}/tours">Browse all Ghana tours</a></p>
</body>
</html>`;
}

// ── Express handler ──────────────────────────────────────────────────

exports.prerender = async (req, res) => {
  const site = resolveBrand(req);
  try {
    const targetUrl = (req.query && req.query.url) || req.path;
    if (!targetUrl) {
      return res.status(400).json({ status: 'error', message: 'Missing url parameter' });
    }

    const parsed = new URL(targetUrl, site.url);
    const path = parsed.pathname;
    const place = parsed.searchParams.get('place');

    let html = null;

    // Route to the right handler
    if (path === '/') {
      html = await handleHomePage(site);
    } else if (path.startsWith('/tour/')) {
      // Both forms the storefront can address arrive here:
      // /tour/<id>/<slug> (canonical — what the SPA links and the sitemap lists)
      // and /tour/<slug> or /tour/<id> (legacy/short forms). The lookup key is
      // always the final segment; the canonical emitted is the tour's own
      // id+slug, so both forms agree on one URL.
      const slug = decodeURIComponent(path.replace('/tour/', '').split('/').filter(Boolean).pop() || '');
      html = slug ? await handleTourPage(site, slug) : null;
    } else if (path === '/tours') {
      html = await handleListingsPage(site, place);
    } else if (path.startsWith('/supplier/')) {
      const name = decodeURIComponent(path.replace('/supplier/', ''));
      html = buildHtml(site, {
        title: `${name} - Ghana Tour Operator`,
        description: `Book tours with ${name} on ${site.name}. Authentic Ghana tours and experiences.`,
        keywords: `${name}, Ghana tour operator, Ghana tours`,
        image: site.defaultImage.url,
        url: `${site.url}${path}`,
        canonical: `${site.url}${path}`,
        jsonLd: [buildBreadcrumbSchema([
          { name: 'Home', url: `${site.url}/` },
          { name: name, url: `${site.url}${path}` },
        ])],
      });
    } else {
      html = handleStaticPage(site, path);
    }

    if (!html) {
      // Unknown URL → real 404. Previously this fell back to the homepage with
      // HTTP 200, which made every unknown path a soft duplicate of "/" and
      // kept them stuck in Google's "Discovered – currently not indexed".
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Prerender', 'true');
      return res.status(404).send(handleNotFoundPage(site));
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Prerender', 'true');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[Prerender] Error:', err.message);
    // 503 + HTML + noindex: a transient API/rate-limit failure is a "try
    // again later", not a broken page. JSON here used to leave crawlers with
    // nothing to parse and an unretryable error.
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', '120');
    res.setHeader('X-Prerender', 'error');
    return res.status(503).send(handleUnavailablePage(site));
  }
};

// Exposed for unit tests (the handlers are exercised through `prerender`).
exports._internal = {
  BRANDS,
  DEFAULT_BRAND,
  normalizeHost,
  resolveBrand,
  brandify,
  buildHtml,
  handleStaticPage,
  handleNotFoundPage,
  handleUnavailablePage,
};
