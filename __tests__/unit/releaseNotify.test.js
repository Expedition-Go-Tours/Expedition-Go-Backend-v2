const {
  buildStartPayload,
  buildFinalPayload,
  formatDuration,
  isFailed,
  readTests,
} = require('../../scripts/release/notify');

const META = {
  subject: 'fix(release): announce deploy start',
  body: 'The summary compared the display label with the raw result.',
  author: 'Gideon',
  url: 'https://github.com/Expedition-Go-Tours/Expedition-Go-Backend-v2/commit/abcdef1234567890',
  pr: { number: 184, url: 'https://github.com/Expedition-Go-Tours/Expedition-Go-Backend-v2/pull/184' },
};

const BASE = {
  apps: 'platform, stays',
  sha: 'abcdef1234567890',
  ref: 'main',
  meta: META,
  runUrl: 'https://github.com/o/r/actions/runs/1',
  ciRunUrl: 'https://github.com/o/r/actions/runs/2',
  event: 'push',
  actor: 'gideon',
  repoUrl: 'https://github.com/o/r',
  oncallRoleId: '1234',
};

const OK = { build: 'success', migrate: 'skipped', platform: 'success', stays: 'success', verify: 'success' };

describe('release notifier', () => {
  it('formats durations the way the old embeds did', () => {
    expect(formatDuration(92)).toBe('1m 32s');
    expect(formatDuration(8)).toBe('8s');
    expect(formatDuration(null)).toBe('—');
  });

  it('treats only success and deliberate skips as non-failures', () => {
    expect(isFailed(OK)).toBe(false);
    expect(isFailed({ ...OK, verify: 'failure' })).toBe(true);
    expect(isFailed({ ...OK, build: 'cancelled' })).toBe(true);
    expect(isFailed({ ...OK, deploy: '' })).toBe(true);
  });

  it('builds a start card with commit, PR and run buttons', () => {
    const payload = buildStartPayload(BASE);

    expect(payload.content).toContain('Deploy started');
    expect(payload.content).toContain('platform, stays');
    expect(payload.embeds[0].title).toBe(META.subject);
    expect(payload.embeds[0].color).toBe(0x3498db);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].fields[0].name).toBe('Commit message');
    const labels = payload.components[0].components.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['View run', 'Commit', 'PR #184']));
  });

  it('builds a green final card with stages, tests, health and links', () => {
    const payload = buildFinalPayload({
      ...BASE,
      results: OK,
      durations: { build: 92, migrate: null, platform: 66, stays: 58, verify: 2 },
      health: [
        { host: 'api.travioghana.com', code: 200, ms: 340 },
        { host: 'apiv1.travioafrica.com', code: 200, ms: 410 },
      ],
      tests: {
        unit: { passed: 4100, failed: 0, skipped: 12 },
        integration: { passed: 700, failed: 0, skipped: 5 },
        e2e: { passed: 183, failed: 0, skipped: 0 },
        total: { passed: 4983, failed: 0, skipped: 17 },
      },
    });

    expect(payload.content).toContain('✅ Deployed');
    expect(payload.content).not.toContain('<@&');
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].color).toBe(0x2ecc71);
    expect(payload.embeds[0].fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Stages', 'Tests', 'Health', 'Commit message']),
    );
    const testsField = payload.embeds[0].fields.find((f) => f.name === 'Tests');
    expect(testsField.value).toContain('4,983 passed');
    expect(testsField.value).toContain('integration 700');
    const healthField = payload.embeds[0].fields.find((f) => f.name === 'Health');
    expect(healthField.value).toContain('api.travioghana.com 200');
    const labels = payload.components[0].components.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['View run', 'Commit', 'CI run', 'Rollback runbook']));
  });

  it('builds a red card that pings on-call when verification fails', () => {
    const payload = buildFinalPayload({
      ...BASE,
      results: { ...OK, verify: 'failure' },
      durations: { build: 92, migrate: null, platform: 66, stays: 58, verify: 2 },
      health: [{ host: 'api.travioghana.com', code: 502, ms: 900 }],
      tests: null,
    });

    expect(payload.content.startsWith('<@&1234>')).toBe(true);
    expect(payload.content).toContain('❌ Release failed');
    expect(payload.allowed_mentions).toEqual({ parse: ['roles'] });
    expect(payload.embeds[0].color).toBe(0xe74c3c);
    const stages = payload.embeds[0].fields.find((f) => f.name === 'Stages').value;
    expect(stages).toContain('Ingress');
    expect(stages).toContain('FAILED');
    expect(payload.embeds[0].fields.some((f) => f.name === 'Tests')).toBe(false);
  });

  it('returns null when the test-summary artifact is missing', () => {
    expect(readTests('/tmp/does-not-exist/test-summary.json')).toBeNull();
  });
});
