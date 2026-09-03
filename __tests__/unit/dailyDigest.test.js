jest.mock('dotenv', () => ({ config: jest.fn() }));

jest.mock('child_process', () => ({
  execSync: jest.fn(() => ''),
}));

const mockPrisma = {
  systemConfig: {
    findUnique: jest.fn().mockResolvedValue({ key: 'platform.timezone', value: 'UTC' }),
  },
  booking: {
    aggregate: jest.fn().mockResolvedValue({
      _count: 5,
      _sum: { grossAmount: 1250.75, platformCommission: 187.61, supplierPayout: 1063.14 },
    }),
    count: jest.fn().mockResolvedValue(3),
    groupBy: jest.fn().mockImplementation(({ by }) => {
      if (by && by[0] === 'status') {
        return Promise.resolve([
          { status: 'CONFIRMED', _count: 4 },
          { status: 'REFUNDED', _count: 1 },
        ]);
      }
      return Promise.resolve([
        { tourId: 't1', _sum: { grossAmount: 600 } },
        { tourId: 't2', _sum: { grossAmount: 400 } },
      ]);
    }),
  },
  user: { count: jest.fn().mockResolvedValue(8) },
  supplierProfile: {
    count: jest.fn().mockResolvedValue(2),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  review: {
    aggregate: jest.fn().mockResolvedValue({ _count: 9, _avg: { rating: 4.6 } }),
  },
  payout: {
    aggregate: jest.fn().mockResolvedValue({ _count: 3, _sum: { amount: 900 } }),
  },
  tour: {
    findUnique: jest.fn().mockImplementation(({ where }) => {
      const tours = { t1: { title: 'Serengeti Safari' }, t2: { title: 'Zanzibar Beach' } };
      return Promise.resolve(tours[where.id] || { title: 'Unknown Tour' });
    }),
  },
  dispute: {
    count: jest.fn().mockResolvedValue(1),
  },
  $disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrisma),
}));

jest.mock('../../utils/discordNotifier', () => ({
  notifyDiscord: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/mimoClient', () => ({
  callMimo: jest.fn(() => Promise.resolve('FACT: bookings low\nINFERENCE: review sources')),
}));

const { execSync } = require('child_process');
const { callMimo } = require('../../utils/mimoClient');

const {
  collectDigest,
  parseBackupLog,
  parseDrillLog,
  incidentSummary,
  periodInfo,
  deltaPct,
  renderer,
  buildReport,
} = require('../../scripts/dailyDigest');

function resetMocks() {
  jest.clearAllMocks();
  delete process.env.MIMO_API_KEY;
  delete process.env.DIGEST_PERIOD;
  delete process.env.BETTERSTACK_API_TOKEN;

  mockPrisma.systemConfig.findUnique.mockResolvedValue({ key: 'platform.timezone', value: 'UTC' });
  mockPrisma.booking.aggregate.mockResolvedValue({
    _count: 5,
    _sum: { grossAmount: 1250.75, platformCommission: 187.61, supplierPayout: 1063.14 },
  });
  mockPrisma.booking.count.mockResolvedValue(3);
  mockPrisma.user.count.mockResolvedValue(8);
  mockPrisma.supplierProfile.count.mockResolvedValue(2);
  mockPrisma.review.aggregate.mockResolvedValue({ _count: 9, _avg: { rating: 4.6 } });
  mockPrisma.payout.aggregate.mockResolvedValue({ _count: 3, _sum: { amount: 900 } });
  mockPrisma.dispute.count.mockResolvedValue(1);

  // fake /health + incidents
  process.env.BETTERSTACK_API_TOKEN = 'test-bs';
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/health')) {
      return { status: 200, ok: true, json: async () => ({ status: 'success', checks: { database: 'healthy', redis: 'healthy' }, scheduler: { status: 'healthy', expected: 20, registered: 20, missing: [], stale: [] } }) };
    }
    if (String(url).includes('/incidents')) {
      return { status: 200, ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, status: 500 };
  });

  execSync.mockImplementation((cmd) => {
    if (/systemctl is-active nginx/.test(cmd)) return 'active';
    if (/free -m/.test(cmd)) return 'RAM 40%';
    if (/df -h/.test(cmd)) return 'Disk 21%';
    if (/loadavg/.test(cmd)) return '0.1 0.2 0.3';
    if (/Backup complete|Dump OK|FAIL:/.test(cmd)) return '2026-09-02T02:00:02+00:00 Dump OK: travio-2026-09-02.dump (5.1M)\n2026-09-02T02:00:04+00:00 === Backup complete ===';
    if (/Restore drill COMPLETE|RESTORE DRILL FAIL/.test(cmd)) return '2026-09-02T03:00:00+00:00 === Restore drill COMPLETE: 55 tables (54 exact), 68 FKs, 255 indexes, 0 orphans, 0 over-restore ===';
    if (/git -C .* log/.test(cmd)) return 'abc1234 feat: something\nbcd2345 fix: other';
    return '';
  });
}

