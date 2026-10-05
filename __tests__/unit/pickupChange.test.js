/**
 * "Customer pickup location updated" with the same address in both rows.
 *
 * Production: booking TRG-07915925-2026-07 (Travio Ghana, travel 2026-10-06)
 * was created at 13:45:15 with a pickup of "Somewhere Nice, 9 Cotton Avenue,
 * Accra, Ghana". The customer re-saved that same pickup at 13:45:42 — 27
 * seconds later, while still on the confirmation screen — and both endpoints
 * mailed their "…has changed" notice unconditionally, comparing nothing:
 *
 *   storefront.js    updateMyPickup  → supplier-pickup-updated  (to supplier)
 *   bookingController updatePickup    → pickup-details-updated   (to customer)
 *
 * The second gate was `pickupFieldsProvided`, which only records that a form
 * was submitted. Both templates are titled "… has changed" and set the previous
 * value struck through beside the new one, so the mail asserted something false
 * and asked the supplier to redo their guide, driver and vehicle schedule for a
 * location that never moved.
 *
 * These tests pin the comparison itself, the fields it deliberately ignores,
 * and the two call-site decisions that now depend on it.
 */
const fs = require('fs');
const path = require('path');
const { pickupChange, comparable } = require('../../src/core/services/pickupChange');

const SRC = path.join(__dirname, '..', '..', 'src');

// The exact pickup stored on TRG-07915925-2026-07, read from production.
const PRODUCTION_PICKUP = {
  mode: 'area',
  time: '',
  status: 'selected',
  address: {
    lat: 5.5774962,
    lng: -0.2060028,
    name: 'Somewhere Nice, 9 Cotton Avenue, Accra, Ghana',
    address: 'Somewhere Nice, 9 Cotton Avenue, Accra, Ghana',
  },
  areaName: 'Cantonments, La',
  pickupLater: false,
  instructions: '',
};

const ADDRESS = 'Somewhere Nice, 9 Cotton Avenue, Accra, Ghana';

describe('re-saving the pickup already on the booking is not a change', () => {
  it('reports no change for the production snapshot against itself', () => {
    const result = pickupChange(PRODUCTION_PICKUP, { ...PRODUCTION_PICKUP });
    expect(result.changed).toBe(false);
  });

  it('would have produced two identical rows — the mail the supplier received', () => {
    const result = pickupChange(PRODUCTION_PICKUP, { ...PRODUCTION_PICKUP });
    // The defect, stated as an assertion: nothing differed, so the
    // "Previous location" and "New location" rows were the same string.
    expect(result.previousPickupLocation).toBe(ADDRESS);
    expect(result.pickupLocation).toBe(ADDRESS);
    expect(result.previousPickupLocation).toBe(result.pickupLocation);
  });

  it('ignores the null vs empty-string difference a re-save introduces', () => {
    const resaved = { ...PRODUCTION_PICKUP, instructions: undefined, time: undefined };
    expect(pickupChange(PRODUCTION_PICKUP, resaved).changed).toBe(false);
  });

  it('treats the JSON string form and the object form as the same pickup', () => {
    expect(pickupChange(JSON.stringify(PRODUCTION_PICKUP), PRODUCTION_PICKUP).changed).toBe(false);
  });

  it('does not throw on absent or unparseable snapshots', () => {
    expect(() => pickupChange(null, undefined)).not.toThrow();
    expect(() => pickupChange('{not json', { mode: 'area' })).not.toThrow();
    expect(pickupChange(null, null).changed).toBe(false);
  });
});

