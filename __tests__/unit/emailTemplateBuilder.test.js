const fs = require('fs');
const path = require('path');
const B = require('../../scripts/emailTemplateBuilder');

/**
 * Mobile button layout contract.
 *
 * The "Write a review" CTA shipped as a 91x74px block with the label broken
 * across three lines ("Write" / "a" / "review") at a 320px viewport — the
 * Gmail-on-Android width. Root cause: `buttons()` emitted its wrapper table
 * with no class, so the mobile `.btn-wrap` rules were dead CSS, and the only
 * rule that did apply (`.btn { width:100% }`) resolved against a shrink-to-fit
 * <td> — i.e. 100% of the label's own width.
 *
 * These assertions pin both halves of the fix: the markup must carry the hook,
 * and the stylesheet must make the hook mean something.
 */
const GENERATED_DIR = path.join(__dirname, '..', '..', 'sendgrid-templates', 'generated');

describe('email template button wrapper', () => {
  const built = B.buttons([
    { label: 'Write a review', href: '{{reviewUrl}}' },
    { label: 'Explore more experiences', href: '{{browseUrl}}', kind: 'secondary' },
  ]);

  it('tags the wrapper table so the mobile rules can reach it', () => {
    // Regression guard: an unclassed wrapper is exactly what shipped broken.
    expect(built).toMatch(/<table[^>]*class="btn-wrap"/);
  });

  it('still keeps every button addressable inside one row on desktop', () => {
    expect(built).toMatch(/<a href="\{\{reviewUrl\}\}" class="btn"/);
    expect(built).toMatch(/<a href="\{\{browseUrl\}\}" class="btn"/);
    // Both buttons share the one inner row — stacking is a mobile-only concern.
    const innerRow = built.match(/<tr>(\s*<td style="padding:0 8px 0 0;vertical-align:middle;">[\s\S]*?)<\/td><\/tr>/);
    expect(innerRow).not.toBeNull();
    expect((innerRow[1].match(/class="btn"/g) || []).length).toBe(2);
  });

  it('gives .btn-wrap cells a full-width block layout under 640px', () => {
    const shell = B.shell('Subject', built);
    // Without a rule making the <td> full width, `.btn { width:100% }` still
    // collapses to the label width and the CTA wraps.
    expect(shell).toMatch(/\.btn-wrap td \{[^}]*display:block !important/);
    expect(shell).toMatch(/\.btn-wrap td \{[^}]*width:100% !important/);
  });

  it('blockifies the row-group and row too, not just the table', () => {
    // Blockifying only <table> leaves <tr> as a table-row, so the engine
    // wraps it in a shrink-to-fit anonymous table and `width:100%` resolves
    // against that — buttons land at ~172px inside a 234px wrapper instead
    // of filling it. Verified against booking-confirmed.html at 320px.
    const shell = B.shell('Subject', built);
    expect(shell).toMatch(/\.btn-wrap, \.btn-wrap tbody, \.btn-wrap tr \{[^}]*display:block !important/);
    expect(shell).toMatch(/\.btn-wrap, \.btn-wrap tbody, \.btn-wrap tr \{[^}]*width:100% !important/);
  });

  it('trims horizontal button padding on mobile so long labels stay on one line', () => {
    // buttonPrimary uses padding:14px 34px; at full width that leaves ~171px
    // of content box, which wrapped "Review payment details" onto two lines.
    const shell = B.shell('Subject', built);
    expect(shell).toMatch(/\.btn \{[^}]*padding-left:16px !important/);
    expect(shell).toMatch(/\.btn \{[^}]*padding-right:16px !important/);
  });
});

describe('generated email templates', () => {
  const files = fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith('.html'));

  it('has generated templates to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every multi-button template has a class="btn-wrap" wrapper', () => {
    // The build artifacts are what SendGrid actually sends, so the contract
    // has to hold there and not just in the builder. Single-button templates
    // go through buttonPrimary(), whose table is already width="100%".
    const offenders = [];
    for (const file of files) {
      const html = fs.readFileSync(path.join(GENERATED_DIR, file), 'utf8');
      if (!html.includes('class="btn"')) continue;
      if (!html.includes('class="btn-wrap"')) {
        // Only a group layout needs the hook; a lone full-width button does not.
        const buttonsInOneTable = /<table[^>]*width="100%"[^>]*>\s*<tr>\s*<td align="center">/.test(html);
        if (!buttonsInOneTable) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the review-request CTA points at a templated URL, not a literal one', () => {
    const html = fs.readFileSync(path.join(GENERATED_DIR, 'review-request.html'), 'utf8');
    const primary = html.match(/<a href="([^"]+)" class="btn"[^>]*>Write a review<\/a>/);
    expect(primary).not.toBeNull();
    expect(primary[1]).toBe('{{reviewUrl}}');
  });
});

