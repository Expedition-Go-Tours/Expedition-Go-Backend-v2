const { execSync } = require('child_process');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  certExpiryDays,
  probeSignal,
  SIGNALS,
} = require('../../bots/discord-bot/incidentMonitor');

function opensslAvailable() {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeCert(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-test-'));
  const key = path.join(dir, 'key.pem');
  const crt = path.join(dir, 'crt.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${key}" -out "${crt}" -days ${days} -subj "/CN=localhost"`,
    { stdio: 'ignore' },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

const hasOpenssl = opensslAvailable();

describe('SSL cert-expiry signal', () => {
  it('registers an ssl signal with down/up titles', () => {
    const s = SIGNALS.find((x) => x.id === 'ssl');
    expect(s).toBeDefined();
    expect(s.titleDown).toMatch(/SSL/i);
    expect(s.titleUp).toMatch(/SSL/i);
  });

  it('is a healthy no-op when sslHost is not configured', async () => {
    const r = await probeSignal('ssl', {});
    expect(r.healthy).toBe(true);
    expect(r.detail).toMatch(/not configured/i);
  });

  it('stays healthy (no false incident) when the host is unreachable', async () => {
    const r = await probeSignal('ssl', { sslHost: 'does-not-exist.invalid', sslAlertDays: 21 });
    expect(r.healthy).toBe(true);
    expect(r.detail).toMatch(/unknown/i);
  });

  it('returns null for a closed port instead of throwing', async () => {
    const info = await certExpiryDays('127.0.0.1', 1, 1500);
    expect(info).toBeNull();
  });

  (hasOpenssl ? describe : describe.skip)('against a live TLS endpoint', () => {
    it('measures days-to-expiry from the presented certificate', async () => {
      const { key, cert } = makeCert(10);
      const server = tls.createServer({ key, cert }, (s) => s.end());
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;
      try {
        const info = await certExpiryDays('localhost', port);
        expect(info).not.toBeNull();
        const days = Math.floor(info.days);
        expect(days).toBeGreaterThanOrEqual(8);
        expect(days).toBeLessThanOrEqual(10);
        expect(info.validTo).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        server.close();
      }
    });
  });
});
