/**
 * Did a pickup update actually change anything the recipient must act on?
 *
 * Both pickup-update endpoints used to fire their "pickup information has
 * changed" email on every accepted save, comparing nothing before or after. A
 * customer who re-submitted the pickup they had just chosen at checkout
 * therefore mailed the supplier a notice whose "Previous location" and "New
 * location" rows were byte-identical. Production case TRG-07915925-2026-07:
 * created 13:45:15, pickup re-saved 13:45:42, both rows "Somewhere Nice,
 * 9 Cotton Avenue, Accra, Ghana".
 *
 * That is not merely a redundant mail. Both templates are titled "… has
 * changed" and set the previous value struck through beside the new one, so an
 * unchanged save asserts something false and asks the supplier to redo their
 * guide, driver and vehicle schedule for a location that never moved.
 *
 * The comparison covers what the recipient is asked to act on: the address (its
 * label and its coordinates), the area or place it sits in, the pickup mode,
 * the requested time, the instructions, and whether the customer deferred.
 *
 * Two groups are deliberately excluded:
 *
 *   - the bookkeeping both endpoints stamp on every save (`updatedAt`,
 *     `updatedBy`) — including these would make every save look like a change;
 *   - `status`, which is platform-derived and flips when a supplier confirms a
 *     pickup rather than when anyone moves it. Including it would make a
 *     customer re-saving their own unchanged pickup read as a change, which is
 *     exactly the defect above.
 *
 * A saved pickup still gets written either way — this only governs whether the
 * change is announced.
 */
const { pickupAddressLabel } = require('./emailFormatting');

/** Accept the JSON column in either its object or string form. */
function parsePickup(pickupLike) {
  if (pickupLike === null || pickupLike === undefined) return {};
  if (typeof pickupLike === 'string') {
    try {
      const parsed = JSON.parse(pickupLike);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof pickupLike === 'object' ? pickupLike : {};
}

const text = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * Coordinates survive JSON round-trips and geocoding with float noise. Compare
 * them far finer than any real pickup move (~0.1 m at 6 dp) but coarsely
 * enough to ignore pure representation differences.
 */
const coord = (value) => {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6) : '';
};

/**
 * The canonical address point plus any *different* legacy top-level pin.
 * Deduping the root copy means a supplier save that mirrors the same point to
 * both places is not reported as a move, while a genuinely different top-level
 * pin still is. Keeping the canonical pair separate (rather than in one set)
 * means swapping the address and top-level points is still a change.
 */
function coordinateSignature(pickup) {
  const address = pickup.address && typeof pickup.address === 'object' ? pickup.address : {};
  const pair = (lat, lng) => {
    const a = coord(lat);
    const b = coord(lng);
    return a && b ? `${a},${b}` : '';
  };
  const addressPair = pair(address.lat, address.lng);
  const rootPair = pair(pickup.lat, pickup.lng);
  return {
    address: addressPair,
    root: rootPair && rootPair !== addressPair ? rootPair : '',
  };
}

/** Canonical form of the announcement-relevant fields. */
function comparable(pickupLike) {
  const pickup = parsePickup(pickupLike);
  const address = pickup.address && typeof pickup.address === 'object' ? pickup.address : {};
  return JSON.stringify({
    mode: text(pickup.mode),
    pickupLater: !!pickup.pickupLater,
    time: text(pickup.time),
    areaName: text(pickup.areaName),
    place: text(pickup.place),
    locationName: text(pickup.locationName),
    instructions: text(pickup.instructions),
    name: text(address.name),
    address: text(address.address),
    // The supplier endpoint historically wrote the pin to the top-level
    // snapshot fields while leaving `address` untouched. Those writes are a
    // real move for the customer's map and must be announced too — otherwise
    // the dashboard said "customer notified" after a pin-only edit and no
    // notification was ever sent. Deduping identical pairs avoids a false
    // notice when a save mirrors the address point to the root.
    coords: coordinateSignature(pickup),
  });
}

/**
 * @param {object|string|null} previous pickup as stored before the update
 * @param {object|string|null} next     pickup as it will be stored after it
 * @returns {{changed: boolean, previousPickupLocation: string, pickupLocation: string}}
 */
function pickupChange(previous, next) {
  return {
    changed: comparable(previous) !== comparable(next),
    previousPickupLocation: pickupAddressLabel(previous),
    pickupLocation: pickupAddressLabel(next),
  };
}

module.exports = { comparable, pickupChange };