/**
 * Email Service — Resend + locally compiled templates.
 *
 * Every transactional email renders a compiled HTML document from
 * sendgrid-templates/generated/<key>.html using utils/emailRenderer.js and is
 * delivered through Resend (raw HTML — no cloud template sync required).
 *
 * The 28 template keys mirror scripts/buildEmailTemplates.js so the send layer
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
const emailUrls = require('../config/emailUrls');

const GENERATED_DIR = path.join(__dirname, '..', 'sendgrid-templates', 'generated');

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
// Shared shell values (resolved once per process from config + env)
// ---------------------------------------------------------------------------
let shellCache = null;
let shellPromise = null;

async function getShellVars() {
  if (shellCache) return shellCache;
  if (shellPromise) return shellPromise;

  shellPromise = (async () => {
    try {
      const [brandName, supportEmail, logoUrl] = await Promise.all([
        getConfig('platform.name'),
        getConfig('email.support_email'),
        getConfig('email.logo_url'),
      ]);
      shellCache = {
        brandName: brandName || 'Travio Africa',
        supportEmail: supportEmail || process.env.SUPPORT_EMAIL || 'support@travioafrica.com',
        logoUrl: logoUrl || process.env.LOGO_URL || 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1778862668/TRAVOI_AFRICA_NEW_kd1tnr.png',
        year: new Date().getFullYear(),
      };
    } catch (err) {
      shellCache = {
        brandName: 'Travio Africa',
        supportEmail: process.env.SUPPORT_EMAIL || 'support@travioafrica.com',
        logoUrl: process.env.LOGO_URL || 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1778862668/TRAVOI_AFRICA_NEW_kd1tnr.png',
        year: new Date().getFullYear(),
      };
    }
    return shellCache;
  })();

  return shellPromise;
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
  const shell = await getShellVars();
  const merged = {
    ...shell,
    preheader: opts.preheader || data.preheader || '',
    ...data,
  };
  return render(source, merged);
}

function parseFrom() {
  const fromRaw = process.env.EMAIL_FROM || '';
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
async function sendHtml({ to, subject, html, text = '', attachments = [] }) {
  const client = getResend();

  if (!client) {
    console.error(`[Email] Skipped send (no RESEND_API_KEY) to ${to}: ${subject}`);
    return { success: false, reason: 'no-provider', html };
  }

  try {
    const fromInfo = parseFrom();
    const { data: result, error } = await client.emails.send({
      from: fromInfo.from,
      to,
      subject,
      html,
      ...(text ? { text } : {}),
      ...(process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
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

async function sendRendered({ to, subject, key, data = {}, attachments = [], opts = {} }) {
  const html = await renderTemplate(key, data, opts);
  return sendHtml({ to, subject, html, text: opts.text || '', attachments });
}

/**
 * Generic send — accepts a template key (compiled) or a legacy template name.
 * Legacy names without a compiled document fall back to inline generation so
 * account/status emails (team invites, supplier status, notifications) keep
 * working without cloud templates.
 */
async function sendEmail({ to, subject, template, data = {}, attachments = [], opts = {} }) {
  if (template && loadTemplate(template)) {
    return sendRendered({ to, subject, key: template, data, attachments, opts });
  }
  // Legacy / inline path
  const content = generateEmailContent(template, data);
  if (content && content.html) {
    const shell = await getShellVars();
    const merged = { ...shell, year: shell.year, ...data };
    let html = content.html;
    for (const [k, v] of Object.entries(merged)) {
      html = html.split(`{{${k}}}`).join(v == null ? '' : String(v));
    }
    return sendHtml({ to, subject, html, text: content.text || '', attachments });
  }
  throw new Error(`[Email] No template or inline generator for: ${template}`);
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
 * Shared booking data used by every booking-scoped template.
 * Callers can override any field afterwards.
 */
async function buildBookingBase(booking) {
  const shell = await getShellVars();
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
    reviewUrl: emailUrls.writeReview(booking.id, clientOrigin, tour.slug),
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    paymentReference: paymentReference || b.stripePaymentIntentId || '',
    paymentAmountLabel: fmt.formatCurrency(paid, b.currency),
    outstandingBalanceLabel: fmt.formatCurrency(outstanding, b.currency),
    supportEmail: (await getShellVars()).supportEmail,
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
    paymentReference: paymentReference || b.stripePaymentIntentId || '',
    chargedAtLabel: fmt.formatLongDate(chargedAt || b.paidAt || new Date()),
    paymentStatusLabel: 'Paid',
    supportEmail: (await getShellVars()).supportEmail,
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
    paymentReference: paymentReference || b.stripePaymentIntentId || '',
    paidAtLabel: fmt.formatLongDate(paidAt || b.paidAt || new Date()),
    paymentStatusLabel: 'Paid',
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
    supportEmail: (await getShellVars()).supportEmail,
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
  const data = {
    ...base,
    cancellationReason: reason || b.cancellationReason || '',
    refundAmountLabel: fmt.formatCurrency(refundAmount ?? b.refundAmount ?? b.grossAmount, b.currency),
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'Important: Your booking has been cancelled',
    key: 'supplier-cancelled-booking',
    data,
  });
}

