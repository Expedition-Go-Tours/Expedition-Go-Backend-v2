/**
 * Lightweight prerender endpoint for SEO.
 *
 * When a bot hits the site, the Vercel Edge Middleware proxies to this endpoint.
 * It fetches the page data from the internal API, builds a full HTML page with
 * meta tags, Open Graph, Twitter Cards, and JSON-LD structured data, and returns
 * it. No headless browser needed — just API calls + string concatenation.
 *
 * This gives bots (Googlebot, Bing, social scrapers) fully rendered HTML with
 * all SEO markup, while users get the fast SPA.
 */

const SITE_URL = 'https://expeditiongotours.com';
const SITE_NAME = 'Expedition-Go Tours';
const DEFAULT_IMAGE = 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1759237936/hero-bg_e5jwmx.jpg';
const DEFAULT_DESCRIPTION = 'Discover authentic Ghana tours and experiences. Book cultural tours, wildlife safaris, food tours, and adventure activities across Accra, Cape Coast, Volta Region, and more. Free cancellation, best prices guaranteed.';

const https = require('https');
const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
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

function linkList(links) {
  return links
    .map((l) => `<a href="${SITE_URL}${l.href}">${escapeHtml(l.label)}</a>`)
    .join('\n        ');
}

function buildHtml({ title, description, keywords, image, url, canonical, type, jsonLd, price, rating, robots, bodyHtml }) {
  const fullTitle = `${title} | ${SITE_NAME}`;
  const ogImage = image?.startsWith('http') ? image : `${SITE_URL}${image || ''}`;

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
  ${ogTag('og:url', url)}
  ${ogTag('og:site_name', SITE_NAME)}
  ${ogTag('og:locale', 'en_US')}
  ${price ? ogTag('og:price:amount', price.amount) : ''}
  ${price ? ogTag('og:price:currency', price.currency) : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@ExpeditionGo">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <title>${escapeHtml(fullTitle)}</title>
  ${jsonLd ? jsonLd.map((s) => `<script type="application/ld+json">${JSON.stringify(s)}</script>`).join('\n  ') : ''}
</head>
<body>
  <header>
    <nav aria-label="Main">
        ${linkList(NAV_LINKS)}
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
        ${linkList(FOOTER_LINKS)}
    </nav>
    <p>&copy; ${new Date().getFullYear()} ${SITE_NAME}. All rights reserved.</p>
  </footer>
  <script>window.__PRERENDERED__ = true;</script>
</body>
</html>`;
}

function buildOrganizationSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/src/assets/icons/compyIcon.png`,
    sameAs: ['https://www.facebook.com/expeditiongo', 'https://www.instagram.com/expeditiongo'],
    contactPoint: { '@type': 'ContactPoint', contactType: 'customer service', availableLanguage: ['English', 'French'] },
  };
}

function buildWebSiteSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}/tours?place={search_term_string}`,
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

function buildProductSchema(tour) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: tour.title,
    description: (tour.description || tour.title || '').slice(0, 500),
    image: tour.coverPhoto || tour.photos?.[0] || DEFAULT_IMAGE,
    url: `${SITE_URL}/tour/${tour.slug}`,
    brand: { '@type': 'Organization', name: SITE_NAME },
    offers: {
      '@type': 'Offer',
      price: tour.startingPrice || 0,
      priceCurrency: tour.currency || 'USD',
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: SITE_NAME },
    },
  };
  if (tour.averageRating && tour.reviewCount) {
    schema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: tour.averageRating,
      reviewCount: tour.reviewCount,
      bestRating: 5,
      worstRating: 1,
    };
  }
  return schema;
}

// ── Page handlers ────────────────────────────────────────────────────

async function handleTourPage(slug) {
  const API = process.env.API_URL || 'http://localhost:5000';
  const data = await fetchJson(`${API}/api/expedition/tours/${encodeURIComponent(slug)}`);
  // API response is nested: data.tour.tour (expedition listing -> tour)
  const listing = data?.data?.tour || data?.data;
  const tour = listing?.tour || listing;
  if (!tour || !tour.title) return null;

  const city = tour.city || tour.location?.split(',')[0]?.trim() || 'Ghana';
  const region = tour.location?.split(',')[1]?.trim() || '';
  const image = tour.coverPhoto || tour.photos?.[0] || DEFAULT_IMAGE;
  const durationLabel = tour.durationMinutes
    ? `${Math.floor(tour.durationMinutes / 60)}h${tour.durationMinutes % 60 ? ` ${tour.durationMinutes % 60}m` : ''}`
    : 'Experience';

  // Related tours — internal links so crawlers discover the rest of the catalogue
  // from any tour page. Best-effort: a failure never blocks the page.
  let relatedHtml = '';
  try {
    const listData = await fetchJson(`${API}/api/expedition/tours?limit=8`);
    const others = (listData?.data?.tours || [])
      .map((l) => l.tour || l)
      .filter((t) => t && t.slug && t.slug !== slug)
      .slice(0, 6);
    if (others.length) {
      relatedHtml = `<section aria-label="Related tours">
        <h2>More tours in Ghana</h2>
        <ul>
          ${others.map((t) => `<li><a href="${SITE_URL}/tour/${encodeURIComponent(t.slug)}">${escapeHtml(t.title)}</a></li>`).join('\n          ')}
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
      <p><a href="${SITE_URL}/tour/${encodeURIComponent(slug)}">Book this tour on ${SITE_NAME}</a></p>
      ${relatedHtml}`;

  return buildHtml({
    title: `${tour.title} in ${city}`,
    description: `${tour.title} - ${durationLabel} in ${city}${region ? ', ' + region : ''}, Ghana. Book from $${tour.startingPrice || 0}. ${tour.averageRating ? `Rated ${tour.averageRating}/5` : ''} Free cancellation, instant confirmation.`,
    keywords: `${tour.title}, ${city} tours, ${tour.category || 'tours'} in ${city}, Ghana tours, book ${tour.title}, things to do in ${city}`,
    image,
    url: `${SITE_URL}/tour/${slug}`,
    canonical: `${SITE_URL}/tour/${slug}`,
    type: 'product',
    price: { amount: String(tour.startingPrice || 0), currency: tour.currency || 'USD' },
    rating: tour.averageRating && tour.reviewCount ? { value: tour.averageRating, count: tour.reviewCount } : undefined,
    bodyHtml,
    jsonLd: [
      buildProductSchema(tour),
      buildBreadcrumbSchema([
        { name: 'Home', url: `${SITE_URL}/` },
        { name: region || 'Ghana', url: `${SITE_URL}/tours` },
        { name: city, url: `${SITE_URL}/tours?place=${encodeURIComponent(city)}` },
        { name: tour.title, url: `${SITE_URL}/tour/${slug}` },
      ]),
    ],
  });
}

async function handleListingsPage(place) {
  const API = process.env.API_URL || 'http://localhost:5000';
  const url = place
    ? `${API}/api/expedition/tours?limit=50&place=${encodeURIComponent(place)}`
    : `${API}/api/expedition/tours?limit=50`;
  const data = await fetchJson(url);
  const listings = data?.data?.tours || [];
  const tours = listings.map((l) => l.tour || l).filter(Boolean);
  const count = tours.length;

  const title = place ? `Tours in ${place} | ${count} experiences` : 'Ghana Tours & Experiences';
  const description = place
    ? `Discover ${count} tours and experiences in ${place}, Ghana. Book cultural tours, food tours, wildlife safaris, and adventure activities. Free cancellation, best prices guaranteed.`
    : `Explore ${count} authentic Ghana tours and experiences. Book cultural tours, wildlife safaris, food tours, and adventure activities. Free cancellation.`;

  const keywords = place
    ? `${place} tours, things to do in ${place}, ${place} Ghana, ${place} activities, Ghana tours`
    : 'Ghana tours, things to do in Ghana, Ghana experiences, Accra tours, Cape Coast tours, Ghana safari';

  return buildHtml({
    title,
    description,
    keywords,
    image: tours[0]?.coverPhoto || DEFAULT_IMAGE,
    url: place ? `${SITE_URL}/tours?place=${encodeURIComponent(place)}` : `${SITE_URL}/tours`,
    canonical: place ? `${SITE_URL}/tours?place=${encodeURIComponent(place)}` : `${SITE_URL}/tours`,
    jsonLd: [
      buildBreadcrumbSchema([
        { name: 'Home', url: `${SITE_URL}/` },
        ...(place ? [{ name: place, url: `${SITE_URL}/tours?place=${encodeURIComponent(place)}` }] : []),
        { name: 'Tours', url: `${SITE_URL}/tours` },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        numberOfItems: count,
        itemListElement: tours.slice(0, 20).map((t, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: t.title,
          url: `${SITE_URL}/tour/${t.slug}`,
        })),
      },
    ],
  });
}

function handleHomePage() {
  return buildHtml({
    title: 'Ghana Tours & Experiences | Book Authentic African Adventures',
    description: DEFAULT_DESCRIPTION,
    keywords: 'Ghana tours, things to do in Ghana, Ghana experiences, Accra tours, Cape Coast tours, Ghana safari, Ghana food tour, Ghana cultural tour, West Africa tours, African vacation, Ghana travel',
    image: DEFAULT_IMAGE,
    url: `${SITE_URL}/`,
    canonical: `${SITE_URL}/`,
    jsonLd: [buildOrganizationSchema(), buildWebSiteSchema()],
  });
}

function handleStaticPage(path) {
  const pages = {
    '/about-us': {
      title: 'About Us',
      description: 'Learn about Expedition-Go Tours — Ghana\'s premier tour platform. We connect travelers with authentic local experiences across Ghana.',
      keywords: 'Expedition-Go Tours, about us, Ghana tour company, Ghana travel platform',
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
      description: 'Get in touch with Expedition-Go Tours. Contact us for booking inquiries, partnerships, and support.',
      keywords: 'contact Expedition-Go Tours, Ghana tours support',
    },
    '/stories': {
      title: 'Travel Stories from Ghana',
      description: 'Read inspiring travel stories from Ghana. Discover hidden gems, local culture, food, and adventure experiences.',
      keywords: 'Ghana travel stories, Ghana blog, travel experiences Ghana',
    },
    '/reviews': {
      title: 'Reviews & Testimonials',
      description: 'Read reviews from travelers who booked Ghana tours through Expedition-Go Tours.',
      keywords: 'Ghana tours reviews, Expedition-Go Tours reviews',
    },
    '/careers': {
      title: 'Careers',
      description: 'Join the Expedition-Go Tours team. Explore career opportunities in Ghana\'s growing tourism industry.',
      keywords: 'Expedition-Go Tours careers, Ghana tourism jobs',
    },
    '/blog': {
      title: 'Travel Stories & Blog',
      description: 'Read inspiring travel stories from Ghana. Discover hidden gems, local culture, food experiences, wildlife adventures, and travel tips for your Ghana vacation.',
      keywords: 'Ghana travel blog, Ghana travel stories, Ghana travel guide, things to do in Ghana',
    },
    '/partnerships': {
      title: 'Partnerships',
      description: 'Partner with Expedition-Go Tours. We work with hotels, transport providers, travel agents, and content creators to grow Ghana tourism.',
      keywords: 'Ghana tourism partnership, travel partnership Ghana, Expedition-Go Tours partners',
    },
    '/content-creators': {
      title: 'Content Creators Programme',
      description: 'Join the Expedition-Go Tours content creators programme. Collaborate with us on Ghana travel content and experiences.',
      keywords: 'Ghana travel content creators, influencer programme Ghana, travel collaboration',
    },
    '/travel-agents': {
      title: 'For Travel Agents',
      description: 'Expedition-Go Tours works with travel agents worldwide to book authentic Ghana tours and experiences for their clients.',
      keywords: 'Ghana travel agents, book Ghana tours for clients, Ghana tour operator B2B',
    },
    '/hotels': {
      title: 'For Hotels & Accommodation Providers',
      description: 'Partner with Expedition-Go Tours to offer your guests curated Ghana tours and experiences. Add value to every stay.',
      keywords: 'Ghana hotels tours, hotel partnership Ghana, guest experiences Ghana',
    },
    '/transport': {
      title: 'Transport & Airport Transfers',
      description: 'Book reliable airport transfers and transport across Ghana with Expedition-Go Tours. Private drivers, comfortable vehicles, punctual pickup.',
      keywords: 'Ghana airport transfer, Accra airport pickup, Ghana transport service, private driver Ghana',
    },
    '/transport-providers': {
      title: 'For Transport Providers',
      description: 'Partner with Expedition-Go Tours as a transport provider. Grow your Ghana transfer and transport business with qualified bookings.',
      keywords: 'Ghana transport providers, partner transport Ghana, Ghana driver partnership',
    },
    '/terms-and-conditions': {
      title: 'Terms & Conditions',
      description: 'Read the terms and conditions governing bookings and use of the Expedition-Go Tours platform.',
      keywords: 'Expedition-Go Tours terms, booking terms Ghana tours',
    },
    '/privacy-policy': {
      title: 'Privacy Policy',
      description: 'Learn how Expedition-Go Tours collects, uses, and protects your personal data.',
      keywords: 'Expedition-Go Tours privacy policy, data protection Ghana',
    },
    '/cookies-policy': {
      title: 'Cookie Policy',
      description: 'How Expedition-Go Tours uses cookies and similar technologies, and how you can control them.',
      keywords: 'Expedition-Go Tours cookie policy, cookies Ghana tours',
    },
    '/refund-policy': {
      title: 'Refund Policy',
      description: 'Understand the cancellation and refund policy for tours booked through Expedition-Go Tours.',
      keywords: 'Ghana tours refund policy, cancellation policy Ghana tours',
    },
    '/foundation': {
      title: 'Expedition-Go Foundation',
      description: 'The Expedition-Go Foundation supports community, conservation, and education projects across Ghana.',
      keywords: 'Expedition-Go Foundation, Ghana community tourism, responsible travel Ghana',
    },
    '/supplier-terms': {
      title: 'Supplier Terms',
      description: 'Terms and conditions for suppliers listing tours and experiences on Expedition-Go Tours.',
      keywords: 'Expedition-Go Tours supplier terms, list tours Ghana',
    },
  };

  const page = pages[path];
  if (!page) return null;

  return buildHtml({
    ...page,
    image: DEFAULT_IMAGE,
    url: `${SITE_URL}${path}`,
    canonical: `${SITE_URL}${path}`,
    jsonLd: [buildBreadcrumbSchema([
      { name: 'Home', url: `${SITE_URL}/` },
      { name: page.title, url: `${SITE_URL}${path}` },
    ])],
  });
}

/**
 * Real 404 page. Returned with HTTP 404 (never a 200 homepage duplicate) so
 * Google stops treating unknown URLs as soft duplicates of the homepage.
 */
function handleNotFoundPage() {
  return buildHtml({
    title: 'Page not found',
    description: 'The page you are looking for could not be found. Browse Ghana tours and experiences on Expedition-Go Tours instead.',
    image: DEFAULT_IMAGE,
    url: `${SITE_URL}/404`,
    canonical: `${SITE_URL}/404`,
    robots: 'noindex, follow',
    bodyHtml: '<p><a href="' + SITE_URL + '/tours">Browse all Ghana tours</a></p>',
  });
}

// ── Express handler ──────────────────────────────────────────────────

exports.prerender = async (req, res) => {
  try {
    const targetUrl = req.query.url || req.path;
    if (!targetUrl) {
      return res.status(400).json({ status: 'error', message: 'Missing url parameter' });
    }

    const parsed = new URL(targetUrl, SITE_URL);
    const path = parsed.pathname;
    const place = parsed.searchParams.get('place');

    let html = null;

    // Route to the right handler
    if (path === '/') {
      html = handleHomePage();
    } else if (path.startsWith('/tour/')) {
      const slug = path.replace('/tour/', '');
      html = await handleTourPage(slug);
    } else if (path === '/tours') {
      html = await handleListingsPage(place);
    } else if (path.startsWith('/supplier/')) {
      const name = decodeURIComponent(path.replace('/supplier/', ''));
      html = buildHtml({
        title: `${name} - Ghana Tour Operator`,
        description: `Book tours with ${name} on Expedition-Go Tours. Authentic Ghana tours and experiences.`,
        keywords: `${name}, Ghana tour operator, Ghana tours`,
        image: DEFAULT_IMAGE,
        url: `${SITE_URL}${path}`,
        canonical: `${SITE_URL}${path}`,
        jsonLd: [buildBreadcrumbSchema([
          { name: 'Home', url: `${SITE_URL}/` },
          { name: name, url: `${SITE_URL}${path}` },
        ])],
      });
    } else {
      html = handleStaticPage(path);
    }

    if (!html) {
      // Unknown URL → real 404. Previously this fell back to the homepage with
      // HTTP 200, which made every unknown path a soft duplicate of "/" and
      // kept them stuck in Google's "Discovered – currently not indexed".
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Prerender', 'true');
      return res.status(404).send(handleNotFoundPage());
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('X-Prerender', 'true');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[Prerender] Error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Prerender failed' });
  }
};
