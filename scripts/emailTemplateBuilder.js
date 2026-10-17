/**
 * Email Template Builder — shared design system for every transactional email.
 *
 * Generates production-ready, responsive HTML for SendGrid dynamic templates
 * (Handlebars variables like {{var}}, {{#if}}, {{#each}}). Table-based so it
 * renders correctly in Outlook, Gmail, Apple Mail and every mobile client:
 *  - fluid, max-width 640px container
 *  - media queries that stack columns and widen buttons on small screens
 *  - MSO (Outlook) conditional comments for spacing compatibility
 *  - inline styles with class overrides for the major clients
 *
 * Each template is defined as { key, subject, build(data) } and compiled to a
 * complete HTML document in buildEmailTemplates.js.
 */

const COLORS = {
  bg: '#F8FAFC',
  card: '#FFFFFF',
  border: '#E2E8F0',
  navy: '#001F3F',
  body: '#334155',
  muted: '#475569',
  faint: '#64748B',
  accent: '#007A4D',
  accentDark: '#007A4D',
  accentSoft: '#E6F6F0',
  accentSoftBorder: '#B7E4D2',
  danger: '#B91C1C',
  dangerSoft: '#FEF2F2',
  warning: '#B45309',
  warningSoft: '#FFFBEB',
  info: '#1D4ED8',
  infoSoft: '#EFF6FF',
  navySoft: '#EEF2F7',
};

