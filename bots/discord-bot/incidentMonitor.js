/**
 * Incident monitor for the TravioAfrica ops bot.
 *
 * Polls the API health endpoint (local + public) and uses a small
 * transition-based state machine to declare incidents and recoveries:
 *
 *   HEALTHY --2 consecutive failed checks (~60s)--> INCIDENT
 *   INCIDENT --2 consecutive good checks (~60s)--> RECOVERED
 *
 * A single transient failure never fires an alert, and while an incident is
 * open repeated failing polls do NOT re-post (one card per incident). State is
 * persisted in Redis so a bot restart resumes an open incident without
 * duplicating cards.
 *
 * On declare/recover it posts a rich, diagnostic Discord embed to the
 * incidents channel via the shared webhook notifier (notifyDiscord), so
 * delivery never depends on channel visibility / permissions.
 *
 * LIKELY CAUSE is evidence-based ("restart occurred ~Xs after deployment"),
 * and the conclusion is labeled ASSESSMENT — correlation is not proof.
 *
 * @version 2.0.0
 */

const { execSync } = require('child_process');
const { notifyDiscord } = require('../../utils/discordNotifier');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const LOCAL_TIMEOUT_MS = 8000;
const PUBLIC_TIMEOUT_MS = 10000;
const REDIS_STATE_KEY = 'incident:monitor:state';
const MAX_ERR_TAIL_LINES = 10;

// Consecutive-check thresholds. At a 30s interval, FAIL_THRESHOLD=2 declares
// an incident ~60s after the first failure; RECOVER_THRESHOLD=2 resolves ~60s
// after the API returns. Single transient blips never fire.
const FAIL_THRESHOLD = 2;
const RECOVER_THRESHOLD = 2;

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
    const df = sh(`df -h / | tail -1`);
    const parts = df.split(/\s+/);
    diag.disk = { usedPct: parts[4] || null, total: parts[1] || null };
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

function buildEmbed({ direction, startedAt, resolvedAt, durationSec, diag }) {
  const incident = direction === 'down';

  if (incident) {
    const api = diag?.pm2?.find((p) => p.name === 'expedition-api');
    const restarts = api?.restarts || 0;
    const likelyCauseLines = [];
    if (restarts > 0) {
      likelyCauseLines.push(`PM2 restart detected — \`expedition-api\` restarted ${restarts}×`);
    } else if (api && api.status !== 'online') {
      likelyCauseLines.push(`\`expedition-api\` is not online (\`${api.status}\`)`);
    } else {
      likelyCauseLines.push('Health check failed (no PM2 restart detected)');
    }

    // LIKELY CAUSE is evidence; ASSESSMENT is the (non-overstated) conclusion.
    let assessment = 'Unclassified — correlation has not established a cause.';
    if (diag?.deploy?.restartedRecently) {
      assessment = `Likely deploy-related transient — API restart occurred ~${diag.deploy.apiUpSinceSec}s after deployment (${diag.deploy.lastCommitAt || 'recent commit'}).`;
    }

    const fields = [
      { name: 'LIKELY CAUSE', value: likelyCauseLines.join('\n'), inline: false },
      { name: 'ASSESSMENT', value: assessment, inline: false },
      { name: 'DEPENDENCIES', value: depsLine(diag), inline: false },
      { name: 'RESOURCES', value: resourcesLine(diag) || '—', inline: false },
    ];
    if (diag?.errorTail) {
      fields.push({ name: 'LATEST ERROR', value: `\`\`\`\n${diag.errorTail.slice(0, 900)}\n\`\`\``, inline: false });
    }
    fields.push({ name: 'CHECK FIRST', value: checkFirstLines(diag).join('\n'), inline: false });
    if (diag?.deploy?.lastCommitAt) {
      fields.push({ name: 'Commit', value: diag.deploy.lastCommitAt, inline: false });
    }

    return {
      title: '🚨 PRODUCTION INCIDENT',
      color: 0xff4444,
      content: `**API: DOWN** · Detected ${fmtTimestamp(startedAt)} · Duration: ongoing`,
      fields,
    };
  }

  // RECOVERED
  const fields = [
    { name: 'DEPENDENCIES', value: depsLine(diag), inline: false },
    { name: 'RESOURCES', value: resourcesLine(diag) || '—', inline: false },
    { name: 'CHECK FIRST', value: checkFirstLines(diag).join('\n'), inline: false },
  ];
  return {
    title: '✅ INCIDENT RESOLVED',
    color: 0x00c853,
    content: `**API: UP** · Downtime: ${Math.round(durationSec)}s · Recovered ${fmtTimestamp(resolvedAt)}`,
    fields,
  };
}

