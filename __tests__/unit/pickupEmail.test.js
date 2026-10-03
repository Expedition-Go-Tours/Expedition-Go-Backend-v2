/**
 * Supplier "Pickup information has changed" email — blank "New location" row.
 *
 * A customer who picks "I don't know yet" at checkout sends
 * `{ skipValidation: true }`. resolvePickupSelection accepts it (ok:true), so
 * the controller's 400 guard never fires, and normalizePickupSnapshot stores
 * `{ pickupLater: true, areaName: '', address: null, status: 'deferred' }`.
 * pickupAddressLabel() then resolves to ''.
 *
 * Three defects turned that into a blank email reaching suppliers:
 *
 *   1. stripeHelpers queued supplier-pickup-updated on *every* payment
 *      success off a mere `if (booking.pickup)` truthiness check — a pickup
 *      object always exists, so the check said nothing about content. The two
 *      confirmation emails queued four lines above already render
 *      pickupLocation / pickupRequiredLabel, making it redundant as well as
 *      mis-worded (the headline claims something "has changed" when nothing
 *      has).
 *   2. The two "updated" templates gave {{previousPickupLocation}} a guard but
 *      left the *new* value's row unguarded, so an empty string rendered an
 *      empty cell. The other four templates that render pickupLocation all
 *      guard it — these two were the exceptions.
 *   3. The reservation-time sends tested `if (pickupSnapshot)` for truthiness
 *      rather than for an address, so pay-later bookings mailed it too.
 *
 * These tests pin the root cause, the render guard across every template that
 * uses the field, and the call-site decision.
 */
const fs = require('fs');
const path = require('path');
const { render } = require('../../src/core/services/emailRenderer');
const { pickupAddressLabel } = require('../../src/core/services/emailFormatting');
const { normalizePickupSnapshot } = require('../../src/core/services/geoUtils');

const GENERATED_DIR = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');

// The exact snapshot normalizePickupSnapshot produces for the "I don't know
// yet" path — matches what was found in production.
const DEFERRED_CONFIG = { pickupType: 'area', pickupAreas: [{ name: 'Osu', lat: 5.6, lng: -0.2 }] };
const deferredSnapshot = () => normalizePickupSnapshot({ skipValidation: true }, DEFERRED_CONFIG);
const settledSnapshot = () => normalizePickupSnapshot({ areaName: 'Osu' }, DEFERRED_CONFIG);

describe('a deferred pickup has no address to report', () => {
  it('normalizes to the production payload exactly', () => {
    expect(deferredSnapshot()).toEqual({
      mode: 'area',
      pickupLater: true,
      areaName: '',
      address: null,
      time: '',
      instructions: '',
      status: 'deferred',
    });
  });

  it('resolves to an empty address label', () => {
    // This is the blank: the snapshot is truthy, so every `if (pickup)`
    // guard passes, while the label has nothing in it.
    expect(pickupAddressLabel(deferredSnapshot())).toBe('');
  });

  it('resolves to a real label once the customer names an area', () => {
    expect(pickupAddressLabel(settledSnapshot())).toBe('Osu');
  });
});

describe('every template guards pickupLocation', () => {
  const templates = fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith('.html'));
  const guarded = templates.filter((f) =>
    fs.readFileSync(path.join(GENERATED_DIR, f), 'utf-8').includes('{{pickupLocation}}'),
  );

  it('finds the templates expected to carry the field', () => {
    // If this drops, a template was renamed/removed and the audit below is
    // silently testing fewer files than it claims to.
    expect(guarded.length).toBeGreaterThanOrEqual(6);
  });

  // Returns the innermost {{#if}} still open at `idx`, or null. Skipping a
  // {{/if}} is what makes "Previous location" not count as a guard for the
  // "New location" row that follows it — the exact bug.
  const openGuardAt = (source, idx) => {
    const stack = [];
    for (const t of source.slice(0, idx).matchAll(/\{\{(#if|\/if)([\s\S]*?)\}\}/g)) {
      if (t[1] === '#if') stack.push(`{{#if${t[2]}}}`);
      else stack.pop();
    }
    return stack.length ? stack[stack.length - 1] : null;
  };

  it.each(guarded)('%s renders the field inside its own if', (file) => {
    const source = fs.readFileSync(path.join(GENERATED_DIR, file), 'utf-8');
    const occurrences = [...source.matchAll(/\{\{pickupLocation\}\}/g)];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const m of occurrences) {
      expect(openGuardAt(source, m.index)).toBe('{{#if pickupLocation}}');
    }
  });
});

describe('the updated templates omit the row when the value is empty', () => {
  const cases = [
    ['supplier-pickup-updated', 'New location'],
    ['pickup-details-updated', 'New pickup location'],
  ];

  it.each(cases)('%s drops "%s" for an empty value', (key, label) => {
    const source = fs.readFileSync(path.join(GENERATED_DIR, `${key}.html`), 'utf-8');
    const html = render(source, { pickupLocation: '', previousPickupLocation: '' });
    // The bug: a label with no value beside it.
    expect(html).not.toContain(`>${label}<`);
    expect(html).not.toContain('Previous location');
  });

  it.each(cases)('%s still shows the value when there is one', (key, label) => {
    const source = fs.readFileSync(path.join(GENERATED_DIR, `${key}.html`), 'utf-8');
    const html = render(source, {
      pickupLocation: 'Osu Castle, Accra',
      previousPickupLocation: 'Cantonments, La',
    });
    expect(html).toContain(`>${label}<`);
    expect(html).toContain('Osu Castle, Accra');
    // A genuine edit still shows the old value struck out beside the new one.
    expect(html).toContain('Cantonments, La');
  });
});

describe('the payment path no longer queues the update email', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'core', 'services', 'stripeHelpers.js'),
    'utf-8',
  );

  it('never enqueues supplier-pickup-updated on settlement', () => {
    // The confirmation emails queued just above it already carry the pickup
    // data, so this send was pure duplication dressed up as a change notice.
    expect(source).not.toMatch(/enqueueEmail\(\s*\{\s*type:\s*'supplier-pickup-updated'/);
  });
});
