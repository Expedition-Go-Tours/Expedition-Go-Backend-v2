/**
 * CI path filter — decides which API image(s) a change requires.
 *
 * The map is the only thing standing between a shared-code change and a
 * half-rebuilt production pair. These tests pin the decisions that matter:
 * a Stays file must not rebuild the Platform image, a shared file must rebuild
 * both, and an unrecognised path must never be treated as "nothing to do".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  detect,
  globToRegExp,
  loadMap,
  normalise,
} = require('../../ci/detect-changes');

const map = loadMap();

describe('globToRegExp', () => {
  it('does not let * cross a path separator', () => {
    const re = globToRegExp('src/brands/ghana/stays*.js');
    expect(re.test('src/brands/ghana/staysRoutes.js')).toBe(true);
    expect(re.test('src/brands/ghana/staysBookingsController.js')).toBe(true);
    expect(re.test('src/brands/ghana/nested/staysRoutes.js')).toBe(false);
    expect(re.test('src/brands/ghana/staysRoutes.ts')).toBe(false);
  });

  it('treats ** as any number of segments, including none', () => {
    const re = globToRegExp('apps/**/server.js');
    expect(re.test('apps/server.js')).toBe(true);
    expect(re.test('apps/stays-api/server.js')).toBe(true);
    expect(re.test('apps/a/b/c/server.js')).toBe(true);
  });

  it('anchors the whole path', () => {
    const re = globToRegExp('package.json');
    expect(re.test('package.json')).toBe(true);
    expect(re.test('nested/package.json')).toBe(false);
    expect(re.test('package.json.bak')).toBe(false);
  });
});

describe('normalise', () => {
  it('strips a leading ./ and converts backslashes', () => {
    expect(normalise('./src\\core\\a.js')).toBe('src/core/a.js');
  });
});

describe('detect', () => {
  it('builds only Stays for a Stays controller change', () => {
    const r = detect(['src/brands/ghana/staysBookingsController.js'], map);
    expect(r).toMatchObject({ platform: false, stays: true, migrations: false });
  });

  it('builds only Stays for the Stays application itself', () => {
    const r = detect(['apps/stays-api/app.js'], map);
    expect(r).toMatchObject({ platform: false, stays: true });
  });

  it('builds only Platform for a Platform route', () => {
    const r = detect(['routes/tourRoutes.js'], map);
    expect(r).toMatchObject({ platform: true, stays: false });
  });

  it('builds both for shared core code', () => {
    const r = detect(['src/core/services/prismaClient.js'], map);
    expect(r).toMatchObject({ platform: true, stays: true });
  });

  it('builds both for dependency and image changes', () => {
    for (const file of ['package.json', 'package-lock.json', 'Dockerfile', '.dockerignore']) {
      const r = detect([file], map);
      expect(r.platform).toBe(true);
      expect(r.stays).toBe(true);
    }
  });

  it('builds both when deploy tooling changes', () => {
    const r = detect(['deploy/scripts/lib.sh'], map);
    expect(r).toMatchObject({ platform: true, stays: true });
  });

  it('treats an unknown path as both, and reports it', () => {
    const r = detect(['brand-new-top-level/thing.js'], map);
    expect(r).toMatchObject({ platform: true, stays: true });
    expect(r.unknown).toEqual(['brand-new-top-level/thing.js']);
  });

  it('ignores documentation-only changes entirely', () => {
    const r = detect(
      ['docs/architecture/two-app-split.md', 'README.md', 'deploy/nginx/README.md'],
      map,
    );
    expect(r).toMatchObject({ platform: false, stays: false, migrations: false });
    expect(r.ignored).toBe(3);
    expect(r.unknown).toEqual([]);
  });

  it('ignores test-only changes without rebuilding images', () => {
    const r = detect(['__tests__/api/staysInventory.test.js'], map);
    expect(r).toMatchObject({ platform: false, stays: false });
  });

  it('flags a migration change and builds both', () => {
    const r = detect(['prisma/migrations/20261116_add_x/migration.sql'], map);
    expect(r).toMatchObject({ platform: true, stays: true, migrations: true });
  });

  it('flags schema.prisma as a migration change', () => {
    const r = detect(['prisma/schema.prisma'], map);
    expect(r).toMatchObject({ platform: true, stays: true, migrations: true });
  });

  it('does not flag a migration for a non-schema prisma file', () => {
    const r = detect(['prisma/seed.js'], map);
    expect(r.migrations).toBe(false);
  });

  it('rebuilds both when the release workflow changes', () => {
    const r = detect(['.github/workflows/docker-release.yml'], map);
    expect(r).toMatchObject({ platform: true, stays: true });
  });

  it('ignores an unrelated workflow change', () => {
    const r = detect(['.github/workflows/ci.yml'], map);
    expect(r).toMatchObject({ platform: false, stays: false });
  });

  it('returns nothing for an empty change set', () => {
    expect(detect([], map)).toMatchObject({
      platform: false,
      stays: false,
      migrations: false,
      changed: 0,
    });
  });

  it('combines per-file decisions without double-counting', () => {
    const r = detect(
      [
        'src/brands/ghana/staysRoutes.js',
        'routes/tourRoutes.js',
        'src/core/services/logger.js',
        'docs/plan.md',
      ],
      map,
    );
    expect(r).toMatchObject({
      platform: true,
      stays: true,
      changed: 4,
      ignored: 1,
    });
  });

  it('every rule references a known application', () => {
    for (const rule of map.rules) {
      expect(rule.apps.length).toBeGreaterThan(0);
      for (const app of rule.apps) {
        expect(map.apps).toContain(app);
      }
    }
  });

  it('every pattern compiles', () => {
    for (const rule of map.rules) {
      for (const re of rule.regexps) expect(re).toBeInstanceOf(RegExp);
    }
    for (const re of map.ignoreRegexps) expect(re).toBeInstanceOf(RegExp);
    for (const re of map.migrationRegexps) expect(re).toBeInstanceOf(RegExp);
  });
});

describe('CLI', () => {
  const script = path.resolve(__dirname, '../../ci/detect-changes.js');

  it('prints JSON for explicit file arguments', () => {
    const out = execFileSync(process.execPath, [script, 'apps/stays-api/app.js'], {
      encoding: 'utf8',
    });
    const result = JSON.parse(out);
    expect(result.stays).toBe(true);
    expect(result.platform).toBe(false);
  });

  it('rebuilds both with --all and never auto-runs migrations', () => {
    const out = execFileSync(process.execPath, [script, '--all'], { encoding: 'utf8' });
    const result = JSON.parse(out);
    expect(result).toMatchObject({
      platform: true,
      stays: true,
      migrations: false,
    });
  });

  it('writes GitHub Action outputs when GITHUB_OUTPUT is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-changes-'));
    const outputFile = path.join(dir, 'output');
    fs.writeFileSync(outputFile, '');

    execFileSync(process.execPath, [script, 'routes/tourRoutes.js'], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputFile },
    });

    const written = fs.readFileSync(outputFile, 'utf8');
    expect(written).toContain('platform=true');
    expect(written).toContain('stays=false');
    expect(written).toContain('migrations=false');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
