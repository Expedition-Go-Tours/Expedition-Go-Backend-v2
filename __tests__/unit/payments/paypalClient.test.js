/**
 * PayPal transport.
 *
 * The retry and error-shaping rules decide whether a network blip charges a
 * customer twice or whether a declined payment is recognisable as one, so they
 * are pinned here against a stubbed fetch.
 */

const {
  request,
  PayPalApiError,
  invalidateAccessToken,
  getAccessToken,
} = require('../../../src/core/services/payments/paypalClient');

let fetchMock;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function installEnv(over = {}) {
  process.env.PAYPAL_MODE = 'sandbox';
  process.env.PAYPAL_CLIENT_ID = over.clientId || 'client-id';
  process.env.PAYPAL_CLIENT_SECRET = over.clientSecret || 'client-secret';
}

beforeEach(() => {
  installEnv();
  invalidateAccessToken();
  fetchMock = jest.fn();
  global.fetch = fetchMock;
});

afterAll(() => {
  delete global.fetch;
  invalidateAccessToken();
});

function tokenCall() {
  return jsonResponse(200, { access_token: 'token-1', expires_in: 32400 });
}

describe('authentication', () => {
  it('requests a token once and reuses it', async () => {
    fetchMock.mockResolvedValue(tokenCall());

    expect(await getAccessToken()).toBe('token-1');
    expect(await getAccessToken()).toBe('token-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
  });

  it('shares one in-flight token request across concurrent callers', async () => {
    fetchMock.mockResolvedValue(tokenCall());
    const tokens = await Promise.all([getAccessToken(), getAccessToken(), getAccessToken()]);
    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to call PayPal without credentials', async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    const err = await request('/v2/checkout/orders/ORDER-1').catch((e) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.message).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('error shaping', () => {
  it('prefers the specific PayPal issue over the generic error name', async () => {
    installEnv({ clientId: 'client-id-2' });
    invalidateAccessToken();
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(422, {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        debug_id: 'dbg-1',
        details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Order is not approved' }],
      }));

    const err = await request('/v2/checkout/orders/ORDER-1/capture', {
      method: 'POST',
      body: {},
      idempotencyKey: 'k-1',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PayPalApiError);
    expect(err.code).toBe('ORDER_NOT_APPROVED');
    expect(err.errorName).toBe('UNPROCESSABLE_ENTITY');
    expect(err.requestId).toBe('dbg-1');
  });

  it('reports INSTRUMENT_DECLINED so the caller can decline instead of retry', async () => {
    installEnv({ clientId: 'client-id-3' });
    invalidateAccessToken();
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(422, {
        name: 'UNPROCESSABLE_ENTITY',
        details: [{ issue: 'INSTRUMENT_DECLINED' }],
      }));

    const err = await request('/v2/checkout/orders/ORDER-1/capture', {
      method: 'POST',
      body: {},
      idempotencyKey: 'k-2',
    }).catch((e) => e);

    expect(err.code).toBe('INSTRUMENT_DECLINED');
    expect(err.retriable).toBe(false);
  });
});

describe('retries', () => {
  it('retries a GET after a 500', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(500, { name: 'INTERNAL_SERVICE_ERROR' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ORDER-1' }));

    const result = await request('/v2/checkout/orders/ORDER-1', { attempts: 3 });
    expect(result).toEqual({ id: 'ORDER-1' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries a POST only when the caller supplied a PayPal-Request-Id', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(500, { name: 'INTERNAL_SERVICE_ERROR' }));

    await expect(request('/v2/checkout/orders', {
      method: 'POST',
      body: {},
      attempts: 3,
    })).rejects.toThrow(/HTTP 500|INTERNAL_SERVICE_ERROR/);
    // token + exactly one POST: an unkeyed POST must never be repeated.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates after a 401 and replays the request', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(401, { name: 'INVALID_CLIENT' }))
      .mockResolvedValueOnce(jsonResponse(200, { access_token: 'token-2', expires_in: 32400 }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'ORDER-1' }));

    const result = await request('/v2/checkout/orders/ORDER-1');
    expect(result).toEqual({ id: 'ORDER-1' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry a validation failure', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenCall())
      .mockResolvedValueOnce(jsonResponse(400, {
        name: 'INVALID_REQUEST',
        details: [{ issue: 'INVALID_PARAMETER_VALUE' }],
      }));

    const err = await request('/v2/checkout/orders', {
      method: 'POST',
      body: {},
      attempts: 3,
    }).catch((e) => e);

    expect(err.code).toBe('INVALID_PARAMETER_VALUE');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
