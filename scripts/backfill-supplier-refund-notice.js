#!/usr/bin/env node
/**
 * Backfill the supplier's refund decision notice.
 *
 * The in-app notification and the redesigned decision email shipped after some
 * refunds were already approved, so those suppliers got the old email (or no
 * bell entry at all). This replays the decision fan-out for one request or for
 * everything executed on a given day.
 *
 * Idempotent for the bell: the notification carries a per-request dedupe key,
 * so running it twice cannot create a second row. The EMAIL is not deduped by
 * the provider — it only sends with --email, and that is a deliberate re-send.
 *
 * Usage (on the server, from the app directory):
 *   node scripts/backfill-supplier-refund-notice.js --request <id>            # dry run
 *   node scripts/backfill-supplier-refund-notice.js --request <id> --apply
 *   node scripts/backfill-supplier-refund-notice.js --date 2026-11-05 --apply
 *   node scripts/backfill-supplier-refund-notice.js --date 2026-11-05 --apply --email
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = require('../src/core/services/prismaClient');
const service = require('../src/core/services/supplierRefundRequest');

function argValue(name) {
  const inline = process.argv.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : null;
}

const requestId = argValue('--request');
const date = argValue('--date');
const apply = process.argv.includes('--apply');
const withEmail = process.argv.includes('--email');

function dayBounds(value) {
  const start = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`Bad --date: ${value}`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

async function loadTargets() {
  if (requestId) {
    const row = await prisma.supplierRefundRequest.findUnique({ where: { id: requestId } });
    return row ? [row] : [];
  }
  if (date) {
    const { start, end } = dayBounds(date);
    return prisma.supplierRefundRequest.findMany({
      where: {
        status: 'COMPLETED',
        executedAt: { gte: start, lt: end },
      },
      orderBy: { executedAt: 'asc' },
    });
  }
  throw new Error('Pass --request <id> or --date YYYY-MM-DD');
}

function decisionOf(request) {
  if (request.status === 'COMPLETED') return 'approved';
  if (request.status === 'FAILED') return 'failed';
  if (request.status === 'REJECTED') return 'rejected';
  return null;
}

(async () => {
  const targets = await loadTargets();
  if (!targets.length) {
    console.log('No matching refund requests.');
    return;
  }

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${targets.length} request(s)`);

  for (const request of targets) {
    const decision = decisionOf(request);
    if (!decision) {
      console.log(`- ${request.requestNumber}: status ${request.status} is not a decision. Skipped.`);
      continue;
    }

    console.log(
      `- ${request.requestNumber} (${request.id}) · booking ${request.bookingId} · ${decision}` +
        ` · refund ${request.refundedAmount ?? request.preview?.proposed ?? '?'} ${request.preview?.currency || ''}`.trimEnd(),
    );

    if (!apply) continue;

    try {
      await service.notifySupplierRefundOutcome({ request, decision });
      console.log('    bell: enqueued (deduped per request)');
    } catch (err) {
      console.error(`    bell FAILED: ${err.message}`);
    }

    if (withEmail) {
      try {
        const { sendSupplierRefundDecisionEmail } = require('../src/core/services/emailService');
        await sendSupplierRefundDecisionEmail(request.id);
        console.log('    email: sent to the supplier audience');
      } catch (err) {
        console.error(`    email FAILED: ${err.message}`);
      }
    }
  }

  if (!apply) {
    console.log('\nNothing changed. Re-run with --apply (add --email to re-send the email).');
  }
})()
  .catch((err) => {
    console.error('Backfill failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    // The notification queue keeps Redis sockets open, so the event loop never
    // drains on its own — the script would finish its work and then hang.
    process.exit(process.exitCode || 0);
  });
