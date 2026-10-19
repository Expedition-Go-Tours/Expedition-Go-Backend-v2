/**
 * Transactional-email previews — shared source of truth.
 *
 * Renders every compiled template (sendgrid-templates/generated/*.html) with
 * realistic sample data. Two callers use it:
 *
 *   - the dev scripts (scripts/preview-email-template.js, preview-all.js)
 *   - the admin gallery endpoint (GET /api/admin/email-previews), which is
 *     gated by a short-lived signed token so it can be opened in a browser
 *     without an admin Bearer token.
 *
 * It lives in src/ (not scripts/) because the production image excludes
 * scripts/, and the endpoint needs this at runtime. All sample data is
 * anonymised — it is mock content, never a real customer.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { render } = require('./emailRenderer');

const GENERATED_DIR = path.join(__dirname, '..', '..', '..', 'sendgrid-templates', 'generated');

// Shell vars — mirror resolveShellVars() for the Ghana brand.
const SHELL = {
  brandName: 'Travio Ghana',
  supportEmail: 'support@travioghana.com',
  logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1789926536/TravioG_csfsyl.png',
  poweredByLabel: '',
  year: new Date().getFullYear(),
  preheader: 'New reservation TRG-48808538-2026-11, payment pending',
};

// A fully-populated SAMPLE booking so every conditional row renders. All values
// are fabricated (ada@example.com, +233 24 000 0000) — never real PII.
const SAMPLE = {
  // identity / links
  bookingNumber: 'TRG-48808538-2026-11',
  supplierReference: '',
  brandName: 'Travio Ghana',
  customerName: 'Ada Mensah',
  customerInitials: 'AM',
  // No avatar URL: the contact card falls back to the initials circle, which
  // is exactly what most accounts look like.
  customerAvatarUrl: '',
  customerEmail: 'ada@example.com',
  customerPhone: '+233 24 000 0000',
  supplierName: 'Sample Experiences Ltd',

  // lead traveler (the person going on the trip)
  leadTravelerName: 'Ada Mensah',
  leadTravelerEmail: 'ada@example.com',
  leadTravelerPhone: '+233 24 000 0000',
  leadTravelerInitials: 'AM',
  // Address used by the supplier review-invite email (lead traveller → account
  // holder → "your guest"). Mirrors the sender's resolved value.
  guestName: 'Ada Mensah',

  // experience
  tourTitle: 'Accra Flying Dress Experience',
  tourImageUrl:
    'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_1200,h_520,f_jpg,q_auto/v1787749419/user-photos/f7k7m3eeasci5xgt0csk.png',
  dateLabel: 'Wed, 4 Nov 2026',
  experienceDateLabel: 'Wed, 4 Nov 2026',
  timeLabel: '09:00',
  durationLabel: '6 hours',
  languageLabel: 'English',
  travelersLabel: '2 adults, 1 child',
  bookingTypeLabel: 'Reserve now, pay later',
  specialRequirements: 'Vegetarian meals for all travellers, please.',

  // Similar activities rail (see emailService.buildSimilarTours).
  similarTours: [
    {
      url: 'https://travioghana.com/tour/cmv2v1rxj0201i4nqlq9n1fau/jamestown-walking-tour',
      imageUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,w_480,h_480/v1787749419/user-photos/f7k7m3eeasci5xgt0csk.png',
      title: 'Jamestown & Usshertown Walking Tour',
      place: 'Accra, Ghana',
      hasRating: true,
      ratingLabel: '4.9',
      reviewCountLabel: '214 reviews',
      hasPrice: true,
      priceLabel: '$38.00',
    },
    {
      url: 'https://travioghana.com/tour/cmv2v1rxj0202i4nqlq9n1fau/accra-street-food-crawl',
      imageUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,w_480,h_480/v1787749419/user-photos/f7k7m3eeasci5xgt0csk.png',
      title: 'Accra Street Food Crawl',
      place: 'Accra, Ghana',
      hasRating: true,
      ratingLabel: '4.7',
      reviewCountLabel: '96 reviews',
      hasPrice: true,
      priceLabel: '$45.00',
    },
    {
      url: 'https://travioghana.com/tour/cmv2v1rxj0203i4nqlq9n1fau/cape-coast-castle-day-trip',
      imageUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,w_480,h_480/v1787749419/user-photos/f7k7m3eeasci5xgt0csk.png',
      title: 'Cape Coast Castle & Kakum Day Trip',
      place: 'Cape Coast, Ghana',
      hasRating: true,
      ratingLabel: '4.8',
      reviewCountLabel: '341 reviews',
      hasPrice: true,
      priceLabel: '$72.00',
    },
  ],

  // pickup
  pickupRequiredLabel: 'Yes',
  pickupIncludedLabel: 'Yes',
  pickupLocation: 'Kempinski Hotel Gold Coast City, Accra',
  pickupTime: '08:15',
  meetingPoint: 'Kempinski Hotel lobby',
  meetingTime: '08:30',
  directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=Kempinski%20Hotel%20lobby',

  // money
  totalLabel: '$385.00',
  commissionLabel: '$57.75',
  payoutAmountLabel: '$327.25',
  amountPaidLabel: '$385.00',
  amountPaidTodayLabel: '$0.00',
  scheduledPaymentLabel: '$385.00',
  paymentAmountLabel: '$385.00',
  paymentMethodLabel: 'Visa •••• 4242',
  paymentStatusLabel: 'Pending',

  // pay-later timing
  chargeDateLabel: 'Tue, 3 Nov 2026',
  chargeAtLabel: 'Tue, 3 Nov 2026, 00:15 GMT',
  chargedAtLabel: 'Tue, 3 Nov 2026, 00:15 GMT',
  bookedAtLabel: '9 Oct 2026',
  cancellationPolicyText: 'Free cancellation up to 24 hours before your experience.',
  cancelDeadlineLabel: 'November 3, 2026, 9:00 AM',
  cancellationDeadlineLabel: 'November 3, 2026, 9:00 AM',
  cancelledAtLabel: '15 Oct 2026, 20:01 GMT',
  cancellationReason: 'Severe weather in the region',
  compensationLabel: '$327.25',
  refundAmountLabel: '$385.00',
  refundReference: 're_3Qk2Lm2eZvKYlo2C1xAMPLE',
  refundedAtLabel: '15 Oct 2026, 20:05 GMT',
  statusLabel: 'Scheduled',
  payoutReference: 'po_1Qk2Lm2eZvKYlo2C1xAMPLE',
  payoutDateLabel: 'Fri, 20 Nov 2026',
  paymentDestination: 'GTBank •••• 7781',
  payoutReason: 'The bank account on file is no longer valid.',

  // links
  bookingUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau',
  tourUrl: 'https://travioghana.com/tour/cmv2v1rxj0200i4nqlq9n1fau/accra-flying-dress-experience',
  reviewUrl: 'https://travioghana.com/review/accra-flying-dress-experience?bookingId=cmv2v1rxj0200i4nqlq9n1fau&tourId=cmv2v1rxj0200i4nqlq9n1fau',
  manageUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/manage',
  managePaymentUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/payment',
  voucherUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/voucher',
  refundUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/refund',
  cancellationUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/cancellation',
  browseUrl: 'https://travioghana.com/tours',
  supportUrl: 'https://travioghana.com/support',
  supplierBookingUrl: 'https://supplier.travioghana.com/bookings?bookingId=cmv2v1rxj0200i4nqlq9n1fau',
  supplierPayoutUrl: 'https://supplier.travioghana.com/finance',
  dashboardUrl: 'https://supplier.travioghana.com/',
};

// Templates touched by the current change set — highlighted in the gallery.
const CHANGED = new Set([
  'booking-confirmed',
  'supplier-new-booking',
  'supplier-pay-later-charged',
  'supplier-review-invite',
  'refund-processing',
  'refund-completed',
  'supplier-payout-scheduled',
  'supplier-payout-completed',
  'supplier-payout-failed',
]);

// Grouping is presentation-only: first matching prefix wins, else "Other".
const GROUPS = [
  { label: 'Customer', test: (k) => !/^(supplier|admin|team|chat)-/.test(k) },
  { label: 'Supplier', test: (k) => k.startsWith('supplier-') },
  { label: 'Admin', test: (k) => k.startsWith('admin-') },
  { label: 'Team', test: (k) => k.startsWith('team-') },
  { label: 'Chat', test: (k) => k.startsWith('chat-') },
];

function groupFor(key) {
  const group = GROUPS.find((g) => g.test(key));
  return group ? group.label : 'Other';
}

function titleize(key) {
  return key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Every compiled template key, derived from the generated artifacts on disk. */
