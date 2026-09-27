/**
 * Prerender endpoint: brand resolution, crawler-safe statuses, structured data.
 *
 * The endpoint backs every storefront from one service, so the rules that
 * matter are: a request for www.travioghana.com must never mention another
 * brand's domain, a missing page must answer 404 (not a homepage duplicate),
 * and an upstream failure must answer retryable HTML (never JSON).
 */

const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');

const { prerender, _internal } = require('../../src/core/domain/prerenderController');

const GHANA_HOST = 'www.travioghana.com';

/** The brand's real accounts. Keep in step with the storefront's
 *  `src/lib/brandSocial.ts` — the two ends of a brand must agree. */
const TRAVIO_GHANA_SAME_AS = [
  'https://www.instagram.com/travioghana',
  'https://www.tiktok.com/@travio.ghana',
  'https://www.youtube.com/@TravioGhana',
];

let requested;
/** How the mocked HTTP layer should answer: statusCode + payload. */
let nextResponse;

function installHttpMock() {
  requested = [];
  nextResponse = { statusCode: 200, payload: { status: 'success', data: {} } };
  const impl = (url, opts, cb) => {
    requested.push(url);
    const { statusCode, payload, raw } = nextResponse;
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = {};
    res.resume = () => {};
    process.nextTick(() => {
      // Hand the response to the caller first so its data/end listeners are
      // attached, then stream the body.
      if (typeof cb === 'function') cb(res);
      if (raw != null) res.emit('data', raw);
      else if (payload !== undefined) res.emit('data', JSON.stringify(payload));
      res.emit('end');
    });
    return { on() {}, destroy() {} };
  };
  jest.spyOn(https, 'get').mockImplementation(impl);
  jest.spyOn(http, 'get').mockImplementation(impl);
}

function makeReq(target, opts = {}) {
  const u = new URL(target, 'https://placeholder.test');
  const query = { url: target, ...Object.fromEntries(u.searchParams) };
  if (opts.host) query.host = opts.host;
  return {
    query,
    path: u.pathname,
    headers: { host: opts.headerHost || 'apiv1.travioafrica.com' },
  };
}

function makeRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    send(html) { this.body = html; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function render(target, opts) {
  const res = makeRes();
  await prerender(makeReq(target, opts), res);
  return res;
}

beforeEach(() => {
  installHttpMock();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('brand resolution', () => {
  it('falls back to Expedition-Go Tours when no storefront identifies itself', async () => {
    const res = await render('/');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://www.expeditiongotours.com/">');
    expect(res.body).toContain('| Expedition-Go Tours</title>');
    expect(res.body).toContain('content="Expedition-Go Tours"');
  });

  it('renders Travio Ghana branding and canonicals for the travighana host', async () => {
    const res = await render('/about-us', { host: GHANA_HOST });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/about-us">');
    expect(res.body).toContain('content="Travio Ghana"');
    expect(res.body).toContain('| Travio Ghana</title>');
    // Cross-brand leakage: another brand's domain or title must never appear.
    expect(res.body).not.toContain('expeditiongotours.com');
    expect(res.body).not.toContain('Expedition-Go Tours');
  });

  it('accepts host as a query parameter, a header, a port and a full origin', async () => {
    const asOrigin = await render('/', { host: `https://${GHANA_HOST}:443` });
    expect(asOrigin.body).toContain('https://www.travioghana.com/');

    const asHeader = await render('/', { headerHost: GHANA_HOST });
    expect(asHeader.body).toContain('https://www.travioghana.com/');

    const bare = await render('/', { headerHost: 'travioghana.com' });
    expect(bare.body).toContain('https://www.travioghana.com/');
  });

  it('treats an unknown host as the default brand', async () => {
    const res = await render('/', { host: 'someone-elses-site.test' });
    expect(res.body).toContain('https://www.expeditiongotours.com/');
  });

  it('normalises hosts before lookup', () => {
    expect(_internal.normalizeHost('www.travioghana.com')).toBe('travioghana.com');
    expect(_internal.normalizeHost('WWW.TravioGhana.com:443')).toBe('travioghana.com');
    expect(_internal.normalizeHost('https://www.travioghana.com/path?q=1')).toBe('travioghana.com');
    expect(_internal.normalizeHost('')).toBe('');
  });
});

describe('static page copy', () => {
  it('brands shared copy for Travio Ghana', async () => {
    const res = await render('/partnerships', { host: GHANA_HOST });
    expect(res.body).toContain('Partner with Travio Ghana');
    expect(res.body).not.toContain('{brand}');
  });

  it('keeps shared copy branded for the default storefront', async () => {
    const res = await render('/partnerships');
    expect(res.body).toContain('Partner with Expedition-Go Tours');
    expect(res.body).not.toContain('{brand}');
  });

  // The foundation page was the one hardcoded to a different brand's name,
  // which contradicted the live <h1> and made the two versions of the page
  // disagree. This endpoint is now only a fallback for routes the frontend
  // prerenders, but it must not contradict the app when it does answer.
  it('names the foundation for the requesting brand, not another one', async () => {
    const ghana = await render('/foundation', { host: GHANA_HOST });
    expect(ghana.body).toContain('Every Journey Makes a Difference');
    expect(ghana.body).toContain('Travio Ghana Foundation');
    expect(ghana.body).not.toContain('Expedition-Go Foundation');

    const fallback = await render('/foundation');
    expect(fallback.body).not.toContain('Travio Ghana Foundation');
    expect(fallback.body).toContain('Expedition-Go Tours Foundation');
  });
});

describe('structured data', () => {
  it('points the Organization logo at a crawlable asset', async () => {
    const ghana = await render('/', { host: GHANA_HOST });
    expect(ghana.body).toContain('"logo":{"@type":"ImageObject","url":"https://www.travioghana.com/logo.png","width":512,"height":512}');
    expect(ghana.body).not.toContain('/src/assets/icons/compyIcon.png');

    const fallback = await render('/');
    expect(fallback.body).toContain('"logo":{"@type":"ImageObject","url":"https://www.expeditiongotours.com/logo.png","width":320,"height":320}');
    expect(fallback.body).not.toContain('/src/assets/icons/compyIcon.png');
  });

  it('gives Travio Ghana a branded, sized social card', async () => {
    const res = await render('/', { host: GHANA_HOST });
    expect(res.body).toContain('property="og:image" content="https://www.travioghana.com/og-default.png"');
    expect(res.body).toContain('property="og:image:width" content="1200"');
    expect(res.body).toContain('property="og:image:height" content="630"');
    // No X/Twitter profile for this brand — twitter:site must not be borrowed.
    expect(res.body).not.toContain('name="twitter:site"');
    expect(res.body).not.toContain('@ExpeditionGo');
  });

  it('keeps the Expedition Twitter handle for the default storefront', async () => {
    const res = await render('/');
    expect(res.body).toContain('name="twitter:site" content="@ExpeditionGo"');
  });
});

/**
 * `sameAs` is how a crawler connects this storefront to the brand's other
 * profiles. Travio Ghana's list named the Expedition-Go brand's Instagram,
 * TikTok and YouTube accounts, plus a fourth Instagram handle nobody
 * controlled — the same "borrow another brand's account" mistake the
 * `twitter:site` rule above exists to prevent, three lines away.
 *
 * The storefront declares the same list in `src/lib/brandSocial.ts`; these
 * expectations and that module have to agree, or the two disagree about who
 * this brand is.
 */
describe('sameAs names the brand that is being rendered', () => {
  /** Pulls the Organization `sameAs` array back out of the rendered page. */
  function sameAsOf(body) {
    const match = /"sameAs":\[([^\]]*)\]/.exec(body);
    expect(match).not.toBeNull();
    return JSON.parse(`[${match[1]}]`);
  }

  it('declares the real Travio Ghana accounts', async () => {
    const res = await render('/', { host: GHANA_HOST });
    expect(sameAsOf(res.body)).toEqual(expect.arrayContaining(TRAVIO_GHANA_SAME_AS));
  });

  it('does not hand the brand another brand\u2019s accounts', async () => {
    const res = await render('/', { host: GHANA_HOST });
    // The exact strings that were wrong, so a paste-back is caught.
    expect(res.body).not.toContain('expeditiongotours');
    expect(res.body).not.toContain('ExpeditionGoTravelandToursLTD');
    expect(res.body).not.toContain('travioGhanatours');
  });

  it('has no duplicates, which would waste a slot in the entity', async () => {
    const urls = sameAsOf((await render('/', { host: GHANA_HOST })).body);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('leaves the Expedition-Go storefront pointing at its own profiles', async () => {
    // This service backs two brands; fixing one must not retarget the other.
    const res = await render('/');
    expect(res.body).toContain('"https://www.instagram.com/expeditiongo"');
    expect(res.body).not.toContain('https://www.instagram.com/travioghana');
  });

  it('never serves one brand\u2019s profiles under the other\u2019s domain', async () => {
    const ghana = await render('/', { host: GHANA_HOST });
    expect(ghana.body).not.toContain('expeditiongotours.com');
    expect(ghana.body).not.toContain('@ExpeditionGo');
  });
});

/**
 * Tour pages carry no top-level Organization — only Product and BreadcrumbList
 * — so the brand entity is the nested `brand` (and the offer's `seller`). Those
 * were a bare name, which left the 32 tour pages, the most numerous on the
 * site, declaring who sells the tour but no social identity to connect that
 * name to anything else.
 */
describe('tour pages identify the brand', () => {
  const tour = {
    id: 'tour-1',
    slug: 'kakum-canopy-walk',
    title: 'Kakum Canopy Walk',
    city: 'Cape Coast',
    startingPrice: 45,
    currency: 'USD',
    averageRating: 4.8,
    reviewCount: 12,
  };

  /** The rendered Product schema, parsed back out of the page. */
  async function productOf(opts) {
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour } } } };
    const res = await render('/tour/kakum-canopy-walk', opts);
    const blocks = [...res.body.matchAll(/<script[^>]*application\/ld\+json[^>]*>(.*?)<\/script>/gs)]
      .map((m) => JSON.parse(m[1]));
    const product = blocks.find((b) => b['@type'] === 'Product');
    expect(product).toBeDefined();
    return product;
  }

  it('gives the product brand the same profiles as the site', async () => {
    const product = await productOf({ host: GHANA_HOST });
    expect(product.brand.sameAs).toEqual(expect.arrayContaining(TRAVIO_GHANA_SAME_AS));
  });

  it('gives the offer seller them too, so both references resolve', async () => {
    const product = await productOf({ host: GHANA_HOST });
    expect(product.offers.seller.sameAs).toEqual(expect.arrayContaining(TRAVIO_GHANA_SAME_AS));
    expect(product.brand.name).toBe('Travio Ghana');
  });

  it('does not put another brand\u2019s accounts on a tour page', async () => {
    const product = await productOf({ host: GHANA_HOST });
    expect(JSON.stringify(product)).not.toMatch(/expeditiongo/i);
    expect(JSON.stringify(product)).not.toMatch(/travioGhanatours/i);
  });

  it('resolves the profiles per requesting brand', async () => {
    // Same service, two storefronts: a tour page for the default brand must not
    // advertise Travio Ghana's profiles.
    const product = await productOf();
    expect(product.brand.name).toBe('Expedition-Go Tours');
    expect(product.brand.sameAs).toContain('https://www.instagram.com/expeditiongo');
    expect(JSON.stringify(product)).not.toMatch(/travioghana/i);
  });
});

