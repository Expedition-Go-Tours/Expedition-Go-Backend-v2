/**
 * Stripe settlement facts for a payment — "where did this money land?"
 *
 * A proof-of-payment document is only credible if it names the account that
 * actually received the funds. That is read from Stripe at render time, not
 * inferred from a database column:
 *
 *   - a direct charge settles into the platform account;
 *   - a destination charge settles into the connected account named by
 *     `charge.destination` (or `payment_intent.transfer_data.destination`).
 *
 * Everything here is best-effort. A Stripe outage must never stop an admin
 * from downloading a receipt: the caller gets `{ error }` and prints the
 * stored card/PaymentIntent facts instead.
 *
 * Account metadata is cached (10 min) because it changes rarely and the
 * platform account is the same for every download.
 */

const { getStripe } = require('./stripeHelpers');

const CACHE_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5000;

const accountCache = new Map();

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function displayName(account) {
  if (!account) return null;
  return (
    (account.business_profile && account.business_profile.name) ||
    (account.settings && account.settings.dashboard && account.settings.dashboard.display_name) ||
    account.email ||
    null
  );
}

function toAccount(account, connected) {
  if (!account) return null;
  return {
    id: account.id || null,
    name: displayName(account),
    country: account.country || null,
    defaultCurrency: account.default_currency ? String(account.default_currency).toUpperCase() : null,
    connected: Boolean(connected),
  };
}

async function resolveAccount(stripe, accountId) {
  const key = accountId || 'platform';
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const account = accountId
    ? await withTimeout(stripe.accounts.retrieve(accountId), LOOKUP_TIMEOUT_MS, 'Stripe account lookup')
    : await withTimeout(stripe.accounts.retrieve(), LOOKUP_TIMEOUT_MS, 'Stripe account lookup');

  const value = toAccount(account, Boolean(accountId));
  accountCache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Resolve settlement facts for a Stripe PaymentIntent.
 *
 * @param {object} params
 * @param {string} params.paymentIntentId
 * @returns {Promise<object|null>} null when there is nothing to look up;
 *   `{ error }` when Stripe could not be reached.
 */
async function getStripeSettlement({ paymentIntentId }) {
  if (!paymentIntentId) return null;

  try {
    const stripe = getStripe();
    const intent = await withTimeout(
      stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] }),
      LOOKUP_TIMEOUT_MS,
      'Stripe payment lookup',
    );

    const charge = intent.latest_charge && typeof intent.latest_charge === 'object'
      ? intent.latest_charge
      : null;

    const destination =
      (charge && charge.destination) ||
      (intent.transfer_data && intent.transfer_data.destination) ||
      null;

    const account = await resolveAccount(stripe, destination);
    const card = charge && charge.payment_method_details && charge.payment_method_details.card;

    return {
      account,
      connectedAccountId: destination || null,
      charge: charge
        ? {
            id: charge.id || null,
            receiptUrl: charge.receipt_url || null,
            balanceTransactionId:
              typeof charge.balance_transaction === 'string'
                ? charge.balance_transaction
                : (charge.balance_transaction && charge.balance_transaction.id) || null,
            brand: (card && card.brand) || null,
            last4: (card && card.last4) || null,
            paid: Boolean(charge.paid),
            captured: Boolean(charge.captured),
          }
        : null,
      amount: intent.amount_received != null ? intent.amount_received / 100 : intent.amount != null ? intent.amount / 100 : null,
      currency: intent.currency ? String(intent.currency).toUpperCase() : null,
      status: intent.status || null,
      livemode: Boolean(intent.livemode),
      receiptEmail: intent.receipt_email || null,
    };
  } catch (err) {
    console.warn(`[Settlement] Stripe lookup failed: ${err.message}`);
    return { error: err.message };
  }
}

/** Test hook: drop cached account metadata. */
function clearSettlementCache() {
  accountCache.clear();
}

module.exports = { getStripeSettlement, clearSettlementCache };
