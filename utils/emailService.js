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

// Lazy initialization: set API key on first send to avoid crash/warning
// when env var is missing during test/CI.
let sgMailInitialized = false;

function ensureSgMail() {
  if (sgMailInitialized) return;
  if (process.env.SENDGRID_API_KEY) {
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }
  sgMailInitialized = true;
}

/**
 * Send email using SendGrid
 */
async function sendEmail({ to, subject, template, data = {}, attachments = [] }) {
  ensureSgMail();
  try {
    const emailContent = generateEmailContent(template, data);
    
    const fromRaw = process.env.EMAIL_FROM || '';
    const fromMatch = fromRaw.match(/^(.*?)\s*<([^>]+)>$/);
    const fromEmail = fromMatch ? fromMatch[2].trim() : fromRaw;
    const fromName = fromMatch ? fromMatch[1].trim() : 'Travio Africa';

    const msg = {
      to,
      from: { email: fromEmail, name: fromName },
      replyTo: process.env.EMAIL_REPLY_TO,
      subject,
      html: emailContent.html,
      text: emailContent.text,
      attachments
    };

    const result = await sgMail.send(msg);
    console.log(` Email sent successfully to ${to}: ${subject}`);
    
    return { success: true, messageId: result[0].headers['x-message-id'] };
  } catch (error) {
    console.error('Email sending failed:', error);
    
    // Log email failure for debugging
    if (error.response) {
      console.error('SendGrid Error:', error.response.body);
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
        brandName: 'Travio Africa',
        brandSubtext: 'by Expedition-Go Tours',
        supplierBusinessName: data.name,
        approvalDate: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        supportEmail: process.env.SUPPORT_EMAIL,
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/dashboard`
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
 * Generate email content from template
 */
function generateEmailContent(template, data) {
  const templates = {
    'booking-confirmation': generateBookingConfirmationTemplate,
    'booking-cancellation': generateBookingCancellationTemplate,
    'supplier-approved': generateSupplierApprovedTemplate,
    'supplier-rejected': generateSupplierRejectedTemplate,
    'supplier-under-review': generateSupplierUnderReviewTemplate,
    'supplier-activated': generateSupplierActivatedTemplate,
    'supplier-suspended': generateSupplierSuspendedTemplate,
    'review-notification': generateReviewNotificationTemplate,
    'payout-notification': generatePayoutNotificationTemplate,
    'supplier-booking-notification': generateSupplierBookingNotificationTemplate,
    'generic-notification': generateGenericNotificationTemplate
  };

  const templateFunction = templates[template];
  if (!templateFunction) {
    return generateGenericNotificationTemplate(data);
  }

  return templateFunction(data);
}

/**
 * Email template generators
 */
function generateBookingConfirmationTemplate(data) {
  const travelers = [];
  if (data.travelers?.adults) travelers.push(`${data.travelers.adults} Adult(s)`);
  if (data.travelers?.children) travelers.push(`${data.travelers.children} Child(ren)`);
  if (data.travelers?.infants) travelers.push(`${data.travelers.infants} Infant(s)`);

  const includedHtml = (data.included || []).map(i => `<li style="padding:3px 0;color:#64748B;font-size:13px;line-height:1.5;">${i}</li>`).join('');
  const bringHtml = (data.whatToBring || []).map(b => `<li style="padding:3px 0;color:#64748B;font-size:13px;line-height:1.5;">${b}</li>`).join('');

  const brandName = data.brandName || 'Travio Africa';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Booking Confirmed</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">

          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 24px 40px;">
              <img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;">
            </td>
          </tr>

          <!-- Title & Status -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Booking Confirmed</h1>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td bgcolor="#E6F6F0" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #00A669; line-height: 1;" class="font-main">
                          &#x2713;&nbsp;&nbsp;Confirmed
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Booking Reference Block -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" bgcolor="#F8FAFC" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 24px 32px; text-align: center;" align="center">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Booking Reference</span>
                    <span style="font-size: 32px; font-weight: 800; color: #001F3F; line-height: 1;" class="font-main">${data.bookingNumber}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tour Details Card -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 32px;">

                <!-- Tour Title -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                    <h3 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #001F3F; line-height: 1.4;" class="font-main">${data.tourTitle}</h3>
                    <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.4;" class="font-main">Your booking has been confirmed. Details below.</p>
                  </td>
                </tr>
                </table>

                <!-- Date -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Date</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.selectedDate}</span>
                  </td>
                </tr>
                </table>

                <!-- Time -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Time</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.selectedTime || 'Flexible'}</span>
                  </td>
                </tr>
                </table>

                <!-- Meeting Point -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Meeting Point</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.meetingPoint?.address || 'To be confirmed'}</span>
                    ${data.meetingPoint?.instructions ? `<p style="margin: 4px 0 0; font-size: 13px; color: #64748B; line-height: 1.4;" class="font-main">${data.meetingPoint.instructions}</p>` : ''}
                    ${data.meetingPoint?.coordinates ? `<p style="margin: 4px 0 0;"><a href="https://maps.google.com/?q=${data.meetingPoint.coordinates.lat},${data.meetingPoint.coordinates.lng}" style="color: #00A669; font-size: 13px; text-decoration: underline; font-weight: 600;" class="font-main">View on Google Maps &rarr;</a></p>` : ''}
                  </td>
                </tr>
                </table>

                <!-- Travelers -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Travelers</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${travelers.join(' &bull; ') || '1 Adult'}</span>
                  </td>
                </tr>
                </table>

                <!-- Tour Operator -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0 24px 0;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Tour Operator</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.supplierName}</span>
                  </td>
                </tr>
                </table>

                <!-- Total Paid -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 18px 24px;" align="left" valign="middle">
                          <span style="display: block; font-size: 11px; font-weight: 700; color: #00A669; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;" class="font-main">Total Paid</span>
                          <span style="font-size: 26px; font-weight: 800; color: #00A669; line-height: 1;" class="font-main">${data.currency} ${parseFloat(data.totalAmount || 0).toFixed(2)}</span>
                          ${data.subtotal ? `
                          <table cellpadding="0" cellspacing="0" border="0" style="margin-top: 6px;">
                            <tr><td style="color: #64748B; font-size: 12px; padding: 1px 0;">Subtotal</td><td style="padding: 1px 0 1px 12px; color: #001F3F; font-size: 12px; font-weight: 500;">${data.currency} ${parseFloat(data.subtotal).toFixed(2)}</td></tr>
                            ${data.taxes ? `<tr><td style="color: #64748B; font-size: 12px; padding: 1px 0;">Taxes &amp; Fees</td><td style="padding: 1px 0 1px 12px; color: #001F3F; font-size: 12px;">${data.currency} ${parseFloat(data.taxes).toFixed(2)}</td></tr>` : ''}
                          </table>` : ''}
                        </td>
                        <td style="padding: 18px 24px; text-align: right;" align="right" valign="middle" width="60">
                          <table role="presentation" width="36" height="36" bgcolor="#00A669" style="border-radius: 50%;" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td align="center" valign="middle" style="font-size: 16px; color: #ffffff; line-height: 36px;">&#x2713;</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                </table>

                </td></tr>
              </table>
            </td>
          </tr>

          <!-- What's Included -->
          ${includedHtml ? `
          <tr>
            <td style="padding: 0 40px 20px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;" class="font-main">What's Included</span>
                  <ul style="margin: 0; padding-left: 16px;">${includedHtml}</ul>
                </td></tr>
              </table>
            </td>
          </tr>` : ''}

          <!-- What to Bring -->
          ${bringHtml ? `
          <tr>
            <td style="padding: 0 40px 20px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;" class="font-main">What to Bring</span>
                  <ul style="margin: 0; padding-left: 16px;">${bringHtml}</ul>
                </td></tr>
              </table>
            </td>
          </tr>` : ''}

          <!-- Cancellation Policy -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Cancellation Policy</span>
                  <p style="margin: 0; font-size: 13px; color: #64748B; line-height: 1.5;" class="font-main">${data.cancellationPolicy || 'Free cancellation up to 24 hours before start time'}</p>
                </td></tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${data.bookingUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">View Booking Details &nbsp;&rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tour Operator Contact Strip -->
          ${data.supplierContact ? `
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" bgcolor="#F8FAFC" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 16px 24px;" align="left" valign="middle">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;" class="font-main">Tour Operator</span>
                    <span style="font-size: 14px; font-weight: 600; color: #001F3F;" class="font-main">${data.supplierName}</span>
                  </td>
                  <td style="padding: 16px 24px; text-align: right;" align="right" valign="middle">
                    <a href="tel:${data.supplierContact}" style="color: #00A669; font-size: 14px; font-weight: 600; text-decoration: none;" class="font-main">&#x1F4DE;&nbsp; ${data.supplierContact}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>` : ''}

          <!-- Footer -->
          <tr>
            <td bgcolor="#001F3F" style="padding: 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main">
                    <strong style="color: #00A669; font-size: 14px;">Thank you for booking!</strong><br>
                    <span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span>
                  </td>
                  <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">
                    Need help? <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: underline; font-weight: 600;">Contact us</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">
          &copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
BOOKING CONFIRMED! — ${data.tourTitle}
Booking Ref: ${data.bookingNumber}
Status: Confirmed

Date: ${data.selectedDate}${data.selectedTime ? ' at ' + data.selectedTime : ''}
Meeting Point: ${data.meetingPoint?.address || 'To be confirmed'}
Travelers: ${travelers.join(', ') || '1 Adult'}
Tour Operator: ${data.supplierName}${data.supplierContact ? ' | ' + data.supplierContact : ''}

Total Paid: ${data.currency} ${data.totalAmount}
${data.subtotal ? `Subtotal: ${data.currency} ${data.subtotal}` : ''}${data.taxes ? `\nTaxes & Fees: ${data.currency} ${data.taxes}` : ''}

Cancellation: ${data.cancellationPolicy || 'Free cancellation up to 24 hours before start time'}

View booking details: ${data.bookingUrl}

Need help? ${supportEmail}

${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateBookingCancellationTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Booking Cancelled</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">

          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 24px 40px;">
              <img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;">
            </td>
          </tr>

          <!-- Title & Status -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Booking Cancelled</h1>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td bgcolor="#FEF2F2" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #DC2626; line-height: 1;" class="font-main">
                          Cancelled
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Booking Reference Block -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" bgcolor="#F8FAFC" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 24px 32px; text-align: center;" align="center">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Booking Reference</span>
                    <span style="font-size: 32px; font-weight: 800; color: #001F3F; line-height: 1;" class="font-main">${data.bookingNumber}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Cancellation Details Card -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 32px;">

                <!-- Tour Title -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                    <h3 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #001F3F; line-height: 1.4;" class="font-main">${data.tourTitle}</h3>
                    <p style="margin: 0 0 16px 0; font-size: 14px; color: #64748B; line-height: 1.4;" class="font-main">Hi ${data.customerName}, your booking has been cancelled as requested.</p>
                  </td>
                </tr>
                </table>

                <!-- Date -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Original Date</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.selectedDate}</span>
                  </td>
                </tr>
                </table>

                <!-- Reason -->
                ${data.cancellationReason ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0 24px 0;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Reason</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.cancellationReason}</span>
                  </td>
                </tr>
                </table>` : ''}

                ${data.refundAmount ? `
                <!-- Refund Info -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 18px 24px;" align="left" valign="middle">
                          <span style="display: block; font-size: 11px; font-weight: 700; color: #00A669; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;" class="font-main">Refund Amount</span>
                          <span style="font-size: 26px; font-weight: 800; color: #00A669; line-height: 1;" class="font-main">${data.currency} ${parseFloat(data.refundAmount).toFixed(2)}</span>
                          <p style="margin: 6px 0 0; font-size: 13px; color: #475569; line-height: 1.4;" class="font-main">Processed to your original payment method within 5-7 business days.</p>
                        </td>
                        <td style="padding: 18px 24px; text-align: right;" align="right" valign="middle" width="60">
                          <table role="presentation" width="36" height="36" bgcolor="#00A669" style="border-radius: 50%;" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td align="center" valign="middle" style="font-size: 16px; color: #ffffff; line-height: 36px;">&#x2713;</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                </table>` : ''}

                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding: 0 40px 40px 40px;" align="center">
              <span style="font-size: 13px; color: #64748B;" class="font-main">We're sorry to see you go. Need help? <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#001F3F" style="padding: 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main">
                    <strong style="color: #00A669; font-size: 14px;">Thank you for choosing us!</strong><br>
                    <span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span>
                  </td>
                  <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">
                    Hope to see you again.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">
          &copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
BOOKING CANCELLED — ${data.tourTitle}
Booking Ref: ${data.bookingNumber}
Status: Cancelled

Hi ${data.customerName},

Your booking has been cancelled as requested.
Original Date: ${data.selectedDate}
${data.cancellationReason ? 'Reason: ' + data.cancellationReason : ''}
${data.refundAmount ? 'Refund of ' + data.currency + ' ' + data.refundAmount + ' will be processed within 5-7 business days.' : ''}

Questions? Contact: ${supportEmail}

${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateSupplierApprovedTemplate(data = {}) {
  const brandName = data.brandName || 'Travio Africa';
  const supplierName = data.supplierBusinessName || data.name || 'there';
  const dashboardUrl = data.dashboardUrl || '#';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const heroImageUrl = data.heroImageUrl || process.env.HERO_IMAGE_URL || 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1747318000/email-hero-capetown.jpg';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Welcome to ${brandName}</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">

          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left">
                    <img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;">
                  </td>
                  <td align="right" valign="middle">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">
                          &#x1F464;&nbsp;&nbsp;Supplier
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero Section (55/45 split) -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td width="55%" valign="top" style="padding-right: 20px;" align="left">
                    <h1 style="margin: 0 0 16px 0; font-size: 32px; font-weight: 800; color: #001F3F; line-height: 1.15;" class="font-main">Welcome to<br>Travio <span style="color: #00A669;">Africa!</span></h1>
                    <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${supplierName},</p>
                    <p style="margin: 0 0 8px 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">Congratulations! Your supplier application has been approved.</p>
                    <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">You're now part of our tour platform community.</p>
                  </td>
                  <td width="45%" valign="top" align="right">
                    <img src="${heroImageUrl}" alt="Scenic travel destination" width="220" style="display: block; max-width: 220px; height: auto; border-radius: 30% 0% 30% 30%; border-right: 4px solid #00A669;">
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Next Steps Card -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <!-- Title row -->
                <tr><td style="padding: 32px 32px 24px 32px;" align="left">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="font-size: 24px; padding-right: 12px; line-height: 1;" valign="middle">&#x1F4CB;</td>
                        <td valign="middle" align="left">
                          <h3 style="margin: 0 0 2px 0; font-size: 18px; font-weight: 700; color: #001F3F; line-height: 1.3;" class="font-main">Your next steps</h3>
                          <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.3;" class="font-main">Follow these simple steps to get started on ${brandName}.</p>
                        </td>
                      </tr>
                    </table>
                  </td></tr>

                <!-- 3 Steps -->
                <tr><td style="padding: 0 32px 32px 32px;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td width="33.33%" valign="top" style="padding-right: 8px;" align="left">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td width="48" height="48" bgcolor="#E6F6F0" style="border-radius: 50%; text-align: center; line-height: 48px;" align="center" valign="middle">
                                <span style="font-size: 20px; line-height: 48px;">&#x1F4B3;</span>
                              </td>
                            </tr>
                          </table>
                          <div style="margin-top: 12px; margin-bottom: 8px;"><span style="background-color: #00A669; color: #ffffff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; line-height: 1.4;" class="font-main">1</span></div>
                          <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #001F3F; line-height: 1.3;" class="font-main">Set up your payment method</h4>
                          <p style="margin: 0; font-size: 12px; color: #64748B; line-height: 1.4;" class="font-main">Set up your payment method to start receiving payments securely.</p>
                        </td>
                        <td width="33.33%" valign="top" style="padding-left: 4px; padding-right: 4px;" align="left">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td width="48" height="48" bgcolor="#E6F6F0" style="border-radius: 50%; text-align: center; line-height: 48px;" align="center" valign="middle">
                                <span style="font-size: 20px; line-height: 48px;">&#x1F9F3;</span>
                              </td>
                            </tr>
                          </table>
                          <div style="margin-top: 12px; margin-bottom: 8px;"><span style="background-color: #00A669; color: #ffffff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; line-height: 1.4;" class="font-main">2</span></div>
                          <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #001F3F; line-height: 1.3;" class="font-main">Create your first tour listing</h4>
                          <p style="margin: 0; font-size: 12px; color: #64748B; line-height: 1.4;" class="font-main">Add your tours and start reaching global travelers.</p>
                        </td>
                        <td width="33.33%" valign="top" style="padding-left: 8px;" align="left">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td width="48" height="48" bgcolor="#E6F6F0" style="border-radius: 50%; text-align: center; line-height: 48px;" align="center" valign="middle">
                                <span style="font-size: 20px; line-height: 48px;">&#x1F464;</span>
                              </td>
                            </tr>
                          </table>
                          <div style="margin-top: 12px; margin-bottom: 8px;"><span style="background-color: #00A669; color: #ffffff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px; line-height: 1.4;" class="font-main">3</span></div>
                          <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: #001F3F; line-height: 1.3;" class="font-main">Set up your supplier profile</h4>
                          <p style="margin: 0; font-size: 12px; color: #64748B; line-height: 1.4;" class="font-main">Tell travelers about your business and unique expertise.</p>
                        </td>
                      </tr>
                    </table>
                  </td></tr>
              </table>
            </td>
          </tr>

          <!-- Ready-State Row -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 24px 0 24px 24px;" width="56" valign="middle" align="center">
                    <span style="font-size: 28px; line-height: 1;">&#x1F4C8;</span>
                  </td>
                  <td style="padding: 24px 16px 24px 24px;" align="left" valign="middle">
                    <h4 style="margin: 0 0 4px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">You're all set!</h4>
                    <p style="margin: 0; font-size: 13px; color: #475569; line-height: 1.4;" class="font-main">Access your dashboard to manage your listings, bookings, and grow your business with ${brandName}.</p>
                  </td>
                  <td style="padding: 24px; text-align: right;" align="right" valign="middle" width="190">
                    <a href="${dashboardUrl}" target="_blank" style="display: inline-block; background-color: #00A669; padding: 12px 20px; border-radius: 8px; color: #ffffff; font-size: 14px; font-weight: 700; text-decoration: none; white-space: nowrap;" class="font-main">Access Your Dashboard &nbsp;&rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding: 0 40px 40px 40px;" align="center">
              <span style="font-size: 13px; color: #64748B;" class="font-main">&#x1F3A7;&nbsp;&nbsp;Need help getting started? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#001F3F" style="padding: 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main">
                    <strong style="color: #00A669; font-size: 14px;">Welcome aboard!</strong><br>
                    <span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span>
                  </td>
                  <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 24px; color: #ffffff; font-weight: 400;" valign="middle">
                    Let's <span style="color: #00A669;">grow</span> together.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">
          &copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
WELCOME TO ${brandName.toUpperCase()}!

Hi ${supplierName},

Congratulations! Your supplier application has been approved. You're now part of our tour platform community.

YOUR NEXT STEPS:
1. Set up your payment method — to start receiving payments securely
2. Create your first tour listing — add your tours and reach global travelers
3. Set up your supplier profile — tell travelers about your business and unique expertise

Access your dashboard: ${dashboardUrl}

Need help getting started? Contact us at: ${supportEmail}

Welcome aboard!
${brandName} Team
${year} ${brandName} by Expedition-Go Tours. All rights reserved.
Let's grow together.`;

  return { html, text };
}

function generateSupplierRejectedTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supplierName = data.supplierBusinessName || data.name || 'there';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Application Update</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">

          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left">
                    <img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;">
                  </td>
                  <td align="right" valign="middle">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">
                          Supplier
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Title & Status -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Application Update</h1>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;">
                      <tr>
                        <td bgcolor="#FEF2F2" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #DC2626; line-height: 1;" class="font-main">
                          Not Approved
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Message Card -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 32px;">

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                    <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${supplierName},</p>
                    <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">Thank you for your interest in becoming a supplier on ${brandName}. After careful review, we're unable to approve your application at this time.</p>
                  </td>
                </tr>
                </table>

                ${data.notes ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0;">
                    <table role="presentation" width="100%" bgcolor="#FEF2F2" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                      <tr><td style="padding: 20px 24px;">
                        <span style="display: block; font-size: 11px; font-weight: 700; color: #DC2626; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;" class="font-main">Feedback</span>
                        <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5;" class="font-main">${data.notes}</p>
                      </td></tr>
                    </table>
                  </td>
                </tr>
                </table>` : ''}

                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-top: 8px;">
                    <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.5;" class="font-main">You're welcome to reapply in the future. If you have questions, please reach out to our team.</p>
                  </td>
                </tr>
                </table>

                </td></tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding: 0 40px 40px 40px;" align="center">
              <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#001F3F" style="padding: 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main">
                    <strong style="color: #00A669; font-size: 14px;">Thank you for your interest</strong><br>
                    <span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span>
                  </td>
                  <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">
                    Wishing you the best.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">
          &copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
APPLICATION UPDATE — Not Approved

Hi ${supplierName},

Thank you for your interest in becoming a supplier on ${brandName}. After careful review, we're unable to approve your application at this time.

${data.notes ? 'Feedback: ' + data.notes : ''}

You're welcome to reapply in the future. Questions? Contact: ${supportEmail}

${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateSupplierBookingNotificationTemplate(data) {
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>New Booking Received</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 24px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left">
                    <img src="${logoUrl}" alt="Travio Africa" width="180" style="display: block; max-width: 180px; height: auto;">
                </td>
                  <td align="right" valign="middle">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">
                          &#x1F3EA;&nbsp;&nbsp;Supplier
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Title & Status -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left">
                    <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">New Booking Received</h1>
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td bgcolor="#E6F6F0" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #00A669; line-height: 1;" class="font-main">
                          &#x2713;&nbsp;&nbsp;Confirmed
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Booking Reference Block -->
          <tr>
            <td style="padding: 0 40px 32px 40px;">
              <table role="presentation" width="100%" bgcolor="#F8FAFC" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 24px 32px; text-align: center;" align="center">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Booking Reference</span>
                    <span style="font-size: 32px; font-weight: 800; color: #001F3F; line-height: 1;" class="font-main">${data.bookingNumber}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tour Details Card -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                <tr><td style="padding: 32px;">

                <!-- Tour Title Header -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                    <h3 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #001F3F; line-height: 1.4;" class="font-main">${data.tourTitle}</h3>
                    <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.4;" class="font-main">A guest has booked your tour. Details below.</p>
                  </td>
                </tr>
                </table>

                <!-- Customer -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Customer</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.customerName}</span>
                  </td>
                </tr>
                </table>

                <!-- Phone -->
                ${data.customerPhone ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Phone / WhatsApp</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.customerPhone}</span>
                  </td>
                </tr>
                </table>` : ''}

                <!-- Location -->
                ${data.customerLocation ? `
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Location</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.customerLocation}</span>
                  </td>
                </tr>
                </table>` : ''}

                <!-- Date & Time -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td width="50%" valign="top" style="padding-right: 12px;" align="left">
                          <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Date</span>
                          <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.selectedDate}</span>
                        </td>
                        <td width="50%" valign="top" style="padding-left: 12px;" align="left">
                          <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Time</span>
                          <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.selectedTime || '\u2014'}</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                </table>

                <!-- Travelers -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td style="padding: 20px 0 24px 0;">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Travelers</span>
                    <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.travelerCount} guest(s)</span>
                  </td>
                </tr>
                </table>

                <!-- Total Paid -->
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding: 18px 24px;" align="left" valign="middle">
                          <span style="display: block; font-size: 11px; font-weight: 700; color: #00A669; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;" class="font-main">Total Paid</span>
                          <span style="font-size: 26px; font-weight: 800; color: #00A669; line-height: 1;" class="font-main">${data.currency} ${data.totalAmount}</span>
                        </td>
                        <td style="padding: 18px 24px; text-align: right;" align="right" valign="middle" width="60">
                          <table role="presentation" width="36" height="36" bgcolor="#00A669" style="border-radius: 50%;" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td align="center" valign="middle" style="font-size: 16px; color: #ffffff; line-height: 36px;">&#x2713;</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                </table>

                </td></tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center">
                    <a href="${data.dashboardUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">View in Dashboard &nbsp;&rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td style="padding: 0 40px 40px 40px;" align="center">
              <span style="font-size: 13px; color: #64748B;" class="font-main">&#x1F3A7;&nbsp;&nbsp;Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td bgcolor="#001F3F" style="padding: 32px 40px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main">
                    <strong style="color: #00A669; font-size: 14px;">Welcome aboard!</strong><br>
                    <span style="color: #94A3B8; font-size: 13px;">Travio Africa Team</span>
                  </td>
                  <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 24px; color: #ffffff; font-weight: 400;" valign="middle">
                    Let's <span style="color: #00A669;">grow</span> together.
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>

        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">
          &copy; ${year} Travio Africa by Expedition-Go Tours. All rights reserved.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
NEW BOOKING! — ${data.tourTitle}
Ref: ${data.bookingNumber}
Status: Confirmed

Customer: ${data.customerName}
${data.customerPhone ? 'Phone: ' + data.customerPhone : ''}
${data.customerLocation ? 'Location: ' + data.customerLocation : ''}
Date: ${data.selectedDate}${data.selectedTime ? ' at ' + data.selectedTime : ''}
Travelers: ${data.travelerCount}

Total Paid: ${data.currency} ${data.totalAmount}

View in Dashboard: ${data.dashboardUrl}

Need help? ${supportEmail}

${year} Travio Africa by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
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

// Add other template generators as needed...
function generateSupplierUnderReviewTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supplierName = data.supplierBusinessName || data.name || 'there';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Additional Information Required</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left"><img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;"></td>
                <td align="right" valign="middle">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">Supplier</td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Additional Information Required</h1>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;"><tr><td bgcolor="#FEF3C7" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #D97706; line-height: 1;" class="font-main">Under Review</td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${supplierName},</p>
                <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">We're currently reviewing your supplier application. To complete the process, we need some additional documents from you.</p>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0;">
                <table role="presentation" width="100%" bgcolor="#FEF3C7" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #D97706; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;" class="font-main">Action Required</span>
                  <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5;" class="font-main">Please log in to your dashboard to upload the requested items. This will help us complete your review promptly.</p>
                </td></tr></table>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-top: 8px;">
                <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.5;" class="font-main">If you have any questions about the required documents, don't hesitate to reach out.</p>
              </td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">We're almost there!</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">Just a few more steps.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `ADDITIONAL INFORMATION REQUIRED\n\nHi ${supplierName},\n\nWe're reviewing your supplier application and need some additional documents.\n\nPlease log in to your dashboard to upload the requested items.\n\nQuestions? Contact: ${supportEmail}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateSupplierActivatedTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supplierName = data.supplierBusinessName || data.name || 'there';
  const dashboardUrl = data.dashboardUrl || '#';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Account Activated</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left"><img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;"></td>
                <td align="right" valign="middle">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">Supplier</td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Account Activated</h1>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;"><tr><td bgcolor="#E6F6F0" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #00A669; line-height: 1;" class="font-main">&#x2713;&nbsp;&nbsp;Active</td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${supplierName},</p>
                <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">Your Stripe onboarding is complete. Your supplier account is now active and you can start receiving bookings and payouts.</p>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0;">
                <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #00A669; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;" class="font-main">What's Next</span>
                  <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5;" class="font-main">Your account is fully set up. You can now manage listings, accept bookings, and track your earnings from your dashboard.</p>
                </td></tr></table>
              </td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <a href="${dashboardUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">Go to Dashboard &nbsp;&rarr;</a>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">You're live!</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">Let's grow together.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `ACCOUNT ACTIVATED\n\nHi ${supplierName},\n\nYour Stripe onboarding is complete. Your supplier account is now active.\n\nGo to dashboard: ${dashboardUrl}\n\nQuestions? Contact: ${supportEmail}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateSupplierSuspendedTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supplierName = data.supplierBusinessName || data.name || 'there';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Account Suspended</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left"><img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;"></td>
                <td align="right" valign="middle">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">Supplier</td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">Account Suspended</h1>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;"><tr><td bgcolor="#FEF2F2" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #DC2626; line-height: 1;" class="font-main">Suspended</td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${supplierName},</p>
                <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">Your supplier account has been temporarily suspended. This action was taken to ensure the security and integrity of our platform.</p>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0;">
                <table role="presentation" width="100%" bgcolor="#FEF2F2" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 24px;">
                  <span style="display: block; font-size: 11px; font-weight: 700; color: #DC2626; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px;" class="font-main">What to Do</span>
                  <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5;" class="font-main">Please contact our support team for more information about this suspension and the steps needed to restore your account.</p>
                </td></tr></table>
              </td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Contact support at <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">We're here to help</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">Let's resolve this.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `ACCOUNT SUSPENDED\n\nHi ${supplierName},\n\nYour supplier account has been temporarily suspended.\n\nPlease contact our support team for more information and steps to restore your account.\n\nContact: ${supportEmail}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateReviewNotificationTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const dashboardUrl = data.reviewUrl || '#';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const stars = '&#x2605;'.repeat(data.rating || 0) + '&#x2606;'.repeat(5 - (data.rating || 0));

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>New Review Received</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left"><img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;"></td>
                <td align="right" valign="middle">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">Supplier</td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">New Review Received</h1>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;"><tr><td bgcolor="#FEF3C7" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: #D97706; line-height: 1;" class="font-main">${data.rating || 0}-Star Review</td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                <h3 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #001F3F; line-height: 1.4;" class="font-main">${data.tourTitle}</h3>
                <p style="margin: 0; font-size: 14px; color: #64748B; line-height: 1.4;" class="font-main">${data.customerName} left a review on ${data.reviewDate}</p>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Rating</span>
                <span style="font-size: 20px; color: #F59E0B; letter-spacing: 2px;" class="font-main">${stars}</span>
              </td></tr></table>
              ${data.reviewTitle ? `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Title</span>
                <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.reviewTitle}</span>
              </td></tr></table>` : ''}
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Comment</span>
                <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.5;" class="font-main">${data.reviewComment || 'No comment provided.'}</p>
              </td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <a href="${dashboardUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">View Review &nbsp;&rarr;</a>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">Keep up the great work!</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">Reviews fuel your success.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `NEW REVIEW — ${data.rating || 0} Stars\n\nTour: ${data.tourTitle}\nCustomer: ${data.customerName}\nDate: ${data.reviewDate}\n${data.reviewTitle ? 'Title: ' + data.reviewTitle + '\n' : ''}Comment: ${data.reviewComment || 'No comment provided.'}\n\nView review: ${dashboardUrl}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generatePayoutNotificationTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const dashboardUrl = data.dashboardUrl || '#';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const year = new Date().getFullYear();

  const pageTitle = data.title || 'Payout Processed';
  const pageMessage = data.message || 'Your payout has been processed and is on its way to your bank account.';
  const statusLabel = data.statusLabel || 'Sent';
  const statusColor = data.statusColor || '#E6F6F0';
  const statusTextColor = data.statusTextColor || '#00A669';

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>${pageTitle}</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td align="left"><img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;"></td>
                <td align="right" valign="middle">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td bgcolor="#F1F5F9" style="border-radius: 50px; padding: 6px 14px; font-size: 13px; font-weight: 600; color: #334155; line-height: 1;" class="font-main">Supplier</td></tr></table>
                </td>
              </tr>
            </table>
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">${pageTitle}</h1>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto;"><tr><td bgcolor="${statusColor}" style="border-radius: 20px; padding: 6px 16px; font-size: 14px; font-weight: 700; color: ${statusTextColor}; line-height: 1;" class="font-main">${statusLabel}</td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding-bottom: 24px; border-bottom: 1px solid #E2E8F0;">
                <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 700; color: #001F3F;" class="font-main">Hi ${data.supplierName},</p>
                <p style="margin: 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">${pageMessage}</p>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Payout ID</span>
                <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.payoutId}</span>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Tour</span>
                <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.tourTitle || 'N/A'}</span>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0; border-bottom: 1px solid #F1F5F9;">
                <span style="display: block; font-size: 11px; font-weight: 700; color: #64748B; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px;" class="font-main">Date</span>
                <span style="font-size: 15px; font-weight: 600; color: #001F3F;" class="font-main">${data.payoutDate}</span>
              </td></tr></table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 20px 0;">
                <table role="presentation" width="100%" bgcolor="#F0FDF4" style="border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr>
                  <td style="padding: 18px 24px;" align="left" valign="middle">
                    <span style="display: block; font-size: 11px; font-weight: 700; color: #00A669; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px;" class="font-main">Amount</span>
                    <span style="font-size: 26px; font-weight: 800; color: #00A669; line-height: 1;" class="font-main">${data.currency} ${parseFloat(data.payoutAmount).toFixed(2)}</span>
                  </td>
                  <td style="padding: 18px 24px; text-align: right;" align="right" valign="middle" width="60">
                    <table role="presentation" width="36" height="36" bgcolor="#00A669" style="border-radius: 50%;" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" valign="middle" style="font-size: 16px; color: #ffffff; line-height: 36px;">&#x2713;</td></tr></table>
                  </td>
                </tr></table>
              </td></tr></table>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <a href="${dashboardUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">View Earnings &nbsp;&rarr;</a>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">Enjoy your earnings!</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">Here's to more.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${pageTitle.toUpperCase()}\n\nHi ${data.supplierName},\n\n${pageMessage}\nPayout ID: ${data.payoutId}\nTour: ${data.tourTitle || 'N/A'}\nDate: ${data.payoutDate}\nAmount: ${data.currency} ${data.payoutAmount}\n\nView earnings: ${dashboardUrl}\n\nQuestions? Contact: ${supportEmail}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

function generateGenericNotificationTemplate(data) {
  const brandName = data.brandName || 'Travio Africa';
  const supportEmail = data.supportEmail || 'support@expeditiongo.com';
  const logoUrl = data.logoUrl || process.env.LOGO_URL || 'https://firebasestorage.googleapis.com/v0/b/expedition-go-tours-domain.appspot.com/o/travio-logo.png?alt=media';
  const actionUrl = data.actionUrl || '#';
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="x-apple-disable-message-reformatting">
  <title>Notification</title>
  <style>
    body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; background-color: #F8FAFC; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; border-collapse: collapse; }
    img { border: 0; outline: none; text-decoration: none; -ms-interpolation-mode: bicubic; }
    .font-main { font-family: 'Plus Jakarta Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#F8FAFC">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="100%" style="max-width: 640px; background-color: #ffffff; border: 1px solid #E2E8F0; border-radius: 16px;" cellspacing="0" cellpadding="0" border="0">
          <tr><td style="padding: 40px 40px 24px 40px;">
            <img src="${logoUrl}" alt="${brandName}" width="180" style="display: block; max-width: 180px; height: auto;">
          </td></tr>
          <tr><td style="padding: 0 40px 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <h1 style="margin: 0 0 12px 0; font-size: 28px; font-weight: 800; color: #001F3F; line-height: 1.2;" class="font-main">${data.title || 'Notification'}</h1>
            </td></tr></table>
          </td></tr>
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" style="border: 1px solid #E2E8F0; border-radius: 12px;" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding: 32px;">
              <p style="margin: 0 0 16px 0; font-size: 15px; color: #334155; line-height: 1.5;" class="font-main">${data.message}</p>
              ${data.userName ? `<p style="margin: 0; font-size: 14px; color: #64748B;" class="font-main">Hi ${data.userName},</p>` : ''}
            </td></tr></table>
          </td></tr>
          ${actionUrl && actionUrl !== '#' ? `
          <tr><td style="padding: 0 40px 40px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center">
              <a href="${actionUrl}" target="_blank" style="display: block; width: 100%; background-color: #00A669; padding: 16px 0; text-align: center; border-radius: 10px; color: #ffffff; font-size: 16px; font-weight: 700; text-decoration: none; line-height: 1;" class="font-main">Take Action &nbsp;&rarr;</a>
            </td></tr></table>
          </td></tr>` : ''}
          <tr><td style="padding: 0 40px 40px 40px;" align="center">
            <span style="font-size: 13px; color: #64748B;" class="font-main">Need help? Contact <a href="mailto:${supportEmail}" style="color: #00A669; text-decoration: none; font-weight: 600;">${supportEmail}</a></span>
          </td></tr>
          <tr><td bgcolor="#001F3F" style="padding: 32px 40px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td align="left" style="color: #ffffff; font-size: 14px; line-height: 1.4;" class="font-main"><strong style="color: #00A669; font-size: 14px;">Best regards</strong><br><span style="color: #94A3B8; font-size: 13px;">${brandName} Team</span></td>
              <td align="right" style="font-family: 'Caveat', 'Georgia', 'Apple Chancery', cursive; font-size: 20px; color: #ffffff; font-weight: 400;" valign="middle">We're here for you.</td>
            </tr></table>
          </td></tr>
        </table>
        <p style="margin: 24px 0 0 0; text-align: center; font-size: 11px; color: #94A3B8; line-height: 1;" class="font-main">&copy; ${year} ${brandName} by Expedition-Go Tours. All rights reserved.</p>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${data.title || 'Notification'}\n\n${data.message}\n\n${year} ${brandName} by Expedition-Go Tours. All rights reserved.`;

  return { html, text };
}

module.exports = {
  sendEmail,
  sendBookingConfirmationEmail,
  sendBookingCancellationEmail,
  sendSupplierStatusEmail,
  sendReviewNotificationEmail,
  sendPayoutNotificationEmail,
  sendSupplierBookingNotification,
  generatePrintableTicketHtml
};