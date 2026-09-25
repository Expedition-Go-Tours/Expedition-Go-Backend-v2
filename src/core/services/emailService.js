/**
 * Email Service — Resend + locally compiled templates.
 *
 * Every transactional email renders a compiled HTML document from
 * sendgrid-templates/generated/<key>.html using utils/emailRenderer.js and is
 * delivered through Resend (raw HTML — no cloud template sync required).
 *
 * The template keys mirror scripts/buildEmailTemplates.js so the send layer
 * and the templates can never drift apart. Legacy helpers (sendEmail,
 * sendBookingConfirmationEmail, ...) remain exported so queue workers,
 * controllers and tests keep working unchanged.
 *
 * @author Tour Platform Team
 * @version 2.0.0
 */

const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');
const prisma = require('./prismaClient');
const getConfig = require('./getConfig');
const { render } = require('./emailRenderer');
const fmt = require('./emailFormatting');
const emailUrls = require('../../../config/emailUrls');
const { resolveRecipients } = require('./notificationRecipientService');

const GENERATED_DIR = path.join(__dirname, '..', '..', '..', 'sendgrid-templates', 'generated');

// Lazy Resend client: only initialized when RESEND_API_KEY is present so tests
// and CI can require this module without a configured provider.
let resendClient = null;
let resendWarned = false;

function getResend() {
  if (!process.env.RESEND_API_KEY) {
    if (!resendWarned) {
      console.error('[Email] CRITICAL: RESEND_API_KEY is not set in environment variables');
      resendWarned = true;
    }
    return null;
  }
  if (!resendClient) resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

// ---------------------------------------------------------------------------
// Brand-aware shell values (resolved once per brand per process)
//
// Every brand's email identity lives in config/brands.js (`email` block). The
// DB/env config remains the fallback for the default brand so existing
// deployments keep rendering exactly as before.
// ---------------------------------------------------------------------------
const { getBrandEmail, BRANDS, DEFAULT_BRAND, resolveBrandKey } = require('../../../config/brands');

const shellCache = new Map();
const shellPromises = new Map();

// Fallbacks when a brand has no accent configured (matches the legacy look).
const DEFAULT_ACCENT = '#00A669';
const DEFAULT_ACCENT_DARK = '#007A4D';
const DEFAULT_ACCENT_SOFT = '#E6F6F0';

async function resolveShellVars(brandKey) {
  const brand = getBrandEmail(brandKey);
  try {
    const [cfgBrandName, cfgSupport, cfgLogo] = await Promise.all([
      getConfig('platform.name'),
      getConfig('email.support_email'),
      getConfig('email.logo_url'),
    ]);
    return {
      brandName: brand.brandName || cfgBrandName || 'Travio Africa',
      supportEmail: brand.supportEmail || cfgSupport || process.env.SUPPORT_EMAIL || 'support@travioafrica.com',
      logoUrl: brand.logoUrl || cfgLogo || process.env.LOGO_URL || '',
      poweredByLabel: brand.poweredByLabel || '',
      // Brand-aware accent so a Ghana invite looks Ghana-green, Africa its own.
      accentColor: brand.accentColor || DEFAULT_ACCENT,
      accentDark: brand.accentDark || DEFAULT_ACCENT_DARK,
      accentSoft: brand.accentSoft || DEFAULT_ACCENT_SOFT,
      year: new Date().getFullYear(),
    };
  } catch {
    return {
      brandName: brand.brandName || 'Travio Africa',
      supportEmail: brand.supportEmail || process.env.SUPPORT_EMAIL || 'support@travioafrica.com',
      logoUrl: brand.logoUrl || process.env.LOGO_URL || '',
      poweredByLabel: brand.poweredByLabel || '',
      accentColor: brand.accentColor || DEFAULT_ACCENT,
      accentDark: brand.accentDark || DEFAULT_ACCENT_DARK,
      accentSoft: brand.accentSoft || DEFAULT_ACCENT_SOFT,
      year: new Date().getFullYear(),
    };
  }
}

async function getShellVars(brandKey = null) {
  const cacheKey = brandKey || '__default__';
  if (shellCache.has(cacheKey)) return shellCache.get(cacheKey);
  if (shellPromises.has(cacheKey)) return shellPromises.get(cacheKey);

  const p = resolveShellVars(brandKey).then((vars) => {
    shellCache.set(cacheKey, vars);
    shellPromises.delete(cacheKey);
    return vars;
  });
  shellPromises.set(cacheKey, p);
  return p;
}

// ---------------------------------------------------------------------------
// Template loading + rendering
// ---------------------------------------------------------------------------
const templateCache = new Map();

function loadTemplate(key) {
  if (templateCache.has(key)) return templateCache.get(key);
  const file = path.join(GENERATED_DIR, `${key}.html`);
  if (!fs.existsSync(file)) return null;
  const html = fs.readFileSync(file, 'utf-8');
  templateCache.set(key, html);
  return html;
}

/**
 * Render a compiled template against `data` and inject shell vars.
 * Unknown vars render as '' — safe against missing optional fields.
 */
async function renderTemplate(key, data = {}, opts = {}) {
  const source = loadTemplate(key);
  if (source === null) throw new Error(`[Email] Template not found: ${key}`);
  const shell = await getShellVars(opts.brandKey || data.brandKey || null);
  const merged = {
    ...shell,
    preheader: opts.preheader || data.preheader || '',
    ...data,
  };
  return render(source, merged);
}

/**
 * Resolve the From: header for a brand. `EMAIL_FROM` (env) still wins when set,
 * so ops can override without a deploy; otherwise the brand registry's
 * `email.from` is used (falling back to Travio Africa).
 */
function parseFrom(brandKey = null) {
  const brand = getBrandEmail(brandKey);
  // Per-brand env override (EMAIL_FROM_GHANA / _EXPEDITION). The legacy
  // EMAIL_FROM stays the Africa/default override so existing config is honoured.
  const suffix = brand.key && brand.key !== 'africa' ? `_${brand.key.toUpperCase()}` : '';
  const envFrom = process.env[`EMAIL_FROM${suffix}`] || (suffix ? null : process.env.EMAIL_FROM);
  const fromRaw = envFrom || brand.from || '';
  const match = fromRaw.match(/^(.*?)\s*<([^>]+)>$/);
  return {
    from: fromRaw || 'Travio Africa <notifications@travioafrica.com>',
    email: match ? match[2].trim() : fromRaw || 'notifications@travioafrica.com',
    name: match ? match[1].trim() : 'Travio Africa',
  };
}

function normalizeAttachments(attachments = []) {
  return attachments
    .filter((a) => a && (a.content || a.path))
    .map((a) => ({
      filename: a.filename || 'attachment',
      content: a.content || a.path,
    }));
}

/**
 * Core delivery — render a compiled template and send via Resend.
 */
/**
 * Normalise a Resend tag list. Accepts [{ name, value }] and drops incomplete
 * entries so a malformed tag can never fail the send.
 */
function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((t) => t && t.name != null && t.value != null)
    .slice(0, 50)
    .map((t) => ({ name: String(t.name), value: String(t.value) }));
}

