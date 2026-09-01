#!/usr/bin/env node
/**
 * extractJunitCounts.js — parse a jest-junit XML report and write
 * passed/failed/skipped counts to $GITHUB_OUTPUT (or stdout).
 *
 * Usage:
 *   node scripts/extractJunitCounts.js <path-to-junit.xml> [--stdout]
 *
 * Exports pure parse functions for testing.
 *
 * @version 1.0.0
 */

const fs = require('fs');

/**
 * Count tests in junit XML. Aggregates over all <testsuite> elements.
 * Returns { passed, failed, skipped, total }.
 */
function parseJunit(xml) {
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;

  // Aggregate per-testsuite attributes (only <testsuite>, not the <testsuites> wrapper).
  let attrs = xml.match(/<testsuite\s[^>]*>/g) || [];
  if (!attrs.length) {
    // Fall back to the root <testsuites> wrapper (reporters that don't nest).
    attrs = xml.match(/<testsuites\s[^>]*>/g) || [];
  }
  for (const a of attrs) {
    const t = Number((a.match(/tests="(\d+)"/) || [])[1] || 0);
    const f = Number((a.match(/failures="(\d+)"/) || [])[1] || 0);
    const e = Number((a.match(/errors="(\d+)"/) || [])[1] || 0);
    const s = Number((a.match(/skipped="(\d+)"/) || [])[1] || 0);
    tests += t;
    failures += f;
    errors += e;
    skipped += s;
  }

  // Fallback: if no testsuite attributes found, count <testcase> elements.
  if (tests === 0) {
    const cases = xml.split(/<testcase\b/).length - 1;
    const fails = xml.split(/<failure\b/).length - 1;
    const errs = xml.split(/<error\b/).length - 1;
    const skips = xml.split(/<skipped\b/).length - 1;
    tests = cases;
    failures = fails;
    errors = errs;
    skipped = skips;
  }

  // Some reporters omit skipped attr but jest-junit includes it; total
  // passed = tests - failures - errors - skipped.
  const totalFail = failures + errors;
  let passed = tests - totalFail - skipped;
  if (passed < 0) passed = 0;

  return { passed, failed: totalFail, skipped, total: tests };
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('[extractJunitCounts] missing junit file path');
    return 1;
  }
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`[extractJunitCounts] cannot read ${file}: ${e.message}`);
    return 1;
  }

  const { passed, failed, skipped } = parseJunit(xml);
  const out = `passed=${passed}\nfailed=${failed}\nskipped=${skipped}`;

  if (args.includes('--stdout')) {
    console.log(out);
  } else if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out + '\n');
  } else {
    console.log(out);
  }
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { parseJunit };