describe('tour pages', () => {
  const tour = {
    id: 'tour-1',
    slug: 'kakum-canopy-walk',
    title: 'Kakum Canopy Walk',
    city: 'Cape Coast',
    startingPrice: 45,
    currency: 'USD',
    averageRating: 4.8,
    reviewCount: 12,
    durationMinutes: 60,
    description: 'Walk the canopy.',
  };

  it('reads the requesting brand catalogue and canonicalises to /tour/<id>/<slug>', async () => {
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour } } } };
    const res = await render('/tour/kakum-canopy-walk', { host: GHANA_HOST });

    expect(res.statusCode).toBe(200);
    expect(requested[0]).toContain('/api/travioghana/tours/kakum-canopy-walk');
    // The id+slug form is what the storefront links and sitemaps — a slug-only
    // request must converge on it rather than publish a second URL.
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tour/tour-1/kakum-canopy-walk">');
    expect(res.body).toContain('content="product"');
    expect(res.body).toContain('"@type":"Product"');
    expect(res.body).toContain('"url":"https://www.travioghana.com/tour/tour-1/kakum-canopy-walk"');
    expect(res.body).toContain('| Travio Ghana</title>');
  });

  it('accepts the /tour/<id>/<slug> form and self-canonicalises to it', async () => {
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour } } } };
    const res = await render('/tour/tour-1/kakum-canopy-walk', { host: GHANA_HOST });

    expect(requested[0]).toContain('/api/travioghana/tours/kakum-canopy-walk');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tour/tour-1/kakum-canopy-walk">');
  });

  it('resolves a bare /tour/<id> link to the same canonical', async () => {
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour } } } };
    const res = await render('/tour/tour-1', { host: GHANA_HOST });

    // The API lookup accepts slug OR id, so an id-only link still resolves.
    expect(requested[0]).toContain('/api/travioghana/tours/tour-1');
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tour/tour-1/kakum-canopy-walk">');
  });

  it('falls back to the slug-only URL when the payload has no id', async () => {
    const { id, ...slugOnly } = tour;
    void id;
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour: slugOnly } } } };
    const res = await render('/tour/kakum-canopy-walk', { host: GHANA_HOST });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tour/kakum-canopy-walk">');
  });

  it('answers 404 when the API says the tour does not exist', async () => {
    nextResponse = { statusCode: 404, payload: { status: 'fail' } };
    const res = await render('/tour/does-not-exist', { host: GHANA_HOST });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('noindex, follow');
    expect(res.body).toContain('Page not found');
  });

  it('uses the requesting brand in related and book-this-tour links', async () => {
    nextResponse = { statusCode: 200, payload: { status: 'success', data: { tour: { tour } } } };
    const res = await render('/tour/kakum-canopy-walk', { host: GHANA_HOST });
    expect(res.body).toContain('Book this tour on Travio Ghana');
    expect(res.body).not.toContain('Book this tour on Expedition-Go Tours');
  });
});

