jest.mock('child_process', () => ({
  execSync: jest.fn(() => {
    throw new Error('simulated shell unavailable');
  }),
}));

jest.mock('../../utils/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

const { notifyDiscord } = require('../../utils/discordNotifier');
const {
  buildEmbed,
  collectDiagnostics,
  fetchHealth,
  startIncidentMonitor,
  FAIL_THRESHOLD,
  RECOVER_THRESHOLD,
} = require('../../bots/discord-bot/incidentMonitor');

const BASE = {
  target: 'apiv1.travioafrica.com/health',
  startedAt: 1700000000000,
  resolvedAt: 1700000030000,
  durationSec: 30,
};

describe('thresholds', () => {
  it('declares after 2 consecutive failures and recovers after 2 good checks', () => {
    expect(FAIL_THRESHOLD).toBe(2);
    expect(RECOVER_THRESHOLD).toBe(2);
  });
});

describe('buildEmbed', () => {
  const diag = {
    pm2: [
      { name: 'expedition-api', status: 'online', restarts: 6, uptimeSec: 8, memMB: 300, pid: 1 },
      { name: 'discord-bot', status: 'online', restarts: 0, uptimeSec: 900, memMB: 90, pid: 2 },
    ],
    deploy: { lastCommitAt: '2026-09-01 13:20:00', apiUpSinceSec: 8, restartedRecently: true },
    errorTail: 'TypeError: something failed\n    at line 1',
    database: 'ok',
    redis: 'ok',
    nginx: 'ok',
    disk: { total: '75G', usedPct: '21%' },
    memory: '62% used',
    load: '0.19 0.88 0.66',
    cpu: 31,
  };

  it('builds a red incident embed with evidence-based LIKELY CAUSE + ASSESSMENT', () => {
    const e = buildEmbed({ direction: 'down', ...BASE, diag });
    expect(e.title).toBe('🚨 PRODUCTION INCIDENT');
    expect(e.color).toBe(0xff4444);
    expect(e.content).toContain('API: DOWN');
    expect(e.content).toContain('Duration: ongoing');

    const byName = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    // Evidence, not overstatement
    expect(byName['LIKELY CAUSE']).toContain('restarted 6×');
    expect(byName['ASSESSMENT']).toContain('Likely deploy-related transient');
    expect(byName['ASSESSMENT']).toContain('~8s after deployment');
    expect(byName['DEPENDENCIES']).toContain('✅ PostgreSQL');
    expect(byName['RESOURCES']).toContain('CPU 31%');
    expect(byName['LATEST ERROR']).toContain('TypeError');
    expect(byName['CHECK FIRST']).toContain('⚠️ expedition-api');
    expect(byName['Commit']).toContain('13:20:00');
  });

  it('labels unclassified assessment when no deploy correlation', () => {
    const d = { ...diag, deploy: null, pm2: [{ name: 'expedition-api', status: 'online', restarts: 0, uptimeSec: 900, memMB: 300 }] };
    const e = buildEmbed({ direction: 'down', ...BASE, diag: d });
    const byName = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    expect(byName['ASSESSMENT']).toContain('Unclassified');
    expect(byName['LIKELY CAUSE']).toContain('no PM2 restart detected');
  });

  it('builds a green resolved embed with downtime duration', () => {
    const e = buildEmbed({ direction: 'up', ...BASE, diag });
    expect(e.title).toBe('✅ INCIDENT RESOLVED');
    expect(e.color).toBe(0x00c853);
    expect(e.content).toContain('API: UP');
    expect(e.content).toContain('Downtime: 30s');
    const byName = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    expect(byName['DEPENDENCIES']).toContain('✅ PostgreSQL');
  });

  it('handles missing diagnostics gracefully', () => {
    const e = buildEmbed({ direction: 'down', ...BASE, diag: null });
    expect(e.title).toBe('🚨 PRODUCTION INCIDENT');
    const byName = Object.fromEntries(e.fields.map((f) => [f.name, f.value]));
    expect(byName['LIKELY CAUSE']).toContain('Health check failed');
    expect(byName['ASSESSMENT']).toContain('Unclassified');
  });

  it('never contains raw secrets / provider keys in the embed', () => {
    const e = buildEmbed({ direction: 'down', ...BASE, diag });
    const blob = JSON.stringify(e);
    expect(blob).not.toMatch(/sk_test|postgres:|DATABASE_URL|Bearer |password|MIMO_API_KEY/i);
  });
});

describe('fetchHealth', () => {
  it('returns ok when status is 200', async () => {
    global.fetch = async () => ({ status: 200 });
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(true);
  });

  it('returns down on non-200', async () => {
    global.fetch = async () => ({ status: 503 });
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(false);
  });

  it('returns down when fetch throws', async () => {
    global.fetch = async () => { throw new Error('timeout'); };
    const r = await fetchHealth('http://x/health', 1000);
    expect(r.ok).toBe(false);
  });
});

describe('collectDiagnostics', () => {
  const ctx = {
    repoDir: '/repo',
    errorLog: '/logs/api-error.log',
    databaseUrl: 'postgresql://u:p@localhost/db',
    redisUrl: 'redis://:pw@localhost:6379',
  };

  it('returns all diagnostic keys without throwing when shell is unavailable', async () => {
    const diag = await collectDiagnostics(ctx);
    for (const k of ['pm2', 'deploy', 'errorTail', 'database', 'redis', 'nginx', 'disk', 'memory', 'load', 'cpu']) {
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
    intervalMs: 100000, // keep the poll loop from firing during tests
    ...over,
  });

  const makeRedis = () => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    notifyDiscord.mockResolvedValue(undefined);
  });

  it('declares one incident after FAIL_THRESHOLD failures, then recovers after RECOVER_THRESHOLD good checks', async () => {
    let healthy = true;
    global.fetch = jest.fn(async () => ({ status: healthy ? 200 : 503 }));

    const redis = makeRedis();
    const { stop, tick, ready } = startIncidentMonitor({ target: 'x', env: makeEnv(), redis });

    await ready; // startup check ran on healthy baseline
    expect(notifyDiscord).not.toHaveBeenCalled();

    // 1st failure → streak 1, no alert yet
    healthy = false;
    await tick();
    expect(notifyDiscord).not.toHaveBeenCalled();

    // 2nd failure → declare incident
    await tick();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const [chan1, , opts1] = notifyDiscord.mock.calls[0];
    expect(chan1).toBe('incidents');
    expect(opts1.title).toBe('🚨 PRODUCTION INCIDENT');
    expect(opts1.color).toBe(0xff4444);

    // still down: no re-post
    await tick();
    await tick();
    await tick();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);

    // recovery: 1st good check → no alert yet
    healthy = true;
    await tick();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);

    // 2nd good check → resolved
    await tick();
    expect(notifyDiscord).toHaveBeenCalledTimes(2);
    const [, , opts2] = notifyDiscord.mock.calls[1];
    expect(opts2.title).toBe('✅ INCIDENT RESOLVED');
    expect(opts2.color).toBe(0x00c853);

    stop();
  });

  it('does not fire on a single transient failure followed by recovery', async () => {
    let healthy = true;
    global.fetch = jest.fn(async () => ({ status: healthy ? 200 : 503 }));
    const redis = makeRedis();
    const { stop, tick, ready } = startIncidentMonitor({ target: 'x', env: makeEnv(), redis });
    await ready;

    healthy = false;
    await tick(); // 1 failure
    healthy = true;
    await tick(); // back to healthy
    await tick();
    expect(notifyDiscord).not.toHaveBeenCalled();

    stop();
  });

  it('resumes an open incident from Redis without a duplicate card', async () => {
    let healthy = false;
    global.fetch = jest.fn(async () => ({ status: healthy ? 200 : 503 }));
    const redis = makeRedis();
    redis.get.mockResolvedValue(JSON.stringify({ state: 'INCIDENT', downSince: Date.now() - 60000, passStreak: 0 }));

    const { stop, tick, ready } = startIncidentMonitor({ target: 'x', env: makeEnv(), redis });
    await ready; // startup check ran while still down → no new incident
    expect(notifyDiscord).not.toHaveBeenCalled();

    // recovery after 2 good checks
    healthy = true;
    await tick();
    await tick();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
    const [, , opts] = notifyDiscord.mock.calls[0];
    expect(opts.title).toBe('✅ INCIDENT RESOLVED');

    stop();
  });

  it('does not start when apiUrl is missing', () => {
    expect(startIncidentMonitor({ target: 'x', env: {} })).toBeUndefined();
  });
});



