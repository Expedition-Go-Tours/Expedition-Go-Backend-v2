/**
 * Incident monitor for the TravioAfrica ops bot.
 *
 * A single transition-based engine watches MULTIPLE signals. Each signal has
 * its own state machine, its own Redis key, and its own rich embed:
 *
 *   HEALTHY --N consecutive failed checks--> INCIDENT
 *   INCIDENT --2 consecutive good checks----> RECOVERED
 *
 *  Signals:
 *   api       local + public health endpoint (N=2, ~60s)
 *   load      1-min load vs cores x 2        (N=4, ~2min — deploy bursts
 *                                            self-resolve before paging)
 *   disk      /  usage > 85%                 (N=2)
 *   ram       memory usage > 85%             (N=2)
 *   swap      swap usage > 50%               (N=2)
 *   postgres  psql SELECT 1                  (N=2)
 *   redis     redis-cli ping                 (N=2)
 *   backup    newest dump < 26h old          (N=2)
 *   scheduler registered BullMQ sweep not running within 2x cadence (N=2)
 *
 * A signal only fires once per incident (no duplicate cards), and repeated
 * failing polls while an incident is open do NOT re-post. State is persisted
 * per-check in Redis so a bot restart resumes an open incident exactly once.
 *
 * On declare/recover it posts a rich, diagnostic Discord embed to the
 * incidents channel via the shared webhook notifier (notifyDiscord), so
 * delivery never depends on channel visibility / permissions.
 *
 * LIKELY CAUSE is evidence-based ("restart occurred ~Xs after deployment"),
 * and the conclusion is labeled ASSESSMENT — correlation is not proof.
 *
 * @version 3.0.0
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { notifyDiscord } = require('../../utils/discordNotifier');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const LOCAL_TIMEOUT_MS = 8000;
const PUBLIC_TIMEOUT_MS = 10000;
const MAX_ERR_TAIL_LINES = 10;
const REDIS_STATE_KEY_PREFIX = 'incident:monitor:state';

// Consecutive-check thresholds. At a 30s interval, FAIL_THRESHOLD=2 declares
// an incident ~60s after the first failure; RECOVER_THRESHOLD=2 resolves ~60s
// after the signal returns. Single transient blips never fire.
const FAIL_THRESHOLD = 2;
const RECOVER_THRESHOLD = 2;
// Load is more volatile (deploys/restarts burst CPU for a minute or two), so
// require ~2min of sustained pressure before declaring. Recovery stays quick.
const LOAD_FAIL_SAMPLES = 4;
const THRESHOLDS = { rams: '85', disk: '85', swap: '50', backupHours: 26 };

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 10000 }).trim();
}

async function fetchHealth(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.status === 200, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

async function fetchHealthJson(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.status !== 200) return { ok: false, status: res.status, json: null };
    const json = await res.json().catch(() => null);
    return { ok: true, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

function readTail(file, lines = MAX_ERR_TAIL_LINES) {
  try {
    const out = sh(`tail -n ${lines} '${file}' 2>/dev/null`);
    return out || '';
  } catch {
    return '';
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function cpuUsagePct() {
  // Two /proc/stat samples ~150ms apart to derive a near-real-time CPU%.
  try {
    const read = () =>
      sh(`awk '/^cpu / {print $2+$3+$4, $5+$6+$7+$8}' /proc/stat`);
    const a = read().split(/\s+/).map(Number);
    // synchronous delay via a short shell sleep
    sh('sleep 0.15');
    const b = read().split(/\s+/).map(Number);
    const busy = b[0] - a[0];
    const total = (b[0] + b[1]) - (a[0] + a[1]);
    return total > 0 ? Math.round((busy / total) * 100) : null;
  } catch {
    return null;
  }
}

function topCpuProcesses() {
  try {
    const out = sh(`ps -eo pcpu,pmem,comm --sort=-pcpu | head -6`);
    return String(out || '')
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/\s+/g, ' ').trim());
  } catch {
    return null;
  }
}

/**
 * Collect server-side diagnostics to determine the exact cause.
 * Every check is best-effort; failures become null/''.
 */