describe('parseBackupLog', () => {
  it('parses a completed backup', () => {
    const r = parseBackupLog('2026-09-02T02:00:01+00:00 === Backup start ===\n2026-09-02T02:00:03+00:00 Dump OK: travio-2026-09-02.dump (5.1M)\n2026-09-02T02:00:04+00:00 === Backup complete ===');
    expect(r.ok).toBe(true);
    expect(r.value.ok).toBe(true);
    expect(r.value.date).toContain('2026-09-02T02:00:04');
    expect(r.value.size).toContain('5.1M');
    expect(r.value.dest).toContain('Storage Box');
  });

  it('uses the most recent backup block, not the first', () => {
    const log = [
      '2026-09-01T02:00:02+00:00 Dump OK: travio-2026-09-01.dump (5.1M)',
      '2026-09-01T02:00:03+00:00 === Backup complete ===',
      '2026-09-02T02:00:03+00:00 Dump OK: travio-2026-09-02.dump (5.2M)',
      '2026-09-02T02:00:04+00:00 === Backup complete ===',
    ].join('\n');
    const r = parseBackupLog(log);
    expect(r.ok).toBe(true);
    expect(r.value.date).toContain('2026-09-02T02:00:04');
    expect(r.value.size).toContain('5.2M');
  });

  it('reports failure when last event is FAIL', () => {
    const r = parseBackupLog('2026-09-01T02:00:00+00:00 FAIL: pg_dump failed');
    expect(r.ok).toBe(true);
    expect(r.value.ok).toBe(false);
    expect(r.value.note).toContain('failed');
  });

  it('returns unavailable when no events', () => {
    const r = parseBackupLog('');
    expect(r.ok).toBe(false);
  });
});

describe('parseDrillLog', () => {
  it('parses a passing drill', () => {
    const r = parseDrillLog('=== Restore drill COMPLETE: 55 tables (54 exact), 68 FKs, 255 indexes, 0 orphans, 0 over-restore ===');
    expect(r.ok).toBe(true);
    expect(r.value.passed).toBe(true);
    expect(r.value.summary).toContain('55 tables');
  });

  it('parses a failing drill', () => {
    const r = parseDrillLog('2026-09-01T03:00:00+00:00 RESTORE DRILL FAIL: row mismatch on AuditLog');
    expect(r.ok).toBe(true);
    expect(r.value.passed).toBe(false);
    expect(r.value.summary).toContain('row mismatch');
  });

  it('unavailable when no drill markers', () => {
    expect(parseDrillLog('')).toEqual({ ok: false });
  });
});

