const { resolveBrandKey } = require('../config/brands');

/**
 * Attach the brand whose API namespace served this request.
 *
 * Brand-scoped mounts (e.g. /api/travioghana/chat, /api/travioafrica/admin)
 * carry the brand in the route itself, so the value is server-controlled and
 * can be trusted by shared controllers that must scope data per platform
 * (chat conversation isolation). The key is resolved through the brand
 * registry so legacy aliases (`default` → `africa`) still normalise.
 */
function attachBrand(brandKey) {
  const key = resolveBrandKey(brandKey);
  return function brandContext(req, res, next) {
    req.brandKey = key;
    next();
  };
}

/**
 * Best-effort brand for the authenticated user when no route brand is present:
 * an admin/supplier carrying a brand role belongs to that brand.
 */
function brandKeyFromUser(user) {
  if (!user || !Array.isArray(user.roles)) return null;
  if (user.roles.includes('ghana')) return 'ghana';
  if (user.roles.includes('travioafrica')) return 'africa';
  return null;
}

module.exports = { attachBrand, brandKeyFromUser };