async function sendHtml({ to, subject, html, text = '', attachments = [], replyTo, inReplyTo, brandKey = null, tags, tagsByRecipient, unsubscribeUrl }) {
  // Multi-recipient fan-out: one provider call per address so each send carries
  // its own id/tags (per-recipient bounce tracking) and recipients never see
  // each other's addresses. A failure on one address never blocks the others.
  if (Array.isArray(to)) {
    const results = await Promise.allSettled(
      to.map((addr) => sendHtml({
        to: addr, subject, html, text, attachments, replyTo, inReplyTo, brandKey,
        tags: (tagsByRecipient && tagsByRecipient[addr]) || tags,
        unsubscribeUrl,
      })),
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[Email] Fan-out failed to ${to[i]}: ${r.reason?.message || r.reason}`);
      }
    });
    return { success: results.some((r) => r.status === 'fulfilled'), results };
  }

  const client = getResend();

  if (!client) {
    console.error(`[Email] Skipped send (no RESEND_API_KEY) to ${to}: ${subject}`);
    return { success: false, reason: 'no-provider', html };
  }

  try {
    const fromInfo = parseFrom(brandKey);
    // Brand-scoped Reply-To, mirroring parseFrom's EMAIL_FROM pattern:
    // EMAIL_REPLY_TO_<BRAND> wins per brand, the legacy EMAIL_REPLY_TO stays
    // the default (TravioAfrica) override, and every other brand falls back
    // to its own support inbox instead of inheriting the default's override.
    const replyBrand = getBrandEmail(brandKey);
    const replySuffix = replyBrand.key && replyBrand.key !== 'africa' ? `_${replyBrand.key.toUpperCase()}` : '';
    const envReplyTo = process.env[`EMAIL_REPLY_TO${replySuffix}`] || (replySuffix ? null : process.env.EMAIL_REPLY_TO);
    const replyToValue = replyTo || envReplyTo || replyBrand.supportEmail || null;
    const extraHeaders = {};
    if (replyToValue) extraHeaders['Reply-To'] = replyToValue;
    if (inReplyTo) extraHeaders['In-Reply-To'] = inReplyTo;
    if (unsubscribeUrl) extraHeaders['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    const tagList = normalizeTags(tags);

    // Use Resend's REST API directly for plain sends. The SDK version of this
    // request silently drops Reply-To/headers (verified against delivered raw
    // MIME) — and reply-by-email depends on that header. The SDK path is kept
    // only for attachment sends and under test.
    const useREST = attachments.length === 0 && !process.env.JEST_WORKER_ID && process.env.NODE_ENV !== 'test';
    if (useREST) {
      const payload = {
        from: fromInfo.from,
        to,
        subject,
        html,
        ...(text ? { text } : {}),
        ...(replyToValue ? { reply_to: replyToValue } : {}),
        ...(Object.keys(extraHeaders).length ? { headers: extraHeaders } : {}),
        ...(tagList.length ? { tags: tagList } : {}),
      };
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.message || `Resend send failed (${response.status})`);
      console.log(`[Email] Sent to ${to}: ${subject}`);
      return { success: true, messageId: body?.id, html };
    }

    const { data: result, error } = await client.emails.send({
      from: fromInfo.from,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(replyToValue ? { reply_to: replyToValue } : {}),
      ...(Object.keys(extraHeaders).length ? { headers: extraHeaders } : {}),
      ...(tagList.length ? { tags: tagList } : {}),
      ...(attachments.length ? { attachments: normalizeAttachments(attachments) } : {}),
    });

    if (error) throw new Error(error.message);

    console.log(`[Email] Sent to ${to}: ${subject}`);
    return { success: true, messageId: result?.id, html };
  } catch (error) {
    console.error(`[Email] Failed to send to ${to}: ${subject}`, error.message);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

async function sendRendered({ to, subject, key, data = {}, attachments = [], opts = {}, tags, tagsByRecipient, unsubscribeUrl }) {
  const brandKey = opts.brandKey || data.brandKey || null;
  const html = await renderTemplate(key, data, { ...opts, brandKey });
  return sendHtml({
    to, subject, html, text: opts.text || '', attachments,
    replyTo: opts.replyTo, inReplyTo: opts.inReplyTo, brandKey,
    tags: tags || opts.tags,
    tagsByRecipient: tagsByRecipient || opts.tagsByRecipient,
    unsubscribeUrl: unsubscribeUrl || opts.unsubscribeUrl,
  });
}

/**
 * Generic send — accepts a template key (compiled) or a legacy template name.
 * Legacy names without a compiled document fall back to inline generation so
 * account/status emails (team invites, supplier status, notifications) keep
 * working without cloud templates.
 */
async function sendEmail({ to, subject, template, data = {}, attachments = [], opts = {}, tags, tagsByRecipient, unsubscribeUrl }) {
  if (template && loadTemplate(template)) {
    return sendRendered({ to, subject, key: template, data, attachments, opts, tags, tagsByRecipient, unsubscribeUrl });
  }
  // Legacy / inline path
  const content = generateEmailContent(template, data);
  if (content && content.html) {
    // brandKey resolves from opts first, then the payload — mirrors
    // renderTemplate so a queued email carrying data.brandKey renders (and
    // sends From:) with the same identity as a direct call with opts.
    const brandKey = opts?.brandKey || data?.brandKey || null;
    const shell = await getShellVars(brandKey);
    const merged = { ...shell, year: shell.year, ...data };
    let html = content.html;
    for (const [k, v] of Object.entries(merged)) {
      html = html.split(`{{${k}}}`).join(v == null ? '' : String(v));
    }
    return sendHtml({
      to, subject, html, text: content.text || '', attachments,
      replyTo: opts?.replyTo, inReplyTo: opts?.inReplyTo, brandKey,
      tags: tags || opts?.tags,
      tagsByRecipient: tagsByRecipient || opts?.tagsByRecipient,
      unsubscribeUrl: unsubscribeUrl || opts?.unsubscribeUrl,
    });
  }
  throw new Error(`[Email] No template or inline generator for: ${template}`);
}

/**
 * Resolve the audience for a supplier email.
 *
 * Returns { to, tagsByRecipient } ready to spread into sendRendered/sendEmail.
 * `supplierOrId` may be a supplier object (with `id`) or a supplier/user id.
 * When no id is available it degrades to the single supplier email, matching
 * the pre-existing behaviour.
 */
async function supplierRecipientList(supplierOrId, category) {
  const supplierId = typeof supplierOrId === 'string' ? supplierOrId : supplierOrId?.id;
  if (!supplierId) {
    const email = typeof supplierOrId === 'object' ? supplierOrId?.email : null;
    const normalized = email ? String(email).trim().toLowerCase() : null;
    return { to: normalized ? [normalized] : [], tagsByRecipient: {} };
  }
  const recipients = await resolveRecipients(supplierId, category);
  const tagsByRecipient = {};
  for (const r of recipients) {
    if (r.recipientId) {
      tagsByRecipient[r.email] = [{ name: 'notification_recipient', value: r.recipientId }];
    }
  }
  return { to: recipients.map((r) => r.email), tagsByRecipient };
}

/**
 * Double opt-in confirmation for an additional supplier notification address.
 * Sent directly to the address (never through supplierRecipientList).
 */
async function sendNotificationRecipientVerificationEmail({ to, supplierName, verifyUrl, types, expiresInDays = 7, brandKey = null }) {
  const name = supplierName || 'this supplier';
  return sendEmail({
    to,
    subject: `Confirm your email to receive ${name} notifications`,
    template: 'notification-recipient-verify',
    opts: { brandKey },
    data: {
      supplierName: name,
      confirmUrl: verifyUrl,
      types: Array.isArray(types) ? types : [],
      expiresInDays,
      recipientEmail: to,
    },
  });
}

// ---------------------------------------------------------------------------
// Booking context resolution + shared data assembly
// ---------------------------------------------------------------------------
const BOOKING_CONTEXT_INCLUDE = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  tour: {
    select: {
      id: true,
      title: true,
      description: true,
      photos: true,
      productContent: true,
      bookingAndTickets: true,
      categorization: true,
      durationMinutes: true,
      supplier: { select: { id: true, name: true, email: true, phone: true } },
    },
  },
};

/**
 * Resolve a booking to include customer + tour + supplier. Accepts either an
 * already-enriched booking (queue workers pass includes) or a plain object /
 * id — missing relations are fetched.
 */
async function resolveBookingContext(bookingOrId) {
  let booking = typeof bookingOrId === 'string' ? { id: bookingOrId } : bookingOrId;
  if (typeof bookingOrId === 'string' || !booking.customer || !booking.tour) {
    booking = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: BOOKING_CONTEXT_INCLUDE,
    });
  }
  if (!booking) throw new Error(`Booking not found: ${bookingOrId?.id ?? bookingOrId}`);
  return booking;
}

function paymentStatusLabel(status) {
  const map = {
    PENDING: 'Pending',
    PROCESSING: 'Processing',
    SUCCEEDED: 'Paid',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
    REFUNDED: 'Refunded',
  };
  return map[status] || 'Pending';
}

/**
 * Resolve which brand's email identity an email should use.
 *
 * Priority (first signal that maps to a known brand wins):
 *   - explicit brandKey
 *   - booking.source        (GHANA / EXPEDITION / TRAVIO_AFRICA)
 *   - supplier / user roles (ghana / travioafrica)
 *   - conversation.brand    (chat)
 * Falls back to the default brand (Africa) so nothing ever renders unbranded.
 */
function resolveEmailBrand({ brandKey, booking, supplier, user, conversation } = {}) {
  if (brandKey) return resolveBrandKey(brandKey);

  const fromSource = booking && booking.source;
  if (fromSource) {
    const hit = Object.values(BRANDS).find((b) => b.source === fromSource);
    if (hit) return hit.key;
  }

  const rec = supplier && supplier.supplier ? supplier.supplier : supplier;
  const roles = (user && user.roles) || (rec && rec.roles) || (conversation && conversation.brand ? [] : null);
  if (Array.isArray(roles)) {
    // Suppliers enabled on the Expedition sub-store carry both `ghana` and
    // `expedition` — Ghana wins so supplier mail keeps the Travio Ghana
    // supplier-dashboard identity. Expedition-only users (storefront
    // customers / ops) resolve to the Expedition brand instead of the default.
    if (roles.includes('ghana')) return 'ghana';
    if (roles.includes('travioafrica')) return 'africa';
    if (roles.includes('expedition')) return 'expedition';
  }

  if (conversation && conversation.brand) return resolveBrandKey(conversation.brand);

  return DEFAULT_BRAND;
}

/**
 * Shared booking data used by every booking-scoped template.
 * Callers can override any field afterwards.
 */
async function buildBookingBase(booking, opts = {}) {
  const brandKey = resolveEmailBrand({ brandKey: opts.brandKey, booking, supplier: booking && booking.tour && booking.tour.supplier });
  const shell = await getShellVars(brandKey);
  const customer = booking.customer || {};
  const tour = booking.tour || {};
  const supplier = tour.supplier || {};
  const travelers = fmt.formatTravelers(booking.travelers);
  const pickup = fmt.getPickupInfo(booking, tour);
  const currency = booking.currency || 'USD';

  // Lead traveler (entered on the storefront) is available to templates as
  // separate fields, but confirmation emails are still sent to (and address)
  // the booking-owner account — see customerEmail/customerName below.
  const leadName = booking.leadTravelerName || '';
  const leadEmail = booking.leadTravelerEmail || '';
  const leadPhone = booking.leadTravelerPhone || '';

  const paidNow = booking.paymentTiming !== 'later';
  const amountPaid =
    booking.paymentStatus === 'SUCCEEDED' || booking.paymentStatus === 'REFUNDED'
      ? Number(booking.grossAmount)
      : paidNow
        ? Number(booking.grossAmount)
        : 0;

  // Customer links point at the storefront the booking was made on.
  const clientOrigin = emailUrls.bookingClientOrigin(booking);

  const base = {
    // Which brand identity this email renders as. Read by renderTemplate /
    // sendRendered (opts.brandKey wins) so callers don't have to thread it.
    brandKey,
    poweredByLabel: shell.poweredByLabel || '',
    // identity — account holder (the recipient / addressee of emails)
    customerName: customer.name || 'Guest',
    customerEmail: customer.email || '',
    customerPhone: fmt.travelerPhone(booking.travelers) || customer.phone || '',
    customerLocation: fmt.travelerLocation(booking.travelers) || customer.location || '',
    // Lead traveler (the person going on the trip) — for templates that want it
    leadTravelerName: leadName || customer.name || '',
    leadTravelerEmail: leadEmail || customer.email || '',
    leadTravelerPhone: leadPhone || fmt.travelerPhone(booking.travelers) || customer.phone || '',
    supplierName: supplier.name || '',
    supplierContact: supplier.phone || supplier.email || '',
    brandSubtext: `by ${shell.brandName}`,

    // booking
    bookingNumber: booking.bookingNumber,
    tourTitle: tour.title || '',
    tourDescription: tour.description || '',
    dateLabel: fmt.formatLongDate(booking.travelDate),
    timeLabel: fmt.formatTime(booking.selectedTime),
    durationLabel: fmt.getDurationLabel(tour),
    travelersLabel: travelers.label,
    languageLabel: fmt.getLanguageLabel(tour),
    bookingTypeLabel: fmt.getBookingTypeLabel(tour),
    specialRequirements: booking.specialRequests || '',

    // pickup / meeting
    pickupIncludedLabel: pickup.pickupIncluded ? 'Yes' : 'No',
    pickupRequiredLabel: pickup.pickupLater ? 'Yes — pending' : (pickup.pickupIncluded ? 'Yes' : 'No'),
    pickupLater: !!pickup.pickupLater,
    pickupLocation: pickup.pickupLocation,
    pickupTime: pickup.pickupTime,
    pickupInstructions: pickup.pickupInstructions,
    meetingPoint: pickup.meetingPoint,
    meetingTime: pickup.meetingTime,
    locationLabel: pickup.locationLabel,
    directionsUrl: emailUrls.getDirections(pickup.locationLabel || pickup.meetingPoint) || '',

    // money
    currency,
    totalLabel: fmt.formatCurrency(booking.grossAmount, currency),
    subtotalLabel: fmt.formatCurrency(booking.subtotal, currency),
    taxesLabel: fmt.formatCurrency(booking.taxes, currency),
    amountPaidLabel: fmt.formatCurrency(amountPaid, currency),
    amountPaidTodayLabel: fmt.formatCurrency(paidNow ? amountPaid : 0, currency),
    scheduledPaymentLabel: fmt.formatCurrency(paidNow ? 0 : Number(booking.grossAmount), currency),
    paymentStatusLabel: paymentStatusLabel(booking.paymentStatus),
    paymentMethodLabel: '',
    commissionLabel: fmt.formatCurrency(booking.platformCommission, currency),
    payoutAmountLabel: fmt.formatCurrency(booking.supplierPayout, currency),

    // customer URLs — point at the storefront the booking was made on
    bookingUrl: emailUrls.viewBooking(booking.id, clientOrigin),
    voucherUrl: emailUrls.downloadVoucher(booking.id, clientOrigin),
    manageUrl: emailUrls.manageBooking(booking.id, clientOrigin),
    managePaymentUrl: emailUrls.managePaymentMethod(booking.id, clientOrigin),
    pickupUrl: emailUrls.addPickupLocation(booking.id, clientOrigin),
    reviewUrl: emailUrls.writeReview(booking.id, clientOrigin, tour.slug, tour.id),
    refundUrl: emailUrls.viewRefund(booking.id, clientOrigin),
    cancellationUrl: emailUrls.viewCancellation(booking.id, clientOrigin),
    browseUrl: emailUrls.browseExperiences(clientOrigin),
    supportUrl: emailUrls.contactSupport(clientOrigin),

    // supplier URLs
    supplierBookingUrl: emailUrls.supplierViewBooking(booking.id),
    supplierPayoutUrl: emailUrls.supplierPayouts(),
    dashboardUrl: emailUrls.supplierDashboard(),
  };

  return base;
}

// ---------------------------------------------------------------------------
// Customer emails
// ---------------------------------------------------------------------------

async function sendBookingConfirmedEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const ticket = b.tour?.bookingAndTickets || {};
  const data = {
    ...base,
    cancellationPolicyText:
      (typeof ticket.cancellationPolicy === 'object' && ticket.cancellationPolicy.text) ||
      (typeof ticket.cancellationPolicy === 'string' && ticket.cancellationPolicy) ||
      'Free cancellation up to 24 hours before your experience.',
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Booking Confirmed — ${base.tourTitle} (Ref: ${base.bookingNumber})`,
    key: 'booking-confirmed',
    data,
  });
}

async function sendReserveLaterConfirmedEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    paymentDateLabel: fmt.formatLongDate(b.travelDate),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Your booking is confirmed — payment scheduled (Ref: ${base.bookingNumber})`,
    key: 'reserve-later-confirmed',
    data,
  });
}

async function sendPaymentReminderEmail(booking, { paymentDate, paymentAmount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    paymentAmountLabel: fmt.formatCurrency(paymentAmount ?? b.grossAmount, b.currency),
    paymentDateLabel: fmt.formatLongDate(paymentDate || b.travelDate),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Upcoming payment for your booking',
    key: 'payment-reminder',
    data,
  });
}

async function sendPaymentSuccessfulEmail(booking, { paymentReference, amount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const paid = Number(amount ?? b.grossAmount);
  const outstanding = Math.max(0, Number(b.grossAmount) - paid);
  const data = {
    ...base,
    paymentReference: paymentReference || b.bookingNumber || '',
    paymentAmountLabel: fmt.formatCurrency(paid, b.currency),
    outstandingBalanceLabel: fmt.formatCurrency(outstanding, b.currency),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Payment received — ${base.tourTitle} (Ref: ${base.bookingNumber})`,
    key: 'payment-successful',
    data,
  });
}

async function sendPayLaterChargedEmail(booking, { paymentReference, chargedAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    amountChargedLabel: base.totalLabel,
    paymentReference: paymentReference || b.bookingNumber || '',
    chargedAtLabel: fmt.formatLongDate(chargedAt || b.paidAt || new Date()),
    paymentStatusLabel: 'Paid',
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Your reservation is confirmed — payment collected (Ref: ${base.bookingNumber})`,
    key: 'pay-later-charged',
    data,
  });
}

// Manual-confirmation tours: payment landed but the booking is NOT confirmed
// yet — the supplier must accept it first. The customer is told payment was
// received and confirmation is pending.
async function sendAwaitingConfirmationEmail(booking, { paymentReference, paidAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    amountPaidLabel: base.totalLabel,
    paymentReference: paymentReference || b.bookingNumber || '',
    paidAtLabel: fmt.formatLongDate(paidAt || b.paidAt || new Date()),
    paymentStatusLabel: 'Paid',
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Payment received — awaiting confirmation (Ref: ${base.bookingNumber})`,
    key: 'awaiting-confirmation',
    data,
  });
}

async function sendPaymentUnsuccessfulEmail(booking, { deadline, amount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    paymentAmountLabel: fmt.formatCurrency(amount ?? b.grossAmount, b.currency),
    deadlineLabel: fmt.formatLongDate(deadline || b.travelDate),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Action required: We couldn\u2019t process your payment',
    key: 'payment-unsuccessful',
    data,
  });
}

async function sendCustomerBookingChangedEmail(booking, { changes = [], previousTotal, adjustment, newTotal } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const currency = b.currency || 'USD';
  const data = {
    ...base,
    changes,
    previousTotalLabel: fmt.formatCurrency(previousTotal ?? b.grossAmount, currency),
    adjustmentLabel: fmt.formatCurrency(adjustment ?? 0, currency),
    newTotalLabel: fmt.formatCurrency(newTotal ?? b.grossAmount, currency),
    paymentStatusLabel: paymentStatusLabel(b.paymentStatus),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your booking has been updated',
    key: 'customer-booking-changed',
    data,
  });
}

async function sendPickupDetailsUpdatedEmail(booking, { previousPickupLocation = '' } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    previousPickupLocation,
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your pickup information has been updated',
    key: 'pickup-details-updated',
    data,
  });
}

async function sendPickupLocationRequiredEmail(booking, { deadline } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    deadlineLabel: fmt.formatLongDate(deadline || b.travelDate),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Action required: Add your pickup location',
    key: 'pickup-location-required',
    data,
  });
}

async function sendBookingReminderEmail(booking, { items = [] } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const ticket = b.tour?.bookingAndTickets || {};
  const product = b.tour?.productContent || {};
  const reminderItems =
    items.length > 0
      ? items
      : [
          ...(product.whatToBring || []).slice(0, 5),
          ...(ticket.checkInProcess ? [`Check-in: ${ticket.checkInProcess}`] : []),
        ];
  const data = {
    ...base,
    items: reminderItems,
    supplierContact: b.tour?.supplier?.phone || b.tour?.supplier?.email || '',
  };
  return sendRendered({
    to: base.customerEmail,
    subject: `Reminder: ${base.tourTitle} on ${fmt.formatShortDate(b.travelDate)}`,
    key: 'booking-reminder',
    data,
  });
}