describe('a pickup that genuinely moved is still announced', () => {
  it('detects a different address', () => {
    const next = {
      ...PRODUCTION_PICKUP,
      address: { lat: 5.6, lng: -0.19, name: 'Osu Castle, Accra, Ghana', address: 'Osu Castle, Accra, Ghana' },
    };
    const result = pickupChange(PRODUCTION_PICKUP, next);
    expect(result.changed).toBe(true);
    expect(result.previousPickupLocation).toBe(ADDRESS);
    expect(result.pickupLocation).toBe('Osu Castle, Accra, Ghana');
  });

  it('detects a move of the coordinates alone', () => {
    // Same label, different pin: the guide still has to drive somewhere else.
    const next = {
      ...PRODUCTION_PICKUP,
      address: { ...PRODUCTION_PICKUP.address, lat: 5.6123456, lng: -0.2345678 },
    };
    expect(pickupChange(PRODUCTION_PICKUP, next).changed).toBe(true);
  });

  it.each([
    ['a different area', { areaName: 'Osu, Accra' }],
    ['a different mode', { mode: 'address' }],
    ['a requested time', { time: '07:30' }],
    ['new instructions', { instructions: 'Ring the bell twice' }],
    ['the customer naming a place', { place: 'Fuel station' }],
    ['the customer naming a location', { locationName: 'Main gate' }],
    ['the customer deferring', { pickupLater: true }],
  ])('detects %s', (_label, patch) => {
    expect(pickupChange(PRODUCTION_PICKUP, { ...PRODUCTION_PICKUP, ...patch }).changed).toBe(true);
  });

  it('detects a customer filling in a previously deferred pickup', () => {
    const deferred = {
      mode: 'area', pickupLater: true, status: 'deferred', areaName: '', address: null,
      time: '', instructions: '',
    };
    expect(pickupChange(deferred, PRODUCTION_PICKUP).changed).toBe(true);
  });
});

describe('bookkeeping does not masquerade as a change', () => {
  it('ignores the updatedAt/updatedBy both endpoints stamp on every save', () => {
    const stamped = {
      ...PRODUCTION_PICKUP,
      updatedBy: 'supplier-user-42',
      updatedAt: new Date().toISOString(),
    };
    expect(pickupChange(PRODUCTION_PICKUP, stamped).changed).toBe(false);
  });

  it('ignores status, which is platform-derived rather than a move', () => {
    // The supplier endpoint always writes status:'confirmed' and pickupLater:false.
    // Folding status in would make a customer re-saving their own unchanged
    // pickup read as a change, which is the defect under test.
    const confirmed = { ...PRODUCTION_PICKUP, status: 'confirmed' };
    expect(pickupChange(PRODUCTION_PICKUP, confirmed).changed).toBe(false);
  });

  it('still notices a real pickupLater change alongside the stamp', () => {
    const deferred = { ...PRODUCTION_PICKUP, pickupLater: true, updatedAt: new Date().toISOString() };
    expect(pickupChange(PRODUCTION_PICKUP, deferred).changed).toBe(true);
  });

  it('ignores coordinate float noise far below any real move', () => {
    const noisy = {
      ...PRODUCTION_PICKUP,
      address: { ...PRODUCTION_PICKUP.address, lat: PRODUCTION_PICKUP.address.lat + 1e-9 },
    };
    expect(pickupChange(PRODUCTION_PICKUP, noisy).changed).toBe(false);
  });
});

describe('comparable is stable regardless of key order', () => {
  it('produces one canonical string per pickup', () => {
    const reordered = {
      instructions: '',
      pickupLater: false,
      areaName: 'Cantonments, La',
      address: PRODUCTION_PICKUP.address,
      mode: 'area',
      time: '',
    };
    expect(comparable(reordered)).toBe(comparable(PRODUCTION_PICKUP));
  });
});

describe('both pickup endpoints gate the notice on the comparison', () => {
  const storefront = fs.readFileSync(path.join(SRC, 'core', 'storefront.js'), 'utf-8');
  const bookingController = fs.readFileSync(path.join(SRC, 'core', 'domain', 'bookingController.js'), 'utf-8');

  it('the customer endpoint decides from pickupChange, not from a bare save', () => {
    expect(storefront).toMatch(/const\s*\{\s*changed,\s*previousPickupLocation\s*\}\s*=\s*pickupChange\(/);
    expect(storefront).toMatch(/if\s*\(changed\)\s*\{[\s\S]{0,900}type:\s*'supplier-pickup-updated'/);
  });

  it('the supplier endpoint no longer treats "a form was sent" as a change', () => {
    expect(bookingController).toMatch(/if\s*\(pickupChangeResult\s*&&\s*pickupChangeResult\.changed\)\s*\{/);
    expect(bookingController).toMatch(/if\s*\(pickupChangeResult\s*&&\s*pickupChangeResult\.changed\)\s*\{[\s\S]{0,900}type:\s*'pickup-details-updated'/);
    // The old, content-free gate must be gone from the notification block.
    expect(bookingController).not.toMatch(/if\s*\(pickupFieldsProvided\)\s*\{\s*enqueueNotification/);
  });

  it('imports the helper in both files', () => {
    expect(storefront).toMatch(/require\('\.\/services\/pickupChange'\)/);
    expect(bookingController).toMatch(/require\('\.\.\/services\/pickupChange'\)/);
  });
});