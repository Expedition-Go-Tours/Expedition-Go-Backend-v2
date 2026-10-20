/**
 * Customer refund + supplier payout emails — the GetYourGuide/Viator-grade
 * redesign.
 *
 * These templates moved from a plain centred hero + flat label/value card to a
 * photo media header, a booking-code bar, a lifecycle status rail and a money
 * panel that makes the amount the loudest thing on the page. These tests pin
 * the parts easy to regress: the header degrades without a photo (and ships the
 * Outlook VML fallback), the amount is emphasised as a total row, optional
 * references stay guarded so no dangling label renders, and the copy stays free
 * of em dashes and emoji.
 *
 * The compiled artifacts are what the send path actually delivers, so the
 * assertions run against sendgrid-templates/generated/<key>.html directly.
 */

const fs = require('fs');
const path = require('path');

const GENERATED = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');
const art = (key) => fs.readFileSync(path.join(GENERATED, `${key}.html`), 'utf8');

const KEYS = [
  'refund-processing',
  'refund-completed',
  'supplier-payout-scheduled',
  'supplier-payout-completed',
  'supplier-payout-failed',
];

describe('refund & payout emails — shared redesign', () => {
  it.each(KEYS)('%s leads with a photo media header that degrades gracefully', (key) => {
    const html = art(key);
    expect(html).toContain('{{#if tourImageUrl}} background="{{tourImageUrl}}"{{/if}}');
    // No CSS url() anywhere — Gmail rewrites or strips it (caniemail #343/#395)
    expect(html).not.toContain("url('");
    // Outlook gets the VML fallback the media header ships with.
    expect(html).toContain('v:rect');
  });

  it.each(KEYS)('%s carries a booking reference bar', (key) => {
    expect(art(key)).toMatch(/Ref<\/span>/);
  });

  // A lifecycle rail shows the happy path; the failure email deliberately uses
  // a "What to do next" step list instead (there is no red rail state).
  it.each(KEYS.filter((k) => k !== 'supplier-payout-failed'))('%s carries a lifecycle status rail', (key) => {
    // statusStrip draws a 4px progress bar per step.
    expect(art(key)).toMatch(/height:4px;background-color:/);
  });

  it.each(KEYS)('%s contains no em dashes', (key) => {
    expect(art(key)).not.toContain('\u2014');
  });

  it.each(KEYS)('%s contains no emoji codepoints', (key) => {
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(art(key))).toBe(false);
  });
});

describe('refund-completed — required booking context', () => {
  const html = art('refund-completed');

  it('shows the booking reference prominently in the reference bar', () => {
    expect(html).toMatch(/Ref<\/span>/);
    expect(html).toContain('{{bookingNumber}}');
  });

  it('names the lead traveller', () => {
    expect(html).toContain('Lead traveller');
    expect(html).toContain('{{leadTravelerName}}');
  });

  it('emphasises the refund amount as the total row', () => {
    expect(html).toContain('{{refundAmountLabel}}');
    expect(html).toContain('font-size:16px;font-weight:800;');
  });

  it('guards the optional refund reference so it cannot render blank', () => {
    expect(html).toContain('{{#if refundReference}}');
  });
});

describe('refund-processing — in-flight framing', () => {
  const html = art('refund-processing');

  it('shows the amount and a processing status', () => {
    expect(html).toContain('{{refundAmountLabel}}');
    expect(html).toContain('Processing');
  });
});

describe('supplier payouts — money panel and guarded rows', () => {
  it('scheduled and completed expose a payout panel with the amount as the total', () => {
    for (const key of ['supplier-payout-scheduled', 'supplier-payout-completed']) {
      const html = art(key);
      expect(html).toContain('{{payoutAmountLabel}}');
      // payoutPanel: navy surface with the large total underneath the rows.
      expect(html).toContain('background-color:#001F3F;border-radius:14px');
      expect(html).toContain('{{#if payoutReference}}');
      expect(html).toContain('{{#if paymentDestination}}');
      expect(html).toContain('{{#if payoutDateLabel}}');
    }
  });

  it('failed guards the reason and offers concrete next steps', () => {
    const html = art('supplier-payout-failed');
    expect(html).toContain('{{#if payoutReason}}');
    expect(html).toContain('Reason:');
    expect(html).toContain('What to do next');
    expect(html).toContain('Review payout details');
  });
});
