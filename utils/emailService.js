/**
 * Email Service - Production Ready
 * Handles transactional emails using SendGrid
 * 
 * Features:
 * - Template-based emails
 * - Booking confirmations and updates
 * - Supplier notifications
 * - System alerts and notifications
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const sgMail = require('@sendgrid/mail');
const prisma = require('./prismaClient');
const getConfig = require('./getConfig');

const TEMPLATE_IDS = {
  'supplier-approved': 'd-2f3d5b9302ae459b8ac94758a70d6ce6',
  'booking-confirmation': 'd-0a159d1f1c43422d85195f8d8f898506',
  'supplier-rejected': 'd-46112aefe32a4e1a846ec72b5ddc38e4',
  'supplier-activated': 'd-493cd6b3347e4552a09f6c7d70a4a933',
  'review-notification': 'd-3fd7be6a230d418e92090c8bc888f8e7',
  'payout-notification': 'd-78cb9803209e42f6a80cfe45b9cdfc3b',
  'supplier-booking-notification': 'd-2973e0ab70734472985569ca1e20b220',
  'generic-notification': 'd-12b0cfb8cf1f4211a22db258e13c9f30',
  'team-invite': 'd-12b0cfb8cf1f4211a22db258e13c9f30',
  'booking-cancellation': 'd-3b94f590c23f4530a05152bbdca561b0',
  'supplier-under-review': 'd-875a87dd2cf14a11a4f1075d053fc6b1',
  'supplier-suspended': 'd-d09364df53b4467ea43a7128483295e3',
};

// Lazy initialization: set API key on first send to avoid crash/warning
// when env var is missing during test/CI.
let sgMailInitialized = false;

function ensureSgMail() {
  if (sgMailInitialized) return;
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  } else {
    console.error('[Email] CRITICAL: SENDGRID_API_KEY is not set in environment variables');
  }
  sgMailInitialized = true;
}

/**
 * Send email using SendGrid
 */
