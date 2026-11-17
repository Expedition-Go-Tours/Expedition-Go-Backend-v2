/**
 * The performance workflow boots platform-api with NODE_ENV=production, so
 * `config/validateEnv.js` exits the process when any PLATFORM_REQUIRED_IN_PROD
 * key is absent. On 2026-11-17 that is exactly what happened: perf.yml set
 * SENDGRID_API_KEY (which nothing reads) but not RESEND_API_KEY, the server
 * exited in under a second, and all three k6 scenarios failed at "Wait for
 * health endpoint" without ever measuring performance.
 *
 * This guard reads the workflow's top-level env block directly, so adding a
 * required variable to the application fails the unit suite until the perf
 * workflow supplies it too.
 */

const fs = require('fs');
const path = require('path');
const {
  PLATFORM_REQUIRED_IN_PROD,
} = require('../../config/validateEnv');

const workflowsDir = path.join(__dirname, '../../.github/workflows');

function topLevelEnvKeys(file) {
  const lines = fs.readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^env:\s*$/.test(line));
  if (start === -1) return new Set();

  const keys = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // The next top-level key ends the workflow-level env block.
    if (/^\S/.test(line)) break;
    const match = line.match(/^ {2}([A-Z0-9_]+):/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

describe('performance workflow environment', () => {
  it('supplies every platform-api required variable in perf.yml', () => {
    const keys = topLevelEnvKeys('perf.yml');
    const missing = PLATFORM_REQUIRED_IN_PROD.filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it('parses the env block rather than passing on an empty set', () => {
    const keys = topLevelEnvKeys('perf.yml');
    expect(keys.size).toBeGreaterThan(5);
    expect(keys.has('DATABASE_URL')).toBe(true);
    expect(keys.has('RESEND_API_KEY')).toBe(true);
  });
});
