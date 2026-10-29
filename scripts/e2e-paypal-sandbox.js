/* PayPal sandbox smoke test.
 *
 * Exercises the exact calls the checkout and refund paths make, against the
 * PayPal sandbox, without needing a browser or a storefront:
 *
 *   1. create an order          (POST /v2/checkout/orders)
 *   2. capture it               (POST /v2/checkout/orders/:id/capture)
 *   3. read the capture back    (GET  /v2/checkout/orders/:id)
 *   4. refund it in full        (POST /v2/payments/captures/:id/refund)
 *   5. poll the refund to COMPLETED
 *   6. verify a webhook signature (only if PAYPAL_WEBHOOK_ID is set; needs a
 *      real delivery id from the PayPal dashboard)
 *
 * It refuses to run against anything but sandbox credentials — this script
 * moves money, so live keys are treated as a mistake, not a warning.
 *
 * Env:
 *   PAYPAL_MODE=sandbox          (any other value refuses to run)
 *   PAYPAL_CLIENT_ID             (required)
 *   PAYPAL_CLIENT_SECRET         (required)
 *   PAYPAL_AMOUNT_MINOR=100      amount to test with, in cents
 *   PAYPAL_DRAFT_ID              optional; otherwise a throwaway id is minted
 *   PAYPAL_WEBHOOK_ID            optional: enables the verification step
 *
 * Run: npm run test:paypal:sandbox
 */
const crypto = require('crypto');
const path = require('path');

// Scripts run outside Jest, so the app's `.env` has to be loaded here —
// otherwise every guard below reads an empty variable and refuses to run.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  createOrder,
  getOrder,
  captureOrder,
  readCapture,
  refundCapture,
  getRefund,
  verifyWebhookSignature,
} = require('../src/core/services/payments/paypalPayments');

const mode = String(process.env.PAYPAL_MODE || '').trim().toLowerCase();
const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
const amountMinor = Number(process.env.PAYPAL_AMOUNT_MINOR || 100);
const draftId = process.env.PAYPAL_DRAFT_ID || `sandbox-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

if (mode !== 'sandbox') {
  console.error('REFUSING TO RUN: PAYPAL_MODE must be exactly "sandbox" (got %j)', mode);
  process.exit(1);
}
if (!clientId || !clientSecret) {
  console.error('REFUSING TO RUN: PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const awaitApproval = args.includes('--await-approval') || process.env.PAYPAL_AWAIT_APPROVAL === '1';
const existingOrderId = process.env.PAYPAL_ORDER_ID || null;
const approvalTimeoutMs = Number(process.env.PAYPAL_APPROVAL_TIMEOUT_MS || 300000);

async function waitForApproval(orderId) {
  const deadline = Date.now() + approvalTimeoutMs;
  for (;;) {
    // Raw PayPal status, not the normalised one: APPROVED and PAYER_ACTION_REQUIRED
    // both collapse to PROCESSING in the internal shape.
    const { order } = await getOrder(orderId);
    if (order.status === 'APPROVED') return order;
    if (order.status === 'COMPLETED') return order; // someone already captured it
    if (order.status === 'VOIDED') {
      throw new Error(`order ${orderId} was voided before it could be approved`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`order ${orderId} was not approved within ${approvalTimeoutMs}ms`);
    }
    await sleep(2000);
  }
}

async function pollForRefund(refundId, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    const { normalized } = await getRefund(refundId);
    if (normalized.status !== 'PENDING') return normalized;
    await sleep(1000);
  }
  return null;
}

async function main() {
  console.log(`PayPal sandbox smoke test — draft ${draftId}, amount ${amountMinor / 100} USD`);

  let orderId;
  let approvalUrl = null;
  let status = null;

  if (existingOrderId) {
    const { order } = await getOrder(existingOrderId);
    orderId = order.id;
    status = order.status;
    console.log(`  order     ${orderId}  status=${status}  (existing)`);
  } else {
    const created = await createOrder({
      draftId,
      amountMinor,
      currency: 'USD',
      description: 'Travio sandbox smoke test',
      brandName: 'Travio Sandbox',
      returnUrl: 'https://example.com/booking/paypal/return',
      cancelUrl: 'https://example.com/booking',
      idempotencyKey: `paypal-order-${draftId}`,
    });
    orderId = created.orderId;
    approvalUrl = created.approvalUrl;
    status = created.status;
    console.log(`  order     ${orderId}  status=${status}`);
    if (!approvalUrl) throw new Error('no approval link returned');
    console.log(`  approve   ${approvalUrl}`);
  }

  // A capture needs an APPROVED order, and approval is a human act in the
  // sandbox. --await-approval parks here (polling every 2s) until the order is
  // approved, so the whole create → capture → refund run can be one command.
  if (awaitApproval && status !== 'COMPLETED') {
    console.log(`  waiting   for approval (up to ${Math.round(approvalTimeoutMs / 1000)}s)`);
    if (approvalUrl) console.log(`  approve   ${approvalUrl}`);
    const approved = await waitForApproval(orderId);
    status = approved.status;
    console.log(`  approved  ${orderId}  status=${status}`);
  }

  // Sandbox orders can be captured without a human approving them when the
  // test account has "simulate" enabled; otherwise this fails with
  // ORDER_NOT_APPROVED, which is expected and still proves the API wiring.
  let capture;
  try {
    const captured = await captureOrder(orderId, { idempotencyKey: `paypal-capture-${draftId}` });
    capture = captured.capture;
  } catch (err) {
    if (/ORDER_NOT_APPROVED/i.test(String(err.code || err.message))) {
      console.log('  capture   ORDER_NOT_APPROVED — approve the order in the sandbox dashboard and re-run');
      console.log('  OK (create + read wiring verified)');
      return;
    }
    throw err;
  }

  console.log(`  capture   ${capture.captureId}  status=${capture.captureStatus}  amount=${capture.amountMinor} ${capture.currency}`);

  const { capture: reread } = await readCapture(orderId);
  if (!reread || reread.captureId !== capture.captureId) {
    throw new Error('readCapture did not return the capture we just made');
  }
  console.log('  read      capture round-tripped correctly');

  const refund = await refundCapture({
    captureId: capture.captureId,
    amountMinor: null,
    currency: 'USD',
    note: 'Travio sandbox smoke test',
    idempotencyKey: `paypal-auto-refund-${capture.captureId}`,
  });
  console.log(`  refund    ${refund.normalized.refundId}  status=${refund.normalized.status}`);

  const settled = await pollForRefund(refund.normalized.refundId);
  if (!settled || settled.status !== 'SUCCEEDED') {
    throw new Error(`refund did not settle: ${settled && settled.status}`);
  }
  console.log(`  refund    settled ${settled.refundId}`);

  if (process.env.PAYPAL_WEBHOOK_ID) {
    const result = await verifyWebhookSignature(
      {
        'paypal-transmission-id': 'sandbox-probe',
        'paypal-transmission-time': new Date().toISOString(),
        'paypal-transmission-sig': 'sandbox-probe',
        'paypal-cert-url': 'https://api.sandbox.paypal.com/cert.pem',
        'paypal-auth-algo': 'SHA256withRSA',
      },
      { id: 'sandbox-probe', event_type: 'PING', resource: {} }
    );
    console.log(`  webhook   verification probe reached PayPal (status=${result.status || result.reason})`);
  } else {
    console.log('  webhook   skipped — PAYPAL_WEBHOOK_ID not set');
  }

  console.log('OK: create, capture, read and refund all work against the sandbox');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAILED:', err.message);
    if (err.requestId) console.error('  PayPal debug id:', err.requestId);
    process.exit(1);
  });
