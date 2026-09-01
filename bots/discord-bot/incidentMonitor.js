/**
 * Incident monitor for the TravioAfrica ops bot.
 *
 * Polls the API health endpoint (local + public) and, on UP→DOWN /
 * DOWN→UP transitions, posts a rich diagnostic embed to the incidents
 * channel. Because the bot runs as a separate PM2 process, it can
 * diagnose the API even when the API itself is down: PM2 status,
 * deploy correlation, error-log tails, DB/Redis/nginx, disk, memory,
 * and load.
 *
 * Deliberately fire-and-forget: never throws, all failures logged.
 *
 * @version 1.0.0
 */

const { execSync } = require('child_process');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const LOCAL_TIMEOUT_MS = 8000;
const PUBLIC_TIMEOUT_MS = 10000;
const REDIS_STATE_KEY = 'incident:monitor:state';
const MAX_ERR_TAIL_LINES = 12;

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
    return out || '(empty)';
  } catch {
    return '(unreadable)';
  }
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

/**
 * Collect server-side diagnostics to determine the exact cause.
 * Every check is best-effort; failures become "(unavailable)".
 */
async function collectDiagnostics(ctx) {
  const diag = {};

  // ── PM2 process states + restart counts ─────────────────────────
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

  // ── Deploy correlation ──────────────────────────────────────────
  try {
    const api = diag.pm2?.find((p) => p.name === 'expedition-api');
    const commitTime = sh(`cd ${ctx.repoDir} && git log -1 --format=%ci 2>/dev/null`);
    const deployAgeSec = api?.uptimeSec ?? null;
    diag.deploy = {
      lastCommitAt: commitTime || null,
      apiUpSinceSec: deployAgeSec,
      likelyDeployRestart: deployAgeSec !== null && deployAgeSec < 300, // restarted <5m ago
    };
  } catch {
    diag.deploy = null;
  }

  // ── API error log tail ──────────────────────────────────────────
  diag.errorTail = readTail(ctx.errorLog);

  // ── PostgreSQL ───────────────────────────────────────────────────
  try {
    const out = sh(`psql "${ctx.databaseUrl}" -tAc 'SELECT 1' 2>/dev/null`);
    diag.database = out.trim() === '1' ? 'healthy' : 'down';
  } catch {
    diag.database = 'down';
  }

  // ── Redis ───────────────────────────────────────────────────────
  try {
    const out = sh(`redis-cli -u "${ctx.redisUrl}" ping 2>/dev/null`);
    diag.redis = out.includes('PONG') ? 'healthy' : 'down';
  } catch {
    diag.redis = 'down';
  }

  // ── nginx ───────────────────────────────────────────────────────
  try {
    diag.nginx = sh('systemctl is-active nginx 2>/dev/null') === 'active' ? 'active' : 'down';
  } catch {
    diag.nginx = 'unknown';
  }

  // ── Disk / memory / load ────────────────────────────────────────
  try {
    const df = sh(`df -h / | tail -1`);
    const parts = df.split(/\s+/);
    diag.disk = { total: parts[1] || '?', usedPct: parts[4] || '?' };
  } catch {
    diag.disk = null;
  }
  try {
    const free = sh(`free -m | awk 'NR==2{printf "%d/%d MB used, %d MB avail", $3, $2, $7}'`);
    diag.memory = free;
  } catch {
    diag.memory = null;
  }
  try {
    diag.load = sh(`cat /proc/loadavg | cut -d' ' -f1-3`);
  } catch {
    diag.load = null;
  }

  return diag;
}