async function sendEmail({ to, subject, template, data = {}, attachments = [] }) {
  ensureSgMail();
  try {
    const [configBrandName, configSupportEmail, configLogoUrl, configHeroImageUrl] = await Promise.all([
      getConfig('platform.name'),
      getConfig('email.support_email'),
      getConfig('email.logo_url'),
      getConfig('email.hero_image_url'),
    ]);

    const fromRaw = process.env.EMAIL_FROM || '';
    const fromMatch = fromRaw.match(/^(.*?)\s*<([^>]+)>$/);
    const fromEmail = fromMatch ? fromMatch[2].trim() : fromRaw;
    const fromName = fromMatch ? fromMatch[1].trim() : configBrandName || 'Travio Africa';

    const templateId = TEMPLATE_IDS[template];
    const msg = {
      to,
      from: { email: fromEmail, name: fromName },
      replyTo: process.env.EMAIL_REPLY_TO,
      subject,
      attachments
    };

    if (templateId) {
      msg.templateId = templateId;
      msg.dynamicTemplateData = {
        ...data,
        supportEmail: configSupportEmail || process.env.SUPPORT_EMAIL,
        logoUrl: configLogoUrl || process.env.LOGO_URL || 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1778862668/TRAVOI_AFRICA_NEW_kd1tnr.png',
        heroImageUrl: configHeroImageUrl || process.env.HERO_IMAGE_URL || 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1747318000/email-hero-capetown.jpg',
        brandName: configBrandName || 'Travio Africa',
        year: new Date().getFullYear()
      };
    } else {
      const emailContent = generateEmailContent(template, data);
      msg.html = emailContent.html;
      msg.text = emailContent.text;
    }

    const result = await sgMail.send(msg);
    console.log(` Email sent successfully to ${to}: ${subject}`);
    
    return { success: true, messageId: result[0]?.headers?.['x-message-id'] };
  } catch (error) {
    console.error(`[Email] Failed to send to ${to}: ${subject}`, error.message);
    
    if (error.response) {
      console.error('[Email] SendGrid response body:', JSON.stringify(error.response.body, null, 2));
    }
    
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send booking confirmation email with full ticket details
 */
async function sendBookingConfirmationEmail(booking) {
  try {
    const [customer, tour] = await Promise.all([
      prisma.user.findUnique({ where: { id: booking.customerId } }),
      prisma.tour.findUnique({
        where: { id: booking.tourId },
        include: { supplier: { select: { name: true, email: true, phone: true } } }
      })
    ]);

    if (!customer || !tour) throw new Error('Booking data incomplete');

    const product = tour.productContent || {};
    const ticket = tour.bookingAndTickets || {};

    await sendEmail({
      to: customer.email,
      subject: `Booking Confirmed — ${tour.title} (Ref: ${booking.bookingNumber})`,
      template: 'booking-confirmation',
      data: {
        customerName: customer.name,
        bookingNumber: booking.bookingNumber,
        tourTitle: tour.title,
        tourDescription: tour.description,
        selectedDate: new Date(booking.selectedDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        selectedTime: booking.selectedTime,
        travelers: booking.travelers,
        subtotal: booking.subtotal,
        taxes: booking.taxes,
        totalAmount: booking.total,
        currency: booking.currency,
        meetingPoint: ticket.meetingPoint || null,
        checkInProcess: ticket.checkInProcess || null,
        cancellationPolicy: ticket.cancellationPolicy || null,
        included: product.included || [],
        whatToBring: product.whatToBring || [],
        highlights: product.highlights || [],
        restrictions: product.restrictions || null,
        supplierName: tour.supplier.name,
        supplierContact: tour.supplier.phone || tour.supplier.email,
        bookingUrl: `${process.env.CLIENT_URL}/bookings/${booking.id}`,
        ticketUrl: `${process.env.CLIENT_URL}/bookings/${booking.id}/ticket`,
        supportEmail: process.env.SUPPORT_EMAIL
      }
    });
  } catch (error) {
    console.error('Booking confirmation email failed:', error);
  }
}

/**
 * Send booking cancellation email
 */
async function sendBookingCancellationEmail(booking, refundAmount = null) {
  try {
    const customer = await prisma.user.findUnique({
      where: { id: booking.customerId }
    });

    const tour = await prisma.tour.findUnique({
      where: { id: booking.tourId }
    });

    await sendEmail({
      to: customer.email,
      subject: `Booking Cancelled - ${tour.title}`,
      template: 'booking-cancellation',
      data: {
        customerName: customer.name,
        bookingNumber: booking.bookingNumber,
        tourTitle: tour.title,
        selectedDate: new Date(booking.selectedDate).toLocaleDateString(),
        cancellationReason: booking.cancellationReason,
        refundAmount: refundAmount,
        currency: booking.currency,
        supportEmail: process.env.SUPPORT_EMAIL
      }
    });

    console.log(` Booking cancellation sent for booking ${booking.bookingNumber}`);
  } catch (error) {
    console.error(' Booking cancellation email failed:', error);
    throw error;
  }
}

/**
 * Send supplier status update email
 */
async function sendSupplierStatusEmail(email, status, data = {}) {
  try {
    const statusTemplates = {
      APPROVED: {
        subject: 'Supplier Application Approved - Welcome!',
        template: 'supplier-approved'
      },
      REJECTED: {
        subject: 'Supplier Application Update',
        template: 'supplier-rejected'
      },
      UNDER_REVIEW: {
        subject: 'Additional Information Required',
        template: 'supplier-under-review'
      },
      ACTIVE: {
        subject: 'Supplier Account Activated',
        template: 'supplier-activated'
      },
      SUSPENDED: {
        subject: 'Supplier Account Suspended',
        template: 'supplier-suspended'
      }
    };

    const config = statusTemplates[status];
    if (!config) {
      throw new Error(`Unknown supplier status: ${status}`);
    }

    await sendEmail({
      to: email,
      subject: config.subject,
      template: config.template,
      data: {
        ...data,
        status,
        brandSubtext: 'by Expedition-Go Tours',
        supplierBusinessName: data.name,
        approvalDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/dashboard`,
      }
    });

    console.log(` Supplier status email sent: ${status} to ${email}`);
  } catch (error) {
    console.error(' Supplier status email failed:', error);
    throw error;
  }
}

/**
 * Send review notification email to supplier
 */
async function sendReviewNotificationEmail(review) {
  try {
    const supplier = await prisma.user.findUnique({
      where: { id: review.tour.supplierId }
    });

    const customer = await prisma.user.findUnique({
      where: { id: review.customerId }
    });

    await sendEmail({
      to: supplier.email,
      subject: `New ${review.rating}-Star Review Received`,
      template: 'review-notification',
      data: {
        supplierName: supplier.name,
        tourTitle: review.tour.title,
        customerName: customer.name,
        rating: review.rating,
        reviewTitle: review.title,
        reviewComment: review.comment,
        reviewDate: new Date(review.createdAt).toLocaleDateString(),
        reviewUrl: `${process.env.CLIENT_URL}/supplier/reviews/${review.id}`
      }
    });

    console.log(` Review notification sent to supplier for review ${review.id}`);
  } catch (error) {
    console.error(' Review notification email failed:', error);
    throw error;
  }
}

/**
 * Send payout notification email
 */
async function sendPayoutNotificationEmail(supplierId, payoutData) {
  try {
    const supplier = await prisma.user.findUnique({
      where: { id: supplierId }
    });

    await sendEmail({
      to: supplier.email,
      subject: 'Payout Processed',
      template: 'payout-notification',
      data: {
        supplierName: supplier.name,
        payoutAmount: payoutData.amount,
        currency: payoutData.currency,
        payoutDate: new Date(payoutData.date).toLocaleDateString(),
        payoutId: payoutData.id,
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/earnings`
      }
    });

    console.log(`Payout notification sent to supplier ${supplierId}`);
  } catch (error) {
    console.error(' Payout notification email failed:', error);
    throw error;
  }
}

/**
 * Send supplier booking notification
 */
async function sendSupplierBookingNotification(booking) {
  try {
    const [supplier, tour, customer] = await Promise.all([
      prisma.user.findUnique({ where: { id: booking.tour.supplierId } }),
      prisma.tour.findUnique({ where: { id: booking.tourId } }),
      prisma.user.findUnique({ where: { id: booking.customerId } })
    ]);

    if (!supplier || !tour) throw new Error('Supplier data incomplete');

    const travelerCount = (booking.travelers?.adults || 0) + (booking.travelers?.children || 0) + (booking.travelers?.infants || 0);

    await sendEmail({
      to: supplier.email,
      subject: `New Booking — ${tour.title}`,
      template: 'supplier-booking-notification',
      data: {
        supplierName: supplier.name,
        tourTitle: tour.title,
        bookingNumber: booking.bookingNumber,
        customerName: customer?.name || 'Guest',
        selectedDate: new Date(booking.selectedDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        selectedTime: booking.selectedTime,
        travelerCount,
        totalAmount: booking.total,
        currency: booking.currency,
        customerPhone: booking.travelers?.phoneNumber || '',
        customerLocation: booking.travelers?.location || customer?.location || '',
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/bookings/${booking.id}`,
        supportEmail: process.env.SUPPORT_EMAIL
      }
    });
  } catch (error) {
    console.error('Supplier booking notification failed:', error);
  }
}

/**
 * Send team invitation email
 */
async function sendTeamInviteEmail({ to, supplierName, role, inviteUrl, invitedBy }) {
  try {
    await sendEmail({
      to,
      subject: `You've been invited to join ${supplierName}'s team`,
      template: 'team-invite',
      data: {
        supplierName,
        role,
        inviteUrl,
        invitedBy,
        brandSubtext: 'by Expedition-Go Tours',
      }
    });
  } catch (error) {
    console.error(' Team invite email failed:', error);
  }
}

/**
 * Generate email content from template
 */
function generateEmailContent(template, data) {
  const templates = {};

  const templateFunction = templates[template];
  if (!templateFunction) {
    return { html: '<p>Email template not found</p>', text: 'Email template not found' };
  }

  return templateFunction(data);
}




function generatePrintableTicketHtml(data) {
  const travelers = [];
  if (data.travelers?.adults) travelers.push(`${data.travelers.adults} Adult(s)`);
  if (data.travelers?.children) travelers.push(`${data.travelers.children} Child(ren)`);
  if (data.travelers?.infants) travelers.push(`${data.travelers.infants} Infant(s)`);

  const includedHtml = (data.included || []).map(i => `<li>${i}</li>`).join('');

  const formattedDate = new Date(data.selectedDate).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

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
  ${data.meetingPoint ? `<div class="section"><div class="stitle">Pickup Point</div><div class="svalue">${data.meetingPoint.address}</div>${data.meetingPoint.instructions ? `<div style="color:#666;font-size:13px;">${data.meetingPoint.instructions}</div>` : ''}</div>` : ''}
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
  sendEmail,
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  sendTeamInviteEmail,
  generatePrintableTicketHtml,
  generateEmailContent
};