async function sendReviewRequestEmail(booking) {
  const b = await resolveBookingContext(booking);
  const base = await buildBookingBase(b);
  const origin = emailUrls.bookingClientOrigin(b);
  const data = {
    ...base,
    reviewUrl: emailUrls.writeReview(b.id, origin, b.tour?.slug),
    browseUrl: emailUrls.browseExperiences(origin),
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: base.customerEmail,
    subject: 'How was your experience?',
    key: 'review-request',
    data,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    paymentReference: paymentReference || b.stripePaymentIntentId || '',
    chargedAtLabel: fmt.formatLongDate(chargedAt || b.paidAt || new Date()),
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
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
    supportEmail: (await getShellVars()).supportEmail,
  };
  return sendRendered({
    to: supplier.email,
    subject: 'Action required: Payout unsuccessful',
    key: 'supplier-payout-failed',
    data,
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

  return sendEmail({
    to: supplier.email,
    subject: config.subject,
    template: 'generic-notification',
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
  return sendEmail({
    to: supplier.email,
    subject: `Refund request received - ${dispute.disputeNumber}`,
    template: 'generic-notification',
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
  const statusConfig = {
    APPROVED: { subject: 'Supplier Application Approved - Welcome!', heading: 'Welcome to Travio Africa' },
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
    data: {
      ...data,
      header: config.heading,
      message: data.message || `Your supplier account status has changed to ${status}.`,
      buttonText: 'Open dashboard',
      buttonUrl: emailUrls.supplierDashboard(),
      userName: data.name || 'Supplier',
      supplierBusinessName: data.name,
      approvalDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
      dashboardUrl: emailUrls.supplierDashboard(),
    brandSubtext: `by ${data.brandName || 'Travio Africa'}`,
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

  return sendEmail({
    to: supplier.email,
    subject: `New ${review.rating}-Star Review Received`,
    template: 'generic-notification',
    data: {
      header: `New ${review.rating}-Star Review`,
      message: `${customer?.name || 'A traveller'} reviewed "${tour.title}": "${review.comment || review.title || ''}".`,
      buttonText: 'View review',
      buttonUrl: emailUrls.supplierReview(review.id),
      userName: supplier.name,
      supplierName: supplier.name,
      tourTitle: tour.title,
      reviewUrl: emailUrls.supplierReview(review.id),
      reviewDate: new Date(review.createdAt).toLocaleDateString(),
    },
  });
}

async function sendPayoutNotificationEmail(supplierId, payoutData) {
  const supplier = await prisma.user.findUnique({ where: { id: supplierId } });
  if (!supplier?.email) throw new Error(`Supplier ${supplierId} has no email`);

  const currency = payoutData.currency || 'USD';
  return sendEmail({
    to: supplier.email,
    subject: 'Payout Processed',
    template: 'generic-notification',
    data: {
      header: 'Payout Processed',
      message: `Your payout of ${fmt.formatCurrency(payoutData.amount, currency)} has been ${payoutData.statusLabel ? payoutData.statusLabel.toLowerCase() : 'processed'}.`,
      buttonText: 'View earnings',
      buttonUrl: emailUrls.supplierEarnings(),
      userName: supplier.name,
      supplierName: supplier.name,
      payoutAmount: payoutData.amount,
      currency,
      payoutDate: new Date(payoutData.date).toLocaleDateString(),
      payoutId: payoutData.id,
      dashboardUrl: emailUrls.supplierEarnings(),
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

async function sendTeamInviteEmail({ to, supplierName, role, inviteUrl, invitedBy }) {
  try {
    return await sendEmail({
      to,
      subject: `You've been invited to join ${supplierName}'s team`,
      template: 'team-invite',
      data: { brandName: supplierName, role, inviteLink: inviteUrl, invitedBy },
    });
  } catch (error) {
    console.error('Team invite email failed:', error);
    throw error;
  }
}

async function sendTeamInviteRevokedEmail({ to, supplierName, role, invitedBy }) {
  try {
    return await sendEmail({
      to,
      subject: `Invitation to join ${supplierName}'s team has been revoked`,
      template: 'team-invite-revoked',
      data: { brandName: supplierName, role, invitedBy },
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
    'team-invite': generateTeamInviteEmail,
    'team-invite-revoked': generateTeamInviteRevokedEmail,
    'generic-notification': generateGenericNotificationEmail,
  };
  const fn = templates[template];
  if (!fn) return { html: '', text: '' };
  return fn(data);
}

function generateGenericNotificationEmail(data) {
  const heading = data.header || data.title || 'Notification';
  const body = data.message || data.messageBody || '';
  const btnUrl = data.buttonUrl || data.buttonText && data.buttonUrl;
  const btnText = data.buttonText || 'Open';

  const buttonHtml = data.buttonUrl
    ? `<tr><td align="center" style="padding:24px 40px 8px 40px;"><a href="${data.buttonUrl}" style="display:inline-block;background-color:#0E9F6E;color:#ffffff;font-family:'Plus Jakarta Sans',Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;padding:14px 34px;">${data.buttonText || 'Open'}</a></td></tr>`
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
        <tr><td align="center" style="padding:16px 40px 0 40px;"><span style="font-size:13px;color:#64748B;">Need help? <a href="mailto:{{supportEmail}}" style="color:#0E9F6E;">Contact support</a></span></td></tr>
      </table>
      <p style="margin:24px 0 0;text-align:center;font-size:11px;color:#94A3B8;">&copy; {{year}} {{brandName}}. All rights reserved.</p>
      </td></tr></table></div>`,
    text: `${heading}\n\n${body}\n${data.buttonUrl ? `Open: ${data.buttonUrl}` : ''}`,
  };
}

function generateTeamInviteEmail(data) {
  const templatePath = path.join(__dirname, '..', 'sendgrid-templates', 'team-invite.html');
  let html = fs.readFileSync(templatePath, 'utf-8');

  const replacements = {
    '{{logoUrl}}': data.logoUrl || '',
    '{{brandName}}': data.brandName || 'Travio Africa',
    '{{invitedBy}}': data.invitedBy || 'A team member',
    '{{role}}': data.role || 'member',
    '{{inviteLink}}': data.inviteLink || '#',
    '{{supportEmail}}': data.supportEmail || 'support@travioafrica.com',
    '{{year}}': data.year || new Date().getFullYear().toString(),
  };

  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(key).join(value);
  }

  html = html.replace(/\{\{#if companyName\}\}.*?\{\{\/if\}\}/gs, '');

  return { html, text: `You've been invited to join as ${data.role}. Accept: ${data.inviteLink}` };
}

function generateTeamInviteRevokedEmail(data) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Invitation Revoked</title>
<style>body{margin:0;padding:0;background-color:#F8FAFC;font-family:'Plus Jakarta Sans','Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}</style>
</head>
<body>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" style="max-width:640px;background:#fff;border:1px solid #E2E8F0;border-radius:16px" cellspacing="0" cellpadding="0" border="0">
<tr><td style="padding:40px 40px 32px;text-align:center">
<h1 style="margin:0 0 16px;font-size:28px;font-weight:800;color:#001F3F;line-height:1.2">Invitation Revoked</h1>
<p style="margin:0;font-size:15px;color:#334155;line-height:1.4">${data.invitedBy || 'A team member'} has revoked your invitation to join <strong>${data.brandName || 'their team'}</strong> as <strong>${data.role || 'member'}</strong>.</p>
</td></tr>
<tr><td style="padding:0 40px 40px" align="center"><span style="font-size:13px;color:#64748B">If you have any questions, please contact the supplier directly.</span></td></tr>
<tr><td bgcolor="#001F3F" style="padding:32px 40px;text-align:center"><span style="color:#94A3B8;font-size:13px">${data.brandName || 'Travio Africa'} Team</span></td></tr>
</table>
<p style="margin:24px 0 0;text-align:center;font-size:11px;color:#94A3B8">&copy; ${data.year || new Date().getFullYear()} ${data.brandName || 'Travio Africa'}. All rights reserved.</p>
</td></tr></table>
</body>
</html>`;

  return { html, text: `${data.invitedBy || 'A team member'} has revoked your invitation to join ${data.brandName || 'their team'} as ${data.role || 'member'}.` };
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
  sendReviewRequestEmail,

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

  // finance v2
  sendFinancePayoutRequestEmail,
  sendDisputeOpenedEmail,

  // legacy
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  sendTeamInviteEmail,
  sendTeamInviteRevokedEmail,
  generatePrintableTicketHtml,
  generateEmailContent,
};