async function sendCustomerCancelledFullRefundEmail(booking, { cancelledAt, refundAmount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    cancelledAtLabel: fmt.formatDateTime(cancelledAt || b.cancelledAt || new Date()),
    cancellationReason: b.cancellationReason || '',
    refundAmountLabel: fmt.formatCurrency(refundAmount ?? b.refundAmount ?? b.grossAmount, b.currency),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your booking has been cancelled',
    key: 'customer-cancelled-full-refund',
    data,
  });
}

async function sendCustomerCancelledNoRefundEmail(booking, { cancelledAt, cancellationFee, refundAmount = 0 } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const deadline = fmt.getCancelDeadline(b, b.tour || {});
  const data = {
    ...base,
    cancelledAtLabel: fmt.formatDateTime(cancelledAt || b.cancelledAt || new Date()),
    cancellationDeadlineLabel: fmt.formatDateTime(deadline),
    cancellationFeeLabel: fmt.formatCurrency(cancellationFee ?? b.grossAmount, b.currency),
    refundAmountLabel: fmt.formatCurrency(refundAmount ?? 0, b.currency),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your booking has been cancelled',
    key: 'customer-cancelled-no-refund',
    data,
  });
}

async function sendRefundProcessingEmail(booking, { refundReference } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    refundAmountLabel: fmt.formatCurrency(b.refundAmount ?? b.grossAmount, b.currency),
    refundReference: refundReference || '',
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your refund is being processed',
    key: 'refund-processing',
    data,
  });
}

async function sendRefundCompletedEmail(booking, { refundReference, refundedAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const data = {
    ...base,
    refundAmountLabel: fmt.formatCurrency(b.refundAmount ?? b.grossAmount, b.currency),
    refundReference: refundReference || '',
    refundedAtLabel: fmt.formatDateTime(refundedAt || b.refundedAt || new Date()),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Your refund has been issued',
    key: 'refund-completed',
    data,
  });
}

async function sendSupplierChangedBookingEmail(booking, { changes = [], changeReason, needsAcceptance = false } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const origin = emailUrls.bookingClientOrigin(b);
  const data = {
    ...base,
    changes,
    changeReason: changeReason || '',
    needsAcceptance,
    acceptUrl: emailUrls.manageBooking(b.id, origin),
    rescheduleUrl: emailUrls.manageBooking(b.id, origin),
    cancelUrl: emailUrls.viewCancellation(b.id, origin),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Important update to your booking',
    key: 'supplier-changed-booking',
    data,
  });
}

async function sendSupplierCancelledBookingEmail(booking, { reason, refundAmount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const origin = emailUrls.bookingClientOrigin(b);

  // Refund state is the authoritative label — never a hardcoded "Processing".
  const refundStatusLabel = {
    PENDING: 'Processing',
    PROCESSING: 'Processing',
    SUCCEEDED: 'Completed',
    FAILED: 'Failed — our team has been alerted and will retry',
    NOT_APPLICABLE: 'No refund due (booking was unpaid)',
  }[b.refundStatus] || (b.refundStatus ? b.refundStatus : 'Processing');

  // Supplier-caused cancels open the reschedule-or-refund window.
  const openChoice =
    b.status === 'CANCELLED' &&
    b.cancellationOrigin === 'SUPPLIER' &&
    b.cancellationChoiceDeadline &&
    !b.customerChoice;

  const data = {
    ...base,
    cancellationReason: reason || b.cancellationReason || '',
    refundAmountLabel: fmt.formatCurrency(refundAmount ?? b.refundAmount ?? b.grossAmount, b.currency),
    refundStatusLabel,
    ...(openChoice
      ? {
          choiceUrl: emailUrls.cancellationChoice(
            require('./cancellationReasons').signChoiceToken(b.id, b.cancellationChoiceDeadline),
            origin
          ),
          choiceDeadlineLabel: fmt.formatDateTime(b.cancellationChoiceDeadline),
        }
      : {}),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Important: Your booking has been cancelled',
    key: 'supplier-cancelled-booking',
    data,
  });
}

/**
 * To the SUPPLIER: the 25%-of-retail cancellation fee created by an
 * operational cancel, and the reminder that it nets off their next payout.
 */
async function sendSupplierCancellationFeeEmail(booking, { feeAmount } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const fee = feeAmount ?? (b.cancellationFee != null ? Number(b.cancellationFee) : 0);
  const feePct = process.env.SUPPLIER_CANCELLATION_FEE_PCT || '25';
  const data = {
    ...base,
    feeAmountLabel: fmt.formatCurrency(fee, b.currency),
    feePctLabel: `${feePct}%`,
    grossAmountLabel: fmt.formatCurrency(b.grossAmount, b.currency),
    refundAmountLabel: fmt.formatCurrency(b.refundAmount ?? b.grossAmount, b.currency),
    payoutsUrl: emailUrls.supplierEarnings(),
    reasonLabel: b.cancellationReason || '',
  };
  return sendRendered({
    to: supplier.email,
    subject: `Cancellation fee applied — booking ${b.bookingNumber}`,
    key: 'supplier-cancellation-fee',
    data,
  });
}

async function sendReviewRequestEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const origin = emailUrls.bookingClientOrigin(b);
  const data = {
    ...base,
    reviewUrl: emailUrls.writeReview(b.id, origin, b.tour?.slug, b.tour?.id),
    browseUrl: emailUrls.browseExperiences(origin),
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'How was your experience?',
    key: 'review-request',
    data,
  });
}

/**
 * Notifies the customer (by email) that an operator replied to their review.
 * Booking worker include carries `review` (id/supplierResponse/…); the CTA goes
 * to the tour page's reviews anchor so the customer sees the public reply.
 */
async function sendSupplierResponseEmail(booking) {
  const b = await resolveBookingContext(booking);
  const review = b.review || {};
  const tourTitle = b.tour?.title || 'your trip';
  const origin = emailUrls.bookingClientOrigin(b);
  const slug = b.tour?.slug || b.tour?.id || '';
  const tourUrl = `${origin}/tour/${encodeURIComponent(slug)}#reviews`;
  const reply = (review.supplierResponse || '').trim();
  const brandKey = resolveEmailBrand({ booking: b, supplier: b.tour?.supplier });

  return sendEmail({
    to: b.customer?.email,
    subject: `An operator responded to your review of "${tourTitle}"`,
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      header: `The operator responded to your review of "${tourTitle}"`,
      message: reply
        ? `"${reply}"`
        : 'An operator responded to your review. See their response on the tour page.',
      buttonUrl: tourUrl,
      buttonText: 'See the response',
      userName: b.customer?.name,
    },
  });
}

// ---------------------------------------------------------------------------
// Supplier emails
// ---------------------------------------------------------------------------

async function sendSupplierNewBookingEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    supplierName: supplier.name || 'Supplier',
    customerEmail: base.customerEmail,
    customerPhone: base.customerPhone,
    totalLabel: base.totalLabel,
    commissionLabel: base.commissionLabel,
    payoutAmountLabel: base.payoutAmountLabel,
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `New confirmed booking — ${base.tourTitle} (Ref: ${base.bookingNumber})`,
    key: 'supplier-new-booking',
    data,
  });
}

async function sendSupplierPayLaterChargedEmail(booking, { paymentReference, chargedAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    supplierName: supplier.name || 'Supplier',
    customerEmail: base.customerEmail,
    customerPhone: base.customerPhone,
    totalLabel: base.totalLabel,
    commissionLabel: base.commissionLabel,
    payoutAmountLabel: base.payoutAmountLabel,
    paymentReference: paymentReference || b.bookingNumber || '',
    chargedAtLabel: fmt.formatLongDate(chargedAt || b.paidAt || new Date()),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `Reservation payment collected — booking confirmed (Ref: ${base.bookingNumber})`,
    key: 'supplier-pay-later-charged',
    data,
  });
}

async function sendSupplierBookingChangedEmail(booking, { changes = [], previousPayout, newPayout, payoutAdjustment } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const currency = b.currency || 'USD';
  const data = {
    ...base,
    changes,
    previousPayoutLabel: fmt.formatCurrency(previousPayout ?? b.supplierPayout, currency),
    newPayoutLabel: fmt.formatCurrency(newPayout ?? b.supplierPayout, currency),
    payoutAdjustmentLabel: fmt.formatCurrency(payoutAdjustment ?? 0, currency),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'A confirmed booking has been updated',
    key: 'supplier-booking-changed',
    data,
  });
}

async function sendSupplierContactUpdatedEmail(booking, { customerPhone, customerEmail, emergencyContact } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    customerPhone: customerPhone || base.customerPhone,
    customerEmail: customerEmail || base.customerEmail,
    emergencyContact: emergencyContact || '',
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'Traveller details have changed',
    key: 'supplier-customer-contact-updated',
    data,
  });
}

async function sendSupplierPickupUpdatedEmail(booking, { previousPickupLocation = '' } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    previousPickupLocation,
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'Customer pickup location updated',
    key: 'supplier-pickup-updated',
    data,
  });
}

async function sendSupplierPickupRequiredEmail(booking, { deadline } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const origin = emailUrls.bookingClientOrigin(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    deadlineLabel: fmt.formatLongDate(deadline || b.travelDate),
    pickupUrl: emailUrls.addPickupLocation(b.id, origin),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `Action required: Confirm pickup for booking ${base.bookingNumber}`,
    key: 'supplier-pickup-required',
    data,
  });
}

async function sendSupplierBookingReminderEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `Upcoming booking: ${base.tourTitle} (${fmt.formatShortDate(b.travelDate)})`,
    key: 'supplier-booking-reminder',
    data,
  });
}

async function sendSupplierCustomerCancelledFreeEmail(booking, { cancelledAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    cancelledAtLabel: fmt.formatDateTime(cancelledAt || b.cancelledAt || new Date()),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'Booking cancelled — do not operate',
    key: 'supplier-customer-cancelled-free',
    data,
  });
}

async function sendSupplierCustomerCancelledLateEmail(booking, { cancelledAt } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const deadline = fmt.getCancelDeadline(b, b.tour || {});
  const data = {
    ...base,
    cancelledAtLabel: fmt.formatDateTime(cancelledAt || b.cancelledAt || new Date()),
    cancellationDeadlineLabel: fmt.formatDateTime(deadline),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'Late customer cancellation',
    key: 'supplier-customer-cancelled-late',
    data,
  });
}

async function sendSupplierPlatformCancelledEmail(booking, { reason, compensation } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    cancellationReason: reason || b.cancellationReason || '',
    compensationLabel: fmt.formatCurrency(compensation ?? 0, b.currency),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `Booking cancelled by ${data.brandName || 'Travio Africa'}`,
    key: 'supplier-platform-cancelled',
    data,
  });
}

async function sendSupplierCancellationRecordedEmail(booking, { reason } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const data = {
    ...base,
    cancellationReason: reason || b.cancellationReason || '',
    refundAmountLabel: fmt.formatCurrency(b.refundAmount ?? b.grossAmount, b.currency),
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: 'Supplier cancellation confirmed',
    key: 'supplier-cancellation-recorded',
    data,
  });
}

async function sendSupplierPayoutScheduledEmail({ booking, payout, payoutDate } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const currency = b.currency || 'USD';
  const data = {
    ...base,
    payoutAmountLabel: fmt.formatCurrency(payout?.amount ?? b.supplierPayout, currency),
    payoutReference: payout?.id || payout?.reference || '',
    payoutDateLabel: fmt.formatLongDate(payoutDate || payout?.date),
    paymentDestination: payout?.methodLabel || payout?.destination || '',
    statusLabel: 'Scheduled',
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "payments"),
    subject: 'Your payout is scheduled',
    key: 'supplier-payout-scheduled',
    data,
  });
}

async function sendSupplierPayoutCompletedEmail({ booking, payout, payoutDate } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const currency = b.currency || 'USD';
  const data = {
    ...base,
    payoutAmountLabel: fmt.formatCurrency(payout?.amount ?? b.supplierPayout, currency),
    payoutReference: payout?.id || payout?.reference || '',
    payoutDateLabel: fmt.formatLongDate(payoutDate || payout?.date),
    paymentDestination: payout?.methodLabel || payout?.destination || '',
    statusLabel: 'Completed',
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "payments"),
    subject: 'Your payout has been sent',
    key: 'supplier-payout-completed',
    data,
  });
}

async function sendSupplierPayoutFailedEmail({ booking, payout, reason } = {}) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const supplier = b.tour?.supplier || {};
  const currency = b.currency || 'USD';
  const data = {
    ...base,
    payoutAmountLabel: fmt.formatCurrency(payout?.amount ?? b.supplierPayout, currency),
    payoutReason: reason || payout?.failureReason || '',
  };
  return sendRendered({
    ...await supplierRecipientList(supplier, "payments"),
    subject: 'Action required: Payout unsuccessful',
    key: 'supplier-payout-failed',
    data,
  });
}

// ---------------------------------------------------------------------------
// Product submission / update review notifications
// ---------------------------------------------------------------------------

/**
 * Confirmation to the supplier after a brand-new product is submitted for
 * review. `tour` is expected to carry its `supplier` relation.
 */
async function sendSupplierProductSubmittedEmail(tour) {
  const supplier = tour?.supplier || {};
  const { to, tagsByRecipient } = await supplierRecipientList(supplier, 'systemAlerts');
  if (!to.length) return { success: false, reason: 'no-recipient' };

  const brandKey = resolveEmailBrand({ supplier });

  return sendRendered({
    to,
    tagsByRecipient,
    subject: 'Your product has been submitted for review',
    key: 'supplier-product-submitted',
    opts: { brandKey },
    data: {
      supplierName: supplier.name || 'Supplier',
      tourTitle: tour.title || 'your product',
      supplierProductsUrl: emailUrls.supplierProductsForUser(supplier),
    },
  });
}

/**
 * Confirmation to the supplier after an update to a live product is submitted
 * for review. `tour` is expected to carry its `supplier` relation.
 */
async function sendSupplierProductUpdateSubmittedEmail(tour) {
  const supplier = tour?.supplier || {};
  const { to, tagsByRecipient } = await supplierRecipientList(supplier, 'systemAlerts');
  if (!to.length) return { success: false, reason: 'no-recipient' };

  const brandKey = resolveEmailBrand({ supplier });

  return sendRendered({
    to,
    tagsByRecipient,
    subject: 'Your product update is under review',
    key: 'supplier-product-update-submitted',
    opts: { brandKey },
    data: {
      supplierName: supplier.name || 'Supplier',
      tourTitle: tour.title || 'your product',
      supplierProductUrl: emailUrls.supplierProductForUser(tour.id, supplier),
    },
  });
}

// ---------------------------------------------------------------------------
// Finance v2 — payout request + dispute emails (generic inline template)
// ---------------------------------------------------------------------------

async function sendFinancePayoutRequestEmail(eventType, request) {
  const fmtAmount = `${parseFloat(request.amount).toFixed(2)} ${request.currency}`;
  const supplier = request.supplier || {};
  const config = {
    'payout-request-submitted': {
      subject: `Payout request received — ${fmtAmount}`,
      heading: 'Payout Request Received',
      message: `We received your payout request ${request.requestNumber} for ${fmtAmount} covering ${request.bookingCount} booking(s) from the "${request.cycleLabel}" cycle. Our team will review and process it shortly.`,
    },
    'payout-request-approved': {
      subject: `Payout approved — ${fmtAmount}`,
      heading: 'Payout Approved',
      message: `Your payout request ${request.requestNumber} has been approved. The transfer of ${fmtAmount} to your registered payout method is being arranged.`,
    },
    'payout-completed': {
      subject: `Payout sent — ${fmtAmount}`,
      heading: 'Your Payout Has Been Sent',
      message: `Your payout of ${fmtAmount} (${request.requestNumber}) has been sent.${request.reference ? ` Transaction reference: ${request.reference}.` : ''} Funds typically arrive within 1–3 business days.`,
    },
  }[eventType];
  if (!config) throw new Error(`Unknown finance email event: ${eventType}`);

  const brandKey = resolveEmailBrand({ supplier });

  return sendEmail({
    ...await supplierRecipientList(supplier, "payments"),
    subject: config.subject,
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      header: config.heading,
      message: config.message,
      supplierBusinessName: supplier.name || '',
    },
  });
}

async function sendDisputeOpenedEmail(dispute) {
  const booking = dispute.booking || {};
  const tour = booking.tour || {};
  const supplier = dispute.supplier || {};
  const brandKey = resolveEmailBrand({ supplier });
  return sendEmail({
    ...await supplierRecipientList(supplier, "bookings"),
    subject: `Refund request received - ${dispute.disputeNumber}`,
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      header: 'Refund Request Submitted',
      message: `Your refund request ${dispute.disputeNumber} (reason: ${(dispute.reason || '').replace(/_/g, ' ').toLowerCase()}) for booking ${booking.bookingNumber || ''} - "${tour.title || ''}" has been submitted for review. Payouts for this booking are on hold until a decision is made. We will notify you as soon as it is resolved.`,
      supplierBusinessName: supplier.name || '',
    },
  });
}

// ---------------------------------------------------------------------------
// Legacy helpers (keep the pre-Resend API surface intact)
// ---------------------------------------------------------------------------

async function sendBookingConfirmationEmail(booking) {
  try {
    return await sendBookingConfirmedEmail(booking);
  } catch (error) {
    console.error('Booking confirmation email failed:', error);
  }
}

async function sendBookingCancellationEmail(booking, refundAmount = null) {
  try {
    const hasRefund = Number(refundAmount) > 0;
    if (hasRefund) return await sendCustomerCancelledFullRefundEmail(booking, { refundAmount });
    return await sendCustomerCancelledNoRefundEmail(booking);
  } catch (error) {
    console.error('Booking cancellation email failed:', error);
    throw error;
  }
}

async function sendSupplierStatusEmail(email, status, data = {}) {
  // Callers pass the supplier's `roles` (or an explicit `brandKey`) so the
  // shell, From: header, welcome heading and dashboard link all match the
  // supplier's brand instead of defaulting to TravioAfrica.
  const brandKey = data.brandKey
    || (Array.isArray(data.roles) ? resolveEmailBrand({ user: { roles: data.roles } }) : null);
  const brandName = getBrandEmail(brandKey).brandName;
  const dashboardUrl = emailUrls.supplierDashboardForUser({ roles: data.roles });

  const statusConfig = {
    APPROVED: { subject: 'Supplier Application Approved - Welcome!', heading: `Welcome to ${brandName}` },
    REJECTED: { subject: 'Supplier Application Update', heading: 'Application Update' },
    UNDER_REVIEW: { subject: 'Additional Information Required', heading: 'Action Required' },
    ACTIVE: { subject: 'Supplier Account Activated', heading: 'Your account is active' },
    SUSPENDED: { subject: 'Supplier Account Suspended', heading: 'Account Suspended' },
  };
  const config = statusConfig[status];
  if (!config) throw new Error(`Unknown supplier status: ${status}`);

  return sendEmail({
    to: email,
    subject: config.subject,
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      ...data,
      brandKey,
      header: config.heading,
      message: data.message || `Your supplier account status has changed to ${status}.`,
      buttonText: 'Open dashboard',
      buttonUrl: dashboardUrl,
      userName: data.name || 'Supplier',
      supplierBusinessName: data.name,
      approvalDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      dashboardUrl,
      brandSubtext: `by ${data.brandName || brandName}`,
    },
  });
}

