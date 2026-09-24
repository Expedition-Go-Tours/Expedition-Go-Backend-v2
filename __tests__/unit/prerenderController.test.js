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

describe('failure modes are crawler-safe', () => {
  it('answers 404 with noindex for an unknown path', async () => {
    const res = await render('/definitely-not-a-page', { host: GHANA_HOST });
    expect(res.statusCode).toBe(404);
    expect(res.headers['X-Prerender']).toBe('true');
    expect(res.body).toContain('noindex, follow');
    expect(res.body).toContain('https://www.travioghana.com/tours');
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