function buildEmbed({ direction, target, startedAt, resolvedAt, durationSec, diag }) {
  const isDown = direction === 'down';
  const lines = [];

  if (diag?.pm2?.length) {
    const api = diag.pm2.find((p) => p.name === 'expedition-api');
    if (api) {
      const upTxt = api.status === 'online' ? `${api.uptimeSec}s` : 'DOWN';
      const restarts = api.restarts > 0 ? ` (restarted ${api.restarts}×)` : '';
      lines.push(`**expedition-api:** \`${api.status}\`${restarts}, up ${upTxt}, ${api.memMB}MB`);
    }
    for (const p of diag.pm2.filter((p) => p.name !== 'expedition-api')) {
      if (p.status !== 'online') {
        lines.push(`**${p.name}:** \`${p.status}\`` + (p.restarts > 0 ? ` (restarted ${p.restarts}×)` : ''));
      }
    }
  } else {
    lines.push(`**PM2:** (unavailable)`);
  }

  if (diag?.deploy?.likelyDeployRestart) {
    lines.push(`**Deploy correlation:** API restarted ~${diag.deploy.apiUpSinceSec}s ago, last commit at ${diag.deploy.lastCommitAt || '?'} → **likely a deploy restart (transient)**`);
  }

  lines.push(`**Database:** ${diag?.database || '?'}  |  **Redis:** ${diag?.redis || '?'}  |  **nginx:** ${diag?.nginx || '?'}`);

  if (isDown && diag?.errorTail && diag.errorTail !== '(empty)' && diag.errorTail !== '(unreadable)') {
    lines.push(`\n**Last API errors:**\n\`\`\`\n${diag.errorTail.slice(0, 1200)}\n\`\`\``);
  }

  if (diag?.disk) lines.push(`**Disk /:** ${diag.disk.usedPct} used of ${diag.disk.total}`);
  if (diag?.memory) lines.push(`**Memory:** ${diag.memory}`);
  if (diag?.load) lines.push(`**Load (1/5/15):** ${diag.load}`);

  const embed = {
    title: isDown ? '⚠️ Uptime incident — API health check failed' : '✅ Uptime resolved',
    color: isDown ? 0xff4444 : 0x00c853,
    description: lines.join('\n'),
    fields: [
      { name: 'Monitor', value: target, inline: true },
      { name: 'Started', value: `<t:${Math.floor(startedAt / 1000)}:R>`, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
  if (!isDown && resolvedAt) {
    embed.fields.push({ name: 'Duration', value: `${Math.round(durationSec)}s`, inline: true });
  }
  return embed;
}

/**
 * Start the incident monitor.
 *
 * @param {Object} opts
 * @param {Object} opts.client    - Discord client (ready first).
 * @param {string} opts.channelId - Incidents channel id.
 * @param {string} opts.target    - Human-readable monitor target (e.g. apiv1.travioafrica.com/health).
 * @param {Object} opts.env       - { apiUrl, publicUrl, databaseUrl, redisUrl, repoDir, errorLog, intervalMs }
 * @param {Object} [opts.redis]   - Optional redis client with get/set (for state persistence).
 */
function startIncidentMonitor({ client, channelId, target, env, redis }) {
  if (!channelId || !env?.apiUrl) {
    console.warn('[incident] monitor not started (missing channelId or apiUrl)');
    return;
  }

  const intervalMs = env.intervalMs || DEFAULT_INTERVAL_MS;
  let state = 'UP'; // current known state of the target
  let downSince = 0;
  let active = false;
  let timer = null;

  async function getPersistedState() {
    try {
      const raw = redis ? await redis.get(REDIS_STATE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.state === 'DOWN') {
          state = 'DOWN';
          downSince = parsed.since || Date.now();
        }
      }
    } catch {
      // ignore — fresh state is fine
    }
  }

  async function persist(stateNow, since) {
    try {
      if (redis) await redis.set(REDIS_STATE_KEY, JSON.stringify({ state: stateNow, since }), 'EX', 3600);
    } catch {
      // ignore
    }
  }

  async function check() {
    if (active) return;
    active = true;
    try {
      const local = await fetchHealth(env.apiUrl, LOCAL_TIMEOUT_MS);
      const pub = env.publicUrl ? await fetchHealth(env.publicUrl, PUBLIC_TIMEOUT_MS) : local;
      const down = !(local.ok && pub.ok);

      const now = Date.now();
      if (down && state === 'UP') {
        // UP → DOWN
        state = 'DOWN';
        downSince = now;
        await persist('DOWN', now);
        const diag = await collectDiagnostics(env);
        const embed = buildEmbed({ direction: 'down', target, startedAt: now, diag });
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send({ embeds: [embed] });
          console.log(`[incident] DOWN detected at ${target}`);
        } catch (e) {
          console.error('[incident] failed to post DOWN embed:', e.message);
        }
      } else if (!down && state === 'DOWN') {
        // DOWN → UP
        const durationSec = Math.round((now - downSince) / 1000);
        state = 'UP';
        await persist('UP', 0);
        const diag = await collectDiagnostics(env);
        const embed = buildEmbed({ direction: 'up', target, startedAt: downSince, resolvedAt: now, durationSec, diag });
        try {
          const ch = await client.channels.fetch(channelId);
          await ch.send({ embeds: [embed] });
          console.log(`[incident] RESOLVED after ${durationSec}s at ${target}`);
        } catch (e) {
          console.error('[incident] failed to post UP embed:', e.message);
        }
      }
    } catch (e) {
      console.error('[incident] check error:', e.message);
    } finally {
      active = false;
    }
  }

  (async () => {
    await getPersistedState();
    await check();
    timer = setInterval(check, intervalMs);
    timer.unref?.();
  })();

  return { stop: () => clearInterval(timer), tick: check };
}

module.exports = { startIncidentMonitor, collectDiagnostics, buildEmbed, fetchHealth };