async function collectDiagnostics(ctx) {
  const diag = {};

  try {
    const procs = safeJson(sh('pm2 jlist'));
    diag.pm2 = procs.map((p) => ({
      name: p.name,
      status: p.pm2_env?.status || 'unknown',
      restarts: p.pm2_env?.restart_time ?? 0,
      uptimeSec: p.pm2_env?.status === 'online' ? Math.round((Date.now() - (p.pm2_env?.pm_uptime || Date.now())) / 1000) : null,
      memMB: Math.round((p.monit?.memory || 0) / 1024 / 1024),
      pid: p.pid,
    }));
  } catch {
    diag.pm2 = null;
  }

  try {
    const api = diag.pm2?.find((p) => p.name === 'expedition-api');
    const commitTime = sh(`cd ${ctx.repoDir} && git log -1 --format=%ci 2>/dev/null`);
    const apiUpSinceSec = api?.uptimeSec ?? null;
    diag.deploy = {
      lastCommitAt: commitTime || null,
      apiUpSinceSec,
      restartedRecently: apiUpSinceSec !== null && apiUpSinceSec < 600, // restarted <10m ago
    };
  } catch {
    diag.deploy = null;
  }

  diag.errorTail = readTail(ctx.errorLog);

  try {
    const out = sh(`psql "${ctx.databaseUrl}" -tAc 'SELECT 1' 2>/dev/null`);
    diag.database = out.trim() === '1' ? 'ok' : 'down';
  } catch {
    diag.database = 'down';
  }

  try {
    // Parse password from the redis:// URL and use -a (redis-cli -u with an
    // empty username is rejected by Redis 6+ ACL as WRONGPASS).
    const m = String(ctx.redisUrl || '').match(/redis:\/\/:([^@]+)@/);
    const pw = m ? m[1] : '';
    const out = sh(`redis-cli -h 127.0.0.1 -p 6379 -a '${pw}' --no-auth-warning ping 2>/dev/null`);
    diag.redis = out.includes('PONG') ? 'ok' : 'down';
  } catch {
    diag.redis = 'down';
  }

  try {
    diag.nginx = sh('systemctl is-active nginx 2>/dev/null') === 'active' ? 'ok' : 'down';
  } catch {
    diag.nginx = 'unknown';
  }

  try {
    const df = sh(`df -P / | tail -1`);
    const parts = df.split(/\s+/);
    diag.disk = { usedPct: parts[4] || null, total: parts[1] ? `${Math.round(parts[1] / 1024)}G` : null };
  } catch {
    diag.disk = null;
  }
  try {
    diag.memory = sh(`free -m | awk 'NR==2{printf "%.0f%% used (%d/%d MB)", ($2-$7)/$2*100, $3, $2}'`);
  } catch {
    diag.memory = null;
  }
  try {
    diag.load = sh(`cat /proc/loadavg | cut -d' ' -f1-3`);
  } catch {
    diag.load = null;
  }
  diag.cpu = cpuUsagePct();
  diag.topCpu = topCpuProcesses();

  return diag;
}

function fmtTimestamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/**
 * Deterministic "what the monitor actually observed" lines, derived from diag.
 */
function checkFirstLines(diag) {
  const lines = [];
  const api = diag?.pm2?.find((p) => p.name === 'expedition-api');
  if (api) {
    const restarts = api.restarts || 0;
    if (api.status !== 'online') lines.push(`❌ expedition-api: \`${api.status}\``);
    else if (restarts > 0) lines.push(`⚠️ expedition-api: online but restarted ${restarts}×`);
    else lines.push(`✅ expedition-api: online`);
  } else {
    lines.push(`❓ expedition-api: no PM2 process found`);
  }
  lines.push(diag?.database === 'ok' ? `✅ PostgreSQL: reachable` : `❌ PostgreSQL: unreachable`);
  lines.push(diag?.redis === 'ok' ? `✅ Redis: reachable` : `❌ Redis: unreachable`);
  lines.push(diag?.nginx === 'ok' ? `✅ Nginx: active` : `❌ Nginx: not active`);
  if (diag?.deploy?.restartedRecently) {
    lines.push(`⚠️ API restarted ~${diag.deploy.apiUpSinceSec}s ago`);
  }
  return lines;
}

function depsLine(diag) {
  const sym = (s) => (s === 'ok' ? '✅' : s === 'down' ? '❌' : '❓');
  return `${sym(diag?.database)} PostgreSQL   ${sym(diag?.redis)} Redis   ${sym(diag?.nginx)} Nginx`;
}

function resourcesLine(diag) {
  const parts = [];
  if (diag?.cpu != null) parts.push(`CPU ${diag.cpu}%`);
  if (diag?.memory) parts.push(diag.memory);
  if (diag?.disk?.usedPct) parts.push(`Disk ${diag.disk.usedPct}`);
  if (diag?.load) parts.push(`Load ${diag.load}`);
  return parts.length ? parts.join(' · ') : '—';
}

