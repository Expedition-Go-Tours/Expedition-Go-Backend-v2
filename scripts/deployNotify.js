#!/usr/bin/env node
/**
 * deployNotify.js — central Discord embed builder + sender for CI/CD deploys.
 *
 * GitHub Actions is the source of truth (commit SHA, tests, deploy result,
 * verification result). This script only turns that truth into a human-facing
 * Discord embed and posts it via scripts/discordSendEmbed.sh.
 *
 * Lifecycle states (STATE env):
 *   started   🚀  deployment started
 *   completed 📦  deploy commands finished (NOT yet verified)
 *   verified  🏥  post-deploy verification passed
 *   failed    ❌  deploy OR verification failed (FAIL_STAGE)
 *   ci_failed ❌  CI pipeline failed before/around deploy
 *
 * Safety guarantees:
 *   - ALWAYS exits 0 — a notification failure must never fail a deployment.
 *   - No raw shell/SSH output is ever included; failures link to the run.
 *   - No secrets, env vars, tokens, DB URLs, or infra paths in embeds.
 *   - The commit SHA is the immutable deployment identity (not package.json
 *     version, which is shared across deployments).
 *
 * @version 1.0.0
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const COLORS = {
  started: 0x3b82f6, // blue
  completed: 0xf59e0b, // amber — deployed but verification pending
  verified: 0x22c55e, // green — production verified
  failed: 0xef4444, // red
  ci_failed: 0xef4444, // red
};

const MAX_BODY_CHARS = 1000;

function stripControlChars(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

function truncate(text, max) {
  if (!text) return '';
  const s = stripControlChars(String(text)).trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function comma(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US');
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

function fmtTests(env) {
  const jobs = ['unit', 'integration', 'e2e'];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let have = false;
  for (const j of jobs) {
    const p = env[`TESTS_${j.toUpperCase()}_PASSED`];
    const f = env[`TESTS_${j.toUpperCase()}_FAILED`];
    const k = env[`TESTS_${j.toUpperCase()}_SKIPPED`];
    if (p !== undefined && p !== '') {
      passed += Number(p) || 0;
      have = true;
    }
    if (f !== undefined && f !== '') {
      failed += Number(f) || 0;
      have = true;
    }
    if (k !== undefined && k !== '') {
      skipped += Number(k) || 0;
      have = true;
    }
  }
  if (!have) return null;
  let out = `${comma(passed)} passed`;
  if (failed > 0) out += ` · ${comma(failed)} failed`;
  else out += ' · 0 failed';
  if (skipped > 0) out += ` · ${comma(skipped)} skipped`;
  return out;
}

function runUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = env.GITHUB_REPOSITORY || '';
  const id = env.GITHUB_RUN_ID || '';
  return `${server}/${repo}/actions/runs/${id}`;
}

function commitUrl(env) {
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = env.GITHUB_REPOSITORY || '';
  const sha = env.DEPLOY_SHA || env.GITHUB_SHA || '';
  return `${server}/${repo}/commit/${sha}`;
}

/**
 * Build the embed payload for a given state from env variables.
 * Pure function — exported for testing.
 */