describe('destination listings', () => {
  const listingWith = (tours) => ({ statusCode: 200, payload: { status: 'success', data: { tours } } });

  it('indexes a destination that actually has tours', async () => {
    nextResponse = listingWith([{ tour: { id: 'accra-1', title: 'Accra City Tour', slug: 'accra-city-tour' } }]);
    const res = await render('/tours?place=Accra', { host: GHANA_HOST });

    expect(res.body).toContain('<meta name="robots" content="index, follow"');
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tours?place=Accra">');
    expect(res.body).toContain('Tours in Accra | 1 experiences');
    // ItemList entries follow the same /tour/<id>/<slug> form as the sitemap.
    expect(res.body).toContain('"url":"https://www.travioghana.com/tour/accra-1/accra-city-tour"');
  });

  it('noindexes an empty ?place= so unknown places cannot mint duplicates', async () => {
    nextResponse = listingWith([]);
    const res = await render('/tours?place=NowherevilleZZ', { host: GHANA_HOST });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<meta name="robots" content="noindex, follow"');
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/tours?place=NowherevilleZZ">');
  });
});

/**
 * Thin-content regression guard.
 *
 * The whole reason this endpoint existed was to give crawlers real page
 * content, and it silently stopped doing that for the listings: the catalogue
 * was fetched to build ItemList markup, but the fifty tours were never written
 * into the body, so a crawler read a ~27-word page. The pages were crawled and
 * never indexed. Counting words in <main> is crude, but it is the exact
 * measure that failed, and a cheap floor catches any future handler that
 * forgets to render the data it already fetched.
 */
