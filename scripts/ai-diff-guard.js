#!/usr/bin/env node
/**
 * AI diff guard — validates patches produced by the AI debug agent before
 * they are verified and opened as a PR.
 *
 * Rejects:
 *   1. Changes to protected/infra paths
 *   2. Test-assertion weakening (e.g. toHaveBeenCalledWith -> toHaveBeenCalled,
 *      deleting expect() lines, dropping `.not` assertions)
 *   3. JS files that fail `node --check`
 *   4. Oversized diffs (> MAX_FILES changed files or > MAX_DIFF_LINES lines)
 *
 * Usage:
 *   node scripts/ai-diff-guard.js            # uncommitted working-tree changes
 *   node scripts/ai-diff-guard.js origin/main # committed changes vs a base ref
 *
 * Exit code 0 = safe, 1 = reject (reasons printed to stdout).
 */
const { execSync } = require('child_process');
const fs = require('fs');

const MAX_FILES = 10;
const MAX_DIFF_LINES = 400;

const PROTECTED = [
  /(^|\/)\.env(\.[a-zA-Z0-9_-]+)?$/,
  /^render\.yaml$/,
  /^\.github\/workflows\//,
  /^prisma\/migrations\//,
  /^package-lock\.json$/,
  /^package\.json$/,
  /^Dockerfile/,
  /^docker-compose.*\.ya?ml$/,
  /^ecosystem\.config\.js$/,
];

// Assertion matchers whose removal is suspect (weakening) unless re-added stronger.
const ASSERTION = /(toHaveBeenCalledWith|toBe\(|toEqual\(|toStrictEqual\(|toContain\(|toHaveLength\(|toHaveProperty\(|\.not\.to|toHaveBeenCalledTimes)/;

function git(args) {
  return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
}

function diffFiles(range) {
  return git(`diff --name-only ${range}`).split('\n').filter(Boolean);
}

function numstat(range) {
  return git(`diff --numstat ${range}`).split('\n').filter(Boolean);
}

function main() {
  const errors = [];
  const base = process.argv[2];
  const range = base ? `${base}...HEAD` : 'HEAD';

  let files = [];
  try { files = diffFiles(range); } catch { errors.push('Could not compute diff (are you on a git repo?)'); }
  let stats = [];
  try { stats = numstat(range); } catch { /* same diff failure */ }

  if (files.length === 0) {
    console.log('AI diff guard: no changes detected.');
    return process.exit(0);
  }

  // ── 1. Protected paths + size caps ──────────────────────────────
  let totalLines = 0;
  for (const line of stats) {
    const [add, del] = line.split('\t');
    totalLines += (parseInt(add, 10) || 0) + (parseInt(del, 10) || 0);
  }
  if (files.length > MAX_FILES) errors.push(`Too many files changed (${files.length} > ${MAX_FILES})`);
  if (totalLines > MAX_DIFF_LINES) errors.push(`Diff too large (${totalLines} lines > ${MAX_DIFF_LINES})`);
  for (const f of files) {
    for (const re of PROTECTED) {
      if (re.test(f)) errors.push(`Protected path changed: ${f}`);
    }
  }

  // ── 2. Syntax check on changed JS files ─────────────────────────
  for (const f of files) {
    if (/\.(js|mjs|cjs)$/.test(f) && fs.existsSync(f)) {
      try {
        execSync(`node --check "${f}"`, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        errors.push(`Syntax error in ${f} (node --check failed)`);
      }
    }
  }

  // ── 3. Test-assertion weakening ─────────────────────────────────
  for (const f of files) {
    if (!(/\.(test|spec)\.js$/.test(f) || /__tests__\//.test(f))) continue;
    if (!fs.existsSync(f)) continue;
    let diff = '';
    try { diff = git(`diff -U0 ${range} -- "${f}"`); } catch { continue; }
    const removedLines = (diff.match(/^-(?!--).*/gm) || []).filter((l) => ASSERTION.test(l));
    const addedLines = (diff.match(/^\+(?!\+\+).*/gm) || []).filter((l) => ASSERTION.test(l));
    if (removedLines.length > addedLines.length) {
      errors.push(
        `Test assertions weakened in ${f} (removed ${removedLines.length} strong assertion(s), added ${addedLines.length}). ` +
        `Never weaken tests — update expectations to match production exactly.`
      );
    }
  }

  if (errors.length) {
    console.log('AI DIFF GUARD REJECTED:');
    for (const e of errors) console.log(` - ${e}`);
    return process.exit(1);
  }

  console.log(`AI diff guard passed (${files.length} file(s), ${totalLines} lines).`);
  process.exit(0);
}

main();
