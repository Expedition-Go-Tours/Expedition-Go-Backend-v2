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

// Initialize SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

/**
 * Send email using SendGrid
 */
async function sendEmail({ to, subject, template, data = {}, attachments = [] }) {
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
    console.log(`📧 Email sent successfully to ${to}: ${subject}`);
    
    return { success: true, messageId: result[0].headers['x-message-id'] };
  } catch (error) {
    console.error('❌ Email sending failed:', error);
    
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

    console.log(`✅ Booking cancellation sent for booking ${booking.bookingNumber}`);
  } catch (error) {
    console.error('❌ Booking cancellation email failed:', error);
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
        supportEmail: process.env.SUPPORT_EMAIL,
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/dashboard`
      }
    });

    console.log(`✅ Supplier status email sent: ${status} to ${email}`);
  } catch (error) {
    console.error('❌ Supplier status email failed:', error);
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

    console.log(`✅ Review notification sent to supplier for review ${review.id}`);
  } catch (error) {
    console.error('❌ Review notification email failed:', error);
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

    console.log(`✅ Payout notification sent to supplier ${supplierId}`);
  } catch (error) {
    console.error('❌ Payout notification email failed:', error);
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
        customerLocation: booking.travelers?.location || '',
        dashboardUrl: `${process.env.CLIENT_URL}/supplier/bookings/${booking.id}`
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

  const includedHtml = (data.included || []).map(i => `<li style="padding:3px 0;color:#111827;font-size:14px;line-height:1.5;">${i}</li>`).join('');
  const bringHtml = (data.whatToBring || []).map(b => `<li style="padding:3px 0;color:#111827;font-size:14px;line-height:1.5;">${b}</li>`).join('');

  const html = `<!DOCTYPE html>
<html data-ogsc="" data-ogsb="" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head><meta charset="utf-8">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>
  html, body { margin: 0; padding: 0; background-color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { width: 100%; table-layout: fixed; background-color: #ffffff !important; }
  .main { max-width: 600px; margin: 0 auto; background-color: #ffffff !important; }
  .head { padding: 36px 32px 12px; text-align: center; }
  .section { padding: 14px 32px; border-bottom: 1px solid #e5e7eb; }
  .label { font-size: 11px; font-weight: 600; color: #6b7280 !important; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 3px; word-break: break-word; overflow-wrap: break-word; }
  .value { font-size: 15px; font-weight: 600; color: #111827 !important; margin: 0; line-height: 1.4; word-break: break-word; overflow-wrap: break-word; }
  .value-sm { font-size: 14px; font-weight: 400; color: #111827 !important; margin: 3px 0 0; line-height: 1.5; word-break: break-word; overflow-wrap: break-word; }
  .btn { display: inline-block; background: #2563eb !important; color: #ffffff !important; padding: 14px 36px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px; }
  .btn-link { color: #2563eb !important; font-size: 13px; text-decoration: underline; }
  .ref { font-size: 26px; font-weight: 700; color: #111827 !important; letter-spacing: 2.5px; font-family: 'Courier New', monospace; margin: 0; word-break: break-all; overflow-wrap: break-word; }
  .footer-text { font-size: 12px; color: #9ca3af !important; margin: 0; }
  [data-ogsc] * { background-color: #ffffff !important; color: #111827 !important; }
  [data-ogsc] .btn { background-color: #2563eb !important; color: #ffffff !important; }
  [data-ogsc] .btn-link { color: #2563eb !important; }
  [data-ogsc] .label { color: #6b7280 !important; }
  [data-ogsc] .footer-text { color: #9ca3af !important; }
  [data-ogsc] .ref { color: #111827 !important; }
  * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
  u + .body * { background-color: #ffffff !important; color: #111827 !important; }
</style>
</head>
<body data-ogsc="" style="margin:0;padding:0;background-color:#ffffff !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table class="wrapper" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important;width:100%;">
    <tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff !important;padding:0;">
      <table class="main" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important;max-width:600px;width:100%;">
        <tr><td bgcolor="#ffffff" style="background-color:#ffffff !important;">
          <div class="head">
            <img src="${process.env.LOGO_URL}" alt="Travio Africa" style="height:48px;margin-bottom:10px;">
            <h1 style="font-size:24px;font-weight:700;color:#111827;margin:0;">Booking Confirmed</h1>
          </div>
          <div class="section" style="padding:20px 32px;text-align:center;border-bottom:2px dashed #d1d5db;">
            <p class="label" style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 4px;">Booking Reference</p>
            <p class="ref" style="font-size:26px;font-weight:700;color:#111827;letter-spacing:2.5px;font-family:'Courier New',monospace;margin:0;">${data.bookingNumber}</p>
          </div>
          <div class="section">
            <h2 style="font-size:17px;font-weight:700;color:#111827;margin:0 0 3px;">${data.tourTitle}</h2>
            ${data.tourDescription ? `<p style="font-size:14px;color:#6b7280;margin:0;line-height:1.5;">${data.tourDescription.substring(0, 200)}</p>` : ''}
          </div>
          <div class="section">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:50%;padding:0 8px 0 0;vertical-align:top;">
                  <p class="label">Date</p>
                  <p class="value" style="font-size:15px;font-weight:600;color:#111827;margin:0;">${data.selectedDate}</p>
                </td>
                <td style="width:50%;padding:0 0 0 8px;vertical-align:top;">
                  <p class="label">Time</p>
                  <p class="value" style="font-size:15px;font-weight:600;color:#111827;margin:0;">${data.selectedTime || 'Flexible'}</p>
                </td>
              </tr>
            </table>
          </div>
          <div class="section">
            <p class="label">Participants</p>
            <p class="value">${travelers.join(' &bull; ') || '1 Adult'}</p>
          </div>
          ${data.meetingPoint ? `
          <div class="section">
            <p class="label">Pickup Point</p>
            <p class="value">${data.meetingPoint.address}</p>
            ${data.meetingPoint.instructions ? `<p class="value-sm">${data.meetingPoint.instructions}</p>` : ''}
            ${data.meetingPoint.coordinates ? `<p style="margin:6px 0 0;"><a href="https://maps.google.com/?q=${data.meetingPoint.coordinates.lat},${data.meetingPoint.coordinates.lng}" class="btn-link" style="color:#2563eb;font-size:13px;">View on Google Maps &rarr;</a></p>` : ''}
          </div>` : ''}
          ${data.checkInProcess ? `
          <div class="section">
            <p class="label">Check-in</p>
            <p class="value-sm">${data.checkInProcess}</p>
          </div>` : ''}
          ${includedHtml ? `
          <div class="section">
            <p class="label">What's Included</p>
            <ul style="margin:4px 0 0;padding-left:18px;">${includedHtml}</ul>
          </div>` : ''}
          ${bringHtml ? `
          <div class="section">
            <p class="label">What to Bring</p>
            <ul style="margin:4px 0 0;padding-left:18px;">${bringHtml}</ul>
          </div>` : ''}
          ${data.restrictions ? `
          <div class="section">
            <p class="label">Important</p>
            <p class="value-sm">${data.restrictions}</p>
          </div>` : ''}
          <div class="section">
            <p class="label">Cancellation Policy</p>
            <p class="value-sm">${data.cancellationPolicy || 'Free cancellation up to 24 hours before start time'}</p>
          </div>
          <div class="section" style="border-bottom:2px solid #111827;">
            <p class="label">Price Summary</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr><td style="color:#6b7280;font-size:14px;padding:2px 0;">Subtotal</td><td style="text-align:right;color:#111827;font-size:14px;font-weight:600;padding:2px 0;">${data.currency} ${data.subtotal || data.totalAmount}</td></tr>
              ${data.taxes ? `<tr><td style="color:#6b7280;font-size:14px;padding:2px 0;">Taxes & Fees</td><td style="text-align:right;color:#111827;font-size:14px;padding:2px 0;">${data.currency} ${data.taxes}</td></tr>` : ''}
              <tr><td style="padding:6px 0 0;border-top:1px solid #d1d5db;font-weight:700;color:#111827;font-size:15px;">Total Charged</td><td style="text-align:right;padding:6px 0 0;border-top:1px solid #d1d5db;font-weight:700;color:#111827;font-size:15px;">${data.currency} ${data.totalAmount}</td></tr>
            </table>
          </div>
          <div style="padding:24px 32px;text-align:center;">
            <a href="${data.bookingUrl}" class="btn" style="display:inline-block;background:#2563eb;color:#ffffff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">View Booking Details</a>
            <br><br>
            <a href="${data.ticketUrl}" class="btn-link" style="color:#2563eb;font-size:14px;">Download Printable Ticket &rarr;</a>
          </div>
          ${data.supplierContact ? `
          <div style="padding:18px 32px;text-align:center;border-top:1px solid #e5e7eb;background:#f9fafb;">
            <p style="font-size:13px;color:#6b7280;margin:0 0 6px;">Questions? Call the operator</p>
            <p style="font-size:20px;font-weight:700;color:#111827;margin:0;letter-spacing:0.5px;">
              <a href="tel:${data.supplierContact.replace(/\s/g, '')}" style="color:#111827;text-decoration:none;">${data.supplierContact}</a>
            </p>
            <p style="font-size:12px;color:#9ca3af;margin:6px 0 0;">${data.supplierName || 'Your tour operator'}</p>
          </div>` : ''}
          ${data.supplierName ? `
          <div style="padding:14px 32px;">
            <p class="label">Organized by</p>
            <p class="value" style="font-size:15px;">${data.supplierName}</p>
          </div>` : ''}
        </td></tr>
        <tr><td style="padding:24px 32px;text-align:center;border-top:1px solid #e5e7eb;background-color:#ffffff;">
          <p class="footer-text" style="font-size:12px;color:#9ca3af;margin:0;">Need help? <a href="mailto:${data.supportEmail}" style="color:#2563eb;text-decoration:underline;font-size:12px;">${data.supportEmail}</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `
BOOKING CONFIRMED — ${data.tourTitle}
Booking Ref: ${data.bookingNumber}
Date: ${data.selectedDate}${data.selectedTime ? ' at ' + data.selectedTime : ''}
Participants: ${travelers.join(', ') || '1 Adult'}
Total: ${data.currency} ${data.totalAmount}

Pickup Point: ${data.meetingPoint?.address || 'See booking details'}
Cancellation Policy: ${data.cancellationPolicy || 'Free cancellation up to 24 hours before'}

View booking: ${data.bookingUrl}
Download ticket: ${data.ticketUrl}
Questions? ${data.supportEmail}`;

  return { html, text };
}

function generateBookingCancellationTemplate(data) {
  const html = `<!DOCTYPE html>
<html data-ogsc="" data-ogsb=""><head><meta charset="utf-8">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>
  html, body { margin: 0; padding: 0; background-color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  [data-ogsc] * { background-color: #ffffff !important; color: #111827 !important; }
  * { word-break: break-word; overflow-wrap: break-word; -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
</style>
</head>
<body style="margin:0;padding:0;background-color:#ffffff !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important;max-width:600px;margin:0 auto;">
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff !important;padding:24px 24px 12px;text-align:center;border-bottom:2px solid #e5e7eb;">
        <img src="${process.env.LOGO_URL}" alt="Travio Africa" style="height:44px;margin-bottom:8px;">
      </td></tr>
      <tr><td bgcolor="#ffffff" style="background-color:#ffffff !important;padding:20px 24px;">
      <h1 style="color:#dc2626;font-size:22px;margin:0 0 16px;">Booking Cancelled</h1>
      
      <p style="font-size:15px;color:#111827;margin:0 0 12px;">Hi ${data.customerName},</p>
      
      <p style="font-size:14px;color:#111827;margin:0 0 16px;">Your booking has been cancelled as requested.</p>
      
      <div style="background:#fef2f2;padding:20px;border-radius:8px;margin:0 0 20px;border-left:4px solid #dc2626;">
        <h2 style="font-size:16px;color:#111827;margin:0 0 8px;">${data.tourTitle}</h2>
        <p style="font-size:14px;color:#111827;margin:0 0 4px;"><strong>Booking Number:</strong><br>${data.bookingNumber}</p>
        <p style="font-size:14px;color:#111827;margin:0 0 4px;"><strong>Original Date:</strong><br>${data.selectedDate}</p>
        ${data.cancellationReason ? `<p style="font-size:14px;color:#111827;margin:0;"><strong>Reason:</strong><br>${data.cancellationReason}</p>` : ''}
      </div>
      
      ${data.refundAmount ? `
        <div style="background:#f0fdf4;padding:20px;border-radius:8px;margin:0 0 20px;border-left:4px solid #16a34a;">
          <h3 style="font-size:15px;color:#16a34a;margin:0 0 8px;">Refund Information</h3>
          <p style="font-size:14px;color:#111827;margin:0;">A refund of ${data.currency} ${data.refundAmount} will be processed to your original payment method within 5-7 business days.</p>
        </div>
      ` : ''}
      
      <p style="font-size:14px;color:#111827;margin:0 0 12px;">We're sorry to see you go. If you have any questions, please contact <a href="mailto:${data.supportEmail}" style="color:#2563eb;">${data.supportEmail}</a></p>
      </td></tr>
    </table>
</body></html>`;

  const text = `
    Booking Cancelled
    
    Hi ${data.customerName},
    
    Your booking for "${data.tourTitle}" (${data.bookingNumber}) has been cancelled.
    
    ${data.refundAmount ? `Refund of ${data.currency} ${data.refundAmount} will be processed within 5-7 business days.` : ''}
    
    Questions? Contact: ${data.supportEmail}
  `;

  return { html, text };
}

function generateSupplierApprovedTemplate(data) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #16a34a;">Welcome to Tour Platform!</h1>
      
      <p>Hi ${data.name},</p>
      
      <p>Congratulations! Your supplier application has been approved. You're now part of our tour platform community.</p>
      
      <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a;">
        <h3 style="margin-top: 0;">Next Steps</h3>
        <ol>
          <li>Complete your Stripe Connect onboarding to receive payments</li>
          <li>Create your first tour listing</li>
          <li>Set up your supplier profile</li>
        </ol>
      </div>
      
      <p><a href="${data.dashboardUrl}" style="background: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">Access Your Dashboard</a></p>
      
      <p>Need help getting started? Contact us at ${data.supportEmail}</p>
      
      <p>Welcome aboard!<br>Tour Platform Team</p>
    </div>
  `;

  const text = `
    Welcome to Tour Platform!
    
    Hi ${data.name},
    
    Your supplier application has been approved!
    
    Next steps:
    1. Complete Stripe Connect onboarding
    2. Create your first tour
    3. Set up your profile
    
    Dashboard: ${data.dashboardUrl}
    Support: ${data.supportEmail}
  `;

  return { html, text };
}

function generateSupplierRejectedTemplate(data) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #dc2626;">Supplier Application Update</h1>
      
      <p>Hi ${data.name},</p>
      
      <p>Thank you for your interest in becoming a supplier on our platform. After careful review, we're unable to approve your application at this time.</p>
      
      ${data.notes ? `
        <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
          <h3 style="margin-top: 0;">Feedback</h3>
          <p>${data.notes}</p>
        </div>
      ` : ''}
      
      <p>You're welcome to reapply in the future. If you have questions about this decision, please contact us at ${data.supportEmail}</p>
      
      <p>Best regards,<br>Tour Platform Team</p>
    </div>
  `;

  const text = `
    Supplier Application Update
    
    Hi ${data.name},
    
    We're unable to approve your supplier application at this time.
    
    ${data.notes ? `Feedback: ${data.notes}` : ''}
    
    Questions? Contact: ${data.supportEmail}
  `;

  return { html, text };
}

function generateSupplierBookingNotificationTemplate(data) {
  const html = `<!DOCTYPE html>
<html data-ogsc="" data-ogsb="">
<head><meta charset="utf-8">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<style>
  html, body { margin: 0; padding: 0; background-color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .wrapper { width: 100%; table-layout: fixed; background-color: #ffffff !important; }
  .main { max-width: 600px; margin: 0 auto; background-color: #ffffff !important; }
  .head { padding: 36px 32px 12px; text-align: center; }
  .section { padding: 14px 32px; border-bottom: 1px solid #e5e7eb; }
  .label { font-size: 11px; font-weight: 600; color: #6b7280 !important; text-transform: uppercase; letter-spacing: 0.8px; margin: 0 0 3px; word-break: break-word; overflow-wrap: break-word; }
  .value { font-size: 15px; font-weight: 600; color: #111827 !important; margin: 0; line-height: 1.4; word-break: break-word; overflow-wrap: break-word; }
  .value-sm { font-size: 14px; font-weight: 400; color: #111827 !important; margin: 3px 0 0; line-height: 1.5; word-break: break-word; overflow-wrap: break-word; }
  .ref { font-size: 26px; font-weight: 700; color: #111827 !important; letter-spacing: 2.5px; font-family: 'Courier New', monospace; margin: 0; word-break: break-all; overflow-wrap: break-word; }
  .btn { display: inline-block; background: #059669 !important; color: #ffffff !important; padding: 14px 36px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 15px; }
  [data-ogsc] * { background-color: #ffffff !important; color: #111827 !important; }
  [data-ogsc] .label { color: #6b7280 !important; }
  [data-ogsc] .ref { color: #111827 !important; }
  [data-ogsc] .btn { background: #059669 !important; color: #ffffff !important; }
  * { -ms-text-size-adjust: 100%; -webkit-text-size-adjust: 100%; }
  u + .body * { background-color: #ffffff !important; color: #111827 !important; }
</style>
</head>
<body data-ogsc="" style="margin:0;padding:0;background-color:#ffffff !important;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table class="wrapper" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important;width:100%;">
    <tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff !important;padding:0;">
      <table class="main" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff !important;max-width:600px;width:100%;">
        <tr><td bgcolor="#ffffff" style="background-color:#ffffff !important;">
          <div class="head">
            <img src="${process.env.LOGO_URL}" alt="Travio Africa" style="height:48px;margin-bottom:10px;">
            <h1 style="font-size:22px;font-weight:700;color:#111827;margin:0;">New Booking Received</h1>
          </div>
          <div class="section" style="padding:20px 32px;text-align:center;border-bottom:2px dashed #d1d5db;">
            <p class="label" style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.8px;margin:0 0 4px;">Booking Reference</p>
            <p class="ref" style="font-size:26px;font-weight:700;color:#111827;letter-spacing:2.5px;font-family:'Courier New',monospace;margin:0;">${data.bookingNumber}</p>
          </div>
          <div class="section">
            <h2 style="font-size:17px;font-weight:700;color:#111827;margin:0;">${data.tourTitle}</h2>
            <p style="font-size:14px;color:#6b7280;margin:4px 0 0;">A guest has booked your tour. Details below.</p>
          </div>
          <div class="section">
            <p class="label">Customer</p>
            <p class="value">${data.customerName}</p>
          </div>
          ${data.customerPhone ? `<div class="section"><p class="label">Phone / WhatsApp</p><p class="value">${data.customerPhone}</p></div>` : ''}
          ${data.customerLocation ? `<div class="section"><p class="label">Location</p><p class="value">${data.customerLocation}</p></div>` : ''}
          <div class="section">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="width:50%;padding:0 8px 0 0;vertical-align:top;">
                  <p class="label">Date</p>
                  <p class="value">${data.selectedDate}</p>
                </td>
                <td style="width:50%;padding:0 0 0 8px;vertical-align:top;">
                  <p class="label">Time</p>
                  <p class="value">${data.selectedTime || '—'}</p>
                </td>
              </tr>
            </table>
          </div>
          <div class="section">
            <p class="label">Travelers</p>
            <p class="value">${data.travelerCount} guest(s)</p>
          </div>
          <div class="section" style="border-bottom:2px solid #111827;">
            <p class="label">Total Paid</p>
            <p class="value" style="font-size:18px;">${data.currency} ${data.totalAmount}</p>
          </div>
          <div style="padding:24px 32px;text-align:center;">
            <a href="${data.dashboardUrl}" class="btn" style="display:inline-block;background:#059669;color:#ffffff;padding:14px 36px;border-radius:6px;text-decoration:none;font-weight:600;font-size:15px;">View in Dashboard</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `
NEW BOOKING — ${data.tourTitle}
Ref: ${data.bookingNumber}
Customer: ${data.customerName}
${data.customerPhone ? 'Phone: ' + data.customerPhone : ''}
${data.customerLocation ? 'Location: ' + data.customerLocation : ''}
Date: ${data.selectedDate}${data.selectedTime ? ' ' + data.selectedTime : ''}
Travelers: ${data.travelerCount}
Total: ${data.currency} ${data.totalAmount}
Manage: ${data.dashboardUrl}`;

  return { html, text };
}

function generateGenericNotificationTemplate(data) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1>${data.title}</h1>
      <p>${data.message}</p>
      <p>Best regards,<br>Tour Platform Team</p>
    </div>
  `;

  const text = `${data.title}\n\n${data.message}`;
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
    <img src="${process.env.LOGO_URL}" alt="Travio Africa" style="height:44px;margin-bottom:16px;">
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
function generateSupplierUnderReviewTemplate(data) { return generateGenericNotificationTemplate(data); }
function generateSupplierActivatedTemplate(data) { return generateGenericNotificationTemplate(data); }
function generateSupplierSuspendedTemplate(data) { return generateGenericNotificationTemplate(data); }
function generateReviewNotificationTemplate(data) { return generateGenericNotificationTemplate(data); }
function generatePayoutNotificationTemplate(data) { return generateGenericNotificationTemplate(data); }

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