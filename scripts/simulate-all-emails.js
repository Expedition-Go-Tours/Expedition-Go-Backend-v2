/**
 * Email simulation — renders and sends every one of the 28 transactional
 * templates to a single inbox using realistic mock booking data.
 *
 * Usage:
 *   node scripts/simulate-all-emails.js
 *
 * All recipient addresses (customer + supplier) are pointed at EMAIL_SIM_TO
 * (default kwarteon08@gmail.com) so the whole catalog lands in one inbox.
 * Each send is isolated — one failure does not stop the rest.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const email = require('../utils/emailService');

const TO = process.env.EMAIL_SIM_TO || 'kwarteon08@gmail.com';

// ───────────────────────────────────────────────────────────────────────────
// Mock booking — fully populated so resolveBookingContext skips the DB fetch.
// ───────────────────────────────────────────────────────────────────────────
function mockBooking(overrides = {}) {
  const booking = {
    id: 'sim-booking-1',
    bookingNumber: 'TRA-SIM-0001',
    selectedDate: new Date(Date.now() + 3 * 86400000),
    selectedTime: '09:00',
    specialRequests: 'Vegetarian meals for all travellers, please.',
    travelers: {
      adults: 2,
      children: 1,
      infants: 0,
      details: [
        { ageGroup: 'Adult', count: 2 },
        { ageGroup: 'Child', count: 1 },
      ],
      phoneNumber: '+27 82 555 0142',
      location: 'Cape Town, South Africa',
    },
    pickup: {
      areaName: 'Victoria & Alfred Waterfront',
      address: { address: 'V&A Waterfront, Cape Town' },
      time: '08:30',
      instructions: 'Meet at the Nelson Mandela statue by the ferry terminal.',
    },
    paymentTiming: 'now',
    paymentStatus: 'SUCCEEDED',
    paidAt: new Date(),
    status: 'CONFIRMED',
    currency: 'USD',
    total: '385.00',
    subtotal: '350.00',
    taxes: '35.00',
    commissionAmount: '57.75',
    supplierPayout: '327.25',
    refundAmount: null,
    refundedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    customer: {
      id: 'sim-customer-1',
      name: 'Jane Kamau',
      email: TO,
      phone: '+27 82 555 0142',
      location: 'Cape Town, South Africa',
    },
    tour: {
      id: 'sim-tour-1',
      title: 'Cape of Good Hope & Penguins Private Day Tour',
      description:
        'A full-day private exploration of the Cape Peninsula, Chapman\u2019s Peak Drive, the Cape of Good Hope and a visit to the famous Boulders Beach penguin colony.',
      photos: [],
      productContent: {
        location: { city: 'Cape Town', country: 'South Africa' },
        whatToBring: ['Comfortable walking shoes', 'Sun hat and sunscreen', 'Camera', 'Warm layer for the coast', 'Water bottle'],
      },
      bookingAndTickets: {
        meetingPoint: { name: 'V&A Waterfront', address: 'Victoria & Alfred Waterfront, Cape Town', instructions: 'Look for the guide holding a green sign.' },
        meetingTime: '09:00',
        durationLabel: '8 hours',
        checkInProcess: 'Please check in at the meeting point 15 minutes early.',
        cancellationPolicy: {
          text: 'Free cancellation up to 24 hours before the experience starts.',
        },
      },
      categorization: {
        duration: { value: 8, unit: 'hours' },
        categories: ['Day Tour', 'Nature'],
        language: 'English',
        bookingType: 'private',
      },
      durationMinutes: 480,
      supplier: {
        id: 'sim-supplier-1',
        name: 'Cape Peninsula Explorers',
        email: TO,
        phone: '+27 21 555 0130',
      },
    },
    ...overrides,
  };
  return booking;
}

function mockChanges() {
  return [
    { label: 'Date', previous: 'Monday, August 20, 2026', updated: 'Tuesday, August 21, 2026' },
    { label: 'Starting time', previous: '9:00 AM', updated: '10:00 AM' },
    { label: 'Travellers', previous: '2 adults', updated: '2 adults, 1 child' },
    { label: 'Pickup location', previous: 'V&A Waterfront, Cape Town', updated: 'Hout Bay, Cape Town' },
  ];
}

// Each entry: [name, fn, args] — args passed as the extras payload.
const SENDERS = [
  // Customer emails (16)
  ['booking-confirmed', email.sendBookingConfirmedEmail, {}],
  ['reserve-later-confirmed', email.sendReserveLaterConfirmedEmail, {}],
  ['payment-reminder', email.sendPaymentReminderEmail, { paymentDate: new Date(Date.now() + 2 * 86400000).toISOString(), paymentAmount: '385.00' }],
  ['payment-successful', email.sendPaymentSuccessfulEmail, { paymentReference: 'pi_3SimRef0001', amount: '385.00' }],
  ['pay-later-charged', email.sendPayLaterChargedEmail, { paymentReference: 'pi_3SimRef0001' }],
  ['awaiting-confirmation', email.sendAwaitingConfirmationEmail, { paymentReference: 'pi_3SimRef0001' }],
  ['payment-unsuccessful', email.sendPaymentUnsuccessfulEmail, { deadline: new Date(Date.now() + 1 * 86400000).toISOString(), amount: '385.00' }],
  ['customer-booking-changed', email.sendCustomerBookingChangedEmail, { changes: mockChanges(), previousTotal: '350.00', adjustment: '35.00', newTotal: '385.00' }],
  ['pickup-details-updated', email.sendPickupDetailsUpdatedEmail, { previousPickupLocation: 'V&A Waterfront, Cape Town' }],
  ['pickup-location-required', email.sendPickupLocationRequiredEmail, { deadline: new Date(Date.now() + 3 * 86400000).toISOString() }],
  ['booking-reminder', email.sendBookingReminderEmail, {}],
  ['customer-cancelled-full-refund', email.sendCustomerCancelledFullRefundEmail, { cancelledAt: new Date().toISOString(), refundAmount: '385.00' }],
  ['customer-cancelled-no-refund', email.sendCustomerCancelledNoRefundEmail, { cancelledAt: new Date().toISOString(), cancellationFee: '385.00', refundAmount: '0.00' }],
  ['refund-processing', email.sendRefundProcessingEmail, { refundReference: 're_3SimRef0001' }],
  ['refund-completed', email.sendRefundCompletedEmail, { refundReference: 're_3SimRef0001', refundedAt: new Date().toISOString() }],
  ['supplier-changed-booking', email.sendSupplierChangedBookingEmail, { changes: mockChanges(), changeReason: 'Customer requested a later start time.', needsAcceptance: true }],
  ['supplier-cancelled-booking', email.sendSupplierCancelledBookingEmail, { reason: 'Guide unavailable due to illness.', refundAmount: '385.00' }],
  ['review-request', email.sendReviewRequestEmail, {}],
  // Supplier emails (12)
  ['supplier-new-booking', email.sendSupplierNewBookingEmail, {}],
  ['supplier-pay-later-charged', email.sendSupplierPayLaterChargedEmail, { paymentReference: 'pi_3SimRef0001' }],
  ['supplier-booking-changed', email.sendSupplierBookingChangedEmail, { changes: mockChanges(), previousPayout: '315.00', newPayout: '327.25', payoutAdjustment: '12.25' }],
  ['supplier-customer-contact-updated', email.sendSupplierContactUpdatedEmail, { customerPhone: '+27 82 555 0142', customerEmail: TO, emergencyContact: '+27 83 555 0177 (Susan, traveller)' }],
  ['supplier-pickup-updated', email.sendSupplierPickupUpdatedEmail, { previousPickupLocation: 'V&A Waterfront, Cape Town' }],
  ['supplier-booking-reminder', email.sendSupplierBookingReminderEmail, {}],
  ['supplier-customer-cancelled-free', email.sendSupplierCustomerCancelledFreeEmail, { cancelledAt: new Date().toISOString() }],
  ['supplier-customer-cancelled-late', email.sendSupplierCustomerCancelledLateEmail, { cancelledAt: new Date().toISOString() }],
  ['supplier-platform-cancelled', email.sendSupplierPlatformCancelledEmail, { reason: 'The tour date exceeded maximum capacity.', compensation: '25.00' }],
  ['supplier-cancellation-recorded', email.sendSupplierCancellationRecordedEmail, { reason: 'Customer requested cancellation.' }],
  ['supplier-payout-scheduled', email.sendSupplierPayoutScheduledEmail, { booking: mockBooking(), payout: { id: 'po_3Sim0001', amount: '327.25', methodLabel: 'Bank transfer', date: new Date(Date.now() + 7 * 86400000) }, payoutDate: new Date(Date.now() + 7 * 86400000).toISOString() }],
  ['supplier-payout-completed', email.sendSupplierPayoutCompletedEmail, { booking: mockBooking(), payout: { id: 'po_3Sim0001', amount: '327.25', methodLabel: 'Bank transfer', date: new Date() }, payoutDate: new Date().toISOString() }],
  ['supplier-payout-failed', email.sendSupplierPayoutFailedEmail, { booking: mockBooking(), payout: { id: 'po_3Sim0001', amount: '327.25' }, reason: 'The destination account rejected the transfer (invalid IBAN).' }],
];

// Variants that need a different base booking (pay-later / cancelled states)
const BASE_VARIANTS = {
  'reserve-later-confirmed': mockBooking({ paymentTiming: 'later', paymentStatus: 'PENDING' }),
  'payment-reminder': mockBooking({ paymentTiming: 'later', paymentStatus: 'PENDING' }),
  'payment-successful': mockBooking({ paymentTiming: 'later', paymentStatus: 'SUCCEEDED' }),
  'pay-later-charged': mockBooking({ paymentTiming: 'later', paymentStatus: 'SUCCEEDED', paidAt: new Date() }),
  'awaiting-confirmation': mockBooking({ status: 'PENDING', paymentStatus: 'SUCCEEDED', paidAt: new Date() }),
  'payment-unsuccessful': mockBooking({ paymentTiming: 'later', paymentStatus: 'FAILED' }),
  'customer-cancelled-full-refund': mockBooking({ status: 'CANCELLED', paymentStatus: 'REFUNDED', refundAmount: '385.00', refundedAt: new Date(), cancelledAt: new Date(), cancellationReason: 'Change of plans' }),
  'customer-cancelled-no-refund': mockBooking({ status: 'CANCELLED', paymentStatus: 'SUCCEEDED', cancelledAt: new Date(), cancellationReason: 'Late cancellation' }),
  'refund-processing': mockBooking({ paymentStatus: 'REFUNDED', refundAmount: '385.00' }),
  'refund-completed': mockBooking({ paymentStatus: 'REFUNDED', refundAmount: '385.00' }),
  'review-request': mockBooking({ status: 'COMPLETED', paymentStatus: 'SUCCEEDED', selectedDate: new Date(Date.now() - 5 * 86400000) }),
  'supplier-pay-later-charged': mockBooking({ paymentTiming: 'later', paymentStatus: 'SUCCEEDED', paidAt: new Date() }),
};

async function main() {
  console.log(`\nSimulating all ${SENDERS.length} transactional emails → ${TO}\n`);

  let ok = 0;
  let failed = 0;

  for (const [name, fn, extras] of SENDERS) {
    const booking = BASE_VARIANTS[name] || mockBooking();
    try {
      // Payout senders take { booking, payout, ... } as a single object;
      // booking senders take (booking, extras).
      const args = name.startsWith('supplier-payout') ? { ...extras } : [booking, extras];
      const result = await (name.startsWith('supplier-payout') ? fn(args) : fn(...args));
      if (result && result.success === false) {
        console.log(`  [SKIP]  ${name} — ${result.reason || 'no provider'}`);
        failed += 1;
      } else {
        console.log(`  [SENT]  ${name}`);
        ok += 1;
      }
    } catch (err) {
      console.log(`  [FAIL]  ${name} — ${err.message}`);
      failed += 1;
    }
  }

  console.log(`\nDone: ${ok} sent, ${failed} failed/skipped.\n`);
  process.exit(ok === SENDERS.length ? 0 : 1);
}

main();