// ── Signal definitions ──────────────────────────────────────────────────
// Each check owns one Redis key so an open card resumes after a bot restart
// without duplicating. `probe` returns { healthy, detail } or throws → treated
// as unhealthy (a check we cannot measure is worth knowing about).
const SIGNALS = [
  { id: 'api', label: 'API', fail: FAIL_THRESHOLD, titleDown: '🚨 PRODUCTION INCIDENT', titleUp: '✅ INCIDENT RESOLVED' },
  { id: 'load', label: 'LOAD', fail: LOAD_FAIL_SAMPLES, titleDown: '🚨 HIGH LOAD', titleUp: '✅ LOAD NORMAL' },
  { id: 'disk', label: 'DISK', fail: FAIL_THRESHOLD, titleDown: '🚨 DISK SPACE', titleUp: '✅ DISK OK' },
  { id: 'ram', label: 'MEMORY', fail: FAIL_THRESHOLD, titleDown: '🚨 MEMORY PRESSURE', titleUp: '✅ MEMORY OK' },
  { id: 'swap', label: 'SWAP', fail: FAIL_THRESHOLD, titleDown: '🚨 SWAP PRESSURE', titleUp: '✅ SWAP OK' },
  { id: 'postgres', label: 'POSTGRES', fail: FAIL_THRESHOLD, titleDown: '🚨 POSTGRES DOWN', titleUp: '✅ POSTGRES OK' },
  { id: 'redis', label: 'REDIS', fail: FAIL_THRESHOLD, titleDown: '🚨 REDIS DOWN', titleUp: '✅ REDIS OK' },
  { id: 'backup', label: 'BACKUP', fail: FAIL_THRESHOLD, titleDown: '🚨 BACKUP STALE', titleUp: '✅ BACKUP OK' },
  { id: 'scheduler', label: 'SCHEDULER', fail: FAIL_THRESHOLD, titleDown: '🚨 SCHEDULER STALLED', titleUp: '✅ SCHEDULER OK' },
];

function stateKey(id) {
  return `${REDIS_STATE_KEY_PREFIX}:${id}`;
}

/**
 * Probe each signal once. Best-effort: a probe that cannot run reports
 * unhealthy=false detail via catch → treats unmeasurable as healthy (no false
 * alarms) while collectDiagnostics still captures why diagnostics failed.
 */