async function sendReviewNotificationEmail(review) {
  const tour = review.tour
    ? review.tour
    : await prisma.tour.findUnique({ where: { id: review.tourId }, select: { id: true, title: true, supplierId: true } });
  if (!tour) throw new Error(`Tour ${review.tourId} not found for review ${review.id}`);

  const [supplier, customer] = await Promise.all([
    prisma.user.findUnique({ where: { id: tour.supplierId } }),
    prisma.user.findUnique({ where: { id: review.customerId } }),
  ]);

  const brandKey = resolveEmailBrand({ supplier });

  return sendEmail({
    ...await supplierRecipientList(supplier, "reviews"),
    subject: `New ${review.rating}-Star Review Received`,
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      header: `New ${review.rating}-Star Review`,
      message: `${customer?.name || 'A traveller'} reviewed "${tour.title}": "${review.comment || review.title || ''}".`,
      buttonText: 'View review',
      buttonUrl: emailUrls.supplierReviewForUser(review.id, supplier),
      secondaryButtonText: 'Reply to this review',
      secondaryButtonUrl: emailUrls.supplierReplyReviewForUser(review.id, supplier),
      userName: supplier.name,
      supplierName: supplier.name,
      tourTitle: tour.title,
      reviewUrl: emailUrls.supplierReviewForUser(review.id, supplier),
      reviewDate: new Date(review.createdAt).toLocaleDateString(),
    },
  });
}

function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * New-message notification email (chat → email). Dispatched by the queue as
 * `chat-new-message`; `data` carries everything needed (no booking context).
 * The email's Reply-To is the conversation's unique inbound address so the
 * recipient can simply reply to post back into the chat.
 */
async function sendChatMessageEmail(booking, data = {}) {
  if (!data.to || !data.conversationId) throw new Error('chat-new-message requires to + conversationId');
  console.log(`[ChatEmail] to=${data.to} replyTo=${data.replyTo || '(none)'} conv=${data.conversationId}`);

  const rawSender = String(data.senderName || 'Someone');
  const senderName = htmlEscape(rawSender);
  const messagePlain = String(data.senderMessageHtml || data.content || 'New message').trim().slice(0, 2000);
  const senderMessageHtml = htmlEscape(messagePlain).replace(/\n/g, '<br/>');
  const preheader = htmlEscape((String(data.preheader || messagePlain) || 'New message').slice(0, 140));
  const subject = `New message from ${senderName}`;
  const chatUrl = data.link || emailUrls.supplierDashboard();

  return sendEmail({
    to: data.to,
    subject,
    template: 'chat-new-message',
    data: {
      preheader,
      senderName,
      senderRoleLabel: htmlEscape(String(data.senderRoleLabel || '')),
      senderInitials: htmlEscape(String(data.senderInitials || '?')),
      ...(data.senderAvatarUrl ? { senderAvatarUrl: String(data.senderAvatarUrl) } : {}),
      senderMessageHtml,
      ...(data.attachmentThumbUrl ? { attachmentThumbUrl: String(data.attachmentThumbUrl) } : {}),
      ...(data.attachmentDocLabel ? { attachmentDocLabel: htmlEscape(String(data.attachmentDocLabel)) } : {}),
      ...(data.tourTitle ? { tourTitle: htmlEscape(String(data.tourTitle)) } : {}),
      ...(data.bookingNumber ? { bookingNumber: htmlEscape(String(data.bookingNumber)) } : {}),
      chatUrl,
      brandKey: data.brandKey || null,
    },
    opts: {
      replyTo: data.replyTo,
      ...(data.inReplyTo ? { inReplyTo: data.inReplyTo } : {}),
      text: `New message from ${rawSender}\n\n${messagePlain}\n\nReply to this email to send a reply back in the conversation.\n\n${chatUrl}`,
    },
  });
}

async function sendPayoutNotificationEmail(supplierId, payoutData) {
  const supplier = await prisma.user.findUnique({ where: { id: supplierId } });
  if (!supplier?.email) throw new Error(`Supplier ${supplierId} has no email`);

  const currency = payoutData.currency || 'USD';
  const brandKey = resolveEmailBrand({ supplier });
  return sendEmail({
    ...await supplierRecipientList(supplier, "payments"),
    subject: 'Payout Processed',
    template: 'generic-notification',
    opts: { brandKey },
    data: {
      header: 'Payout Processed',
      message: `Your payout of ${fmt.formatCurrency(payoutData.amount, currency)} has been ${payoutData.statusLabel ? payoutData.statusLabel.toLowerCase() : 'processed'}.`,
      buttonText: 'View earnings',
      buttonUrl: emailUrls.supplierEarningsForUser(supplier),
      userName: supplier.name,
      supplierName: supplier.name,
      payoutAmount: payoutData.amount,
      currency,
      payoutDate: new Date(payoutData.date).toLocaleDateString(),
      payoutId: payoutData.id,
      dashboardUrl: emailUrls.supplierEarningsForUser(supplier),
    },
  });
}

async function sendSupplierBookingNotification(booking) {
  try {
    return await sendSupplierNewBookingEmail(booking);
  } catch (error) {
    console.error('Supplier booking notification failed:', error);
  }
}

// Chip colours per team role — mirrors TEAM_ROLE_COLORS in the dashboards so
// the email and the settings page describe the same access.
const TEAM_ROLE_CHIP = {
  admin: { bg: '#F3E8FF', fg: '#6B21A8' },
  editor: { bg: '#DBEAFE', fg: '#1D4ED8' },
  finance: { bg: '#DCFCE7', fg: '#15803D' },
  support: { bg: '#FFEDD5', fg: '#C2410C' },
};

