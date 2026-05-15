require('dotenv').config();
const { sendEmail } = require('./utils/emailService');

const MANAGER_EMAIL = 'expdeveloper2@gmail.com';

async function sendToAll(config) {
  await sendEmail({ to: MANAGER_EMAIL, ...config });
  console.log(`Sent "${config.subject}" to ${MANAGER_EMAIL}`);
}

async function test() {

  await sendToAll({
    subject: 'Booking Confirmed — Grand Canyon Adventure Tour (Ref: BK-DEMO-001)',
    template: 'booking-confirmation',
    data: {
      customerName: 'John Doe',
      bookingNumber: 'BK-DEMO-001',
      tourTitle: 'Grand Canyon Adventure Tour',
      tourDescription: 'Experience the breathtaking beauty of the Grand Canyon on this full-day guided tour.',
      selectedDate: 'Saturday, June 15, 2026',
      selectedTime: '08:00 AM',
      travelers: { adults: 2, children: 1, infants: 0 },
      subtotal: 350.00,
      taxes: 35.00,
      totalAmount: 385.00,
      currency: 'USD',
      meetingPoint: {
        address: 'Grand Canyon Visitor Center, 1 Main Street, Grand Canyon Village, AZ 86023',
        instructions: 'Meet at the main entrance near the flagpole. Please arrive 15 minutes early.',
        coordinates: { lat: 36.1069, lng: -112.1129 }
      },
      checkInProcess: 'Please present this email (digital or printed) along with a valid photo ID to your guide.',
      cancellationPolicy: 'Free cancellation up to 48 hours before start time. 50% refund within 24-48 hours. No refund within 24 hours.',
      included: ['Professional English-speaking guide', 'National park entry fees', 'Bottled water and snacks', 'Hotel pickup and drop-off (select hotels)', 'Binoculars for wildlife viewing'],
      whatToBring: ['Comfortable hiking shoes', 'Sun protection (hat, sunscreen, sunglasses)', 'Camera', 'Weather-appropriate clothing (layers recommended)', 'Personal water bottle'],
      highlights: ['Sunrise at Mather Point', '2-mile South Rim trail hike', 'Lunch at Desert View Watchtower', 'Photography stops at 5 viewpoints'],
      restrictions: 'Not wheelchair accessible. Moderate fitness level required.',
      supplierName: 'Canyon Explorers Inc.',
      supplierContact: '+1 (928) 555-0199 | bookings@canyonexplorers.com',
      bookingUrl: 'https://expeditiongo.com/bookings/demo-001',
      ticketUrl: 'https://expeditiongo.com/bookings/demo-001/ticket',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Booking Cancelled — Grand Canyon Adventure Tour (Ref: BK-DEMO-001)',
    template: 'booking-cancellation',
    data: {
      customerName: 'John Doe',
      bookingNumber: 'BK-DEMO-001',
      tourTitle: 'Grand Canyon Adventure Tour',
      selectedDate: 'Saturday, June 15, 2026',
      cancellationReason: 'Customer requested cancellation due to schedule conflict.',
      refundAmount: 350.00,
      currency: 'USD',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Supplier Application Approved - Welcome!',
    template: 'supplier-approved',
    data: {
      name: 'Sarah Johnson',
      supplierBusinessName: 'Sarah Johnson',
      brandName: 'Travio Africa',
      brandSubtext: 'by Expedition-Go Tours',
      status: 'APPROVED',
      approvalDate: 'Monday, June 15, 2026',
      dashboardUrl: 'https://expeditiongo.com/supplier/dashboard',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Supplier Application Update',
    template: 'supplier-rejected',
    data: {
      name: 'Mike Smith',
      status: 'REJECTED',
      notes: 'Your application did not meet our verification requirements. Please ensure all business documentation is up to date before reapplying.',
      dashboardUrl: 'https://expeditiongo.com/supplier/dashboard',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Additional Information Required',
    template: 'supplier-under-review',
    data: {
      name: 'Emma Wilson',
      supplierBusinessName: 'Emma Wilson',
      brandName: 'Travio Africa',
      title: 'Additional Information Required',
      message: 'We need some additional documents to complete your supplier application review. Please log in to your dashboard to upload the requested items.',
      status: 'UNDER_REVIEW',
      dashboardUrl: 'https://expeditiongo.com/supplier/dashboard',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Supplier Account Activated',
    template: 'supplier-activated',
    data: {
      name: 'Canyon Explorers Inc.',
      supplierBusinessName: 'Canyon Explorers Inc.',
      brandName: 'Travio Africa',
      title: 'Supplier Account Activated',
      message: 'Your Stripe onboarding is complete. Your supplier account is now active and you can start receiving bookings and payouts.',
      status: 'ACTIVE',
      dashboardUrl: 'https://expeditiongo.com/supplier/dashboard',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Supplier Account Suspended',
    template: 'supplier-suspended',
    data: {
      name: 'City Tours LLC',
      supplierBusinessName: 'City Tours LLC',
      brandName: 'Travio Africa',
      title: 'Supplier Account Suspended',
      message: 'Your supplier account has been temporarily suspended. Please contact support for more information.',
      status: 'SUSPENDED',
      dashboardUrl: 'https://expeditiongo.com/supplier/dashboard',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'New 5-Star Review Received',
    template: 'review-notification',
    data: {
      supplierName: 'Canyon Explorers Inc.',
      tourTitle: 'Grand Canyon Adventure Tour',
      customerName: 'John Doe',
      rating: 5,
      reviewTitle: 'Absolutely Incredible Experience!',
      reviewComment: 'This was the best tour I have ever been on. Our guide was knowledgeable and the views were breathtaking. Highly recommend to anyone visiting the area!',
      reviewDate: 'June 16, 2026',
      reviewUrl: 'https://expeditiongo.com/supplier/reviews/demo-001',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'Payout Processed — USD $1,250.00',
    template: 'payout-notification',
    data: {
      supplierName: 'Canyon Explorers Inc.',
      payoutAmount: 1250.00,
      currency: 'USD',
      payoutDate: 'June 20, 2026',
      payoutId: 'PO-DEMO-001',
      dashboardUrl: 'https://expeditiongo.com/supplier/earnings',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'New Booking — Grand Canyon Adventure Tour (Supplier)',
    template: 'supplier-booking-notification',
    data: {
      supplierName: 'Canyon Explorers Inc.',
      tourTitle: 'Grand Canyon Adventure Tour',
      bookingNumber: 'BK-DEMO-002',
      customerName: 'Alice Johnson',
      selectedDate: 'Saturday, June 22, 2026',
      selectedTime: '09:00 AM',
      travelerCount: 4,
      totalAmount: 520.00,
      currency: 'USD',
      customerPhone: '+1 (555) 234-5678',
      customerLocation: 'Phoenix, AZ',
      dashboardUrl: 'https://expeditiongo.com/supplier/bookings/demo-002',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  await sendToAll({
    subject: 'System Alert — Important Account Notice',
    template: 'generic-notification',
    data: {
      userName: 'Admin User',
      title: 'System Alert: Security Update Required',
      message: 'Please update your account password and enable two-factor authentication to maintain account security. This is required by our new security policy.',
      actionUrl: 'https://expeditiongo.com/settings/security',
      supportEmail: 'support@expeditiongo.com'
    }
  });

  console.log('\n Done! All 11 email templates sent to expdeveloper2@gmail.com');
}

test().catch(console.error);