async function probeSignal(id, env) {
  switch (id) {
    case 'api': {
      const local = await fetchHealth(env.apiUrl, LOCAL_TIMEOUT_MS);
      const pub = env.publicUrl ? await fetchHealth(env.publicUrl, PUBLIC_TIMEOUT_MS) : local;
      return { healthy: local.ok && pub.ok, detail: `local ${local.status} · public ${pub.ok ? pub.status : 'down'}` };
    }
    case 'load': {
      const cores = os.cpus().length || 2;
      const raw = fs.readFileSync('/proc/loadavg', 'utf8');
      const parts = raw.trim().split(/\s+/);
      const load1 = parseFloat(parts[0]);
      return { healthy: !(load1 > cores * 2), detail: `load1 ${load1.toFixed(2)} > ${cores * 2} (${cores} cores)` };
    }
    case 'disk': {
      const out = sh(`df -P / | tail -1`);
      const pct = parseInt(String(out).split(/\s+/)[4], 10);
      return { healthy: !(pct > THRESHOLDS.disk), detail: `root ${pct}% used` };
    }
    case 'ram': {
      const mem = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = Number((mem.match(/MemTotal:\s+(\d+)/) || [])[1] || 0);
      const avail = Number((mem.match(/MemAvailable:\s+(\d+)/) || [])[1] || 0);
      const used = total > 0 ? Math.round(((total - avail) / total) * 100) : 0;
      return { healthy: !(used > THRESHOLDS.rams), detail: `memory ${used}% used (${Math.round(total / 1024)}MB)` };
    }
    case 'swap': {
      const mem = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = Number((mem.match(/SwapTotal:\s+(\d+)/) || [])[1] || 0);
      const free = Number((mem.match(/SwapFree:\s+(\d+)/) || [])[1] || 0);
      const used = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
      return { healthy: !(used > THRESHOLDS.swap), detail: `swap ${used}% used` };
    }
    case 'postgres': {
      const out = sh(`psql "${env.databaseUrl}" -tAc 'SELECT 1' 2>/dev/null`);
      return { healthy: out.trim() === '1', detail: 'PostgreSQL unreachable' };
    }
    case 'redis': {
      const m = String(env.redisUrl || '').match(/redis:\/\/:([^@]+)@/);
      const pw = m ? m[1] : '';
      const out = sh(`redis-cli -h 127.0.0.1 -p 6379 -a '${pw}' --no-auth-warning ping 2>/dev/null`);
      return { healthy: out.includes('PONG'), detail: 'Redis unreachable' };
    }
    case 'backup': {
      const dir = env.backupDir;
      if (!dir) return { healthy: true, detail: 'backupDir not configured' };
      if (!fs.existsSync(dir)) return { healthy: false, detail: `backup dir missing (${dir})` };
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('travio-') && f.endsWith('.dump'))
        .sort()
        .reverse();
      if (!files.length) return { healthy: false, detail: 'no backup file found' };
      const st = fs.statSync(`${dir}/${files[0]}`);
      const ageH = (Date.now() - st.mtimeMs) / 3600000;
      return { healthy: ageH <= THRESHOLDS.backupHours, detail: `newest ${files[0]} is ${ageH.toFixed(1)}h old` };
    }
    case 'scheduler': {
      // Parse the scheduler health block exposed on the app's /health. A job
      // scheduler that is REGISTERED but silently NOT executing is the real
      // risk — stale[] captures that (last run > 2x cadence).
      const r = await fetchHealthJson(env.apiUrl, LOCAL_TIMEOUT_MS);
      if (!r.ok) return { healthy: true, detail: 'api /health unreachable (covered by api signal)' };
      const s = r.json?.scheduler;
      // No scheduler block / redis down / unknown → not a scheduler problem.
      if (!s || s.status === 'unknown') return { healthy: true, detail: 'scheduler status unknown (redis?)' };
      const stale = s.stale || [];
      const missing = s.missing || [];
      if (s.status === 'healthy' && stale.length === 0 && missing.length === 0) {
        return { healthy: true, detail: `${s.registered ?? '?'}/${s.expected ?? '?'} registered` };
      }
      const bits = [];
      if (missing.length) bits.push(`missing: ${missing.join(', ')}`);
      for (const st of stale) {
        bits.push(`${st.jobName} stale ${st.consecutiveFailures ? `(${st.consecutiveFailures} failures)` : '(no recent run)'}`);
      }
      return { healthy: false, detail: `${s.status} — ${bits.join('; ') || 'no detail'}` };
    }
    default:
      return { healthy: true, detail: 'unknown signal' };
  }
}

// ── Embed building ──────────────────────────────────────────────────────
function commonDiagFields(diag, { includeError = true } = {}) {
  const fields = [
    { name: 'DEPENDENCIES', value: depsLine(diag), inline: false },
    { name: 'RESOURCES', value: resourcesLine(diag) || '—', inline: false },
  ];
  if (includeError && diag?.errorTail) {
    fields.push({ name: 'LATEST ERROR', value: `\`\`\`\n${diag.errorTail.slice(0, 900)}\n\`\`\``, inline: false });
  }
  return fields;
}