function listTemplateKeys() {
  if (!fs.existsSync(GENERATED_DIR)) return [];
  return fs
    .readdirSync(GENERATED_DIR)
    .filter((f) => f.endsWith('.html'))
    .map((f) => f.slice(0, -'.html'.length))
    .sort();
}

/**
 * Render one compiled template against the sample data. Reads the committed
 * artifact (not the builder output) so a preview always reflects what would
 * actually be sent. Throws for an unknown key.
 */
function renderTemplateDoc(key) {
  const file = path.join(GENERATED_DIR, `${key}.html`);
  if (!fs.existsSync(file)) {
    const err = new Error(`Unknown template key: ${key}`);
    err.knownKeys = listTemplateKeys();
    throw err;
  }
  return render(fs.readFileSync(file, 'utf8'), { ...SHELL, ...SAMPLE });
}

/**
 * Standalone gallery page embedding each preview in an iframe. `srcFor` /
 * `linkFor` let the caller point the iframes at per-file URLs (dev) or at the
 * token-gated admin endpoint; `changed` controls the "updated" badges.
 */
function buildGallery(keys, options = {}) {
  const srcFor = options.srcFor || ((key) => `./${key}-preview.html`);
  const linkFor = options.linkFor || ((key) => `./${key}-preview.html`);
  const changed = options.changed || CHANGED;

  const byGroup = new Map();
  for (const key of keys) {
    const group = groupFor(key);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(key);
  }

  const order = ['Customer', 'Supplier', 'Admin', 'Team', 'Chat', 'Other'];
  const sections = order
    .filter((label) => byGroup.has(label))
    .map((label) => {
      const cards = byGroup
        .get(label)
        .map((key) => {
          const isChanged = changed.has(key);
          const href = linkFor(key);
          return `
        <section class="card${isChanged ? ' changed' : ''}" id="${escapeHtml(key)}">
          <header>
            <div>
              <h3>${escapeHtml(titleize(key))}${isChanged ? ' <span class="badge">updated</span>' : ''}</h3>
              <code>${escapeHtml(key)}</code>
            </div>
            ${href ? `<a class="open" href="${escapeHtml(href)}" target="_blank" rel="noopener">Open &#8599;</a>` : ''}
          </header>
          <iframe src="${escapeHtml(srcFor(key))}" loading="lazy" title="${escapeHtml(key)}"></iframe>
        </section>`;
        })
        .join('\n');

      return `
      <h2 class="group">${escapeHtml(label)} <span class="count">${byGroup.get(label).length}</span></h2>
      <div class="grid">${cards}
      </div>`;
    })
    .join('\n');

  const updatedCount = [...changed].filter((k) => keys.includes(k)).length;
  const pageTitle = options.title || 'Transactional email gallery';
  const lede =
    options.lede ||
    `${keys.length} templates rendered with sample data. ${updatedCount} updated in the current change set.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f3f4f6;
      color: #111827;
    }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .lede { margin: 0 0 24px; color: #4b5563; }
    h2.group {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: .08em;
      color: #6b7280;
      margin: 32px 0 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e5e7eb;
    }
    .count {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 8px;
      border-radius: 999px;
      background: #e5e7eb;
      color: #374151;
      font-size: 12px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(460px, 1fr));
      gap: 20px;
    }
    .card {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,.04);
      display: flex;
      flex-direction: column;
    }
    .card.changed { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,.15); }
    .card header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid #eef0f3;
      background: #fafafa;
    }
    .card h3 { font-size: 14px; margin: 0 0 2px; }
    .card code { font-size: 11px; color: #6b7280; }
    .badge {
      display: inline-block;
      margin-left: 4px;
      padding: 1px 7px;
      border-radius: 999px;
      background: #e0e7ff;
      color: #4338ca;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .04em;
      vertical-align: middle;
    }
    .open {
      flex-shrink: 0;
      text-decoration: none;
      font-size: 12px;
      color: #4338ca;
      border: 1px solid #c7d2fe;
      border-radius: 8px;
      padding: 5px 10px;
    }
    .open:hover { background: #eef2ff; }
    iframe {
      width: 100%;
      height: 720px;
      border: 0;
      background: #f9fafb;
      display: block;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0b1120; color: #e5e7eb; }
      .lede { color: #9ca3af; }
      h2.group { color: #9ca3af; border-color: #1f2937; }
      .count { background: #1f2937; color: #d1d5db; }
      .card { background: #111827; border-color: #1f2937; }
      .card header { background: #0f172a; border-color: #1f2937; }
      .card code { color: #9ca3af; }
      .open { color: #a5b4fc; border-color: #3730a3; }
      .open:hover { background: #1e1b4b; }
      iframe { background: #030712; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(pageTitle)}</h1>
  <p class="lede">${escapeHtml(lede)}</p>
${sections}
</body>
</html>
`;
}

// ────────────────────────────────────────────────────────────────────────────
// Signed, short-lived gallery links
//
// The gallery is an admin tool, but it has to open in a plain browser (an
// <img>/<a> click, no Bearer header). So the mint endpoint (admin-authenticated)
// issues a `<expMs>.<hmac-sha256>` token with a short TTL; every read endpoint
// verifies it. Mirrors the cancellation-choice token pattern.
// ────────────────────────────────────────────────────────────────────────────

const PREVIEW_TOKEN_NAMESPACE = 'email-previews';
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;

function previewSecret() {
  return process.env.EMAIL_PREVIEW_TOKEN_SECRET || process.env.JWT_SECRET || '';
}

function previewTtlMs() {
  const raw = Number(process.env.EMAIL_PREVIEW_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREVIEW_TTL_MS;
}

/** Mint a signed gallery token. Returns null when no secret is configured. */
function signPreviewToken(ttlMs = previewTtlMs()) {
  const secret = previewSecret();
  if (!secret) return null;
  const expMs = Date.now() + ttlMs;
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${PREVIEW_TOKEN_NAMESPACE}.${expMs}`)
    .digest('base64url');
  return `${expMs}.${sig}`;
}

/** Verify a signed gallery token. Returns { expiresAt } or null. */
function verifyPreviewToken(token) {
  const secret = previewSecret();
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [expRaw, sig] = parts;
  const expMs = parseInt(expRaw, 10);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${PREVIEW_TOKEN_NAMESPACE}.${expMs}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return { expiresAt: new Date(expMs) };
}

module.exports = {
  GENERATED_DIR,
  SHELL,
  SAMPLE,
  CHANGED,
  groupFor,
  titleize,
  escapeHtml,
  listTemplateKeys,
  renderTemplateDoc,
  buildGallery,
  signPreviewToken,
  verifyPreviewToken,
  previewTtlMs,
};