const FONT =
  "'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const BASE_CSS = `
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; background-color:${COLORS.bg}; }
  table, td { mso-table-lspace:0pt; mso-table-rspace:0pt; border-collapse:collapse; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  .font-main { font-family:${FONT}; }
  /* Key-facts tiles: two per row, or one spanning the full row when a grid
     ends on an odd tile. Widths are duplicated on the td's width attribute
     and inline styles because Outlook desktop ignores <style> entirely. */
  .kf-cell { width:50%; }
  .kf-cell-wide { width:100%; }
  @media only screen and (max-width:640px) {
    .container { width:100% !important; }
    .pad { padding-left:20px !important; padding-right:20px !important; }
    .pad-top { padding-top:28px !important; }
    .stack { display:block !important; width:100% !important; box-sizing:border-box !important; }
    .stack-td { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:left !important; }
    .btn { width:100% !important; display:block !important; text-align:center !important; box-sizing:border-box !important; padding-left:16px !important; padding-right:16px !important; }
    /* The button wrapper is a shrink-to-fit table, so the .btn width:100%
       rule alone resolves against a content-width cell and the label wraps
       onto three lines on a 320px phone. Collapsing the wrapper AND its
       row-group/row to blocks is required: blockifying only the <table>
       leaves the <tr> as a table-row, which the engine wraps in a
       shrink-to-fit anonymous table and width:100% resolves against that
       instead of the container. */
    .btn-wrap, .btn-wrap tbody, .btn-wrap tr { display:block !important; width:100% !important; }
    .btn-wrap td { display:block !important; width:100% !important; box-sizing:border-box !important; padding:0 0 8px 0 !important; }
    .h1 { font-size:24px !important; }
    .h2 { font-size:18px !important; }
    .body-lg { font-size:16px !important; }
    .hide-mobile { display:none !important; }
  }
  /* Dark mode.
     Clients that honour prefers-color-scheme (Apple Mail, Outlook.com, iOS
     Gmail) swap these classes. Every tinted surface and its matching text
     colour has a dark counterpart: a light background whose text flips light
     is unreadable, so the surface must move with the text. Clients that force
     colour inversion instead (some Android Gmail builds) simply ignore these
     and keep the already-legible light styling. */
  @media (prefers-color-scheme: dark) {
    .dm-bg { background-color:#0B1220 !important; }
    .dm-card { background-color:#111827 !important; border-color:#1F2937 !important; }
    .dm-surface { background-color:#111827 !important; border-color:#1F2937 !important; }
    .dm-chip { background-color:#1F2937 !important; color:#E5E7EB !important; }
    .dm-text { color:#E5E7EB !important; }
    .dm-muted { color:#9CA3AF !important; }
    .dm-accent { color:#34D399 !important; }
    .dm-info { color:#60A5FA !important; }
    .dm-warning { color:#FBBF24 !important; }
    .dm-danger { color:#F87171 !important; }
    /* Soft tinted surfaces (callouts, badges) */
    .dm-accent-soft { background-color:#0F2A22 !important; }
    .dm-info-soft { background-color:#101F33 !important; }
    .dm-warning-soft { background-color:#2A2110 !important; }
    .dm-danger-soft { background-color:#2A1414 !important; }
    .dm-navy-soft { background-color:#1F2937 !important; }
    /* Key-facts tiles: surface + its accent label */
    .dm-tile-green { background-color:#0F2A22 !important; }
    .dm-tile-blue { background-color:#101F33 !important; }
    .dm-tile-amber { background-color:#2A2110 !important; }
    .dm-tile-purple { background-color:#1E1733 !important; }
    .dm-label-green { color:#34D399 !important; }
    .dm-label-blue { color:#60A5FA !important; }
    .dm-label-amber { color:#FBBF24 !important; }
    .dm-label-purple { color:#C4B5FD !important; }
  }
`;

const HEAD_META = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
`;

/** Outlook conditional wrapper for spacing quirks. */
function msoSpacer(height) {
  return `<!--[if mso]><table role="presentation" width="100%"><tr><td style="height:${height}px;line-height:${height}px">&nbsp;</td></tr></table><![endif]--><div style="height:${height}px;line-height:${height}px;font-size:0">&nbsp;</div>`;
}

function spacer(height) {
  return `<div style="height:${height}px;line-height:${height}px;font-size:0">&nbsp;</div>`;
}

/**
 * The email shell. `bodyHtml` is rendered inside the white card.
 */
function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>${HEAD_META}<title>${title}</title>
<style>${BASE_CSS}</style>
</head>
<body class="dm-bg" style="margin:0;padding:0;background-color:${COLORS.bg};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${COLORS.bg}" class="dm-bg">
    <tr>
      <td align="center" style="padding:32px 16px;" class="pad">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="container" style="max-width:640px;">
          <!-- Preheader (hidden) -->
          <tr><td style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{{preheader}}</td></tr>
          <!-- Card -->
          <tr>
            <td class="dm-card" style="background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;padding:0;overflow:hidden;">
              <!-- Brand header: the logo lives INSIDE the card so the whole
                   email reads as one object, and is sized up from the old
                   170px so it holds its own against the 640px card. It carries
                   the card's top radius itself because overflow:hidden on a
                   <td> is not honoured everywhere. -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0;border-radius:16px 16px 0 0;">
                <tr>
                  <td align="center" style="padding:26px 24px 22px 24px;">
                    <img src="{{logoUrl}}" alt="{{brandName}}" width="220" style="display:block;width:220px;max-width:220px;height:auto;margin:0 auto;border:0;outline:none;">
                    {{#if poweredByLabel}}<div style="margin-top:12px;">
                      <span class="dm-accent-soft dm-accent" style="display:inline-block;font-family:${FONT};font-size:12px;font-weight:700;letter-spacing:0.3px;color:${COLORS.accent};background-color:${COLORS.accentSoft};border-radius:999px;padding:5px 14px;line-height:1;">{{poweredByLabel}}</span>
                    </div>{{/if}}
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                ${bodyHtml}
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:28px 20px 0 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" class="dm-muted" style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.6;padding:0 0 6px 0;">
                    Need help? <a href="mailto:{{supportEmail}}" class="dm-accent" style="color:${COLORS.accent};text-decoration:none;font-weight:600;">Contact support</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" class="dm-muted" style="font-family:${FONT};font-size:12px;color:${COLORS.muted};line-height:1.6;">
                    &copy; {{year}} {{brandName}}. All rights reserved.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Hero: heading + optional subtitle + optional status badge row.
 */
function hero({ heading, subtitle, badgeText, badgeColor = 'accent' }) {
  const badgeColors = {
    accent: { bg: COLORS.accentSoft, text: COLORS.accent, dmBg: 'dm-accent-soft', dmFg: 'dm-accent' },
    danger: { bg: COLORS.dangerSoft, text: COLORS.danger, dmBg: 'dm-danger-soft', dmFg: 'dm-danger' },
    warning: { bg: COLORS.warningSoft, text: COLORS.warning, dmBg: 'dm-warning-soft', dmFg: 'dm-warning' },
    info: { bg: COLORS.infoSoft, text: COLORS.info, dmBg: 'dm-info-soft', dmFg: 'dm-info' },
    navy: { bg: COLORS.navySoft, text: COLORS.navy, dmBg: 'dm-navy-soft', dmFg: 'dm-text' },
  };
  const bc = badgeColors[badgeColor] || badgeColors.accent;

  const badge = badgeText
    ? `<tr><td align="center" style="padding:${subtitle ? '8' : '0'}px 0 0 0;">
         <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
           <tr><td class="${bc.dmBg} ${bc.dmFg}" style="background-color:${bc.bg};border-radius:20px;padding:6px 16px;font-family:${FONT};font-size:13px;font-weight:700;color:${bc.text};line-height:1.2;">${badgeText}</td></tr>
         </table>
       </td></tr>`
    : '';

  return `
  <tr><td class="pad" style="padding:36px 40px 4px 40px;">
    <h1 class="h1 font-main dm-text" style="margin:0 0 12px 0;font-size:28px;font-weight:800;color:${COLORS.navy};line-height:1.25;text-align:center;">${heading}</h1>
    ${subtitle ? `<p class="body-lg font-main dm-text" style="margin:0 auto;max-width:480px;font-size:15px;color:${COLORS.body};line-height:1.6;text-align:center;">${subtitle}</p>` : ''}
  </td></tr>
  ${badge}`;
}

function sectionTitle(text) {
  return `
  <tr><td class="pad" style="padding:28px 40px 4px 40px;">
    <div class="h2 font-main dm-text" style="font-size:15px;font-weight:800;color:${COLORS.navy};letter-spacing:0.4px;text-transform:uppercase;line-height:1.3;">${text}</div>
  </td></tr>`;
}

/**
 * Label/value detail rows. Handles {{#if}} around optional values by taking a
 * conditional value function, or simply an array of {label, value, if}.
 */
function detailRows(rows, options = {}) {
  const { columns = 1 } = options;
  let html = '';
  for (const row of rows) {
    const cond = row.if === undefined ? true : row.if;
    if (cond === false) continue;

    // `if: '{{someVar}}'` means "show this row only when someVar has a value".
    // Extract the bare name so the whole row is wrapped in {{#if someVar}}.
    const ifMatch = typeof cond === 'string' && cond.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
    const rowConditional = row.conditional || (ifMatch ? ifMatch[1] : null);

    const valueStyle = row.strike
      ? `color:${COLORS.faint};text-decoration:line-through;`
      : `color:${COLORS.navy};`;
    const valueClass = row.strike ? 'dm-muted' : 'dm-text';

    const valueHtml = row.raw !== undefined
      ? row.raw
      : `<span class="${valueClass}" style="${valueStyle}font-weight:600;">${row.value || '&mdash;'}</span>`;

    // When the whole row is already gated by {{#if}}, the value renders plain.
    const value = rowConditional ? valueHtml : valueHtml;

    const rowHtml = `
      <tr>
        <td style="padding:7px 40px 7px 40px;" class="pad">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td class="dm-muted" style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.5;padding:0 12px 0 0;width:45%;vertical-align:top;">${row.label}</td>
              <td style="font-family:${FONT};font-size:14px;line-height:1.5;vertical-align:top;">${value}</td>
            </tr>
          </table>
        </td>
      </tr>`;

    // Optional rows disappear entirely when the value is empty, so emails
    // never show orphaned labels like "Meeting point: —".
    html += rowConditional ? `{{#if ${rowConditional}}}${rowHtml}{{/if}}` : rowHtml;
  }
  return html;
}

/**
 * A single rounded surface wrapping label/value rows. Same data contract as
 * detailRows (`{ label, value, if }`), but drawn as one card instead of
 * free-floating rows, so a group of related facts reads as a designed block.
 * The heading (if any) is rendered by the caller via sectionTitle.
 *
 * Optional rows use the same `if: '{{var}}'` guard as detailRows, so an empty
 * value drops the whole row rather than leaving a label with no value.
 */
function detailCard(rows, options = {}) {
  const { background = COLORS.bg } = options;
  let body = '';
  for (const row of rows) {
    const cond = row.if === undefined ? true : row.if;
    if (cond === false) continue;

    const ifMatch = typeof cond === 'string' && cond.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
    const rowConditional = row.conditional || (ifMatch ? ifMatch[1] : null);

    const valueHtml = row.raw !== undefined
      ? row.raw
      : `<span class="dm-text" style="color:${COLORS.navy};font-weight:600;">${row.value || '&mdash;'}</span>`;

    const rowHtml = `
      <tr>
        <td class="dm-muted" style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.5;padding:10px 18px;width:42%;vertical-align:top;border-bottom:1px solid ${COLORS.border};">${row.label}</td>
        <td style="font-family:${FONT};font-size:14px;line-height:1.5;padding:10px 18px;vertical-align:top;border-bottom:1px solid ${COLORS.border};">${valueHtml}</td>
      </tr>`;

    body += rowConditional ? `{{#if ${rowConditional}}}${rowHtml}{{/if}}` : rowHtml;
  }
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-card" style="background-color:${background};border:1px solid ${COLORS.border};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      ${body}
    </table>
  </td></tr>`;
}

/**
 * Before/after diff table (change emails). Renders header + {{#each changes}}.
 */
function diffTable() {
  return `
  {{#if changes}}
  <tr><td class="pad" style="padding:12px 40px 4px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-surface" style="border:1px solid ${COLORS.border};border-radius:10px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>
        <td class="dm-navy-soft dm-text" style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.navy};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:40%;">Detail</td>
        <td class="dm-navy-soft dm-muted" style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.muted};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:30%;">Previous</td>
        <td class="dm-navy-soft dm-accent" style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.accent};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:30%;">Updated</td>
      </tr>
      {{#each changes}}
      <tr>
        <td class="dm-muted" style="padding:10px 16px;font-family:${FONT};font-size:13px;color:${COLORS.muted};border-bottom:1px solid ${COLORS.border};line-height:1.5;">{{label}}</td>
        <td class="dm-muted" style="padding:10px 16px;font-family:${FONT};font-size:13px;color:${COLORS.faint};border-bottom:1px solid ${COLORS.border};line-height:1.5;text-decoration:line-through;">{{previous}}</td>
        <td class="dm-text" style="padding:10px 16px;font-family:${FONT};font-size:13px;font-weight:700;color:${COLORS.navy};border-bottom:1px solid ${COLORS.border};line-height:1.5;">{{updated}}</td>
      </tr>
      {{/each}}
    </table>
  </td></tr>
  {{/if}}`;
}

/**
 * Divider between sections.
 */
function divider() {
  return `<tr><td style="padding:24px 40px 0 40px;" class="pad"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid ${COLORS.border};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
}

/**
 * A colored callout box (info / warning / danger / success).
 */
function callout(text, tone = 'info') {
  const tones = {
    info: { bg: COLORS.infoSoft, text: COLORS.info, dmBg: 'dm-info-soft', dmFg: 'dm-info' },
    warning: { bg: COLORS.warningSoft, text: COLORS.warning, dmBg: 'dm-warning-soft', dmFg: 'dm-warning' },
    danger: { bg: COLORS.dangerSoft, text: COLORS.danger, dmBg: 'dm-danger-soft', dmFg: 'dm-danger' },
    success: { bg: COLORS.accentSoft, text: COLORS.accent, dmBg: 'dm-accent-soft', dmFg: 'dm-accent' },
  };
  const t = tones[tone] || tones.info;
  return `
  <tr><td class="pad" style="padding:20px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="${t.dmBg}" style="background-color:${t.bg};border-radius:10px;border-collapse:separate;border-spacing:0;">
      <tr><td class="${t.dmFg}" style="padding:14px 18px;font-family:${FONT};font-size:14px;color:${t.text};line-height:1.6;font-weight:600;">${text}</td></tr>
    </table>
  </td></tr>`;
}

/**
 * Plain paragraph of body text.
 */
function paragraph(text, options = {}) {
  const { center = false, muted = false, small = false } = options;
  const size = small ? '13px' : '15px';
  const color = muted ? COLORS.muted : COLORS.body;
  const cls = muted ? 'dm-muted' : 'dm-text';
  return `
  <tr><td class="pad" style="padding:16px 40px 0 40px;">
    <p class="${cls}" style="margin:0;font-family:${FONT};font-size:${size};color:${color};line-height:1.7;text-align:${center ? 'center' : 'left'};">${text}</p>
  </td></tr>`;
}

/**
 * Bulleted list ({{#each items}}).
 */
function bulletList() {
  return `
  <tr><td class="pad" style="padding:8px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      {{#each items}}
      <tr>
        <td class="dm-text" style="padding:4px 0;font-family:${FONT};font-size:14px;color:${COLORS.body};line-height:1.6;vertical-align:top;width:20px;">&bull;</td>
        <td class="dm-text" style="padding:4px 0;font-family:${FONT};font-size:14px;color:${COLORS.body};line-height:1.6;">{{this}}</td>
      </tr>
      {{/each}}
    </table>
  </td></tr>`;
}

/**
 * Action buttons — one or more CTA links. Accepts a Handlebars expression for
 * the href so URLs can be conditional ({{#if}} wrapped by caller if needed).
 */
function buttons(items) {
  const btnHtml = items
    .map((b) => {
      const href = b.href; // e.g. "{{bookingUrl}}" or a literal URL
      const style =
        b.kind === 'secondary'
          ? `background-color:${COLORS.card};border:1px solid ${COLORS.border};color:${COLORS.navy};`
          : `background-color:${COLORS.accent};color:#ffffff;`;
      const cls = b.kind === 'secondary' ? 'btn dm-card dm-text' : 'btn';
      return `
        <td style="padding:0 8px 0 0;vertical-align:middle;">
          <a href="${href}" class="${cls}" style="display:inline-block;${style}font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;padding:12px 22px;line-height:1.2;">${b.label}</a>
        </td>`;
    })
    .join('');

  // `btn-wrap` is the hook the mobile block above hangs off; without it
  // `.btn { width:100% }` collapses to the label's own width.
  return `
  <tr><td class="pad" style="padding:28px 40px 8px 40px;">
    <table role="presentation" class="btn-wrap" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>${btnHtml}</tr>
    </table>
  </td></tr>`;
}

/**
 * A single prominent CTA button with full-width option.
 */
function buttonPrimary(label, href, options = {}) {
  const { fullWidth = false, color = COLORS.accent } = options;
  return `
  <tr><td class="pad" style="padding:28px 40px 8px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center">
          <a href="${href}" class="btn" style="display:inline-block;background-color:${color};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;padding:14px 34px;line-height:1.2;">${label}</a>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

/**
 * Money/payment summary panel — highlighted box for totals.
 */
function summaryRows(rows) {
  const rowHtml = rows
    .map((r) => {
      const cond = r.if === undefined ? true : r.if;
      if (cond === false) return '';
      const isTotal = r.total;
      const labelColor = isTotal ? COLORS.navy : COLORS.muted;
      const valColor = isTotal ? COLORS.navy : COLORS.navy;
      const labelClass = isTotal ? 'dm-text' : 'dm-muted';
      const weight = isTotal ? 'font-size:16px;font-weight:800;' : 'font-size:14px;font-weight:600;';
      const rowHtmlInner = `
      <tr>
        <td class="${labelClass}" style="padding:${isTotal ? '12px' : '6px'} 18px;font-family:${FONT};font-size:14px;color:${labelColor};line-height:1.5;${isTotal ? 'font-weight:700;' : ''}">${r.label}</td>
        <td class="dm-text" style="padding:${isTotal ? '12px' : '6px'} 18px;font-family:${FONT};${weight}color:${valColor};line-height:1.5;text-align:right;white-space:nowrap;">${r.value}</td>
      </tr>`;
      // Mirror detailCard: a bare `{{var}}` in `if` becomes a runtime
      // {{#if var}} around the row so optional rows vanish when unset.
      const ifMatch = typeof cond === 'string' && cond.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
      const rowConditional = r.conditional || (ifMatch ? ifMatch[1] : null);
      return rowConditional ? `{{#if ${rowConditional}}}${rowHtmlInner}{{/if}}` : rowHtmlInner;
    })
    .join('');
  // `border-collapse:separate` (the global table rule sets collapse) is what
  // lets the border follow the 12px radius; without it the border draws as a
  // square box around the rounded background. `overflow:hidden` clips the
  // first/last rows to the corners in WebKit/Blink.
  return `
  <tr><td class="pad" style="padding:16px 40px 4px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-surface" style="background-color:${COLORS.bg};border:1px solid ${COLORS.border};border-radius:12px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      ${rowHtml}
    </table>
  </td></tr>`;
}

/**
 * Generic details list for supplier emails (label stacked over value).
 */
function stackedRows(rows) {
  const rowHtml = rows
    .map((r) => {
      const cond = r.if === undefined ? true : r.if;
      if (cond === false) return '';
      return `
      <tr>
        <td style="padding:8px 40px 0 40px;" class="pad">
          <div class="dm-muted" style="font-family:${FONT};font-size:12px;color:${COLORS.muted};line-height:1.4;text-transform:uppercase;letter-spacing:0.3px;font-weight:700;">${r.label}</div>
          <div class="dm-text" style="font-family:${FONT};font-size:15px;color:${COLORS.navy};line-height:1.5;font-weight:600;padding:2px 0 0 0;">${r.value || '&mdash;'}</div>
        </td>
      </tr>`;
    })
    .join('');
  return rowHtml;
}

/**
 * Compact centered header for messaging-style emails.
 */
function chatHeader(subtitle) {
  return `
  <tr><td class="pad" style="padding:34px 40px 0 40px;">
    <p class="dm-accent" style="margin:0 0 6px 0;font-family:${FONT};font-size:11px;font-weight:800;color:${COLORS.accent};letter-spacing:1.6px;text-transform:uppercase;text-align:center;">Messaging</p>
    <h1 class="dm-text" style="margin:0;font-family:${FONT};font-size:24px;font-weight:800;color:${COLORS.navy};line-height:1.25;text-align:center;">New message</h1>
    ${subtitle ? `<p class="body-lg font-main dm-muted" style="margin:6px auto 0 auto;max-width:460px;font-size:13px;color:${COLORS.muted};line-height:1.6;text-align:center;">${subtitle}</p>` : ''}
  </td></tr>`;
}

/**
 * Sender attribution row: avatar (image when available, initials circle
 * otherwise) + name + role. Used by messaging emails.
 */
function senderRow(nameVar, roleVar, avatarVar, initialsVar) {
  return `
  <tr><td class="pad" style="padding:24px 40px 4px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td width="58" valign="middle" style="padding:0 14px 0 0;">
          {{#if ${avatarVar.replace(/[{}]/g, '')}}}
          <img src="${avatarVar}" width="44" height="44" alt="" style="display:block;width:44px;height:44px;border-radius:50%;border:1px solid ${COLORS.border};">
          {{else}}
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            <td width="44" height="44" align="center" style="background-color:${COLORS.navy};border-radius:50%;font-family:${FONT};font-size:15px;font-weight:800;color:#ffffff;">${initialsVar}</td>
          </tr></table>
          {{/if}}
        </td>
        <td valign="middle" style="font-family:${FONT};">
          <div class="dm-text" style="font-size:15px;font-weight:800;color:${COLORS.navy};line-height:1.3;">${nameVar}</div>
          <div class="dm-muted" style="font-size:13px;color:${COLORS.muted};line-height:1.4;padding-top:2px;">${roleVar}</div>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

/**
 * Message card (bubble): optional image thumbnail, then the message text,
 * then an optional attachment label. Renders inline so it inherits the body
 * text color of the outer card.
 */
function messageCard(textVar, thumbVar, docVar) {
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-surface" style="background-color:#F4F6F9;border:1px solid ${COLORS.border};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      {{#if ${thumbVar.replace(/[{}]/g, '')}}}
      <tr><td style="padding:14px 14px 0 14px;">
        <img src="${thumbVar}" alt="Attached image" style="display:block;width:auto;max-width:100%;max-height:240px;border-radius:10px;border:1px solid ${COLORS.border};">
      </td></tr>
      {{/if}}
      <tr><td class="dm-text" style="padding:14px 18px;font-family:${FONT};font-size:15px;color:${COLORS.body};line-height:1.7;">${textVar}</td></tr>
      {{#if ${docVar.replace(/[{}]/g, '')}}}
      <tr><td class="dm-muted" style="padding:0 18px 14px 18px;font-family:${FONT};font-size:13px;color:${COLORS.muted};">&#128206;&nbsp; ${docVar}</td></tr>
      {{/if}}
    </table>
  </td></tr>`;
}

/**
 * Viator-style "About this conversation" strip. The whole row is hidden when
 * there is no tour context.
 */
function contextRow(titleVar, bookingVar) {
  return `
  {{#if ${titleVar.replace(/[{}]/g, '')}}}
  <tr><td class="pad" style="padding:16px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td class="dm-navy-soft dm-text" style="padding:10px 14px;background-color:${COLORS.navySoft};border-left:3px solid ${COLORS.accent};border-radius:8px;font-family:${FONT};font-size:13px;color:${COLORS.body};line-height:1.5;">
          <span class="dm-text" style="font-weight:800;color:${COLORS.navy};">${titleVar}</span>
          {{#if ${bookingVar.replace(/[{}]/g, '')}}}&nbsp;&nbsp;&middot;&nbsp;&nbsp;<span class="dm-muted" style="color:${COLORS.muted};">Ref ${bookingVar}</span>{{/if}}
        </td>
      </tr>
    </table>
  </td></tr>
  {{/if}}`;
}

/**
 * Full-bleed media header — tour photo behind a dark scrim with a status
 * badge, heading and subtitle sitting bottom-left over it.
 *
 * Renders as a real photo in every modern client (Apple Mail, Gmail, mobile)
 * via `background-image` + a linear-gradient scrim. Outlook's Word engine
 * ignores gradients and `background-image`, so the MSO/VML branch below paints
 * a solid navy panel instead — the text stays white-on-navy and readable
 * rather than white-on-white.
 *
 * @param {object} o
 * @param {string} [o.imageUrl]  photo URL (Handlebars ok); ignored when imageVar is set
 * @param {string} [o.imageVar]  template variable name (e.g. 'tourImageUrl'). When
 *   given, the photo is emitted inside a runtime {{#if}} so a missing/empty value
 *   falls back to the gradient over the navy panel instead of an empty url('').
 * @param {string} [o.badgeText]  small uppercase pill over the heading
 * @param {string} [o.badgeColor] accent | warning | info | success
 * @param {string} o.heading
 * @param {string} [o.subtitle]
 * @param {number} [o.height]  desktop hero height in px (default 248)
 */
function mediaHeader({ imageUrl, imageVar, badgeText, badgeColor = 'warning', heading, subtitle, height = 248 }) {
  const badgeTones = {
    accent: { bg: COLORS.accent, text: '#FFFFFF' },
    warning: { bg: '#F59E0B', text: '#3B2500' },
    info: { bg: COLORS.info, text: '#FFFFFF' },
    success: { bg: COLORS.accent, text: '#FFFFFF' },
    danger: { bg: COLORS.danger, text: '#FFFFFF' },
  };
  const bt = badgeTones[badgeColor] || badgeTones.warning;
  const badge = badgeText
    ? `<div style="margin:0 0 14px 0;"><span style="display:inline-block;background-color:${bt.bg};color:${bt.text};font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:0.9px;text-transform:uppercase;border-radius:999px;padding:7px 14px;line-height:1;">${badgeText}</span></div>`
    : '';

  // The hero photo sits behind a gradient that has to survive on its own: some
  // tours have no cover image, and an empty url('') makes mail clients drop the
  // entire background-image declaration, gradient included. When the caller
  // names the variable backing the image, emit a runtime {{#if}} so a missing
  // photo degrades to the gradient over the navy panel instead of a flat block.
  const GRADIENT = 'linear-gradient(180deg, rgba(0,31,63,0.08) 0%, rgba(0,31,63,0.55) 55%, rgba(0,31,63,0.9) 100%)';
  const background = imageVar
    ? `{{#if ${imageVar}}}background-image:${GRADIENT}, url('{{${imageVar}}}');{{else}}background-image:${GRADIENT};{{/if}}`
    : `background-image:${GRADIENT}, url('${imageUrl || ''}');`;

  const inner = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate;border-spacing:0;background-color:${COLORS.navy};${background}background-size:cover;background-position:center;background-repeat:no-repeat;border-radius:0;overflow:hidden;">
      <tr>
        <td valign="bottom" class="pad" style="padding:120px 34px 28px 34px;">
          ${badge}
          <div style="font-family:${FONT};font-size:26px;font-weight:800;color:#ffffff;line-height:1.24;text-shadow:0 1px 3px rgba(0,0,0,0.45);">${heading}</div>
          ${subtitle ? `<div style="font-family:${FONT};font-size:14px;font-weight:500;color:#E8EEF5;line-height:1.5;padding-top:8px;text-shadow:0 1px 3px rgba(0,0,0,0.45);">${subtitle}</div>` : ''}
        </td>
      </tr>
    </table>`;

  return `
  <tr><td style="padding:0;">
    <!--[if gte mso 9]>
    <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:640px;height:${height}px;">
      <v:fill color="#001F3F" />
      <v:textbox inset="0,0,0,0">
    <![endif]-->
    <div>${inner}</div>
    <!--[if gte mso 9]>
      </v:textbox>
    </v:rect>
    <![endif]-->
  </td></tr>`;
}

/**
 * Reference bar — "REF <code>" chip on the left, an optional meta string
 * (e.g. "Reserved 9 Oct 2026") right-aligned.
 */
function referenceBar({ reference, right }) {
  return `
  <tr><td class="pad" style="padding:20px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td valign="middle" style="font-family:${FONT};">
          <span class="dm-muted" style="display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:1.3px;text-transform:uppercase;color:${COLORS.faint};vertical-align:middle;">Ref</span>
          <span class="dm-chip" style="display:inline-block;margin-left:8px;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:15px;font-weight:700;color:${COLORS.navy};background-color:${COLORS.navySoft};border-radius:7px;padding:5px 11px;letter-spacing:0.4px;vertical-align:middle;">${reference}</span>
        </td>
        ${right ? `<td class="dm-muted" valign="middle" align="right" style="font-family:${FONT};font-size:12px;color:${COLORS.faint};white-space:nowrap;">${right}</td>` : ''}
      </tr>
    </table>
  </td></tr>`;
}

/**
 * Copy-friendly link block — the hero for "hand this URL to someone else".
 *
 * The full URL is rendered as selectable monospace text that wraps
 * (`word-break:break-all`) instead of overflowing, paired with a "Copy"
 * affordance to its right. Email clients block JavaScript, so the control
 * cannot itself write to the clipboard: it is a visual cue next to the
 * selectable link (long-press on mobile, select on desktop), which is what a
 * recipient actually copies. The layout stacks on narrow screens.
 *
 * @param {string} url  URL (Handlebars expression allowed)
 * @param {object} [options]
 * @param {string} [options.label]  small uppercase caption above the URL
 */
function copyLink(url, options = {}) {
  const { label = '' } = options;
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-surface dm-accent-soft" style="background-color:${COLORS.accentSoft};border:1px solid ${COLORS.accentSoftBorder};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr><td style="padding:16px 18px;font-family:${FONT};">
        ${label ? `<div class="dm-accent" style="font-size:11px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:${COLORS.accent};line-height:1;padding-bottom:10px;">${label}</div>` : ''}
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr>
            <td class="stack-td dm-text" style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:13px;font-weight:600;color:${COLORS.navy};line-height:1.6;word-break:break-all;overflow-wrap:anywhere;vertical-align:middle;padding:0 12px 0 0;">${url}</td>
            <td class="stack-td" width="1" align="right" style="white-space:nowrap;vertical-align:middle;padding:0;">
              <span class="dm-chip" style="display:inline-block;font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.3px;color:${COLORS.navy};background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:8px;padding:9px 16px;line-height:1;">Copy</span>
            </td>
          </tr>
        </table>
        <div class="dm-muted" style="font-family:${FONT};font-size:12px;color:${COLORS.faint};line-height:1.5;padding-top:10px;">Select or long-press the link to copy it, then send it to your guest.</div>
      </td></tr>
    </table>
  </td></tr>`;
}

/**
 * Lifecycle progress rail — a row of steps, each a coloured bar + label +
 * sublabel. Steps before `activeIndex` are done (accent), the step at
 * `activeIndex` is current (amber), the rest are pending (grey). Stacks
 * vertically on narrow screens.
 *
 * @param {Array<{label:string, sublabel?:string}>} steps
 * @param {number} [activeIndex]
 */
function statusStrip(steps, activeIndex = 0) {
  const width = Math.floor(100 / steps.length);
  const cells = steps
    .map((s, i) => {
      const done = i < activeIndex;
      const active = i === activeIndex;
      const barColor = done ? COLORS.accent : active ? '#F59E0B' : COLORS.border;
      const labelColor = done ? COLORS.accent : active ? COLORS.navy : COLORS.faint;
      const labelClass = done ? 'dm-accent' : active ? 'dm-text' : 'dm-muted';
      const weight = done || active ? '800' : '600';
      return `
      <td class="stack-td" width="${width}%" valign="top" style="padding:0 5px 8px 5px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="height:4px;background-color:${barColor};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td class="${labelClass}" style="padding:11px 0 0 0;font-family:${FONT};font-size:12px;font-weight:${weight};color:${labelColor};line-height:1.3;">${s.label}</td></tr>
          <tr><td class="dm-muted" style="padding:3px 0 0 0;font-family:${FONT};font-size:11px;font-weight:500;color:${COLORS.faint};line-height:1.35;">${s.sublabel || ''}</td></tr>
        </table>
      </td>`;
    })
    .join('');
  return `
  <tr><td class="pad" style="padding:20px 35px 0 35px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>${cells}</tr></table>
  </td></tr>`;
}

/**
 * Monochrome line icons (Feather-style, 24×24 viewBox). Stroke colour and
 * weight come from the wrapper in statGrid. Kept as inline SVG rather than
 * emoji so the tiles match the design system instead of the OS font.
 */
const ICONS = {
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2.5"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  clock:
    '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  duration:
    '<path d="M7 3h10"/><path d="M7 21h10"/><path d="M8 3v3.4a4 4 0 0 0 1.2 2.85L12 12l2.8-2.75A4 4 0 0 0 16 6.4V3"/><path d="M8 21v-3.4a4 4 0 0 1 1.2-2.85L12 12l2.8 2.75A4 4 0 0 1 16 17.6V21"/>',
  users:
    '<path d="M16 20v-1.8a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20"/><circle cx="9" cy="7" r="4"/><path d="M22 20v-1.8a4 4 0 0 0-3-3.87"/><path d="M15.5 3.13a4 4 0 0 1 0 7.75"/>',
};

/**
 * Hosted versions of `ICONS`. Gmail and Outlook strip inline `<svg>`, so the
 * Key-facts cards reference these PNGs instead and the SVG above is only the
 * source (and the fallback if a key is missing from this map).
 *
 * Cloudinary renders them from sendgrid-templates/assets/email-icons/*.svg at
 * 2x for a 20px slot. Refresh with:
 *   node scripts/upload-email-icons.js
 * (It uploads under fixed public_ids with overwrite, and the URLs are
 * versionless, so this constant stays valid across re-uploads.)
 */
const EMAIL_ICON_URLS = {
  calendar: 'https://res.cloudinary.com/dfpagrtoy/image/upload/f_png,w_40,h_40,c_fit,q_95/email-icons/calendar.svg',
  clock: 'https://res.cloudinary.com/dfpagrtoy/image/upload/f_png,w_40,h_40,c_fit,q_95/email-icons/clock.svg',
  duration: 'https://res.cloudinary.com/dfpagrtoy/image/upload/f_png,w_40,h_40,c_fit,q_95/email-icons/duration.svg',
  users: 'https://res.cloudinary.com/dfpagrtoy/image/upload/f_png,w_40,h_40,c_fit,q_95/email-icons/users.svg',
};

/**
 * Key-facts tile palette. Each tone pairs a light surface + accent label with
 * the dark-mode classes defined in BASE_CSS, so the tile and its label move
 * together instead of leaving dark text on a light tile (or vice versa).
 */
const TILE_TONES = {
  green: { tint: '#E7F6EE', color: '#0B7A4B', dmTint: 'dm-tile-green', dmLabel: 'dm-label-green' },
  blue: { tint: '#E8F1FE', color: '#1D4ED8', dmTint: 'dm-tile-blue', dmLabel: 'dm-label-blue' },
  amber: { tint: '#FEF4E6', color: '#B45309', dmTint: 'dm-tile-amber', dmLabel: 'dm-label-amber' },
  purple: { tint: '#F2ECFE', color: '#6D28D9', dmTint: 'dm-tile-purple', dmLabel: 'dm-label-purple' },
};

/**
 * Stat grid — 2×2 cards of colour-tinted facts. Each card carries a solid
 * accent badge with a white line icon, an accent-coloured label and a navy
 * value. Deliberately not the usual pale-grey box + chip: the tint is per
 * fact, so the row reads as a designed summary rather than filler.
 *
 * Pass `tone` (green | blue | amber | purple) to get a tinted card whose
 * background and label also have dark-mode variants. Explicit `tint`/`color`
 * hexes remain supported for one-off colours, but then no dark variant is
 * emitted, so prefer `tone`.
 *
 * Icons are inline SVG (no emoji). The card still reads if a client strips
 * the SVG, because the tint, label and value carry the content. Stacks to
 * one column on mobile via the shared `.stack-td` rule.
 *
 * A tile may carry `if: '{{someVar}}'` to disappear when that value is empty —
 * the same contract as detailRows, so a tour with no start time does not print
 * a blank "Start time" tile.
 *
 * Row packing: the top row must always hold two tiles that actually render.
 * Tiles are paired at BUILD time, but a conditional tile only reveals itself at
 * SEND time via {{#if}} — so pairing in declaration order produced a lone tile
 * sitting at 50% width on top with the remaining pair below whenever the first
 * tile of a row was conditional and empty ("one at the top, two at the
 * bottom"). To guarantee the first row is always full, always-on tiles are
 * packed first (keeping their relative order) and conditional tiles flow into
 * the rows beneath them. A grid with an odd tile count ends on a tile that
 * spans the full row (`.kf-cell-wide`) rather than leaving a half-row gap.
 *
 * @param {Array<{icon:string, label:string, value:string, tone?:string, color?:string, tint?:string, if?:string}>} tiles
 */
function statGrid(tiles) {
  // Optional tile: hide the whole cell when the value is absent, exactly like
  // detailRows does for a row. No `if` means the markup is unconditional.
  const conditionalVar = (t) => {
    const ifMatch = typeof t.if === 'string' && t.if.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
    return t.conditional || (ifMatch ? ifMatch[1] : null);
  };

  const cell = (t, wide = false) => {
    const tone = t.tone ? TILE_TONES[t.tone] : null;
    const tint = (tone && tone.tint) || t.tint || COLORS.accentSoft;
    const color = (tone && tone.color) || t.color || COLORS.accent;
    const tileClass = tone ? ` class="${tone.dmTint}"` : '';
    const labelClass = tone ? ` class="${tone.dmLabel}"` : '';
    // Hosted PNG first: Gmail and Outlook drop inline <svg>, which would leave
    // the badge empty. The SVG path only remains for icons missing from
    // EMAIL_ICON_URLS (so an unknown key still renders in Apple Mail).
    const hosted = EMAIL_ICON_URLS[t.icon];
    const glyph = hosted
      ? `<img src="${hosted}" width="20" height="20" alt="" style="display:block;width:20px;height:20px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">`
      : ICONS[t.icon]
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${ICONS[t.icon]}</svg>`
        : '';
    const widthAttr = wide ? '100%' : '50%';
    const html = `
    <td class="stack-td kf-cell${wide ? ' kf-cell-wide' : ''}" width="${widthAttr}" valign="top" style="width:${widthAttr};padding:0 6px 12px 6px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"${tileClass} style="background-color:${tint};border-radius:16px;border-collapse:separate;border-spacing:0;overflow:hidden;">
        <tr>
          <td style="padding:16px 18px 18px 18px;font-family:${FONT};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
              <td width="38" height="38" align="center" valign="middle" style="background-color:${color};border-radius:11px;line-height:0;font-size:0;">${glyph}</td>
            </tr></table>
            <div${labelClass} style="padding-top:13px;font-size:10.5px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:${color};line-height:1;">${t.label}</div>
            <div class="dm-text" style="padding-top:5px;font-size:16px;font-weight:700;color:${COLORS.navy};line-height:1.3;">${t.value}</div>
          </td>
        </tr>
      </table>
    </td>`;

    const cond = conditionalVar(t);
    return cond ? `{{#if ${cond}}}${html}{{/if}}` : html;
  };

  // Always-on tiles first so the top row can never half-render; conditional
  // tiles keep their own relative order and fill the rows beneath.
  const always = tiles.filter((t) => !conditionalVar(t));
  const optional = tiles.filter((t) => conditionalVar(t));
  const packed = [...always, ...optional];

  const rows = [];
  for (let i = 0; i < packed.length; i += 2) {
    const a = packed[i];
    const b = packed[i + 1];
    rows.push(b ? `<tr>${cell(a)}${cell(b)}</tr>` : `<tr>${cell(a, true)}</tr>`);
  }
  return `
  <tr><td class="pad" style="padding:10px 34px 0 34px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows.join('')}</table>
  </td></tr>`;
}

/**
 * Numbered "what happens next" steps.
 * @param {Array<{title:string, body?:string}>} items
 */
function stepList(items) {
  const rows = items
    .map(
      (it, i) => `
    <tr>
      <td width="40" valign="top" style="padding:0 12px 16px 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
          <td width="26" height="26" align="center" style="background-color:${COLORS.navy};border-radius:50%;font-family:${FONT};font-size:12px;font-weight:800;color:#ffffff;">${i + 1}</td>
        </tr></table>
      </td>
      <td valign="top" style="padding:2px 0 16px 0;font-family:${FONT};">
        <div class="dm-text" style="font-size:14px;font-weight:700;color:${COLORS.navy};line-height:1.4;">${it.title}</div>
        ${it.body ? `<div class="dm-muted" style="font-size:13px;color:${COLORS.muted};line-height:1.6;padding-top:3px;">${it.body}</div>` : ''}
      </td>
    </tr>`
    )
    .join('');
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${rows}</table>
  </td></tr>`;
}

/**
 * Customer contact card — Google profile photo (from User.photoURL) when
 * available, otherwise an initials avatar. Name + email/phone lines.
 */
function contactCard({ name, email, phone, initials, avatarVar = 'customerAvatarUrl' }) {
  const media = `
    {{#if ${avatarVar}}}
    <img src="{{${avatarVar}}}" width="46" height="46" alt="" style="display:block;width:46px;height:46px;border-radius:50%;border:1px solid ${COLORS.border};object-fit:cover;">
    {{else}}
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td width="46" height="46" align="center" style="background-color:${COLORS.navy};border-radius:50%;font-family:${FONT};font-size:16px;font-weight:800;color:#ffffff;">${initials}</td></tr></table>
    {{/if}}`;
  const line = (icon, value, href) =>
    value
      ? `<div class="dm-text" style="font-family:${FONT};font-size:13px;color:${COLORS.body};line-height:1.7;"><span class="dm-muted" style="color:${COLORS.faint};">${icon}</span>&nbsp;&nbsp;<a class="dm-text" href="${href || '#'}" style="color:${COLORS.body};text-decoration:none;">${value}</a></div>`
      : '';
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-surface" style="background-color:#F4F6F9;border:1px solid ${COLORS.border};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>
        <td width="58" valign="middle" style="padding:16px 0 16px 18px;">${media}</td>
        <td valign="middle" style="padding:16px 18px 16px 0;font-family:${FONT};">
          <div class="dm-text" style="font-size:15px;font-weight:800;color:${COLORS.navy};line-height:1.3;padding-bottom:3px;">${name}</div>
          ${line('&#9993;', email, `mailto:${email}`)}
          ${line('&#9742;', phone)}
        </td>
      </tr>
    </table>
  </td></tr>`;
}

/**
 * "Similar activities" recommendation rail. Renders the `similarTours` array
 * (see emailService.buildSimilarTours) through a Handlebars {{#each}} loop, so
 * the whole section collapses to nothing when the payload is empty.
 *
 * Each card leads with the three signals a GetYourGuide/Viator card uses: the
 * experience photo, its star rating with review count, and a "From" price. The
 * photo and title both deep-link to the experience page.
 */
function recommendations(title = 'You may also like', subtitle = '') {
  // Wrapped in {{#if similarTours}} so an empty (or missing) array removes the
  // whole section, heading included, rather than leaving a dangling title.
  return `{{#if similarTours}}
  <tr><td class="pad" style="padding:28px 40px 0 40px;">
    <div class="h2 font-main dm-text" style="font-size:15px;font-weight:800;color:${COLORS.navy};letter-spacing:0.4px;text-transform:uppercase;line-height:1.3;">${title}</div>
    ${subtitle ? `<div class="dm-muted" style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.6;padding-top:5px;">${subtitle}</div>` : ''}
  </td></tr>
  {{#each similarTours}}
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="dm-card" style="background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr>
        {{#if imageUrl}}
        <td width="120" valign="top" style="width:120px;padding:0;">
          <a href="{{url}}" target="_blank" style="display:block;line-height:0;text-decoration:none;">
            <img src="{{imageUrl}}" width="120" height="120" alt="{{title}}" style="display:block;width:120px;height:120px;object-fit:cover;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">
          </a>
        </td>
        {{/if}}
        <td valign="middle" style="padding:14px 18px;font-family:${FONT};">
          <a href="{{url}}" target="_blank" class="dm-text" style="display:block;text-decoration:none;font-size:15px;font-weight:800;color:${COLORS.navy};line-height:1.35;">{{title}}</a>
          {{#if place}}<div class="dm-muted" style="font-size:12.5px;color:${COLORS.muted};line-height:1.4;padding-top:3px;">{{place}}</div>{{/if}}
          {{#if hasRating}}<div style="font-size:13px;line-height:1.4;padding-top:7px;"><span style="color:#F5A623;font-weight:800;">&#9733;</span> <span class="dm-text" style="color:${COLORS.navy};font-weight:800;">{{ratingLabel}}</span> <span class="dm-muted" style="color:${COLORS.muted};font-weight:500;">{{reviewCountLabel}}</span></div>{{/if}}
          {{#if hasPrice}}<div class="dm-muted" style="font-size:13px;color:${COLORS.muted};line-height:1.4;padding-top:6px;">From <span class="dm-text" style="color:${COLORS.navy};font-weight:800;">{{priceLabel}}</span></div>{{/if}}
        </td>
      </tr>
    </table>
  </td></tr>
  {{/each}}
  {{/if}}`;
}

/**
 * Payout panel — navy money block with the payout visually dominant and an
 * optional amber status pill underneath. Uses solid colours throughout so
 * Outlook (no rgba support) renders it legibly.
 *
 * @param {object} o
 * @param {Array<{label:string, value:string}>} o.rows  retail / commission lines
 * @param {string} o.total       the supplier payout value
 * @param {string} [o.statusLabel]
 */
function payoutPanel({ rows, total, statusLabel }) {
  const rowHtml = rows
    .map((r) => {
      const cond = r.if === undefined ? true : r.if;
      if (cond === false) return '';
      const ifMatch = typeof cond === 'string' && cond.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
      const rowConditional = r.conditional || (ifMatch ? ifMatch[1] : null);
      const rowInner = `
      <tr>
        <td style="padding:5px 0;font-family:${FONT};font-size:13px;color:#C7D2E0;line-height:1.5;">${r.label}</td>
        <td style="padding:5px 0;font-family:${FONT};font-size:13px;font-weight:700;color:#ffffff;line-height:1.5;text-align:right;white-space:nowrap;">${r.value}</td>
      </tr>`;
      return rowConditional ? `{{#if ${rowConditional}}}${rowInner}{{/if}}` : rowInner;
    })
    .join('');
  return `
  <tr><td class="pad" style="padding:12px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${COLORS.navy};border-radius:14px;border-collapse:separate;border-spacing:0;overflow:hidden;">
      <tr><td style="padding:20px 22px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          ${rowHtml}
          <tr><td colspan="2" style="padding:12px 0;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="border-top:1px solid #2A4A6B;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
          <tr>
            <td style="font-family:${FONT};font-size:11px;font-weight:800;letter-spacing:0.7px;text-transform:uppercase;color:#C7D2E0;vertical-align:bottom;">Your payout</td>
            <td style="font-family:${FONT};font-size:26px;font-weight:800;color:#ffffff;text-align:right;white-space:nowrap;line-height:1.1;">${total}</td>
          </tr>
        </table>
        ${statusLabel ? `<div style="padding-top:14px;"><span style="display:inline-block;background-color:#FEF3C7;color:#B45309;font-family:${FONT};font-size:11.5px;font-weight:800;letter-spacing:0.3px;border-radius:999px;padding:6px 13px;line-height:1;">${statusLabel}</span></div>` : ''}
      </td></tr>
    </table>
  </td></tr>`;
}

module.exports = {
  COLORS,
  FONT,
  shell,
  hero,
  sectionTitle,
  detailRows,
  detailCard,
  diffTable,
  divider,
  callout,
  paragraph,
  bulletList,
  buttons,
  buttonPrimary,
  summaryRows,
  stackedRows,
  chatHeader,
  senderRow,
  messageCard,
  contextRow,
  mediaHeader,
  referenceBar,
  copyLink,
  statusStrip,
  statGrid,
  ICONS,
  EMAIL_ICON_URLS,
  stepList,
  contactCard,
  recommendations,
  payoutPanel,
  spacer,
  msoSpacer,
};
