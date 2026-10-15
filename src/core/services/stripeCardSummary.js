/**
 * Card-on-file summary (brand + last4) for a Stripe PaymentIntent.
 *
 * Deliberately its own module rather than part of stripeHelpers: the checkout
 * tests mock `stripeHelpers` wholesale, and a function that lives behind that
 * boundary resolves to `undefined` in every one of them — which surfaced as a
 * 400 from the pay-later checkout rather than as an obvious "not a function".
 * This module has no dependencies, so nothing mocks it.
 *
 * Reads `payment_method` only when the caller expanded it (both pay-later
 * checkouts do, on the retrieve they already make, so it costs no extra Stripe
 * call) and yields nulls otherwise, so a booking always saves.
 */
function cardSummaryFromIntent(paymentIntent) {
  const pm = paymentIntent && paymentIntent.payment_method;
  const card = pm && typeof pm === 'object' ? pm.card : null;
  return {
    brand: card && card.brand ? String(card.brand) : null,
    last4: card && card.last4 ? String(card.last4) : null,
  };
}

module.exports = { cardSummaryFromIntent };
