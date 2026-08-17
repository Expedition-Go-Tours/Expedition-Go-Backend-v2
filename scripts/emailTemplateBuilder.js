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
  muted: '#64748B',
  faint: '#94A3B8',
  accent: '#00A669',
  accentDark: '#007A4D',
  accentSoft: '#E6F6F0',
  danger: '#DC2626',
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
  @media only screen and (max-width:640px) {
    .container { width:100% !important; }
    .pad { padding-left:20px !important; padding-right:20px !important; }
    .pad-top { padding-top:28px !important; }
    .stack { display:block !important; width:100% !important; box-sizing:border-box !important; }
    .stack-td { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:left !important; }
    .btn { width:100% !important; display:block !important; text-align:center !important; box-sizing:border-box !important; }
    .btn-wrap { width:100% !important; display:block !important; text-align:center !important; }
    .h1 { font-size:24px !important; }
    .h2 { font-size:18px !important; }
    .body-lg { font-size:16px !important; }
    .hide-mobile { display:none !important; }
  }
`;

const HEAD_META = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
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
<body style="margin:0;padding:0;background-color:${COLORS.bg};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="${COLORS.bg}">
    <tr>
      <td align="center" style="padding:32px 16px;" class="pad">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" class="container" style="max-width:640px;">
          <!-- Preheader (hidden) -->
          <tr><td style="display:none;max-height:0;overflow:hidden;mso-hide:all;">{{preheader}}</td></tr>
          <!-- Header -->
          <tr>
            <td align="center" style="padding:0 0 24px 0;">
              <img src="{{logoUrl}}" alt="{{brandName}}" width="170" style="display:block;width:170px;max-width:170px;height:auto;border:0;outline:none;">
            </td>
          </tr>
          <!-- Card -->
          <tr>
            <td style="background-color:${COLORS.card};border:1px solid ${COLORS.border};border-radius:16px;padding:0;">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:28px 20px 0 20px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.6;padding:0 0 6px 0;">
                    Need help? <a href="mailto:{{supportEmail}}" style="color:${COLORS.accent};text-decoration:none;font-weight:600;">Contact support</a>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-family:${FONT};font-size:12px;color:${COLORS.faint};line-height:1.6;">
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
    accent: { bg: COLORS.accentSoft, text: COLORS.accent },
    danger: { bg: COLORS.dangerSoft, text: COLORS.danger },
    warning: { bg: COLORS.warningSoft, text: COLORS.warning },
    info: { bg: COLORS.infoSoft, text: COLORS.info },
    navy: { bg: COLORS.navySoft, text: COLORS.navy },
  };
  const bc = badgeColors[badgeColor] || badgeColors.accent;

  const badge = badgeText
    ? `<tr><td align="center" style="padding:${subtitle ? '8' : '0'}px 0 0 0;">
         <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
           <tr><td style="background-color:${bc.bg};border-radius:20px;padding:6px 16px;font-family:${FONT};font-size:13px;font-weight:700;color:${bc.text};line-height:1.2;">${badgeText}</td></tr>
         </table>
       </td></tr>`
    : '';

  return `
  <tr><td class="pad" style="padding:36px 40px 4px 40px;">
    <h1 class="h1 font-main" style="margin:0 0 12px 0;font-size:28px;font-weight:800;color:${COLORS.navy};line-height:1.25;text-align:center;">${heading}</h1>
    ${subtitle ? `<p class="body-lg font-main" style="margin:0 auto;max-width:480px;font-size:15px;color:${COLORS.body};line-height:1.6;text-align:center;">${subtitle}</p>` : ''}
    ${badge}
  </td></tr>`;
}

function sectionTitle(text) {
  return `
  <tr><td class="pad" style="padding:28px 40px 4px 40px;">
    <div class="h2 font-main" style="font-size:15px;font-weight:800;color:${COLORS.navy};letter-spacing:0.4px;text-transform:uppercase;line-height:1.3;">${text}</div>
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

    const valueHtml = row.raw !== undefined
      ? row.raw
      : `<span style="color:${COLORS.navy};font-weight:600;">${row.value || '&mdash;'}</span>`;

    // When the whole row is already gated by {{#if}}, the value renders plain.
    const value = rowConditional ? valueHtml : valueHtml;

    const rowHtml = `
      <tr>
        <td style="padding:7px 40px 7px 40px;" class="pad">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td style="font-family:${FONT};font-size:13px;color:${COLORS.muted};line-height:1.5;padding:0 12px 0 0;width:45%;vertical-align:top;">${row.label}</td>
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
 * Before/after diff table (change emails). Renders header + {{#each changes}}.
 */
function diffTable() {
  return `
  <tr><td class="pad" style="padding:12px 40px 4px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.border};border-radius:10px;overflow:hidden;">
      <tr>
        <td style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.navy};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:40%;">Detail</td>
        <td style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.muted};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:30%;">Previous</td>
        <td style="background-color:${COLORS.navySoft};padding:10px 16px;font-family:${FONT};font-size:12px;font-weight:800;color:${COLORS.accent};text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid ${COLORS.border};width:30%;">Updated</td>
      </tr>
      {{#each changes}}
      <tr>
        <td style="padding:10px 16px;font-family:${FONT};font-size:13px;color:${COLORS.muted};border-bottom:1px solid ${COLORS.border};line-height:1.5;">{{label}}</td>
        <td style="padding:10px 16px;font-family:${FONT};font-size:13px;color:${COLORS.faint};border-bottom:1px solid ${COLORS.border};line-height:1.5;text-decoration:line-through;">{{previous}}</td>
        <td style="padding:10px 16px;font-family:${FONT};font-size:13px;font-weight:700;color:${COLORS.navy};border-bottom:1px solid ${COLORS.border};line-height:1.5;">{{updated}}</td>
      </tr>
      {{/each}}
    </table>
  </td></tr>`;
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
    info: { bg: COLORS.infoSoft, text: COLORS.info },
    warning: { bg: COLORS.warningSoft, text: COLORS.warning },
    danger: { bg: COLORS.dangerSoft, text: COLORS.danger },
    success: { bg: COLORS.accentSoft, text: COLORS.accent },
  };
  const t = tones[tone] || tones.info;
  return `
  <tr><td class="pad" style="padding:20px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${t.bg};border-radius:10px;">
      <tr><td style="padding:14px 18px;font-family:${FONT};font-size:14px;color:${t.text};line-height:1.6;font-weight:600;">${text}</td></tr>
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
  return `
  <tr><td class="pad" style="padding:16px 40px 0 40px;">
    <p style="margin:0;font-family:${FONT};font-size:${size};color:${color};line-height:1.7;text-align:${center ? 'center' : 'left'};">${text}</p>
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
        <td style="padding:4px 0;font-family:${FONT};font-size:14px;color:${COLORS.body};line-height:1.6;vertical-align:top;width:20px;">&bull;</td>
        <td style="padding:4px 0;font-family:${FONT};font-size:14px;color:${COLORS.body};line-height:1.6;">{{this}}</td>
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
    .map((b, i) => {
      const href = b.href; // e.g. "{{bookingUrl}}" or a literal URL
      const style =
        b.kind === 'secondary'
          ? `background-color:${COLORS.card};border:1px solid ${COLORS.border};color:${COLORS.navy};`
          : `background-color:${COLORS.accent};color:#ffffff;`;
      const margin = i > 0 ? 'padding:0 0 0 8px;' : 'padding:0;';
      return `
        <td style="padding:0 8px 0 0;vertical-align:middle;">
          <a href="${href}" class="btn" style="display:inline-block;${style}font-family:${FONT};font-size:14px;font-weight:700;text-decoration:none;border-radius:8px;padding:12px 22px;line-height:1.2;">${b.label}</a>
        </td>`;
    })
    .join('');

  return `
  <tr><td class="pad" style="padding:28px 40px 8px 40px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>${btnHtml}</tr>
    </table>
  </td></tr>`;
}

