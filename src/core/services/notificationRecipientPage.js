/**
 * Standalone result pages for the supplier notification-email links.
 *
 * Served by the API and rendered server-side so the recipient — who is not a
 * dashboard user — never hits a login screen. Self-contained HTML, inline CSS,
 * no external assets other than the brand logo.
 */

const ICONS = {
  check: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  clock: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  alert: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
};

const STATES = {
  verified: {
    title: 'Email confirmed',
    accent: '#0E9F6E',
    buttonLabel: 'Manage notification emails',
    iconBg: '#ECFDF5',
    icon: ICONS.check,
    message: "You're all set. This address will now receive the notifications selected for it.",
    showRecipient: true,
  },
  unsubscribed: {
    title: "You're unsubscribed",
    accent: '#0E9F6E',
    buttonLabel: 'Manage notification emails',
    iconBg: '#ECFDF5',
    icon: ICONS.check,
    message: 'This address will no longer receive notifications. The account owner can turn it back on at any time.',
    showRecipient: true,
  },
  expired: {
    title: 'This link has expired',
    accent: '#B45309',
    buttonLabel: 'Open notification settings',
    iconBg: '#FEF3C7',
    icon: ICONS.clock,
    message: 'Confirmation links expire after 7 days. Send a new one from Settings → Notifications.',
    showRecipient: true,
  },
  invalid: {
    title: "This link isn't valid",
    accent: '#DC2626',
    buttonLabel: null,
    iconBg: '#FEE2E2',
    icon: ICONS.alert,
    message: "We couldn't match this confirmation link. It may have already been used or the link may be incomplete. You can send a fresh one from Settings → Notifications.",
    showRecipient: false,
  },
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNotificationRecipientPage({
  state,
  brandName = 'Travio',
  logoUrl = '',
  supportEmail = '',
  recipientEmail = '',
  supplierName = '',
  dashboardUrl = '',
  types = [],
}) {
  const meta = STATES[state] || STATES.invalid;
  const brand = escapeHtml(brandName);

  const details = [];
  if (meta.showRecipient && recipientEmail) {
    details.push(`<div><span class="lbl">Email</span><span class="val">${escapeHtml(recipientEmail)}</span></div>`);
  }
  if (meta.showRecipient && supplierName) {
    details.push(`<div><span class="lbl">Account</span><span class="val">${escapeHtml(supplierName)}</span></div>`);
  }
  const detailBox = details.length
    ? `<div class="detail">${details.join('')}</div>`
    : '';

  const typeList = Array.isArray(types) && types.length
    ? `<div class="types"><p class="types-title">Emails this address will receive</p><ul>${types
        .map((t) => `<li>${escapeHtml(t)}</li>`)
        .join('')}</ul></div>`
    : '';

  const button = meta.buttonLabel && dashboardUrl
    ? `<a class="btn" href="${escapeHtml(dashboardUrl)}" style="background:${meta.accent};">${escapeHtml(meta.buttonLabel)}</a>`
    : '';

  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${brand}" class="logo">`
    : `<p class="brand">${brand}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<title>${escapeHtml(meta.title)} · ${brand}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#EEF2F6;color:#0F172A;padding:28px 20px;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:470px;background:#fff;border:1px solid #E2E8F0;border-radius:18px;overflow:hidden;
        box-shadow:0 24px 48px -28px rgba(15,23,42,.4)}
  .inner{padding:40px 34px 8px;text-align:center}
  .logo{height:40px;max-width:200px;margin:0 auto 26px;display:block}
  .brand{margin:0 0 26px;font-size:17px;font-weight:800;letter-spacing:-.01em}
  .icon{width:66px;height:66px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 22px}
  h1{margin:0 0 10px;font-size:22px;font-weight:800;letter-spacing:-.01em;line-height:1.25}
  p.msg{margin:0;font-size:15px;line-height:1.65;color:#475569}
  .detail{margin:22px 0 0;padding:4px 18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;text-align:left}
  .detail>div{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid #EEF2F6;font-size:13.5px}
  .detail>div:last-child{border-bottom:0}
  .lbl{color:#64748B}
  .val{color:#0F172A;font-weight:600;text-align:right;word-break:break-word}
  .types{margin:20px 0 0;padding:16px 18px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;text-align:left}
  .types-title{margin:0 0 8px;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:#64748B;font-weight:700}
  .types ul{margin:0;padding:0;list-style:none}
  .types li{position:relative;padding:4px 0 4px 22px;font-size:14px;color:#334155}
  .types li:before{content:"";position:absolute;left:2px;top:9px;width:9px;height:5px;border-left:2px solid #0E9F6E;border-bottom:2px solid #0E9F6E;transform:rotate(-45deg)}
  .btn{display:inline-block;margin-top:26px;padding:13px 28px;border-radius:11px;color:#fff;font-weight:700;font-size:14.5px;text-decoration:none}
  .foot{padding:24px 34px 30px;text-align:center;font-size:12px;color:#64748B}
  .foot a{color:#0E9F6E;text-decoration:none;font-weight:600}
</style>
</head>
<body>
  <main class="card" role="main">
    <div class="inner">
      ${logo}
      <div class="icon" style="background:${meta.iconBg};color:${meta.accent};">${meta.icon}</div>
      <h1>${escapeHtml(meta.title)}</h1>
      <p class="msg">${escapeHtml(meta.message)}</p>
      ${detailBox}
      ${typeList}
      ${button}
    </div>
    <div class="foot">
      ${brand}${supportEmail ? ` · <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>` : ''}
    </div>
  </main>
</body>
</html>`;
}

module.exports = { renderNotificationRecipientPage, STATES };
