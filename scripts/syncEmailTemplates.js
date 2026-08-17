/**
 * Sync Email Templates to SendGrid.
 *
 * Reads every compiled template from sendgrid-templates/generated/*.html,
 * creates or updates a SendGrid Dynamic Template for each one, and persists
 * the id mapping to sendgrid-templates/template-ids.json so emailService can
 * look templates up by key without hard-coding ids.
 *
 * Usage:
 *   node scripts/syncEmailTemplates.js            # sync all (create + update)
 *   node scripts/syncEmailTemplates.js --dry-run  # print plan, change nothing
 *   node scripts/syncEmailTemplates.js --force    # update all, even unchanged
 *
 * Idempotent: a template that already exists and is byte-identical is skipped.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const sgClient = require('@sendgrid/client');

const OUT_DIR = path.join(__dirname, '..', 'sendgrid-templates', 'generated');
const IDS_FILE = path.join(__dirname, '..', 'sendgrid-templates', 'template-ids.json');

sgClient.setApiKey(process.env.SENDGRID_API_KEY);

async function api(request) {
  const [response, body] = await sgClient.request(request);
  return { status: response.statusCode, body };
}

/** Subject is the <title> tag; SendGrid uses it as the template version subject. */
function extractSubject(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/);
  return m ? m[1].trim() : '';
}

async function listExistingTemplates() {
  const { status, body } = await api({
    method: 'GET',
    url: '/v3/templates',
    qs: { generations: 'dynamic', page_size: 200 },
  });
  if (status >= 400) throw new Error(`Failed to list templates: ${status} ${JSON.stringify(body)}`);
  const byName = {};
  for (const t of body.templates || []) byName[t.name] = t;
  return byName;
}

async function ensureTemplateVersion(templateId, name, html, subject) {
  const { status, body } = await api({
    method: 'POST',
    url: `/v3/templates/${templateId}/versions`,
    body: { template_id: templateId, active: 1, name: `v1`, subject, html_content: html },
  });
  if (status >= 400) throw new Error(`Failed to create version for ${name}: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

async function updateTemplateVersion(versionId, html, subject) {
  const { status, body } = await api({
    method: 'PATCH',
    url: `/v3/templates/versions/${versionId}`,
    body: { subject, html_content: html },
  });
  if (status >= 400) throw new Error(`Failed to update version: ${status} ${JSON.stringify(body)}`);
  return body.id;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');

  if (!process.env.SENDGRID_API_KEY) {
    console.error('SENDGRID_API_KEY is not set. Aborting.');
    process.exit(1);
  }

  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.html')).sort();
  if (files.length === 0) {
    console.error('No compiled templates found. Run node scripts/buildEmailTemplates.js first.');
    process.exit(1);
  }

  const existing = await listExistingTemplates();

  const ids = {};
  const plan = { create: [], update: [], skip: [], error: [] };

  for (const file of files) {
    const key = file.replace(/\.html$/, '');
    const name = `Travio Africa · ${key}`;
    const html = fs.readFileSync(path.join(OUT_DIR, file), 'utf-8');
    const subject = extractSubject(html);

    try {
      if (existing[name]) {
        const template = existing[name];
        const versions = template.versions || [];
        const active = versions.find((v) => v.active === 1) || versions[0];
        const same = active && active.html_content === html && active.subject === subject;
        if (same && !force) {
          plan.skip.push(key);
          ids[key] = template.id;
          console.log(`=  ${key}  (unchanged)`);
        } else if (active) {
          const versionId = await updateTemplateVersion(active.id, html, subject);
          plan.update.push(key);
          ids[key] = template.id;
          console.log(`~  ${key}  (updated)`);
        } else {
          await ensureTemplateVersion(template.id, name, html, subject);
          plan.update.push(key);
          ids[key] = template.id;
          console.log(`~  ${key}  (version created)`);
        }
      } else {
        if (dryRun) {
          plan.create.push(key);
          console.log(`+  ${key}  (would create)`);
          continue;
        }
        const { status, body } = await api({
          method: 'POST',
          url: '/v3/templates',
          body: { name, generation: 'dynamic' },
        });
        if (status >= 400) throw new Error(`Failed to create template ${key}: ${status} ${JSON.stringify(body)}`);
        const templateId = body.id;
        await ensureTemplateVersion(templateId, name, html, subject);
        plan.create.push(key);
        ids[key] = templateId;
        console.log(`+  ${key}  (created)`);
      }
    } catch (e) {
      plan.error.push({ key, message: e.message });
      console.error(`!  ${key}  FAILED: ${e.message}`);
    }
  }

  if (!dryRun) {
    fs.writeFileSync(IDS_FILE, JSON.stringify(ids, null, 2) + '\n', 'utf-8');
    console.log(`\nSaved template-ids.json (${Object.keys(ids).length} ids)`);
  }

  console.log(`\nSummary: ${plan.create.length} created, ${plan.update.length} updated, ${plan.skip.length} skipped, ${plan.error.length} errors`);
  if (dryRun) console.log('(dry run — nothing was changed)');
  if (plan.error.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('Sync failed:', e);
  process.exit(1);
});
