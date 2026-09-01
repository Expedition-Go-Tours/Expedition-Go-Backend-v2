const { buildPayload, fmtDuration, fmtTests, truncate } = require('../../scripts/deployNotify');

function env(over = {}) {
  return {
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'Expedition-Go-Tours/Expedition-Go-Backend-v2',
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_NUMBER: '42',
    GITHUB_SHA: 'a81f92c000000000000000000000000000000000',
    GITHUB_REF_NAME: 'main',
    GITHUB_ACTOR: 'gideon211',
    ...over,
  };
}

describe('deployNotify.buildPayload', () => {
  it('builds a started embed with env/branch/commit/author/changes/run', () => {
    const e = env({
      DEPLOY_SHORT_SHA: 'a81f92c',
      DEPLOY_AUTHOR: 'Gideon',
      DEPLOY_SUBJECT: 'feat: xyz',
      DEPLOY_CHANGED_FILES: '14',
    });
    const p = buildPayload('started', e);
    expect(p.embeds).toHaveLength(1);
    const em = p.embeds[0];
    expect(em.title).toBe('🚀 Deployment Started');
    expect(em.color).toBe(0x3b82f6);
    const names = em.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Environment', 'Branch', 'Commit', 'Author', 'Changes', 'Run']));
    const commit = em.fields.find((f) => f.name === 'Commit');
    expect(commit.value).toContain('a81f92c');
    expect(em.fields.find((f) => f.name === 'Changes').value).toBe('14 files');
    expect(em.url).toContain('/actions/runs/123456');
  });

  it('defaults changed files to N/A when unavailable', () => {
    const p = buildPayload('started', env());
    expect(p.embeds[0].fields.find((f) => f.name === 'Changes').value).toBe('N/A');
  });

  it('builds a completed embed with duration and test rollup', () => {
    const e = env({
      DEPLOY_SHORT_SHA: 'a81f92c',
      DEPLOY_DURATION: '48',
      TESTS_UNIT_PASSED: '1911',
      TESTS_UNIT_FAILED: '0',
      TESTS_UNIT_SKIPPED: '7',
      TESTS_INTEGRATION_PASSED: '10',
      TESTS_INTEGRATION_FAILED: '0',
      TESTS_INTEGRATION_SKIPPED: '0',
      TESTS_E2E_PASSED: '4',
      TESTS_E2E_FAILED: '0',
      TESTS_E2E_SKIPPED: '0',
    });
    const em = buildPayload('completed', e).embeds[0];
    expect(em.title).toBe('📦 Deployment Completed');
    expect(em.color).toBe(0xf59e0b); // amber — NOT green
    expect(em.description).toContain('verification pending');
    const tests = em.fields.find((f) => f.name === 'Tests').value;
    expect(tests).toContain('1,925 passed');
    expect(tests).toContain('0 failed');
    expect(tests).toContain('7 skipped');
    expect(em.fields.find((f) => f.name === 'Duration').value).toBe('48s');
  });

  it('omits test rollup when no counts are available', () => {
    const em = buildPayload('completed', env({ DEPLOY_DURATION: '10' })).embeds[0];
    expect(em.fields.find((f) => f.name === 'Tests')).toBeUndefined();
  });

  it('builds a verified embed with health/tours/latency/total', () => {
    const e = env({
      DEPLOY_SHORT_SHA: 'a81f92c',
      HEALTH_CODE: '200',
      HEALTH_LATENCY_MS: '180',
      TOURS_CODE: '200',
      VERIFY_DURATION: '14',
      TOTAL_DURATION: '62',
      HEALTH_DETAILS: '{"status":"success","checks":{"database":"healthy","redis":"healthy"}}',
    });
    const em = buildPayload('verified', e).embeds[0];
    expect(em.title).toBe('🏥 Production Verified');
    expect(em.color).toBe(0x22c55e);
    expect(em.fields.find((f) => f.name === 'Health').value).toBe('HTTP 200');
    expect(em.fields.find((f) => f.name === 'Tours').value).toBe('HTTP 200');
    expect(em.fields.find((f) => f.name === 'Latency').value).toBe('180ms');
    expect(em.fields.find((f) => f.name === 'Total (start → verified)').value).toBe('1m 2s');
  });

  it('builds a deployment failure embed with run link only', () => {
    const e = env({
      FAIL_STAGE: 'deployment',
      FAIL_STEP: 'SSH deployment',
      DEPLOY_SHORT_SHA: 'a81f92c',
      DEPLOY_DURATION: '31',
    });
    const em = buildPayload('failed', e).embeds[0];
    expect(em.title).toBe('❌ Deployment Failed');
    expect(em.color).toBe(0xef4444);
    expect(em.description).toContain('See the run for details');
    expect(em.fields.find((f) => f.name === 'Stage').value).toBe('SSH deployment');
    expect(em.fields.find((f) => f.name === 'Run').value).toContain('/actions/runs/123456');
    // Safety: never include raw output / secrets in the embed
    expect(JSON.stringify(em)).not.toMatch(/sk_test|postgres|REDIS|DATABASE_URL|password|token/i);
  });

  it('builds a verification failure embed (never labeled successful)', () => {
    const em = buildPayload('failed', env({ FAIL_STAGE: 'verification', DEPLOY_SHORT_SHA: 'a81f92c' })).embeds[0];
    expect(em.title).toBe('❌ Verification Failed');
    expect(em.description).not.toContain('success');
  });

  it('builds a concise CI failure embed with failed jobs', () => {
    const e = env({
      FAILED_JOBS: '`unit-tests` `deploy` ',
      CI_DURATION: '90',
      DEPLOY_SHORT_SHA: 'a81f92c',
    });
    const em = buildPayload('ci_failed', e).embeds[0];
    expect(em.title).toBe('❌ CI Failed');
    expect(em.fields.find((f) => f.name === 'Failed jobs').value).toContain('unit-tests');
    expect(em.fields.find((f) => f.name === 'Duration').value).toBe('1m 30s');
  });

  it('throws on unknown state', () => {
    expect(() => buildPayload('bogus', env())).toThrow(/Unknown STATE/);
  });
});

describe('deployNotify helpers', () => {
  it('truncates and strips control chars', () => {
    const s = truncate(`line1\nline2\u0007${'x'.repeat(1200)}`, 1000);
    expect(s.length).toBeLessThanOrEqual(1001);
    expect(s).not.toContain('\u0007');
  });

  it('formats durations', () => {
    expect(fmtDuration('5')).toBe('5s');
    expect(fmtDuration('90')).toBe('1m 30s');
    expect(fmtDuration(undefined)).toBe('0s');
  });

  it('formats test rollups with commas', () => {
    const t = fmtTests({ TESTS_UNIT_PASSED: '1911', TESTS_UNIT_FAILED: '0', TESTS_UNIT_SKIPPED: '7' });
    expect(t).toContain('1,911 passed');
  });
});
