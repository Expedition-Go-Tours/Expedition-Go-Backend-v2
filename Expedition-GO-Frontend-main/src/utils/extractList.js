/**
 * Backend responses come in many shapes:
 *   - [item, item]
 *   - { data: [...] }
 *   - { data: { users: [...] } }
 *   - { items: [...] }
 *   - { users: [...] }, { bookings: [...] }
 *
 * `extractList` returns the first array we can find at the top level or one
 * nesting deep. Pass an explicit `keys` list to prefer specific fields.
 */
export function extractList(payload, keys) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = keys && keys.length ? keys : [];
  const fallbackKeys = ["data", "items", "results", "users", "bookings", "tours", "categories", "notifications"];

  for (const key of candidates) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === "object" && !Array.isArray(payload[key])) {
      return [payload[key]];
    }
  }

  for (const key of fallbackKeys) {
    if (Array.isArray(payload[key])) return payload[key];
    if (payload[key] && typeof payload[key] === "object") {
      if (payload[key]?.tour && typeof payload[key].tour === "object" && !Array.isArray(payload[key].tour)) {
        return [payload[key].tour];
      }
      if (payload[key]?.tours && typeof payload[key].tours === "object" && !Array.isArray(payload[key].tours)) {
        return [payload[key].tours];
      }
      for (const inner of fallbackKeys) {
        if (Array.isArray(payload[key]?.[inner])) return payload[key][inner];
      }
    }
  }

  if (payload.tour && typeof payload.tour === "object" && !Array.isArray(payload.tour)) return [payload.tour];
  if (payload?.data?.tour && typeof payload.data.tour === "object" && !Array.isArray(payload.data.tour)) {
    return [payload.data.tour];
  }

  return [];
}

/**
 * Returns the first numeric or string scalar field that matches one of `keys`
 * checking the payload as well as one level of nesting (e.g. `payload.data.total`).
 */
export function extractScalar(payload, keys, fallback = null) {
  if (!payload || typeof payload !== "object") return fallback;
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return payload[key];
  }
  for (const key of keys) {
    if (payload?.data && payload.data[key] !== undefined && payload.data[key] !== null) {
      return payload.data[key];
    }
  }
  return fallback;
}
