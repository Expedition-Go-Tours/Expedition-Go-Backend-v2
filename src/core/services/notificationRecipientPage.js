/**
 * Standalone result pages for the supplier notification-email links.
 *
 * These are served by the API and rendered server-side so the recipient — who
 * is not a dashboard user — never hits a login screen. Self-contained HTML with
 * inline CSS, no external assets except the brand logo.
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
    iconBg: '#ECFDF5',
    icon: ICONS.check,
    message: "You're all set. This address will now receive the notifications selected for it.",
    showRecipient: true,
  },
  unsubscribed: {
    title: "You're unsubscribed",
    accent: '#0E9F6E',
    iconBg: '#ECFDF5',
    icon: ICONS.check,
    message: 'This address will no longer receive notifications. The account owner can turn it back on at any time from their notification settings.',
    showRecipient: true,
  },
  expired: {
    title: 'This link has expired',
    accent: '#D97706',
    iconBg: '#FEF3C7',
    icon: ICONS.clock,
    message: 'This confirmation link is no longer valid. Ask the account owner to send a new confirmation from Settings → Notifications.',
    showRecipient: false,
  },
  invalid: {
    title: "This link isn't valid",
    accent: '#DC2626',
    iconBg: '#FEE2E2',
    icon: ICONS.alert,
    message: "We couldn't find that confirmation link. It may have been used already, or the link may be incomplete. Ask the account owner to send a new one from Settings → Notifications.",
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
}) {
  const meta = STATES[state] || STATES.invalid;
  const brand = escapeHtml(brandName);

  const detailRows = [];
  if (meta.showRecipient && recipientEmail) {
    detailRows.push(`<div><span style="color:#94A3B8;">Email</span><br><b>${escapeHtml(recipientEmail)}</b></div>`);
  }
  if (meta.showRecipient && supplierName) {
    detailRows.push(`<div style="margin-top:10px;"><span style="color:#94A3B8;">Account</span><br><b>${escapeHtml(supplierName)}</b></div>`);
  }
  const detail = detailRows.length
    ? `<div style="margin:22px 0 0;padding:14px 16px;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;font-size:13.5px;color:#334155;text-align:left;word-break:break-word;">${detailRows.join('')}</div>`
    : '';

  const button = (state === 'verified' || state === 'unsubscribed') && dashboardUrl
    ? `<a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;margin-top:24px;padding:13px 26px;border-radius:11px;background:${meta.accent};color:#ffffff;font-weight:700;font-size:14.5px;text-decoration:none;">Manage notification emails</a>`
    : '';

  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${brand}" style="height:38px;max-width:190px;margin:0 auto 24px;display:block;">`
    : `<p style="margin:0 0 24px;font-size:16px;font-weight:800;color:#0F172A;">${brand}</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(meta.title)} · ${brand}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#F1F5F9;color:#0F172A;padding:24px;
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  .card{width:100%;max-width:460px;background:#fff;border:1px solid #E2E8F0;border-radius:18px;overflow:hidden;
        box-shadow:0 18px 40px -22px rgba(15,23,42,.35)}
  .bar{height:6px}
  .inner{padding:40px 32px 8px;text-align:center}
  .icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
  h1{margin:0 0 10px;font-size:22px;font-weight:800;letter-spacing:-.01em}
  p.msg{margin:0;font-size:15px;line-height:1.65;color:#475569}
  .foot{padding:22px 32px 30px;text-align:center;font-size:12px;color:#94A3B8}
  .foot a{color:#0E9F6E;text-decoration:none}
</style>
</head>
<body>
  <main class="card" role="main">
    <div class="bar" style="background:${meta.accent};"></div>
    <div class="inner">
      ${logo}
      <div class="icon" style="background:${meta.iconBg};color:${meta.accent};">${meta.icon}</div>
      <h1>${escapeHtml(meta.title)}</h1>
      <p class="msg">${escapeHtml(meta.message)}</p>
      ${detail}
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
