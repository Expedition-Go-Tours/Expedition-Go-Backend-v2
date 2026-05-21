/**
 * Role-based access control helpers.
 *
 * The backend user object exposes a `role` (or `roles`) field. We normalise
 * it to one of: 'admin', 'manager', 'agent'. Anything else (including missing)
 * is treated as 'guest' which has no admin access.
 */

export const ADMIN_ROLES = Object.freeze({
  ADMIN: "admin",
  MANAGER: "manager",
  AGENT: "agent",
});

export const ALL_ADMIN_ROLES = Object.values(ADMIN_ROLES);

export function getUserRoles(user) {
  if (!user) return [];
  const collected = [];
  if (Array.isArray(user.roles)) collected.push(...user.roles);
  if (typeof user.role === "string") collected.push(user.role);
  return collected
    .filter(Boolean)
    .map((r) => String(r).toLowerCase().trim());
}

export function getPrimaryRole(user) {
  const roles = getUserRoles(user);
  if (roles.includes(ADMIN_ROLES.ADMIN)) return ADMIN_ROLES.ADMIN;
  if (roles.includes(ADMIN_ROLES.MANAGER)) return ADMIN_ROLES.MANAGER;
  if (roles.includes(ADMIN_ROLES.AGENT)) return ADMIN_ROLES.AGENT;
  return roles[0] || "guest";
}

export function userHasRole(user, allowed) {
  if (!allowed || allowed.length === 0) return true;
  const roles = getUserRoles(user);
  if (roles.length === 0) return false;
  const allowedSet = new Set(allowed.map((r) => String(r).toLowerCase()));
  return roles.some((role) => allowedSet.has(role));
}

export function isAdminUser(user) {
  return userHasRole(user, ALL_ADMIN_ROLES);
}
