#!/usr/bin/env node
/**
 * release/notify.js — Discord release notifications for the Docker pipeline.
 *
 * Two messages, no shared state:
 *   MODE=start  posted immediately after the deploy gate opens
 *   MODE=final  posted after verification, and edits nothing
 *
 * The final card carries what the old PM2 notifier had: commit subject/body,
 * author, PR link, per-stage durations, test counts from the CI artifact, health
 * and latency per public vhost, deployment results, and rollback/run links.
 *
 * Guarantees:
 *   - Never fails the release. Every error is a ::warning:: and exit 0.
 *   - No secrets, webhook URLs, tokens or raw logs in the payload.
 *   - Pure builders are exported and unit-tested; only main() touches the
 *     network.
 */

const fs = require('fs');

const COLORS = {
  started: 0x3498db,
  success: 0x2ecc71,
  failure: 0xe74c3c,
};

const DEFAULT_HOSTS = 'apiv1.travioafrica.com api.travioghana.com api.expeditiongotours.com';
const LINK_STYLE = 5; // Discord URL button

function warn(message) {
  console.log(`::warning::${message}`);
}

function truncate(value, max) {
  const text = String(value || '').replace(/\r/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(seconds) {
  if (seconds == null || seconds === '' || Number.isNaN(Number(seconds))) return '—';
  const total = Math.max(0, Math.round(Number(seconds)));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, '0')}s` : `${rest}s`;
}

function isFailed(results) {
  return Object.values(results).some((value) => value !== 'success' && value !== 'skipped');
}

function stageIcon(result) {
  if (result === 'success') return '✅';
  if (result === 'skipped') return '➖';
  return '❌';
}

function stageLine(label, result, seconds) {
  const detail = result === 'skipped' ? 'skipped' : result === 'success' ? formatDuration(seconds) : 'FAILED';
  return `${stageIcon(result)} ${label.padEnd(14)} ${detail}`;
}

function button(label, url) {
  return { type: 2, style: LINK_STYLE, label: truncate(label, 80), url };
}

function buildStartPayload({ apps, sha, ref, meta, runUrl, event, actor }) {
  const short = sha.slice(0, 7);
  const components = [button('View run', runUrl), button('Commit', meta.url)];
  if (meta.pr) components.push(button(`PR #${meta.pr.number}`, meta.pr.url));

  const embed = {
    title: truncate(meta.subject || `Release ${short} in progress`, 240),
    url: runUrl,
    description: [
      `🚀 **Deploying ${short}** — ${apps || 'nothing'} @ ${ref}`,
      `by ${meta.author || actor} · ${event}${meta.pr ? ` · [PR #${meta.pr.number}](${meta.pr.url})` : ''}`,
    ].join('\n'),
    color: COLORS.started,
    timestamp: new Date().toISOString(),
  };

  if (meta.body) {
    embed.fields = [{ name: 'Commit message', value: truncate(meta.body, 900), inline: false }];
  }

  return {
    username: 'Travio Release',
    content: `Deploy started — ${apps || 'nothing'} @ ${ref}`,
    // Commit text is untrusted: it must never be able to mention anyone.
    allowed_mentions: { parse: [] },
    embeds: [embed],
    components: [{ type: 1, components }],
  };
}

function buildFinalPayload({
  apps,
  sha,
  ref,
  meta,
  runUrl,
  ciRunUrl,
  event,
  actor,
  results,
  durations,
  health,
  tests,
  oncallRoleId,
  repoUrl,
}) {
  const short = sha.slice(0, 7);
  const failed = isFailed(results);

  const stages = [
    stageLine('Build', results.build, durations && durations.build),
    stageLine('Migrations', results.migrate, durations && durations.migrate),
    stageLine('platform-api', results.platform, durations && durations.platform),
    stageLine('stays-api', results.stays, durations && durations.stays),
    stageLine('Ingress', results.verify, durations && durations.verify),
  ].join('\n');

  const fields = [{ name: 'Stages', value: `\`\`\`\n${stages}\n\`\`\``, inline: false }];

  if (tests && tests.total) {
    const total = tests.total;
    const detail = ['unit', 'integration', 'e2e']
      .filter((suite) => tests[suite] && Number(tests[suite].passed || tests[suite].failed || tests[suite].skipped))
      .map((suite) => `${suite} ${Number(tests[suite].passed || 0)}`)
      .join(' · ');
    fields.push({
      name: 'Tests',
      value: `${Number(total.passed || 0).toLocaleString()} passed · ${Number(total.failed || 0)} failed · ${Number(total.skipped || 0)} skipped${detail ? `\n${detail}` : ''}`,
      inline: false,
    });
  }

  if (Array.isArray(health) && health.length > 0) {
    fields.push({
      name: 'Health',
      value: health
        .map((h) => `${h.code === 200 ? '✅' : '❌'} ${h.host} ${h.code || 'no response'} · ${Math.round(h.ms)}ms`)
        .join('\n'),
      inline: false,
    });
  }

  if (meta.body) {
    fields.push({ name: 'Commit message', value: truncate(meta.body, 900), inline: false });
  }

  const components = [button('View run', runUrl), button('Commit', meta.url)];
  if (meta.pr) components.push(button(`PR #${meta.pr.number}`, meta.pr.url));
  if (ciRunUrl) components.push(button('CI run', ciRunUrl));
  components.push(button('Rollback runbook', `${repoUrl}/blob/main/docs/deployment/ci-cd.md#rollback`));

  const mention = failed && oncallRoleId ? `<@&${oncallRoleId}> ` : '';
  const headline = failed ? '❌ Release failed' : '✅ Deployed';

  return {
    username: 'Travio Release',
    content: `${mention}${headline} — ${apps || 'nothing'} @ ${ref}`,
    // Only the on-call role may be mentioned, and only on failure. Commit
    // text is untrusted, so success parses no mentions at all.
    allowed_mentions: { parse: failed && oncallRoleId ? ['roles'] : [] },
    embeds: [{
      title: truncate(`Release ${short}${failed ? ' — failed' : ''}`, 240),
      url: runUrl,
      description: [
        `**${meta.subject || `Release ${short}`}**`,
        `by ${meta.author || actor} · ${event}${meta.pr ? ` · [PR #${meta.pr.number}](${meta.pr.url})` : ''}`,
      ].join('\n'),
      fields,
      color: failed ? COLORS.failure : COLORS.success,
      timestamp: new Date().toISOString(),
    }],
    components: [{ type: 1, components }],
  };
}

// ── Data collection (network) ───────────────────────────────────────────────

async function github(path) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'travio-release',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function collectMeta(sha) {
  const fallback = {
    subject: '',
    body: '',
    author: process.env.ACTOR || '',
    url: `https://github.com/${process.env.GITHUB_REPOSITORY}/commit/${sha}`,
    pr: null,
  };
  if (!sha) return fallback;

  const commit = await github(`/commits/${sha}`);
  const pulls = await github(`/commits/${sha}/pulls`);
  const message = commit && commit.commit && commit.commit.message ? commit.commit.message : '';
  const [subject, ...rest] = message.split('\n');

  return {
    subject: subject || '',
    body: rest.join('\n').trim(),
    author:
      (commit && commit.commit && commit.commit.author && commit.commit.author.name)
      || (commit && commit.author && commit.author.login)
      || fallback.author,
    url: (commit && commit.html_url) || fallback.url,
    pr: Array.isArray(pulls) && pulls[0] ? { number: pulls[0].number, url: pulls[0].html_url } : null,
  };
}

function secondsBetween(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isNaN(ms) ? null : Math.max(0, Math.round(ms / 1000));
}

async function collectDurations(runId) {
  if (!runId) return null;
  const data = await github(`/actions/runs/${runId}/jobs?per_page=100`);
  if (!data || !Array.isArray(data.jobs)) return null;

  const find = (name) => data.jobs.find((job) => job.name === name);
  const duration = (name) => {
    const job = find(name);
    return job ? secondsBetween(job.started_at, job.completed_at) : null;
  };
  const max = (values) => {
    const known = values.filter((v) => v != null);
    return known.length ? Math.max(...known) : null;
  };

  return {
    build: max([duration('Build platform'), duration('Build stays')]),
    migrate: duration('Apply migrations'),
    platform: duration('Deploy platform-api'),
    stays: duration('Deploy stays-api'),
    verify: duration('Verify public ingress'),
  };
}

async function collectHealth() {
  const hosts = String(process.env.PUBLIC_HOSTS || DEFAULT_HOSTS).trim().split(/\s+/).filter(Boolean);
  const results = [];

  for (const host of hosts) {
    const started = Date.now();
    try {
      const res = await fetch(`https://${host}/health`, { signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      results.push({ host, code: res.status, ms: Date.now() - started, commit: body.commit || null });
    } catch {
      results.push({ host, code: 0, ms: Date.now() - started, commit: null });
    }
  }

  return results;
}

function readTests(path) {
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function send(payload) {
  const webhook = process.env.WEBHOOK;
  if (!webhook) {
    warn('No Discord release webhook configured (DISCORD_RELEASE_WEBHOOK / DISCORD_DEPLOY_WEBHOOK); skipping notification.');
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      warn(`Discord rejected the notification (HTTP ${res.status}); the release is unaffected.`);
      return;
    } catch (err) {
      if (attempt === 3) {
        warn(`Discord notification failed after 3 attempts: ${err.message}; the release is unaffected.`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  const mode = process.env.MODE;
  const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA || '';
  const ref = process.env.RELEASE_REF || process.env.GITHUB_REF_NAME || 'main';
  const apps = process.env.APPS || '';
  const runUrl = process.env.RUN_URL || '';
  const event = process.env.EVENT || '';
  const actor = process.env.ACTOR || '';
  const repoUrl = `https://github.com/${process.env.GITHUB_REPOSITORY}`;

  if (!['start', 'final'].includes(mode)) {
    warn(`Unknown release notification MODE "${mode}"; skipping.`);
    return;
  }

  const meta = await collectMeta(sha);

  if (mode === 'start') {
    await send(buildStartPayload({ apps, sha, ref, meta, runUrl, event, actor }));
    return;
  }

  const results = {
    build: process.env.BUILD_RESULT || '',
    migrate: process.env.MIGRATE_RESULT || '',
    platform: process.env.PLATFORM_RESULT || '',
    stays: process.env.STAYS_RESULT || '',
    verify: process.env.VERIFY_RESULT || '',
  };

  const durations = await collectDurations(process.env.GITHUB_RUN_ID);
  const health = await collectHealth();
  const tests = readTests(process.env.TEST_SUMMARY_PATH);

  await send(buildFinalPayload({
    apps,
    sha,
    ref,
    meta,
    runUrl,
    ciRunUrl: process.env.CI_RUN_URL || '',
    event,
    actor,
    results,
    durations,
    health,
    tests,
    oncallRoleId: process.env.ONCALL_ROLE_ID || '',
    repoUrl,
  }));
}

if (require.main === module) {
  main().catch((err) => warn(`Release notification failed: ${err.message}; the release is unaffected.`));
}

module.exports = {
  buildStartPayload,
  buildFinalPayload,
  formatDuration,
  isFailed,
  readTests,
  stageLine,
};