describe('listings carry real body content', () => {
  const listingWith = (tours) => ({ statusCode: 200, payload: { status: 'success', data: { tours } } });

  const catalogue = Array.from({ length: 12 }, (_, i) => ({
    tour: {
      id: `t${i}`,
      slug: `experience-${i}`,
      title: `Ghana Experience Number ${i + 1}`,
      city: i % 2 ? 'Accra' : 'Cape Coast',
      region: i % 2 ? 'Greater Accra' : 'Central',
      price: { amount: 40 + i, currency: 'USD' },
      averageRating: 4.5,
      reviewCount: 8,
    },
  }));

  /** Words a crawler can actually read inside <main>. */
  const mainWords = (html) => {
    const main = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
    if (!main) return 0;
    return main[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/g, ' ')
      .split(/\s+/)
      .filter((w) => /[a-z0-9]/i.test(w)).length;
  };

  it('renders every fetched tour into the /tours body', async () => {
    nextResponse = listingWith(catalogue);
    const res = await render('/tours', { host: GHANA_HOST });

    expect(mainWords(res.body)).toBeGreaterThan(120);
    for (const { tour } of catalogue) {
      expect(res.body).toContain(`>${tour.title}</a>`);
      expect(res.body).toContain(`https://www.travioghana.com/tour/${tour.id}/${tour.slug}`);
    }
  });

  it('links every destination so /tours?place= pages are reachable from the site', async () => {
    nextResponse = listingWith(catalogue);
    const res = await render('/tours', { host: GHANA_HOST });

    for (const place of ['Accra', 'Cape Coast', 'Greater Accra', 'Central']) {
      expect(res.body).toContain(`/tours?place=${encodeURIComponent(place)}`);
    }
  });

  it('stays substantive on a destination page and shows prices and ratings', async () => {
    nextResponse = listingWith(catalogue.filter((l) => l.tour.city === 'Accra'));
    const res = await render('/tours?place=Accra', { host: GHANA_HOST });

    expect(mainWords(res.body)).toBeGreaterThan(60);
    // Only the six Accra tours — Cape Coast must not leak into this page.
    expect(res.body).toContain('Ghana Experience Number 2</a> &mdash; from USD 41');
    expect(res.body).toContain('rated 4.5/5 (8 reviews)');
    expect(res.body).not.toContain('Ghana Experience Number 1<');
    // A destination page is a leaf, not a directory listing of other leaves.
    expect(res.body).not.toContain('Explore Ghana by destination');
  });

  it('declares a ListItem count equal to the listings it emits', async () => {
    nextResponse = listingWith(catalogue);
    const res = await render('/tours', { host: GHANA_HOST });

    const list = JSON.parse(/<script type="application\/ld\+json">(\{"@context":"https:\/\/schema\.org","@type":"ItemList"[\s\S]*?)<\/script>/.exec(res.body)[1]);
    expect(list.numberOfItems).toBe(catalogue.length);
    expect(list.itemListElement).toHaveLength(catalogue.length);
  });

  it('still explains itself on an empty destination, without inventing listings', async () => {
    nextResponse = listingWith([]);
    const res = await render('/tours?place=NowherevilleZZ', { host: GHANA_HOST });

    expect(res.body).toContain('No experiences listed for NowherevilleZZ yet');
    expect(res.body).toContain('/contact-us');
    expect(res.body).toContain('"numberOfItems":0');
  });

  it('escapes a hostile place parameter instead of reflecting it as markup', async () => {
    nextResponse = listingWith([]);
    const res = await render('/tours?place=%3Cscript%3Ealert(1)%3C/script%3E', { host: GHANA_HOST });

    // HTML body and every meta tag are escaped.
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  // The JSON-LD block is a second reflection surface, and HTML-escaping would
  // have made the JSON invalid. JSON.stringify does not escape `/`, so an
  // unescaped `</script>` in a schema string closed the script element early
  // and turned the rest of the structured data into live markup.
  it('cannot be broken out of the JSON-LD block', async () => {
    nextResponse = listingWith([]);
    const res = await render('/tours?place=%3C/script%3E%3Cscript%3Ealert(1)%3C/script%3E', { host: GHANA_HOST });

    const blocks = res.body.match(/<script type="application\/ld\+json">/g) || [];
    expect(blocks.length).toBeGreaterThan(0);
    // Nothing between the opening and closing tag may contain a raw `</script>`.
    for (const block of res.body.split('<script type="application/ld+json">').slice(1)) {
      const body = block.slice(0, block.indexOf('</script>'));
      expect(body).not.toContain('</script>');
      expect(body).not.toContain('<');
      // Still valid JSON after unescaping — the escape must be lossless.
      const parsed = JSON.parse(body.replace(/\\u003c/g, '<'));
      expect(parsed).toBeTruthy();
    }
  });
});

describe('failure modes are crawler-safe', () => {
  it('answers 404 with noindex for an unknown path', async () => {
    const res = await render('/definitely-not-a-page', { host: GHANA_HOST });
    expect(res.statusCode).toBe(404);
    expect(res.headers['X-Prerender']).toBe('true');
    expect(res.body).toContain('noindex, follow');
    expect(res.body).toContain('https://www.travioghana.com/tours');
  });

  it('loads the homepage with popular tours, destinations and FAQ markup', async () => {
    nextResponse = {
      statusCode: 200,
      payload: {
        status: 'success',
        data: {
          tours: [
            { id: 't1', slug: 'accra-city-tour', title: 'Accra City Tour', city: 'Accra', region: 'Greater Accra', price: { amount: 35, currency: 'USD' }, averageRating: 4.7, reviewCount: 12 },
            { id: 't2', slug: 'cape-coast-castles', title: 'Cape Coast Castles', city: 'Cape Coast', region: 'Central' },
          ],
        },
      },
    };

    const res = await render('/', { host: GHANA_HOST });

    expect(res.statusCode).toBe(200);
    // Internal links into the money pages (the previous homepage had none).
    expect(res.body).toContain('https://www.travioghana.com/tour/t1/accra-city-tour');
    expect(res.body).toContain('https://www.travioghana.com/tour/t2/cape-coast-castles');
    expect(res.body).toContain('Popular Ghana tours &amp; experiences');
    expect(res.body).toContain('Browse all 2 tours');
    // Destination listings use the prerendered /tours?place= surface.
    expect(res.body).toContain('https://www.travioghana.com/tours?place=Accra');
    expect(res.body).toContain('Explore Ghana by destination');
    // FAQPage + ItemList structured data.
    expect(res.body).toContain('"@type":"FAQPage"');
    expect(res.body).toContain('"@type":"ItemList"');
    expect(res.body).toContain('Frequently asked questions');
    // Dated copy stays out of the crawler HTML.
    expect(res.body).not.toContain('undefined');
  });

  it('still serves a complete homepage when the catalogue API is down', async () => {
    nextResponse = { statusCode: 500, payload: { status: 'error' } };

    const res = await render('/', { host: GHANA_HOST });

    // The brand homepage must never 503 or ship a half-built page.
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Prerender']).toBe('true');
    expect(res.body).toContain('<link rel="canonical" href="https://www.travioghana.com/">');
    expect(res.body).toContain('"@type":"FAQPage"');
    expect(res.body).toContain('Why book with Travio Ghana');
    expect(res.body).not.toContain('Popular Ghana tours');
  });

  it('answers branded 503 HTML (never JSON) when the catalogue API fails', async () => {
    nextResponse = { statusCode: 500, payload: { status: 'error' } };
    const res = await render('/tours', { host: GHANA_HOST });

    expect(res.statusCode).toBe(503);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.headers['Retry-After']).toBe('120');
    expect(res.headers['X-Prerender']).toBe('error');
    expect(typeof res.body).toBe('string');
    expect(res.body).toContain('Travio Ghana');
    expect(res.body).toContain('noindex, follow');
  });

  it('does not turn an upstream 429 into an empty listing page', async () => {
    nextResponse = { statusCode: 429, payload: { status: 'fail' } };
    const res = await render('/tours', { host: GHANA_HOST });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('0 authentic Ghana tours');
  });
});