/** "EB" from "Expedition-Go Tours" — used for the inviter avatar. */
function initialsOf(name) {
  return String(name || '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || 'T';
}

/** Role data the invite template renders as chips + capability lines. */
function teamRoleView(roles) {
  const { toRoleArray, TEAM_ROLE_LABELS, TEAM_ROLE_SUMMARIES } = require('../../../config/teamPermissions');
  const list = toRoleArray(roles);
  return list.map((role) => ({
    key: role,
    label: TEAM_ROLE_LABELS[role] || role,
    summary: TEAM_ROLE_SUMMARIES[role] || '',
    bg: (TEAM_ROLE_CHIP[role] || TEAM_ROLE_CHIP.editor).bg,
    fg: (TEAM_ROLE_CHIP[role] || TEAM_ROLE_CHIP.editor).fg,
  }));
}

/**
 * Team invitation email.
 *
 * Built for how invites are actually read: the inviter's name leads, the
 * supplier and the exact access they get are stated plainly, there is one
 * button, and the security context (expiry, who invited them, "didn't expect
 * this") is spelled out. `roles` is an array (a member can hold two).
 */
async function sendTeamInviteEmail({
  to,
  supplierName,
  roles,
  role,
  inviteUrl,
  invitedBy,
  invitedByEmail = '',
  expiresInHours = 48,
  brandKey = null,
}) {
  const roleView = teamRoleView(roles && roles.length ? roles : role);
  const roleNames = roleView.map((r) => r.label).join(' + ') || 'team member';
  const safeSupplier = htmlEscape(supplierName || 'this supplier');
  const safeInviter = htmlEscape(invitedBy || 'Your supplier');
  const shell = await getShellVars(brandKey);
  const brandName = shell.brandName || 'Travio';

  // Plain-text alternative: helps deliverability and clients that strip HTML.
  const text = [
    `${invitedBy || 'Your supplier'} invited you to join ${supplierName || 'this supplier'} on ${brandName}.`,
    '',
    `Access: ${roleNames}`,
    ...roleView.map((r) => `  - ${r.label}: ${r.summary}`),
    '',
    `Accept the invitation: ${inviteUrl}`,
    '',
    `This link expires in ${expiresInHours} hours and only works for ${to}.`,
    `If you weren't expecting this invitation you can safely ignore it.`,
    `Questions? ${shell.supportEmail}`,
  ].join('\n');

  try {
    return await sendEmail({
      to,
      subject: `${invitedBy || 'A teammate'} invited you to join ${supplierName}'s team on ${brandName}`,
      template: 'team-invite',
      opts: { brandKey, text, preheader: `${roleNames} access to ${supplierName} — accept in one click.` },
      data: {
        supplierName: safeSupplier,
        roles: roleView,
        rolesText: htmlEscape(roleNames),
        inviterName: safeInviter,
        inviterEmail: htmlEscape(invitedByEmail),
        inviterInitials: initialsOf(invitedBy),
        inviteUrl,
        inviteeEmail: htmlEscape(to),
        expiresInHours,
        brandName,
      },
    });
  } catch (error) {
    console.error('Team invite email failed:', error);
    throw error;
  }
}

async function sendTeamInviteRevokedEmail({ to, supplierName, roles, role, invitedBy, brandKey = null }) {
  const roleView = teamRoleView(roles && roles.length ? roles : role);
  try {
    return await sendEmail({
      to,
      subject: `Your invitation to join ${supplierName}'s team was revoked`,
      template: 'team-invite-revoked',
      opts: { brandKey, preheader: `The invitation to ${supplierName} is no longer active.` },
      data: {
        supplierName: htmlEscape(supplierName || 'this supplier'),
        roles: roleView,
        rolesText: htmlEscape(roleView.map((r) => r.label).join(' + ')),
        inviterName: htmlEscape(invitedBy || 'Your supplier'),
        inviteeEmail: htmlEscape(to),
      },
    });
  } catch (error) {
    console.error('Team invite revoked email failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Inline template generation (legacy names without a compiled document)
// ---------------------------------------------------------------------------

function generateEmailContent(template, data) {
  const templates = {
    'generic-notification': generateGenericNotificationEmail,
    'notification-recipient-verify': generateNotificationRecipientVerifyEmail,
    'contact-form': generateContactFormEmail,
  };
  const fn = templates[template];
  if (!fn) return { html: '', text: '' };
  return fn(data);
}

/**
 * Contact-form submission routed to the brand support inbox. Support-facing:
 * renders the visitor's details + message inside the brand shell, so the
 * receiving team sees which storefront the enquiry came from.
 *
 * data: { subject, messageBody, name, email, phone, inquiryType }
 */
function generateContactFormEmail(data) {
  const meta = [
    ['Name', data.name],
    ['Email', data.email],
    ['Phone', data.phone && data.phone !== 'Not provided' ? data.phone : null],
    ['Inquiry', data.inquiryType],
  ].filter(([, v]) => v);
  const metaHtml = meta
    .map(
      ([k, v]) =>
        `<p style="margin:3px 0;font-size:13px;color:#64748B;font-family:'Plus Jakarta Sans',Arial,sans-serif;"><span style="color:#0F172A;font-weight:700;">${htmlEscape(k)}:</span> ${htmlEscape(v)}</p>`
    )
    .join('');

  const messageText = String(data.messageBody || data.message || '');
  const messageHtml = htmlEscape(messageText).replace(/\n/g, '<br>');
  const heading = htmlEscape(data.subject || 'New contact form message');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;padding:0;background-color:#F1F5F9;font-family:'Plus Jakarta Sans',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F1F5F9;padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E2E8F0;">
        <tr><td style="padding:24px 32px 6px 32px;text-align:center;">
          <img src="{{logoUrl}}" alt="{{brandName}}" style="max-height:44px;max-width:200px;display:block;margin:0 auto;">
        </td></tr>
        <tr><td style="padding:6px 32px 0 32px;">
          <h1 style="margin:0;font-size:18px;font-weight:800;color:#0F172A;text-align:center;">${heading}</h1>
        </td></tr>
        <tr><td style="padding:14px 32px 2px 32px;">${metaHtml}</td></tr>
        <tr><td style="padding:12px 32px 6px 32px;">
          <div style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:16px 18px;font-size:14px;line-height:1.7;color:#334155;">${messageHtml}</div>
        </td></tr>
        <tr><td style="padding:14px 32px 26px 32px;text-align:center;font-size:12px;color:#94A3B8;">
          {{year}} &copy; {{brandName}} &middot; {{supportEmail}}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { html, text: messageText };
}

function generateGenericNotificationEmail(data) {
  const heading = data.header || data.title || 'Notification';
  const body = data.message || data.messageBody || '';

  const buttonHtml = data.buttonUrl
    ? `<tr><td align="center" style="padding:24px 40px 8px 40px;"><a href="${data.buttonUrl}" style="display:inline-block;background-color:#0E9F6E;color:#ffffff;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;padding:14px 34px;">${data.buttonText || 'Open'}</a></td></tr>`
    : '';

  const secondaryLinkHtml = data.secondaryButtonUrl
    ? `<tr><td align="center" style="padding:4px 40px 12px 40px;"><a href="${data.secondaryButtonUrl}" style="font-size:13px;color:#0E9F6E;text-decoration:none;font-weight:600;font-family:'Plus Jakarta Sans',Arial,sans-serif;">${data.secondaryButtonText || 'Learn more'}</a></td></tr>`
    : '';

  const metaRows = ['supplierBusinessName', 'approvalDate', 'reviewDate']
    .filter((k) => data[k])
    .map((k) => `<p style="margin:2px 0;font-size:13px;color:#64748B;">${data[k]}</p>`)
    .join('');

  return {
    html: `<div style="font-family:'Plus Jakarta Sans',Arial,sans-serif;background:#F8FAFC;padding:32px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
      <table role="presentation" width="100%" style="max-width:640px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;" cellspacing="0" cellpadding="0" border="0">
        <tr><td align="center" style="padding:36px 40px 4px 40px;"><h1 style="margin:0 0 12px;font-size:28px;font-weight:800;color:#001F3F;text-align:center;">${heading}</h1></td></tr>
        <tr><td align="center" style="padding:0 40px 4px 40px;">${metaRows}</td></tr>
        <tr><td style="padding:16px 40px 0 40px;"><p style="margin:0;font-size:15px;color:#334155;line-height:1.7;text-align:center;">${body}</p></td></tr>
        ${buttonHtml}
        ${secondaryLinkHtml}
        <tr><td align="center" style="padding:16px 40px 0 40px;"><span style="font-size:13px;color:#64748B;">Need help? <a href="mailto:{{supportEmail}}" style="color:#0E9F6E;">Contact support</a></span></td></tr>
      </table>
      <p style="margin:24px 0 0;text-align:center;font-size:11px;color:#94A3B8;">&copy; {{year}} {{brandName}}. All rights reserved.</p>
      </td></tr></table></div>`,
    text: `${heading}\n\n${body}\n${data.buttonUrl ? `Open: ${data.buttonUrl}` : ''}\n${data.secondaryButtonUrl ? `${data.secondaryButtonText || 'More'}: ${data.secondaryButtonUrl}` : ''}`,
  };
}

function generateNotificationRecipientVerifyEmail(data) {
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const types = Array.isArray(data.types) ? data.types : [];
  const typesHtml = types.length
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 8px">${types
        .map((t) => `<tr><td style="padding:7px 0;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:15px;color:#334155;"><span style="display:inline-block;width:20px;color:#0E9F6E;font-weight:800;">&#10003;</span>${esc(t)}</td></tr>`)
        .join('')}</table>`
    : '';
  const confirmUrl = esc(data.confirmUrl || '#');

  return {
    html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Confirm your email address</title><style>body{margin:0;background:#F1F5F9;}</style></head><body style="margin:0;background:#F1F5F9;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F1F5F9" style="background:#F1F5F9;">
      <tr><td align="center" style="padding:40px 16px;font-family:'Plus Jakarta Sans',Arial,sans-serif;">
      <table role="presentation" width="100%" style="max-width:600px;background:#ffffff;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;" cellspacing="0" cellpadding="0" border="0">
        <tr><td align="center" style="padding:36px 40px 8px 40px;"><img src="{{logoUrl}}" alt="{{brandName}}" width="170" style="display:block;max-width:170px;height:auto;"></td></tr>
        <tr><td align="center" style="padding:16px 40px 0 40px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="width:56px;height:56px;background:#ECFDF5;border-radius:28px;font-size:26px;line-height:56px;color:#0E9F6E;">&#9993;</td></tr></table>
        </td></tr>
        <tr><td align="center" style="padding:18px 40px 0 40px;"><h1 style="margin:0;font-size:26px;line-height:1.25;font-weight:800;color:#0F172A;text-align:center;">Confirm your email address</h1></td></tr>
        <tr><td style="padding:14px 40px 0 40px;"><p style="margin:0;font-size:15px;line-height:1.7;color:#475569;text-align:center;">You're being added to receive <strong style="color:#0F172A;">{{brandName}}</strong> notifications for <strong style="color:#0F172A;">${esc(data.supplierName || 'this supplier')}</strong>. Confirm this address to start receiving:</p></td></tr>
        <tr><td style="padding:22px 40px 0 40px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;"><tr><td style="padding:18px 22px;">
            <p style="margin:0 0 6px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748B;font-family:'Plus Jakarta Sans',Arial,sans-serif;">Emails this address will receive</p>
            ${typesHtml}
          </td></tr></table>
        </td></tr>
        <tr><td align="center" style="padding:26px 40px 6px 40px;"><a href="${confirmUrl}" style="display:inline-block;background:#0E9F6E;color:#ffffff;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:16px;font-weight:700;text-decoration:none;border-radius:12px;padding:15px 40px;">Confirm email address</a></td></tr>
        <tr><td style="padding:18px 40px 0 40px;"><p style="margin:0;font-size:12px;line-height:1.6;color:#64748B;text-align:center;word-break:break-all;">Button not working? Paste this link into your browser:<br><a href="${confirmUrl}" style="color:#0E9F6E;">${confirmUrl}</a></p></td></tr>
        <tr><td style="padding:22px 40px 32px 40px;"><p style="margin:0;font-size:13px;line-height:1.7;color:#64748B;text-align:center;">This link expires in ${Number(data.expiresInDays) || 7} days. If you weren't expecting this, you can safely ignore this email — nothing will be sent to ${esc(data.recipientEmail || 'this address')} unless you confirm.</p></td></tr>
        <tr><td bgcolor="#0F172A" style="padding:24px 40px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr><td style="font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:12px;color:#94A3B8;">Questions? <a href="mailto:{{supportEmail}}" style="color:#34D399;text-decoration:none;">{{supportEmail}}</a></td><td align="right" style="font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:12px;color:#94A3B8;">{{brandName}} Team</td></tr>
            <tr><td colspan="2" style="padding-top:10px;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:11px;color:#94A3B8;">&copy; {{year}} {{brandName}}. All rights reserved.</td></tr>
          </table>
        </td></tr>
      </table>
      </td></tr></table></body></html>`,
    text: `Confirm your email address\n\nYou're being added to receive ${data.brandName || ''} notifications for ${data.supplierName || ''}.${types.length ? `\n\nEmails this address will receive:\n${types.map((t) => `- ${t}`).join('\n')}` : ''}\n\nConfirm: ${confirmUrl}\n\nThis link expires in ${data.expiresInDays || 7} days. If you weren't expecting this, ignore this email.`,
  };
}


// ---------------------------------------------------------------------------
// Printable ticket (unchanged — used by the ticket endpoint)
// ---------------------------------------------------------------------------

function generatePrintableTicketHtml(data) {
  const travelers = [];
  if (data.travelers?.adults) travelers.push(`${data.travelers.adults} Adult(s)`);
  if (data.travelers?.children) travelers.push(`${data.travelers.children} Child(ren)`);
  if (data.travelers?.infants) travelers.push(`${data.travelers.infants} Infant(s)`);

  const includedHtml = (data.included || []).map((i) => `<li>${i}</li>`).join('');

  // Prefer the customer-selected pickup snapshot; fall back to the tour's
  // static meeting point so legacy bookings keep rendering.
  const pickupDeferred = !!(data.pickup && data.pickup.pickupLater);
  const pickupLabel = data.pickup
    ? (data.pickup.place || data.pickup.areaName || data.pickup.locationName || (data.pickup.address && (data.pickup.address.name || data.pickup.address.address)) || '')
    : (data.meetingPoint && (data.meetingPoint.address || data.meetingPoint.name)) || '';
  const pickupInstructions = data.pickup
    ? (data.pickup.instructions || '')
    : (data.meetingPoint && data.meetingPoint.instructions) || '';
  const pickupTime = (data.pickup && data.pickup.time) ? data.pickup.time : '';

  const formattedDate = new Date(data.travelDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `<!DOCTYPE html>
<html data-ogsc="" data-ogsb=""><head><meta charset="utf-8"><meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>Ticket — ${data.bookingNumber}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; word-break: break-word; overflow-wrap: break-word; }
  body { font-family: Arial, Helvetica, sans-serif; padding: 24px; color: #111 !important; background: #fff !important; }
  .ticket { max-width: 700px; margin: 0 auto; border: 2px solid #111; padding: 32px; background: #fff !important; }
  .header { text-align: center; border-bottom: 2px solid #111; padding-bottom: 16px; margin-bottom: 16px; }
  .ref { font-size: 30px; font-weight: 700; letter-spacing: 3px; font-family: 'Courier New', monospace; color: #111 !important; word-break: break-all; }
  .status { margin-top: 8px; font-size: 13px; color: #059669 !important; font-weight: 600; }
  .section { margin: 16px 0; }
  .stitle { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #666 !important; margin: 0 0 4px; }
  .svalue { font-weight: 600; font-size: 14px; margin: 0 0 8px; color: #111 !important; }
  table.rows { width: 100%; border-collapse: collapse; }
  table.rows td { padding: 6px 8px 6px 0; vertical-align: top; color: #111 !important; }
  table.rows td:last-child { padding-right: 0; }
  ul { margin: 0; padding-left: 20px; font-size: 14px; }
  li { padding: 2px 0; color: #111 !important; }
  .total-row td { border-top: 2px solid #111; font-weight: 700; font-size: 16px; color: #111 !important; }
  .footer { margin-top: 16px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #666 !important; text-align: center; }
  [data-ogsc] body, [data-ogsb] body, [data-ogsc] .ticket, [data-ogsb] .ticket { background: #fff !important; }
  [data-ogsc] .ref, [data-ogsb] .ref, [data-ogsc] .svalue, [data-ogsb] .svalue, [data-ogsc] td, [data-ogsb] td, [data-ogsc] li, [data-ogsb] li { color: #111 !important; }
  [data-ogsc] .stitle, [data-ogsb] .stitle, [data-ogsc] .footer, [data-ogsb] .footer { color: #666 !important; }
  [data-ogsc] .status, [data-ogsb] .status { color: #059669 !important; }
  [data-ogsc] * { background-color: #ffffff !important; color: #111827 !important; }
  [data-ogsc] .status { color: #059669 !important; }
  [data-ogsc] .stitle, [data-ogsc] .footer { color: #666 !important; }
  @media print { body { padding: 0; } .ticket { border: none; } }
</style></head><body data-ogsc="" style="background:#fff !important;color:#111 !important;">
<div class="ticket">
  <div class="header">
    <img src="${data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media'}" alt="Travio Africa" style="height:44px;margin-bottom:16px;">
    <div class="ref">${data.bookingNumber}</div>
    <div class="status">${data.status === 'CONFIRMED' ? 'Confirmed' : data.status}</div>
  </div>
  <div class="section">
    <div class="stitle">Tour</div>
    <div style="font-size:18px;font-weight:700;">${data.tourTitle}</div>
    ${data.tourDescription ? `<div style="color:#666;font-size:13px;margin-top:4px;">${data.tourDescription.substring(0, 300)}</div>` : ''}
  </div>
  <table class="rows">
    <tr><td style="width:50%;"><div class="stitle">Date</div><div class="svalue">${formattedDate}</div></td>
        <td style="width:50%;"><div class="stitle">Time</div><div class="svalue">${data.selectedTime || 'Flexible'}</div></td></tr>
    <tr><td><div class="stitle">Traveler</div><div class="svalue">${data.customerName}</div></td>
        <td><div class="stitle">Participants</div><div class="svalue">${travelers.join(', ') || '1 Adult'}</div></td></tr>
  </table>
  ${data.pickup || data.meetingPoint ? `<div class="section"><div class="stitle">Pickup Point</div><div class="svalue">${pickupDeferred && !pickupLabel ? 'To be confirmed — the tour operator will confirm your pickup details' : pickupLabel}${pickupTime ? ` &mdash; ${pickupTime}` : ''}</div>${pickupInstructions ? `<div style="color:#666;font-size:13px;">${pickupInstructions}</div>` : ''}</div>` : ''}
  ${includedHtml ? `<div class="section"><div class="stitle">Includes</div><ul>${includedHtml}</ul></div>` : ''}
  ${data.restrictions ? `<div class="section"><div class="stitle">Important</div><div style="font-size:14px;">${data.restrictions}</div></div>` : ''}
  <div class="section"><div class="stitle">Cancellation Policy</div><div style="font-size:14px;">${data.cancellationPolicy || 'Free cancellation up to 24 hours before'}</div></div>
  <table class="rows" style="margin-top:12px;">
    <tr class="total-row"><td>Total Paid</td><td style="text-align:right;">${data.currency} ${data.total}</td></tr>
  </table>
  <div class="footer">Organized by ${data.supplierName} &bull; Contact: ${data.supportEmail}</div>
</div>
</body></html>`;
}

module.exports = {
  // core
  sendEmail,
  renderTemplate,
  getShellVars,
  resolveEmailBrand,

  // customer
  sendBookingConfirmedEmail,
  sendReserveLaterConfirmedEmail,
  sendPaymentReminderEmail,
  sendPaymentSuccessfulEmail,
  sendPayLaterChargedEmail,
  sendAwaitingConfirmationEmail,
  sendPaymentUnsuccessfulEmail,
  sendCustomerBookingChangedEmail,
  sendPickupDetailsUpdatedEmail,
  sendPickupLocationRequiredEmail,
  sendBookingReminderEmail,
  sendCustomerCancelledFullRefundEmail,
  sendCustomerCancelledNoRefundEmail,
  sendRefundProcessingEmail,
  sendRefundCompletedEmail,
  sendSupplierChangedBookingEmail,
  sendSupplierCancelledBookingEmail,
  sendSupplierCancellationFeeEmail,
  sendReviewRequestEmail,
  sendSupplierResponseEmail,

  // supplier
  sendSupplierNewBookingEmail,
  sendSupplierPayLaterChargedEmail,
  sendSupplierBookingChangedEmail,
  sendSupplierContactUpdatedEmail,
  sendSupplierPickupUpdatedEmail,
  sendSupplierPickupRequiredEmail,
  sendSupplierBookingReminderEmail,
  sendSupplierCustomerCancelledFreeEmail,
  sendSupplierCustomerCancelledLateEmail,
  sendSupplierPlatformCancelledEmail,
  sendSupplierCancellationRecordedEmail,
  sendSupplierPayoutScheduledEmail,
  sendSupplierPayoutCompletedEmail,
  sendSupplierPayoutFailedEmail,
  sendSupplierProductSubmittedEmail,
  sendSupplierProductUpdateSubmittedEmail,

  // finance v2
  sendFinancePayoutRequestEmail,
  sendDisputeOpenedEmail,

  // legacy
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendChatMessageEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  sendTeamInviteEmail,
  sendTeamInviteRevokedEmail,
  supplierRecipientList,
  sendNotificationRecipientVerificationEmail,
  generatePrintableTicketHtml,
  generateEmailContent,
};