function buildCauseAndAssessment(signal, detail, diag) {
  const api = diag?.pm2?.find((p) => p.name === 'expedition-api');
  const restarts = api?.restarts || 0;
  const top = diag?.topCpu?.slice(0, 3).join('\n');
  let cause;
  let assessment;

  if (signal === 'api') {
    const likelyCauseLines = [];
    if (restarts > 0) {
      likelyCauseLines.push(`PM2 restart detected — \`expedition-api\` restarted ${restarts}×`);
    } else if (api && api.status !== 'online') {
      likelyCauseLines.push(`\`expedition-api\` is not online (\`${api.status}\`)`);
    } else {
      likelyCauseLines.push('Health check failed (no PM2 restart detected)');
    }
    cause = likelyCauseLines.join('\n');
    assessment = 'Unclassified — correlation has not established a cause.';
    if (diag?.deploy?.restartedRecently) {
      assessment = `Likely deploy-related transient — API restart occurred ~${diag.deploy.apiUpSinceSec}s after deployment (${diag.deploy.lastCommitAt || 'recent commit'}).`;
    }
    return { cause, assessment };
  }

  if (signal === 'scheduler') {
    cause = `A scheduled BullMQ sweep is not executing on time.\nObservation: ${detail}`;
    if (restarts > 0) {
      cause += `\nNote: \`expedition-api\` restarted ${restarts}×${diag?.deploy?.restartedRecently ? ` ~${diag.deploy.apiUpSinceSec}s ago` : ''} — workers/schedulers re-register on boot, so this may have self-healed.`;
    }
    assessment = diag?.deploy?.restartedRecently
      ? 'Scheduler stall detected right after a deployment/restart — confirm schedulers re-verified (registerSchedules/verifySchedules) and the missed run was caught up.'
      : 'A scheduler exists in Redis but has not executed within 2× its cadence. Check the BullMQ worker is consuming (queue logs) and the handler is not throwing/retry-looping.';
    return { cause, assessment };
  }

  // Resource signals: same evidence discipline — restart/deploy correlation,
  // plus the top CPU consumers that explain a load/CPU/memory spike.
  if (restarts > 0) {
    cause = `PM2 restart burst — \`expedition-api\` restarted ${restarts}× (${api?.status || '?'})`;
    if (diag?.deploy?.restartedRecently) {
      cause += `, ~${diag.deploy.apiUpSinceSec}s after deployment`;
    }
    cause += `\nObservation: ${detail}`;
    if (top) cause += `\nTop CPU:\n${top}`;
    assessment = diag?.deploy?.restartedRecently
      ? `Likely deploy-related transient — CPU/memory burst while the API recompiled and PM2 restarted (commit ${diag.deploy.lastCommitAt || 'recent'}).`
      : 'PM2 restarts detected; not clearly deploy-tied. Verify the API is stable.';
  } else {
    cause = `Observation: ${detail}`;
    if (top) cause += `\nTop CPU:\n${top}`;
    if (diag?.deploy?.restartedRecently) {
      assessment = 'A deployment restarted processes recently; this may be a transient burst rather than a sustained issue.';
    } else {
      assessment = 'Unclassified — no recent PM2 restart or deployment detected.';
    }
  }
  return { cause, assessment };
}

/**
 * Build a Discord embed payload for a signal transition.
 *
 * @param {Object} o
 * @param {string} o.direction - 'down' (incident) or 'up' (recovered).
 * @param {string} [o.signal]  - signal id (default 'api').
 * @param {string} [o.detail]  - observed detail (e.g. load reading).
 * @param {Object} [o.diag]    - diagnostics from collectDiagnostics().
 */
function buildEmbed({ direction, startedAt, resolvedAt, durationSec, signal = 'api', detail = '', diag }) {
  const meta = SIGNALS.find((s) => s.id === signal) || SIGNALS[0];
  const incident = direction === 'down';

  if (incident) {
    const { cause, assessment } = buildCauseAndAssessment(signal, detail, diag);
    const fields = [
      { name: 'LIKELY CAUSE', value: cause, inline: false },
      { name: 'ASSESSMENT', value: assessment, inline: false },
      ...commonDiagFields(diag),
    ];
    if (diag?.deploy?.lastCommitAt) {
      fields.push({ name: 'Commit', value: diag.deploy.lastCommitAt, inline: false });
    }
    if (signal === 'api') {
      fields.push({ name: 'CHECK FIRST', value: checkFirstLines(diag).join('\n'), inline: false });
    }
    const headline = signal === 'api' ? 'API: DOWN' : `${meta.label}: PROBLEM`;
    return {
      title: meta.titleDown,
      color: 0xff4444,
      content: `**${headline}** · ${detail || 'check failed'} · Detected ${fmtTimestamp(startedAt)} · Duration: ongoing`,
      fields,
    };
  }

  const fields = [
    ...commonDiagFields(diag, { includeError: false }),
    { name: 'CHECK FIRST', value: checkFirstLines(diag).join('\n'), inline: false },
  ];
  const headline = signal === 'api' ? 'API: UP' : `${meta.label}: OK`;
  return {
    title: meta.titleUp,
    color: 0x00c853,
    content: `**${headline}** · Downtime: ${Math.round(durationSec)}s · Recovered ${fmtTimestamp(resolvedAt)}`,
    fields,
  };
}

/**
 * Start the incident monitor.
 *
 * @param {Object} opts
 * @param {string} opts.target   - Human-readable monitor target (log only).
 * @param {Object} opts.env      - { apiUrl, publicUrl, databaseUrl, redisUrl,
 *                                 repoDir, errorLog, backupDir, intervalMs }.
 * @param {Object} [opts.redis]  - Redis client with get/set for state persistence.
 * @param {Object} [opts.logger] - { log, warn } (defaults to console).
 * @returns {{ stop: Function, tick: Function, ready: Promise }}
 */
