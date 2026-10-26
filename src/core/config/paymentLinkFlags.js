/**
 * SystemConfig keys for the hosted payment-link rollout.
 *
 * Shared by `paymentLinkService` (which gates on them) and
 * `adminSettingsController` (which validates writes), so the admin switch and
 * the runtime check can never drift apart.
 *
 * The strings are part of the deployed contract: renaming one silently turns
 * the feature off. `__tests__/unit/adminSettingsController.test.js` pins them,
 * so a change has to be deliberate.
 *
 * Order matters on the way in: `base` gates the other three. `supplier` gates
 * supplier-sent links, `recovery` gates the automatic email, `chat` gates
 * posting the link in chat.
 */
const PAYMENT_LINK_FLAGS = {
  base: 'feature.payLaterPaymentAttempts.ghana',
  supplier: 'feature.supplierPaymentLinks.ghana',
  recovery: 'feature.payLaterPaymentRecovery.ghana',
  chat: 'feature.paymentLinkChat.ghana',
};

module.exports = PAYMENT_LINK_FLAGS;