describe('pay-later-charged template renders pickup section', () => {
  it('includes Pickup & meeting section with pickupLocation field', () => {
    const html = fs.readFileSync(path.join(GENERATED_DIR, 'pay-later-charged.html'), 'utf8');
    expect(html).toMatch(/Pickup\s*&\s*meeting/);
    expect(html).toMatch(/pickupIncludedLabel/);
    expect(html).toMatch(/pickupLocation/);
  });
});

describe('statGrid — Key facts tiles', () => {
  const built = B.statGrid([
    { icon: 'calendar', label: 'Date', value: '{{dateLabel}}', tint: '#E6F6F0', color: '#007A4D' },
    { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tint: '#EFF6FF', color: '#1D4ED8' },
    { icon: 'duration', label: 'Duration', value: '{{durationLabel}}', tint: '#FFFBEB', color: '#B45309' },
    { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tint: '#EEF2F7', color: '#001F3F' },
  ]);

  it('uses hosted PNG icons instead of inline SVG so Gmail and Outlook render them', () => {
    // Gmail/Outlook strip <svg>; the tiles must reference the Cloudinary PNGs.
    expect((built.match(/<img src="/g) || []).length).toBe(4);
    for (const name of ['calendar', 'clock', 'duration', 'users']) {
      expect(built).toContain(B.EMAIL_ICON_URLS[name]);
      expect(B.EMAIL_ICON_URLS[name]).toMatch(/res\.cloudinary\.com/);
      expect(B.EMAIL_ICON_URLS[name]).toContain('f_png');
    }
    // Keeps an img slot that cannot shift layout, and the white glyph is on a
    // transparent background so it sits on the accent badge.
    expect(built).toMatch(/alt=""/);
    expect(built).toMatch(/width="20" height="20"/);
  });

  it('falls back to inline SVG for an icon that has no hosted URL', () => {
    const saved = B.EMAIL_ICON_URLS.clock;
    try {
      delete B.EMAIL_ICON_URLS.clock;
      const fallback = B.statGrid([{ icon: 'clock', label: 'Start time', value: '09:00' }]);
      expect(fallback).toContain('<svg ');
      expect(fallback).toContain(B.ICONS.clock);
      expect(fallback).not.toContain('<img src=');
    } finally {
      B.EMAIL_ICON_URLS.clock = saved;
    }
  });

  it('contains no emoji codepoints', () => {
    // Anything in the emoji planes (U+1F300–U+1FAFF) came from a hard-coded
    // 🗓 / 🕐 / ⏳ / 👥 in the old tiles.
    expect(/[\u{1F300}-\u{1FAFF}]/u.test(built)).toBe(false);
  });

  it('stacks to one column on mobile and keeps labels/values templated', () => {
    expect(built).toMatch(/class="stack-td"/);
    expect(built).toContain('{{dateLabel}}');
    expect(built).toContain('{{travelersLabel}}');
  });
});

describe('contactCard — customer avatar', () => {
  const built = B.contactCard({
    name: '{{customerName}}',
    email: '{{customerEmail}}',
    phone: '{{customerPhone}}',
    initials: '{{customerInitials}}',
  });

  it('prefers the Google profile photo and falls back to initials', () => {
    expect(built).toMatch(/\{\{#if customerAvatarUrl\}\}/);
    expect(built).toContain('{{customerAvatarUrl}}');
    expect(built).toMatch(/\{\{else\}\}[\s\S]*\{\{customerInitials\}\}[\s\S]*\{\{\/if\}\}/);
  });

  it('renders the avatar as a round image', () => {
    expect(built).toMatch(/border-radius:50%/);
  });
});

describe('generated templates are in sync with the builder', () => {
  const { TEMPLATE_DEFS } = require('../../scripts/buildEmailTemplates');

  it('regenerating every template reproduces the committed artifact byte-for-byte', () => {
    const drifted = [];
    for (const def of TEMPLATE_DEFS) {
      const file = path.join(GENERATED_DIR, `${def.key}.html`);
      if (!fs.existsSync(file)) {
        drifted.push(`${def.key} (missing)`);
        continue;
      }
      if (fs.readFileSync(file, 'utf8') !== def.build()) drifted.push(def.key);
    }
    expect(drifted).toEqual([]);
  });

  it('has no orphaned generated files without a template definition', () => {
    const definedKeys = new Set(TEMPLATE_DEFS.map((d) => `${d.key}.html`));
    const files = fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith('.html'));
    expect(files.filter((f) => !definedKeys.has(f))).toEqual([]);
  });
});