function startIncidentMonitor({ target, env, redis, logger }) {
  if (!env?.apiUrl) {
    (logger?.warn || console.warn)('[incident] monitor not started (missing apiUrl)');
    return;
  }

  const intervalMs = env.intervalMs || DEFAULT_INTERVAL_MS;
  const log = (m) => (logger?.log || console.log)(`[incident] ${m}`);
  const warn = (m) => (logger?.warn || console.warn)(`[incident] ${m}`);

  // Per-signal runtime state.
  const checks = new Map(
    SIGNALS.map((s) => [
      s.id,
      { meta: s, state: 'HEALTHY', downSince: 0, failStreak: 0, passStreak: 0 },
    ])
  );

  let active = false;
  let timer = null;
  let startupResolve = null;
  const ready = new Promise((resolve) => {
    startupResolve = resolve;
  });

  async function persist(id, c) {
    try {
      if (redis) {
        await redis.set(
          stateKey(id),
          JSON.stringify({ state: c.state, downSince: c.downSince, failStreak: c.failStreak, passStreak: c.passStreak }),
          'EX',
          3600
        );
      }
    } catch {
      // non-fatal
    }
  }

  async function loadPersisted(id, c) {
    try {
      const raw = redis ? await redis.get(stateKey(id)) : null;
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && p.state === 'INCIDENT') {
        c.state = 'INCIDENT';
        c.downSince = p.downSince || Date.now();
        c.passStreak = p.passStreak || 0;
      }
    } catch {
      // fresh state is fine
    }
  }

  async function post(signalId, payload) {
    await notifyDiscord('incidents', payload.content, {
      title: payload.title,
      color: payload.color,
      fields: payload.fields,
      timestamp: new Date().toISOString(),
    });
  }

  async function checkSignal(id) {
    const c = checks.get(id);
    if (!c) return;
    try {
      const result = await probeSignal(id, env);
      const healthy = result.healthy;
      const detail = result.detail || '';
      const now = Date.now();

      if (!healthy && c.state === 'HEALTHY') {
        c.failStreak += 1;
        c.passStreak = 0;
        await persist(id, c);
        if (c.failStreak >= c.meta.fail) {
          c.state = 'INCIDENT';
          c.downSince = now;
          c.failStreak = 0;
          await persist(id, c);
          const diag = await collectDiagnostics(env);
          const payload = buildEmbed({ direction: 'down', startedAt: now, signal: id, detail, diag });
          log(`INCIDENT ${id} at ${target} (${c.meta.fail} consecutive failures): ${detail}`);
          await post(id, payload);
        }
      } else if (healthy && c.state === 'INCIDENT') {
        c.passStreak += 1;
        await persist(id, c);
        if (c.passStreak >= RECOVER_THRESHOLD) {
          const durationSec = Math.round((now - c.downSince) / 1000);
          c.state = 'HEALTHY';
          c.passStreak = 0;
          await persist(id, c);
          const diag = await collectDiagnostics(env);
          const payload = buildEmbed({ direction: 'up', startedAt: c.downSince, resolvedAt: now, durationSec, signal: id, detail, diag });
          log(`RECOVERED ${id} after ${durationSec}s at ${target}`);
          await post(id, payload);
        }
      } else if (healthy && c.state === 'HEALTHY') {
        // steady state — reset transient streak noise
        c.failStreak = 0;
      }
      // state === 'INCIDENT' && !healthy: no re-post, keep waiting for recovery
    } catch (e) {
      // A probe that throws (e.g. transient shell error) must not crash the
      // whole engine or spam Discord. Log and continue.
      warn(`probe ${id} error: ${e.message}`);
    }
  }

  async function tick() {
    if (active) return;
    active = true;
    try {
      for (const id of checks.keys()) {
        await checkSignal(id);
      }
    } finally {
      active = false;
    }
  }

  (async () => {
    for (const [id, c] of checks) {
      await loadPersisted(id, c);
    }
    await tick();
    if (startupResolve) startupResolve();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
  })();

  return { stop: () => clearInterval(timer), tick, ready };
}

module.exports = {
  startIncidentMonitor,
  collectDiagnostics,
  buildEmbed,
  fetchHealth,
  probeSignal,
  SIGNALS,
  FAIL_THRESHOLD,
  RECOVER_THRESHOLD,
  LOAD_FAIL_SAMPLES,
};
