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
    
    const msg = {
      to,
      from: {
        email: process.env.EMAIL_FROM,
        name: 'Tour Platform'
      },
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
 * Send booking confirmation email
 */
async function sendBookingConfirmationEmail(booking) {
  try {
    const customer = await prisma.user.findUnique({
      where: { id: booking.customerId }
    });

    const tour = await prisma.tour.findUnique({
      where: { id: booking.tourId },
      include: {
        supplier: {
          select: {
            name: true,
            email: true,
            phone: true
          }
        }
      }
    });

    if (!customer || !tour) {
      throw new Error('Booking data incomplete');
    }

    await sendEmail({
      to: customer.email,
      subject: `Booking Confirmed - ${tour.title}`,
      template: 'booking-confirmation',
      data: {
        customerName: customer.name,
        bookingNumber: booking.bookingNumber,
        tourTitle: tour.title,
        selectedDate: new Date(booking.selectedDate).toLocaleDateString(),
        selectedTime: booking.selectedTime,
        totalAmount: booking.total,
        currency: booking.currency,
        supplierName: tour.supplier.name,
        supplierContact: tour.supplier.phone || tour.supplier.email,
        travelers: booking.travelers,
        specialRequests: booking.specialRequests,
        bookingUrl: `${process.env.CLIENT_URL}/bookings/${booking.id}`
      }
    });

    console.log(`✅ Booking confirmation sent for booking ${booking.bookingNumber}`);
  } catch (error) {
    console.error('❌ Booking confirmation email failed:', error);
    throw error;
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
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #2563eb;">Booking Confirmed!</h1>
      
      <p>Hi ${data.customerName},</p>
      
      <p>Great news! Your booking has been confirmed. Here are the details:</p>
      
      <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h2 style="margin-top: 0;">${data.tourTitle}</h2>
        <p><strong>Booking Number:</strong> ${data.bookingNumber}</p>
        <p><strong>Date:</strong> ${data.selectedDate}</p>
        ${data.selectedTime ? `<p><strong>Time:</strong> ${data.selectedTime}</p>` : ''}
        <p><strong>Total Amount:</strong> ${data.currency} ${data.totalAmount}</p>
      </div>
      
      <h3>Supplier Contact</h3>
      <p><strong>${data.supplierName}</strong><br>
      Contact: ${data.supplierContact}</p>
      
      ${data.specialRequests ? `
        <h3>Special Requests</h3>
        <p>${data.specialRequests}</p>
      ` : ''}
      
      <p><a href="${data.bookingUrl}" style="background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px;">View Booking Details</a></p>
      
      <p>Have questions? Contact us at ${process.env.SUPPORT_EMAIL}</p>
      
      <p>Best regards,<br>Tour Platform Team</p>
    </div>
  `;

  const text = `
    Booking Confirmed!
    
    Hi ${data.customerName},
    
    Your booking for "${data.tourTitle}" has been confirmed.
    
    Booking Number: ${data.bookingNumber}
    Date: ${data.selectedDate}
    ${data.selectedTime ? `Time: ${data.selectedTime}` : ''}
    Total: ${data.currency} ${data.totalAmount}
    
    Supplier: ${data.supplierName}
    Contact: ${data.supplierContact}
    
    View details: ${data.bookingUrl}
    
    Questions? Contact: ${process.env.SUPPORT_EMAIL}
  `;

  return { html, text };
}

function generateBookingCancellationTemplate(data) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #dc2626;">Booking Cancelled</h1>
      
      <p>Hi ${data.customerName},</p>
      
      <p>Your booking has been cancelled as requested.</p>
      
      <div style="background: #fef2f2; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #dc2626;">
        <h2 style="margin-top: 0;">${data.tourTitle}</h2>
        <p><strong>Booking Number:</strong> ${data.bookingNumber}</p>
        <p><strong>Original Date:</strong> ${data.selectedDate}</p>
        ${data.cancellationReason ? `<p><strong>Reason:</strong> ${data.cancellationReason}</p>` : ''}
      </div>
      
      ${data.refundAmount ? `
        <div style="background: #f0fdf4; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #16a34a;">
          <h3 style="margin-top: 0; color: #16a34a;">Refund Information</h3>
          <p>A refund of ${data.currency} ${data.refundAmount} will be processed to your original payment method within 5-7 business days.</p>
        </div>
      ` : ''}
      
      <p>We're sorry to see you go. If you have any questions about this cancellation, please contact us at ${data.supportEmail}</p>
      
      <p>Best regards,<br>Tour Platform Team</p>
    </div>
  `;

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
  sendPayoutNotificationEmail
};