describe('incidentSummary', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  const end = new Date('2026-09-02T00:00:00Z');

  it('counts only Travio monitors and sums downtime', () => {
    const inc = [
      { attributes: { name: 'apiv1.travioafrica.com/health', status: 'Resolved', started_at: '2026-09-01T13:22:00Z', resolved_at: '2026-09-01T13:28:00Z' } },
      { attributes: { name: 'google.com', status: 'Resolved', started_at: '2026-09-01T13:22:00Z', resolved_at: '2026-09-01T13:28:00Z' } },
    ];
    const r = incidentSummary(inc, start, end);
    expect(r.count).toBe(1);
    expect(r.downtimeMs).toBe(6 * 60 * 1000);
  });

  it('counts only the in-window portion of a cross-midnight incident', () => {
    // started 23:00 Sep 1, resolved 01:00 Sep 2 -> only 1h in window
    const inc = [{ attributes: { name: 'apiv1.travioafrica.com', status: 'Resolved', started_at: '2026-09-01T23:00:00Z', resolved_at: '2026-09-02T01:00:00Z' } }];
    const r = incidentSummary(inc, start, end);
    expect(r.count).toBe(1);
    expect(r.downtimeMs).toBe(60 * 60 * 1000);
  });

  it('excludes incidents fully outside the window', () => {
    const inc = [{ attributes: { name: 'apiv1.travioafrica.com', status: 'Resolved', started_at: '2026-09-03T00:00:00Z', resolved_at: '2026-09-03T01:00:00Z' } }];
    expect(incidentSummary(inc, start, end).count).toBe(0);
  });

  it('handles unresolved (ongoing) incidents up to now', () => {
    const inc = [{ attributes: { name: 'apiv1.travioafrica.com/health', status: 'Started', started_at: '2026-09-01T10:00:00Z', resolved_at: null } }];
    const r = incidentSummary(inc, start, end);
    expect(r.count).toBe(1);
    expect(r.downtimeMs).toBeGreaterThan(0);
    expect(r.downtimeMs).toBeLessThanOrEqual(14 * 60 * 60 * 1000);
  });
});

