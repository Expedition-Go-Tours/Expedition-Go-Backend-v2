#!/usr/bin/env node
/**
 * Decide which API images a set of changed files requires.
 *
 * The two applications share one package, one Prisma schema and most of
 * `src/core`. Rebuilding both on every documentation edit wastes runner minutes
 * and, worse, produces a new Stays image digest when nothing about Stays
 * changed — which makes "what is running in production?" harder to answer.
 * Rebuilding only one when a shared file changed is the opposite mistake: it
 * ships two containers built from different source trees.
 *
 * So the default is deliberately paranoid: a path that matches no rule builds
 * both images. Silence is never allowed to mean "nothing changed".
 *
 * CLI:
 *   node ci/detect-changes.js --base origin/main --head HEAD
 *   node ci/detect-changes.js file1.js src/brands/ghana/staysRoutes.js
 *   git diff --name-only main...HEAD | node ci/detect-changes.js --stdin
 *
 * Output (also written to $GITHUB_OUTPUT as one key=value per line):
 *   { "platform": true, "stays": false, "migrations": false,
 *     "changed": 3, "unknown": [], "ignored": 0 }
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAP_PATH = path.join(__dirname, 'dependency-map.json');

function escapeRegExpChar(ch) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Minimal glob → RegExp.
 *
 * Supports exactly what the map uses:
 *   `**`  → any number of path segments
 *   `*`   → anything except `/`
 *   `?`   → one character except `/`
 *
 * Keeping this tiny is intentional: a full glob library is another dependency
 * in the release path, and every pattern in dependency-map.json is one of these
 * three forms.
 */
function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function compileMap(map) {
  return {
    ...map,
    rules: map.rules.map((rule) => ({
      ...rule,
      regexps: rule.paths.map(globToRegExp),
    })),
    ignoreRegexps: map.ignore.map(globToRegExp),
    migrationRegexps: map.migrations.map(globToRegExp),
  };
}

function loadMap(mapPath = MAP_PATH) {
  return compileMap(JSON.parse(fs.readFileSync(mapPath, 'utf8')));
}

/** Normalise to forward slashes and drop any leading `./`. */
function normalise(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * @returns {{ platform: boolean, stays: boolean, migrations: boolean,
 *             changed: number, ignored: number, unknown: string[] }}
 */
function detect(changedFiles, compiled = loadMap()) {
  const result = {
    platform: false,
    stays: false,
    migrations: false,
    changed: 0,
    ignored: 0,
    unknown: [],
  };

  for (const raw of changedFiles) {
    const file = normalise(raw).trim();
    if (!file) continue;
    result.changed += 1;

    if (compiled.ignoreRegexps.some((re) => re.test(file))) {
      result.ignored += 1;
      continue;
    }

    if (compiled.migrationRegexps.some((re) => re.test(file))) {
      result.migrations = true;
    }

    const rule = compiled.rules.find((candidate) =>
      candidate.regexps.some((re) => re.test(file)),
    );

    if (!rule) {
      // Unknown path: build everything. A new top-level directory must not be
      // able to slip past the map unnoticed.
      result.platform = true;
      result.stays = true;
      result.unknown.push(file);
      continue;
    }

    if (rule.apps.includes('platform')) result.platform = true;
    if (rule.apps.includes('stays')) result.stays = true;
  }

  return result;
}

/** `git diff --name-only` between two refs; empty string on failure. */
function changedFromGit(base, head) {
  const args = ['diff', '--name-only'];
  if (base && head) args.push(`${base}...${head}`);
  else if (base) args.push(base);
  const output = execFileSync('git', args, { encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function writeGithubOutput(result) {
  const target = process.env.GITHUB_OUTPUT;
  if (!target) return;
  const lines = [
    `platform=${result.platform}`,
    `stays=${result.stays}`,
    `migrations=${result.migrations}`,
    `changed=${result.changed}`,
    `unknown_count=${result.unknown.length}`,
  ];
  fs.appendFileSync(target, `${lines.join('\n')}\n`);
}

function main(argv) {
  const args = argv.slice(2);
  let files = [];
  let base = '';
  let head = '';
  let forceAll = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--all') {
      // Manual release: build both images regardless of what changed. A human
      // pressing "Run workflow" wants the pair rebuilt, not a diff guess.
      forceAll = true;
    } else if (arg === '--stdin') {
      files = readStdin().split('\n').filter(Boolean);
    } else if (arg === '--base') {
      base = args[(i += 1)];
    } else if (arg === '--head') {
      head = args[(i += 1)];
    } else if (arg === '--json') {
      // Output format is always JSON; accepted for readability at call sites.
    } else {
      files.push(arg);
    }
  }

  if (!files.length && (base || head)) {
    files = changedFromGit(base, head);
  }

  if (forceAll) {
    const result = {
      platform: true,
      stays: true,
      migrations: false,
      changed: files.length,
      ignored: 0,
      unknown: [],
    };
    writeGithubOutput(result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const result = detect(files);
  writeGithubOutput(result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  detect,
  globToRegExp,
  loadMap,
  compileMap,
  normalise,
  changedFromGit,
  MAP_PATH,
};
