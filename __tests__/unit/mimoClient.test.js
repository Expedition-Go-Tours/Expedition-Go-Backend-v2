const { callMimo, parseJson } = require('../../utils/mimoClient');

beforeEach(() => {
  process.env.MIMO_API_KEY = 'test-key';
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MIMO_API_KEY;
});

function mockFetch(body) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ choices: [{ message: { content: body } }] }),
  });
}

describe('callMimo', () => {
  it('returns content on success', async () => {
    mockFetch('hello world');
    const result = await callMimo({ system: 'sys', user: 'q' });
    expect(result).toBe('hello world');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to reasoning_content when content is empty string', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '', reasoning_content: 'deep thought' } }] }),
    });
    const result = await callMimo({ system: 's', user: 'q' });
    expect(result).toBe('deep thought');
  });

  it('falls back to reasoning_content when content is null', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: null, reasoning_content: 'reasoned' } }] }),
    });
    const result = await callMimo({ system: 's', user: 'q' });
    expect(result).toBe('reasoned');
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    let callCount = 0;
    global.fetch = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 429, headers: new Map([['retry-after', '1']]) };
      return { ok: true, json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] }) };
    });
    const result = await callMimo({ system: 's', user: 'q' });
    expect(result).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting 429 retries', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '1']]),
    });
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow('MiMo API 429: rate limited after 3 retries');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws after max retries on 500 error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('server error'),
    });
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow('MiMo API 500');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('throws when content is empty and no reasoning_content', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: null, reasoning_content: null } }] }),
    });
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow('empty content');
  });

  it('throws when choices array is empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    });
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow();
  });

  it('throws when response has no choices field', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow();
  });

  it('throws when MIMO_API_KEY is missing', async () => {
    delete process.env.MIMO_API_KEY;
    await expect(callMimo({ system: 's', user: 'q' })).rejects.toThrow('MIMO_API_KEY not set');
  });

  it('sends correct headers and body', async () => {
    mockFetch('ok');
    await callMimo({ system: 'sys', user: 'hi', maxTokens: 1024, temperature: 0.5 });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.headers).toEqual({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key',
    });
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('mimo-v2.5');
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.temperature).toBe(0.5);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('skips system message when system is undefined', async () => {
    mockFetch('ok');
    await callMimo({ user: 'q' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('uses MIMO_MODEL env var when set', async () => {
    process.env.MIMO_MODEL = 'custom-model';
    mockFetch('ok');
    await callMimo({ system: 's', user: 'q' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('custom-model');
    delete process.env.MIMO_MODEL;
  });

  it('uses override model param over env var', async () => {
    process.env.MIMO_MODEL = 'env-model';
    mockFetch('ok');
    await callMimo({ system: 's', user: 'q', model: 'override-model' });
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('override-model');
    delete process.env.MIMO_MODEL;
  });
});

describe('parseJson', () => {
  it('parses plain JSON', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown json fences', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('strips bare markdown fences', () => {
    expect(parseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles extra whitespace around JSON', () => {
    expect(parseJson('  {"a":1}  ')).toEqual({ a: 1 });
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJson('not json at all')).toThrow(SyntaxError);
  });

  it('throws on empty string', () => {
    expect(() => parseJson('')).toThrow(SyntaxError);
  });
});