describe('periodInfo', () => {
  it('daily windows exclude the reporting day from baseline', () => {
    // monkeypatch Date so utcDayStart returns known offsets is tricky; instead
    // assert relationships: baseline is 1 day before prior, prior ends at reporting start.
    const p = periodInfo(false);
    expect(p.reportingEnd.getTime()).toBeGreaterThan(p.reportingStart.getTime());
    expect(p.priorEnd.getTime()).toBe(p.reportingStart.getTime());
    expect(p.baselineEnd.getTime()).toBe(p.reportingStart.getTime());
    // reporting window is 1 day; baseline window spans 1 day too (daily)
    expect(p.baselineStart.getTime()).toBe(p.priorStart.getTime());
    expect(p.reportingEnd.getTime() - p.reportingStart.getTime()).toBe(24 * 3600 * 1000);
  });

  it('weekly windows span 7 days', () => {
    const p = periodInfo(true);
    expect(p.reportingEnd.getTime() - p.reportingStart.getTime()).toBe(7 * 24 * 3600 * 1000);
    expect(p.baselineEnd.getTime()).toBe(p.reportingStart.getTime());
    expect(p.reportingStart.getTime() - p.baselineStart.getTime()).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('deltaPct', () => {
  it('computes direction and magnitude', () => {
    expect(deltaPct(1, 2)).toBe('↓ 50% vs previous');
    expect(deltaPct(4, 2)).toBe('↑ 100% vs previous');
  });
  it('returns em dash when previous is 0 or missing', () => {
    expect(deltaPct(3, 0)).toBe('—');
    expect(deltaPct(3, null)).toBe('—');
  });
});

describe('collectDigest (end-to-end, mocked)', () => {
  beforeEach(resetMocks);

  it('returns a full model with all sections when everything succeeds', async () => {
    const m = await collectDigest();
    expect(m.timezone).toBe('UTC');
    expect(m.sections.biz).toBeTruthy();
    expect(m.sections.biz.count).toBe(5);
    expect(m.sections.signups.newUsers).toBe(8);
    expect(m.sections.health.postgres.value).toBe('healthy');
    expect(m.sections.incidents.ok).toBe(true);
    expect(m.sections.deploys.ok).toBe(true);
    expect(m.dataStatus).toBe('live database');
  });

  it('renders a scannable report with Discord-native fields', async () => {
    const m = await collectDigest();
    const out = renderer(m, m);
    // renderer returns { title, color, description, fields, verdict }
    expect(out.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Business', 'Customers', 'Platform health', 'Operations', 'Backups', 'Data quality'])
    );
    expect(out.title).toContain('TravioAfrica');
    expect(out.description).toContain('Reporting:');
    expect(out.verdict).toContain('operational');
    const dataQuality = out.fields.find((f) => f.name === 'Data quality');
    expect(dataQuality.value).toContain('All queries succeeded');
  });

  it('AI note disabled without MIMO_API_KEY', async () => {
    delete process.env.MIMO_API_KEY;
    const r = await buildReport();
    expect(r.model).toBeTruthy();
    expect(callMimo).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  beforeEach(resetMocks);

  it('renders unavailable (never 0) when booking query throws', async () => {
    mockPrisma.booking.aggregate.mockRejectedValue(new Error('db down'));
    const m = await collectDigest();
    expect(m.sections.biz).toBeNull();
    expect(m.dataStatus).not.toBe('live database');
    const out = renderer(m, m);
    const business = out.fields.find((f) => f.name === 'Business');
    expect(business.value).toContain('unavailable');
    expect(business.value).not.toMatch(/Bookings 0/);
  });

  it('renders unavailable for incidents when API fails', async () => {
    process.env.BETTERSTACK_API_TOKEN = 'x';
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    const m = await collectDigest();
    expect(m.sections.incidents.ok).toBe(false);
    const out = renderer(m, m);
    const ops = out.fields.find((f) => f.name === 'Operations');
    expect(ops.value).toContain('unavailable');
  });

  it('claims operational only when all health probes healthy', async () => {
    const m = await collectDigest();
    const out = renderer(m, m);
    expect(out.verdict).toContain('operational');

    // make redis unhealthy
    mockPrisma.systemConfig.findUnique.mockResolvedValue({ value: 'UTC' });
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/health')) {
        return { status: 200, ok: true, json: async () => ({ status: 'degraded', checks: { database: 'healthy', redis: 'unhealthy' } }) };
      }
      return { ok: false, status: 500 };
    });
    const m2 = await collectDigest();
    const out2 = renderer(m2, m2);
    expect(out2.verdict).not.toContain('operational');
    const health = out2.fields.find((f) => f.name === 'Platform health');
    expect(health.value).toContain('Redis ⚠');
  });

  it('flags a stalled scheduler even when the API is otherwise healthy', async () => {
    const m = await collectDigest();
    expect(m.sections.health.scheduler.ok).toBe(true);
    expect(m.sections.health.scheduler.value).toContain('healthy');
    const out = renderer(m, m);
    expect(out.verdict).toContain('operational');

    // scheduler registered but a sweep has stopped running
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/health')) {
        return { status: 200, ok: true, json: async () => ({ status: 'success', checks: { database: 'healthy', redis: 'healthy' }, scheduler: { status: 'degraded', expected: 20, registered: 20, missing: [], stale: [{ jobName: 'cleanup-stale-bookings', consecutiveFailures: 5 }] } }) };
      }
      return { ok: false, status: 500 };
    });
    const m2 = await collectDigest();
    expect(m2.sections.health.scheduler.ok).toBe(true);
    expect(m2.sections.health.scheduler.value).toContain('cleanup-stale-bookings');
    const out2 = renderer(m2, m2);
    expect(out2.verdict).not.toContain('operational');
    const health = out2.fields.find((f) => f.name === 'Platform health');
    expect(health.value).toContain('Schedulers ⚠');
  });
});
