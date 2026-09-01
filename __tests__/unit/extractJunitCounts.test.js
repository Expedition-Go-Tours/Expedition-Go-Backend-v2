const { parseJunit } = require('../../scripts/extractJunitCounts');

describe('extractJunitCounts.parseJunit', () => {
  it('aggregates counts from testsuite attributes', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="jest tests" tests="1925" failures="0" errors="0" time="60.79" skipped="12">
        <testsuite name="a" tests="1000" failures="0" errors="0" skipped="5" time="30">
          <testcase name="t1"/>
        </testsuite>
        <testsuite name="b" tests="925" failures="0" errors="0" skipped="7" time="30">
          <testcase name="t2"/>
        </testsuite>
      </testsuites>`;
    const r = parseJunit(xml);
    expect(r.total).toBe(1925);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(12);
    expect(r.passed).toBe(1913);
  });

  it('counts failures and errors as failed', () => {
    const xml = `<testsuites tests="100" failures="3" errors="1" skipped="2">
      <testsuite name="a" tests="100" failures="3" errors="1" skipped="2" time="1"/>
    </testsuites>`;
    const r = parseJunit(xml);
    expect(r.total).toBe(100);
    expect(r.failed).toBe(4);
    expect(r.passed).toBe(94);
  });

  it('falls back to counting testcase elements when no attributes', () => {
    const xml = `<testsuites>
      <testsuite name="a">
        <testcase name="t1"/>
        <testcase name="t2"><failure message="x"/></testcase>
        <testcase name="t3"><skipped/></testcase>
      </testsuite>
    </testsuites>`;
    const r = parseJunit(xml);
    expect(r.total).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.passed).toBe(1);
  });

  it('handles empty reports', () => {
    const r = parseJunit('');
    expect(r).toEqual({ passed: 0, failed: 0, skipped: 0, total: 0 });
  });
});
