/**
 * Geographic helpers for pickup geoshapes (GetYourGuide-style service zones).
 *
 * A pickup geoshape is a closed polygon (ordered [lat, lng] vertices) that
 * defines where a supplier offers area-based pickup. Customers pick an
 * address at checkout; the address is valid only if it falls inside one of
 * the supplier's polygons and outside every exclusion zone. Areas saved as
 * a location point only (no drawn shape) match by proximity to that point.
 */

/**
 * Radius (meters) around a location-only area's saved point within which a
 * customer address counts as inside the area. Must match the customer app's
 * LOCATION_AREA_RADIUS_M (src/lib/pickupZone.ts) — server and client
 * verdicts must never disagree.
 */
const LOCATION_AREA_RADIUS_M = 1000;

/**
 * Ray-casting point-in-polygon test.
 * @param {number} lat
 * @param {number} lng
 * @param {Array<Array<number>>} polygon - ordered [lat, lng] vertices
 * @returns {boolean}
 */
function pointInPolygon(lat, lng, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [, lngI] = polygon[i];
    const [latI] = polygon[i];
    const [, lngJ] = polygon[j];
    const [latJ] = polygon[j];
    const intersect =
      latI > lat !== latJ > lat &&
      lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Haversine distance in meters between two points.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const NORMALIZE_NAME = (v) => String(v || '').trim().toLowerCase();

/**
 * Resolve whether an address falls inside any area of a geoshape and outside
 * all of its exclusion zones.
 * @param {{ lat: number, lng: number }} address
 * @param {Array<{ name: string, polygon?: Array, exclusions?: Array }>} pickupAreas
 * @returns {object|null} matching area, or null when no area matches
 */
function findPickupAreaForAddress(address, pickupAreas) {
  if (!Array.isArray(pickupAreas) || !address || !Number.isFinite(address.lat) || !Number.isFinite(address.lng)) {
    return null;
  }

  for (const area of pickupAreas) {
    const polygon = Array.isArray(area.polygon) ? area.polygon : null;
    const hasShape = !!polygon && polygon.length >= 3;

    if (!hasShape) {
      // Radius-based or legacy area without a drawn geoshape: match the saved
      // location point by proximity using the per-area radiusKm (converted to
      // meters), falling back to the default LOCATION_AREA_RADIUS_M for legacy
      // areas that don't have radiusKm set.
      const radiusM = Number.isFinite(area.radiusKm) ? area.radiusKm * 1000 : LOCATION_AREA_RADIUS_M;
      if (
        Number.isFinite(area.lat) &&
        Number.isFinite(area.lng) &&
        distanceMeters(address.lat, address.lng, area.lat, area.lng) <= radiusM
      ) {
        return area;
      }
      if (NORMALIZE_NAME(address.name) === NORMALIZE_NAME(area.name)) return area;
      continue;
    }

    if (!pointInPolygon(address.lat, address.lng, polygon)) continue;

    // Inside the service zone — reject addresses inside any exclusion zone.
    const excludedBy = (area.exclusions || []).find(
      (exclusion) => Array.isArray(exclusion) && pointInPolygon(address.lat, address.lng, exclusion)
    );
    if (excludedBy) return { ...area, _excluded: true };

    return area;
  }

  return null;
}

/**
 * Validate + normalize a customer pickup selection against the tour's pickup
 * configuration (the `bookingAndTickets` JSON blob).
 *
 * @param {object} selection - from checkout body: `{ mode, areaName, locationName, address, time, instructions }`
 * @param {object} pickupConfig - `{ pickupType, pickupAreas, pickupLocations }`
 * @returns {{ ok: true, pickup: object } | { ok: false, error: string }}
 */
function resolvePickupSelection(selection, pickupConfig = {}) {
  if (!selection || typeof selection !== 'object') {
    return { ok: true, pickup: null };
  }

  const config = pickupConfig && typeof pickupConfig === 'object' ? pickupConfig : {};
  const pickupType = config.pickupType || 'area';
  const skipValidation = !!selection.skipValidation;
  const mode = selection.mode || pickupType;
  const requestedArea = NORMALIZE_NAME(selection.areaName);
  const requestedLocation = NORMALIZE_NAME(selection.locationName);
  const address = selection.address && typeof selection.address === 'object' ? selection.address : null;

  // ---- Area-based pickup -------------------------------------------------
  if (mode === 'area') {
    const areas = Array.isArray(config.pickupAreas) ? config.pickupAreas : [];
    if (areas.length === 0) {
      // No zones configured yet — accept gracefully so the booking isn't
      // blocked. The supplier can collect pickup details after booking.
      if (!address && !requestedArea) {
        return { ok: true, pickup: null };
      }
      return { ok: false, error: 'This tour does not offer pickup at this time' };
    }

    let area = null;
    if (address) {
      const found = findPickupAreaForAddress(address, areas);
      if (found && found._excluded) {
        return { ok: false, error: 'Pickup is not available at the provided address (outside the pickup zone)' };
      }
      if (found) {
        area = found;
      } else if (!skipValidation && requestedArea) {
        area = areas.find((a) => NORMALIZE_NAME(a.name) === requestedArea) || null;
      }
    } else if (requestedArea) {
      area = areas.find((a) => NORMALIZE_NAME(a.name) === requestedArea) || null;
    }

    if (!area && !skipValidation) {
      return { ok: false, error: 'Pickup is not available at the provided address' };
    }

    const time = (selection.time && String(selection.time)) || area?.time || '';
    return {
      ok: true,
      pickup: {
        mode: 'area',
        ...(skipValidation ? { pickupLater: true } : {}),
        areaName: area ? area.name : (selection.areaName || ''),
        address: address || null,
        time,
        instructions: selection.instructions || '',
      },
    };
  }

  // ---- Pickup location list ----------------------------------------------
  const locations = Array.isArray(config.pickupLocations) ? config.pickupLocations : [];
  if (locations.length === 0) {
    // No pickup points configured — accept gracefully so the booking isn't
    // blocked. The supplier can collect pickup details after booking.
    if (!address && !requestedLocation) {
      return { ok: true, pickup: null };
    }
    return { ok: false, error: 'This tour does not offer pickup at this time' };
  }

  let location = null;
  if (requestedLocation) {
    location = locations.find((l) => NORMALIZE_NAME(l.name) === requestedLocation) || null;
  }
  if (!location && address && Number.isFinite(address.lat) && Number.isFinite(address.lng)) {
    // Allow a nearby match (~200 m) for autocomplete-sourced addresses.
    const match = locations.find(
      (l) => Number.isFinite(l.lat) && Number.isFinite(l.lng) &&
        distanceMeters(address.lat, address.lng, l.lat, l.lng) <= 200
    );
    if (match) location = match;
  }
  if (!location && !skipValidation) {
    return { ok: false, error: 'Pickup location is not available for this tour' };
  }

  const time = (selection.time && String(selection.time)) || location?.pickupTime || '';
  return {
    ok: true,
    pickup: {
      mode: 'address',
      ...(skipValidation ? { pickupLater: true } : {}),
      locationName: location ? location.name : (selection.locationName || ''),
      address: address || null,
      time,
      instructions: selection.instructions || '',
    },
  };
}

/**
 * True when a booking's stored pickup still matches the tour's current
 * pickup configuration (used when supplier edits a booking's pickup).
 */
function isPickupBookable(pickup, pickupConfig = {}) {
  if (!pickup || typeof pickup !== 'object') return false;
  return resolvePickupSelection(
    {
      mode: pickup.mode,
      areaName: pickup.areaName,
      locationName: pickup.locationName,
      address: pickup.address,
    },
    pickupConfig
  ).ok;
}

/**
 * Canonical pickup state for a stored booking snapshot. One source of truth
 * so every consumer (planner, reminders, storefront, dashboard) agrees.
 *  - 'deferred'  — customer chose "pickup later" (no pickup location yet)
 *  - 'selected'  — customer picked a zone/address; supplier hasn't confirmed
 *  - 'confirmed' — supplier has set pickup time and/or place
 */
function pickupStatus(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'deferred';
  if (snapshot.pickupLater || snapshot.skipValidation) return 'deferred';

  const hasPlace = !!(snapshot.place && String(snapshot.place).trim());
  const hasAddress = !!(
    snapshot.address &&
    typeof snapshot.address === 'object' &&
    (snapshot.address.name || snapshot.address.address)
  );
  const hasLocation = !!(
    snapshot.areaName ||
    snapshot.locationName ||
    hasAddress ||
    (Number.isFinite(snapshot.lat) && Number.isFinite(snapshot.lng))
  );

  if ((hasPlace || snapshot.updatedBy) && (snapshot.time || hasLocation)) return 'confirmed';
  if (hasLocation && snapshot.time) return 'confirmed';
  if (hasLocation) return 'selected';
  return 'deferred';
}

/**
 * True when a booking's pickup still needs operator attention: no pickup
 * location, or no confirmed time, or no instructions. Mirrors the supplier
 * dashboard's client-side completeness rule so the API and UI agree.
 */
function isPickupIncomplete(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return true;
  const hasLocation = !!(
    snapshot.areaName ||
    snapshot.locationName ||
    snapshot.place ||
    (snapshot.address &&
      typeof snapshot.address === 'object' &&
      (snapshot.address.name || snapshot.address.address)) ||
    (Number.isFinite(snapshot.lat) && Number.isFinite(snapshot.lng))
  );
  return !hasLocation || !snapshot.time || !snapshot.instructions;
}

/**
 * Normalize a raw checkout pickup selection into the canonical snapshot with a
 * `status`. Re-resolves against the tour's current config so the stored
 * snapshot is always validated + normalized (the same code path as
 * confirmBooking and the materialize webhook). If re-resolution fails (e.g.
 * the supplier changed the pickup config after booking) it degrades gracefully
 * to `deferred` so a booking is never blocked.
 *
 * @param {object|null} selection - raw checkout selection ({ mode, areaName, locationName, address, skipValidation })
 * @param {object} pickupConfig - tour pickup config ({ pickupType, pickupAreas, pickupLocations })
 * @param {{ forceConfirmed?: boolean }} [options]
 * @returns {object|null} canonical snapshot, or null when no pickup selection
 */
function normalizePickupSnapshot(selection, pickupConfig = {}, options = {}) {
  if (!selection || typeof selection !== 'object') return null;

  const result = resolvePickupSelection(selection, pickupConfig);
  if (!result.ok) {
    const mode = (pickupConfig && (pickupConfig.pickupType || 'area')) || 'area';
    return { mode, pickupLater: true, status: 'deferred', areaName: '', address: null, time: '', instructions: '' };
  }

  const p = result.pickup;
  if (!p) return null;

  const snapshot = { ...p, pickupLater: !!p.pickupLater };
  return { ...snapshot, status: options.forceConfirmed ? 'confirmed' : pickupStatus(snapshot) };
}

module.exports = {
  LOCATION_AREA_RADIUS_M,
  pointInPolygon,
  distanceMeters,
  findPickupAreaForAddress,
  resolvePickupSelection,
  isPickupBookable,
  pickupStatus,
  isPickupIncomplete,
  normalizePickupSnapshot,
};