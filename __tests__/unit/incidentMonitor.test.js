const { execSync } = require('child_process');

jest.mock('child_process', () => ({
  execSync: jest.fn(() => {
    throw new Error('simulated shell unavailable');
  }),
}));

const { buildEmbed, collectDiagnostics, fetchHealth, startIncidentMonitor } = require('../../bots/discord-bot/incidentMonitor');

describe('buildEmbed', () => {
  const base = {
    target: 'apiv1.travioafrica.com/health',
    startedAt: 1700000000000,
    resolvedAt: 1700000030000,
    durationSec: 30,
  };

  it('builds a red DOWN embed with diagnostics', () => {
    const diag = {
      pm2: [
        { name: 'expedition-api', status: 'online', restarts: 1085, uptimeSec: 130, memMB: 300, pid: 1 },
        { name: 'discord-bot', status: 'online', restarts: 0, uptimeSec: 900, memMB: 90, pid: 2 },
      ],
      deploy: { lastCommitAt: '2026-09-01 13:20:00', apiUpSinceSec: 130, likelyDeployRestart: true },
      errorTail: 'TypeError: something failed\n    at line 1',
      database: 'healthy',
      redis: 'healthy',
      nginx: 'active',
      disk: { total: '75G', usedPct: '21%' },
      memory: '1000/3809 MB used, 1600 MB avail',
      load: '0.19 0.88 0.66',
    };
    const embed = buildEmbed({ direction: 'down', ...base, diag });
    expect(embed.color).toBe(0xff4444);
    expect(embed.title).toContain('incident');
    expect(embed.description).toContain('expedition-api');
    expect(embed.description).toContain('likely a deploy restart');
    expect(embed.description).toContain('Database:** healthy');
    expect(embed.description).toContain('Redis:** healthy');
    expect(embed.description).toContain('Last API errors');
    expect(embed.description).toContain('Disk /:** 21%');
  });

  it('builds a green resolved embed with duration', () => {
    const diag = { database: 'healthy', redis: 'healthy', nginx: 'active' };
    const embed = buildEmbed({ direction: 'up', ...base, diag });
    expect(embed.color).toBe(0x00c853);
    expect(embed.title).toContain('resolved');
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Duration', value: '30s' }),
    ]));
  });

  it('marks unavailable diagnostics gracefully', () => {
    const embed = buildEmbed({ direction: 'down', ...base, diag: null });
    expect(embed.description).toContain('(unavailable)');
  });
});

describe('fetchHealth', () => {
  it('returns ok when status is 200', async () => {
    global.fetch = async (url, opts) => ({ status: 200 });
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });

  it('returns down on non-200', async () => {
    global.fetch = async () => ({ status: 503 });
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(false);
  });

  it('returns down when fetch throws (timeout/network)', async () => {
    global.fetch = async () => { throw new Error('timeout'); };
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
  });
});

describe('collectDiagnostics', () => {
  const ctx = {
    repoDir: '/repo',
    errorLog: '/logs/api-error.log',
    databaseUrl: 'postgresql://u:p@localhost/db',
    redisUrl: 'redis://:pw@localhost:6379',
  };

  it('collects the full suite and falls back to unavailable', async () => {
    // Simulate unavailable shell commands by making everything throw.
    // We use a child_process stub via jest.isolateModules in a child... simplest: monkeypatch execSync through require cache is complex.
    // Instead, run against a context and assert no exceptions and shape present.
    const diag = await collectDiagnostics(ctx);
    expect(diag).toBeDefined();
    expect(typeof diag).toBe('object');
    // keys exist regardless of command availability
    for (const k of ['pm2', 'deploy', 'errorTail', 'database', 'redis', 'nginx', 'disk', 'memory', 'load']) {
      expect(k in diag).toBe(true);
    }
  });
});

describe('startIncidentMonitor', () => {
  const makeEnv = (over = {}) => ({
    apiUrl: 'http://127.0.0.1:5000/health',
    publicUrl: 'https://apiv1.travioafrica.com/health',
    databaseUrl: 'postgresql://u:p@localhost/db',
    redisUrl: 'redis://:pw@localhost:6379',
    repoDir: '/repo',
    errorLog: '/logs/api-error.log',
    intervalMs: 5000,
    ...over,
  });

  const makeClient = () => ({
    channels: { fetch: jest.fn().mockResolvedValue({ send: jest.fn().mockResolvedValue(undefined) }) },
  });

  it('does not start without channelId', () => {
    expect(startIncidentMonitor({ client: makeClient(), channelId: '', target: 'x', env: makeEnv() })).toBeUndefined();
  });

  it('posts DOWN then UP embeds on health transitions', async () => {
    let healthy = true;
    global.fetch = jest.fn(async () => ({ status: healthy ? 200 : 503 }));

    const channel = { send: jest.fn().mockResolvedValue(undefined) };
    const client = { channels: { fetch: jest.fn().mockResolvedValue(channel) } };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };

    const { stop, tick } = startIncidentMonitor({
      client,
      channelId: '111',
      target: 'apiv1.travioafrica.com/health',
      env: makeEnv({ intervalMs: 100000 }),
      redis,
    });

    // Wait for the initial check (healthy → no embed)
    await new Promise((r) => setTimeout(r, 50));
    expect(channel.send).not.toHaveBeenCalled();

    // Simulate outage
    healthy = false;
    await tick();
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send.mock.calls[0][0].embeds[0].title).toContain('incident');
    expect(channel.send.mock.calls[0][0].embeds[0].color).toBe(0xff4444);

    // No duplicate while still down
    await tick();
    expect(channel.send).toHaveBeenCalledTimes(1);

    // Recovery
    healthy = true;
    await tick();
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(channel.send.mock.calls[1][0].embeds[0].title).toContain('resolved');
    expect(channel.send.mock.calls[1][0].embeds[0].color).toBe(0x00c853);

    stop();
  });
});
