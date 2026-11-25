/**
 * Product verticals that share chat and notification storage.
 *
 * Both values are persisted on Conversation/Notification. A missing or
 * unrecognised query value means "no vertical filter" so older callers keep
 * their previous behaviour.
 */
const PRODUCT_DOMAINS = Object.freeze({
  STAYS: 'STAYS',
  EXPERIENCES: 'EXPERIENCES',
});

function parseProductDomain(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase();
  return PRODUCT_DOMAINS[key] ? PRODUCT_DOMAINS[key] : null;
}

module.exports = { PRODUCT_DOMAINS, parseProductDomain };