function buildPayload(state, env) {
  const sha = env.DEPLOY_SHA || env.GITHUB_SHA || '';
  const shortSha = (env.DEPLOY_SHORT_SHA || sha || '').slice(0, 7);
  const branch = env.GITHUB_REF_NAME || '';
  const author = env.DEPLOY_AUTHOR || env.GITHUB_ACTOR || '';
  const subject = env.DEPLOY_SUBJECT || '';
  const body = truncate(env.DEPLOY_BODY || '', MAX_BODY_CHARS);
  const run = runUrl(env);
  const runLabel = env.GITHUB_RUN_NUMBER ? `#${env.GITHUB_RUN_NUMBER}` : '';

  const embed = {
    title: '',
    color: COLORS[state] || 0x5865f2,
    timestamp: env.DEPLOY_TIMESTAMP || new Date().toISOString(),
    fields: [],
    url: run,
  };

  const shaField = {
    name: 'Commit',
    value: `[\`${shortSha}\`](${commitUrl(env)})${subject ? ` — ${subject}` : ''}`,
    inline: false,
  };

  if (state === 'started') {
    embed.title = '🚀 Deployment Started';
    embed.description = body ? `**${truncate(subject, 200)}**\n\n${body}` : truncate(subject, 200);
    embed.fields = [
      { name: 'Environment', value: env.DEPLOY_ENV || 'production', inline: true },
      { name: 'Branch', value: branch || 'main', inline: true },
      shaField,
      { name: 'Author', value: author || '—', inline: true },
      { name: 'Changes', value: env.DEPLOY_CHANGED_FILES ? `${env.DEPLOY_CHANGED_FILES} files` : 'N/A', inline: true },
      { name: 'Run', value: `[${runLabel}](${run})`, inline: true },
    ];
  } else if (state === 'completed') {
    embed.title = '📦 Deployment Completed';
    embed.description = 'Deploy commands finished — **verification pending**.';
    const tests = fmtTests(env);
    const fields = [
      shaField,
      { name: 'Stage', value: env.DEPLOY_STAGE || 'Deployed', inline: true },
    ];
    if (tests) fields.push({ name: 'Tests', value: tests, inline: false });
    fields.push(
      { name: 'Duration', value: fmtDuration(env.DEPLOY_DURATION), inline: true },
      { name: 'Run', value: `[${runLabel}](${run})`, inline: true }
    );
    embed.fields = fields;
  } else if (state === 'verified') {
    embed.title = '🏥 Production Verified';
    const health = env.HEALTH_CODE ? `HTTP ${env.HEALTH_CODE}` : '—';
    const tours = env.TOURS_CODE ? `HTTP ${env.TOURS_CODE}` : '—';
    const latency = env.HEALTH_LATENCY_MS ? `${env.HEALTH_LATENCY_MS}ms` : '—';
    embed.description = 'Post-deployment verification passed.';
    embed.fields = [
      { name: 'Production URL', value: env.PRODUCTION_URL || 'https://apiv1.travioafrica.com', inline: false },
      { name: 'Health', value: health, inline: true },
      { name: 'Tours', value: tours, inline: true },
      { name: 'Latency', value: latency, inline: true },
      shaField,
      { name: 'Verification duration', value: fmtDuration(env.VERIFY_DURATION), inline: true },
      { name: 'Total (start → verified)', value: fmtDuration(env.TOTAL_DURATION), inline: true },
    ];
    if (env.HEALTH_DETAILS) {
      embed.fields.push({ name: 'Health details', value: truncate(env.HEALTH_DETAILS, 400), inline: false });
    }
  } else if (state === 'failed') {
    const stage = env.FAIL_STAGE === 'verification' ? 'Verification' : 'Deployment';
    embed.title = `❌ ${stage} Failed`;
    embed.description = `The ${stage.toLowerCase()} step failed. See the run for details.`;
    embed.fields = [
      { name: 'Stage', value: env.FAIL_STEP || stage, inline: true },
      shaField,
      { name: 'Branch', value: branch || 'main', inline: true },
      { name: 'Duration', value: fmtDuration(env.DEPLOY_DURATION), inline: true },
      { name: 'Run', value: `[${runLabel}](${run})`, inline: false },
    ];
  } else if (state === 'ci_failed') {
    embed.title = '❌ CI Failed';
    embed.description = 'CI pipeline failed — deployment blocked.';
    const tests = fmtTests(env);
    const fields = [];
    if (env.FAILED_JOBS) fields.push({ name: 'Failed jobs', value: env.FAILED_JOBS, inline: false });
    if (tests) fields.push({ name: 'Tests', value: tests, inline: false });
    fields.push(
      shaField,
      { name: 'Author', value: author || '—', inline: true },
      { name: 'Duration', value: fmtDuration(env.CI_DURATION), inline: true },
      { name: 'Run', value: `[${runLabel}](${run})`, inline: false }
    );
    embed.fields = fields;
  } else {
    throw new Error(`Unknown STATE: ${state}`);
  }

  return { embeds: [embed] };
}

/**
 * CLI entrypoint. Usage:
 *   node scripts/deployNotify.js
 * Reads STATE + all data from the environment, writes the payload to a
 * temp file, and sends via scripts/discordSendEmbed.sh.
 * Never exits non-zero (unless the script itself is broken).
 */
function main() {
  const state = process.env.STATE;
  if (!state) {
    console.error('[deployNotify] STATE env var required');
    return 0;
  }

  let payload;
  try {
    payload = buildPayload(state, process.env);
  } catch (e) {
    console.error(`[deployNotify] failed to build payload: ${e.message}`);
    return 0;
  }

  const webhook = process.env.DISCORD_DEPLOY_WEBHOOK || '';
  if (!webhook) {
    console.error('[deployNotify] DISCORD_DEPLOY_WEBHOOK empty — skipping.');
    return 0;
  }

  const tmp = path.join(os.tmpdir(), `deploy-notify-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));

  try {
    const script = path.join(__dirname, 'discordSendEmbed.sh');
    execSync(`bash "${script}" "${webhook}" "${tmp}"`, {
      stdio: 'inherit',
      timeout: 30000,
    });
  } catch (e) {
    console.error(`[deployNotify] send failed (non-fatal): ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }

  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { buildPayload, fmtDuration, fmtTests, truncate };