/**
 * Start the incident monitor.
 *
 * @param {Object} opts
 * @param {string} opts.target   - Human-readable monitor target.
 * @param {Object} opts.env      - { apiUrl, publicUrl, databaseUrl, redisUrl, repoDir, errorLog, intervalMs }
 * @param {Object} [opts.redis]  - Redis client with get/set for state persistence.
 * @param {Object} [opts.logger] - { log, warn } (defaults to console).
 * @returns {{ stop: Function, tick: Function }}
 */
function startIncidentMonitor({ target, env, redis, logger }) {
  if (!env?.apiUrl) {
    (logger?.warn || console.warn)('[incident] monitor not started (missing apiUrl)');
    return;
  }

  const intervalMs = env.intervalMs || DEFAULT_INTERVAL_MS;
  const log = (m) => (logger?.log || console.log)(`[incident] ${m}`);
  const warn = (m) => (logger?.warn || console.warn)(`[incident] ${m}`);

  let state = 'HEALTHY'; // HEALTHY | INCIDENT
  let downSince = 0;
  let failStreak = 0;
  let passStreak = 0;
  let active = false;
  let timer = null;
  let startupResolve = null;
  const ready = new Promise((resolve) => {
    startupResolve = resolve;
  });

  async function persist() {
    try {
      if (redis) {
        await redis.set(
          REDIS_STATE_KEY,
          JSON.stringify({ state, downSince, failStreak, passStreak }),
          'EX',
          3600
        );
      }
    } catch {
      // non-fatal
    }
  }

  async function loadPersisted() {
    try {
      const raw = redis ? await redis.get(REDIS_STATE_KEY) : null;
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && p.state === 'INCIDENT') {
        state = 'INCIDENT';
        downSince = p.downSince || Date.now();
        passStreak = p.passStreak || 0;
      }
    } catch {
      // fresh state is fine
    }
  }

  async function post(payload) {
    // notifyDiscord('incidents', content, opts) never rejects and reads the
    // webhook URL from the environment — channel-visibility independent.
    await notifyDiscord('incidents', payload.content, {
      title: payload.title,
      color: payload.color,
      fields: payload.fields,
      timestamp: new Date().toISOString(),
    });
  }

  async function check() {
    if (active) return;
    active = true;
    try {
      const local = await fetchHealth(env.apiUrl, LOCAL_TIMEOUT_MS);
      const pub = env.publicUrl ? await fetchHealth(env.publicUrl, PUBLIC_TIMEOUT_MS) : local;
      const healthy = local.ok && pub.ok;
      const now = Date.now();

      if (!healthy && state === 'HEALTHY') {
        failStreak += 1;
        passStreak = 0;
        await persist();
        if (failStreak >= FAIL_THRESHOLD) {
          state = 'INCIDENT';
          downSince = now;
          failStreak = 0;
          await persist();
          const diag = await collectDiagnostics(env);
          const payload = buildEmbed({ direction: 'down', startedAt: now, diag });
          log(`INCIDENT declared at ${target} (${FAIL_THRESHOLD} consecutive failures)`);
          await post(payload);
        }
      } else if (healthy && state === 'INCIDENT') {
        passStreak += 1;
        await persist();
        if (passStreak >= RECOVER_THRESHOLD) {
          const durationSec = Math.round((now - downSince) / 1000);
          state = 'HEALTHY';
          passStreak = 0;
          await persist();
          const diag = await collectDiagnostics(env);
          const payload = buildEmbed({ direction: 'up', startedAt: downSince, resolvedAt: now, durationSec, diag });
          log(`RECOVERED after ${durationSec}s at ${target}`);
          await post(payload);
        }
      } else if (healthy && state === 'HEALTHY') {
        // steady state — reset transient streak noise
        failStreak = 0;
      }
      // state === 'INCIDENT' && !healthy: no re-post, keep waiting for recovery
    } catch (e) {
      warn(`check error: ${e.message}`);
    } finally {
      active = false;
    }
  }

  (async () => {
    await loadPersisted();
    await check();
    if (startupResolve) startupResolve();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
  })();

  return { stop: () => clearInterval(timer), tick: check, ready };
}

module.exports = { startIncidentMonitor, collectDiagnostics, buildEmbed, fetchHealth, FAIL_THRESHOLD, RECOVER_THRESHOLD };