/**
 * A single prominent CTA button with full-width option.
 */
function buttonPrimary(label, href, options = {}) {
  const { fullWidth = false } = options;
  return `
  <tr><td class="pad" style="padding:28px 40px 8px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center">
          <a href="${href}" class="btn" style="display:inline-block;background-color:${COLORS.accent};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;padding:14px 34px;line-height:1.2;">${label}</a>
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
      const isTotal = r.total;
      const labelColor = isTotal ? COLORS.navy : COLORS.muted;
      const valColor = isTotal ? COLORS.navy : COLORS.navy;
      const weight = isTotal ? 'font-size:16px;font-weight:800;' : 'font-size:14px;font-weight:600;';
      return `
      <tr>
        <td style="padding:${isTotal ? '12px' : '6px'} 18px;font-family:${FONT};font-size:14px;color:${labelColor};line-height:1.5;${isTotal ? 'font-weight:700;' : ''}">${r.label}</td>
        <td style="padding:${isTotal ? '12px' : '6px'} 18px;font-family:${FONT};${weight}color:${valColor};line-height:1.5;text-align:right;white-space:nowrap;">${r.value}</td>
      </tr>`;
    })
    .join('');
  return `
  <tr><td class="pad" style="padding:16px 40px 4px 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${COLORS.bg};border:1px solid ${COLORS.border};border-radius:12px;">
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
          <div style="font-family:${FONT};font-size:12px;color:${COLORS.muted};line-height:1.4;text-transform:uppercase;letter-spacing:0.3px;font-weight:700;">${r.label}</div>
          <div style="font-family:${FONT};font-size:15px;color:${COLORS.navy};line-height:1.5;font-weight:600;padding:2px 0 0 0;">${r.value || '&mdash;'}</div>
        </td>
      </tr>`;
    })
    .join('');
  return rowHtml;
}

module.exports = {
  COLORS,
  FONT,
  shell,
  hero,
  sectionTitle,
  detailRows,
  diffTable,
  divider,
  callout,
  paragraph,
  bulletList,
  buttons,
  buttonPrimary,
  summaryRows,
  stackedRows,
  spacer,
  msoSpacer,
};
