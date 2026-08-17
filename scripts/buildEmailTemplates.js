/**
 * Email Template Definitions — all 28 transactional emails.
 *
 * Each definition is { key, name, build(data) } where build() returns the body
 * HTML rendered inside the shared shell. The compiled full documents are
 * written to sendgrid-templates/generated/<key>.html for the SendGrid sync
 * script, and the keys/subjects are imported by emailService.js so the service
 * layer and templates can never drift apart.
 */

const fs = require('fs');
const path = require('path');
const B = require('./emailTemplateBuilder');

const OUT_DIR = path.join(__dirname, '..', 'sendgrid-templates', 'generated');

// ────────────────────────────────────────────────────────────────────────────
// Shared body fragments
// ────────────────────────────────────────────────────────────────────────────

function customerBookingDetailsRows() {
  return B.detailRows([
    { label: 'Booking reference', value: '{{bookingNumber}}' },
    { label: 'Experience', value: '{{tourTitle}}' },
    { label: 'Date', value: '{{dateLabel}}' },
    { label: 'Starting time', value: '{{timeLabel}}', if: '{{timeLabel}}' },
    { label: 'Duration', value: '{{durationLabel}}', if: '{{durationLabel}}' },
    { label: 'Travellers', value: '{{travelersLabel}}' },
    { label: 'Language', value: '{{languageLabel}}' },
    { label: 'Booking type', value: '{{bookingTypeLabel}}' },
    { label: 'Supplier', value: '{{supplierName}}' },
  ]);
}

function customerPickupSection() {
  return `
    ${B.sectionTitle('Pickup & meeting')}
    ${B.detailRows([
      { label: 'Pickup included', value: '{{pickupIncludedLabel}}' },
      { label: 'Pickup location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
      { label: 'Pickup time', value: '{{pickupTime}}', if: '{{pickupTime}}' },
      { label: 'Meeting point', value: '{{meetingPoint}}', if: '{{meetingPoint}}' },
      { label: 'Meeting time', value: '{{meetingTime}}', if: '{{meetingTime}}' },
    ])}
    {{#if pickupInstructions}}
    ${B.paragraph('Pickup instructions: <strong>{{pickupInstructions}}</strong>')}
    {{/if}}
    {{#if directionsUrl}}
    ${B.buttonPrimary('Get directions', '{{directionsUrl}}')}
    {{/if}}`;
}

function supplierBookingDetailsRows() {
  return B.detailRows([
    { label: 'Booking reference', value: '{{bookingNumber}}' },
    { label: 'Supplier reference', value: '{{supplierReference}}', if: '{{supplierReference}}' },
    { label: 'Experience', value: '{{tourTitle}}' },
    { label: 'Date', value: '{{dateLabel}}' },
    { label: 'Starting time', value: '{{timeLabel}}', if: '{{timeLabel}}' },
    { label: 'Travellers', value: '{{travelersLabel}}' },
    { label: 'Language', value: '{{languageLabel}}' },
    { label: 'Booking type', value: '{{bookingTypeLabel}}' },
    { label: 'Pickup required', value: '{{pickupRequiredLabel}}' },
    { label: 'Pickup / meeting location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
  ]);
}

function customerContactRows() {
  return B.stackedRows([
    { label: 'Lead traveller', value: '{{customerName}}' },
    { label: 'Telephone', value: '{{customerPhone}}', if: '{{customerPhone}}' },
    { label: 'Email', value: '{{customerEmail}}', if: '{{customerEmail}}' },
  ]);
}

function supplierPayoutRows() {
  return B.detailRows([
    { label: 'Booking reference', value: '{{bookingNumber}}', if: '{{bookingNumber}}' },
    { label: 'Experience', value: '{{tourTitle}}', if: '{{tourTitle}}' },
    { label: 'Supplier payout', value: '{{payoutAmountLabel}}' },
    { label: 'Payout reference', value: '{{payoutReference}}', if: '{{payoutReference}}' },
    { label: 'Payout date', value: '{{payoutDateLabel}}', if: '{{payoutDateLabel}}' },
    { label: 'Payment destination', value: '{{paymentDestination}}', if: '{{paymentDestination}}' },
    { label: 'Status', value: '{{statusLabel}}' },
  ]);
}

// ────────────────────────────────────────────────────────────────────────────
// Customer emails
// ────────────────────────────────────────────────────────────────────────────

const customerBookingConfirmed = {
  key: 'booking-confirmed',
  name: 'Customer · Booking confirmed',
  build(data) {
    return B.shell('Your booking is confirmed', `
      ${B.hero({ heading: 'Your experience is confirmed!', badgeText: '&#10003;&nbsp;&nbsp;Confirmed', badgeColor: 'accent', subtitle: 'Hello {{customerName}},<br>Thank you for booking with {{brandName}}. Your experience is confirmed, and everything you need is below.' })}
      ${B.sectionTitle('Booking details')}
      ${customerBookingDetailsRows()}
      ${B.divider()}
      ${customerPickupSection()}
      ${B.divider()}
      ${B.sectionTitle('Payment')}
      ${B.detailRows([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount paid', value: '{{amountPaidLabel}}' },
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      ${B.divider()}
      ${B.sectionTitle('Cancellation policy')}
      ${B.paragraph('{{cancellationPolicyText}}')}
      ${B.buttons([
        { label: 'View booking', href: '{{bookingUrl}}' },
        { label: 'Download voucher', href: '{{voucherUrl}}' },
        { label: 'Manage booking', href: '{{manageUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const reserveLaterConfirmed = {
  key: 'reserve-later-confirmed',
  name: 'Customer · Reserve now, pay later',
  build() {
    return B.shell('Your booking is confirmed — payment scheduled', `
      ${B.hero({ heading: 'Your experience is reserved!', badgeText: 'Reserved', badgeColor: 'info', subtitle: 'Hello {{customerName}},<br>Your booking is confirmed. No payment has been taken yet.' })}
      ${B.sectionTitle('Payment schedule')}
      ${B.detailRows([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount paid today', value: '{{amountPaidTodayLabel}}' },
        { label: 'Scheduled payment', value: '{{scheduledPaymentLabel}}' },
        { label: 'Payment date', value: '{{paymentDateLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      ${B.callout('We\u2019ll remind you before the payment is collected.', 'info')}
      ${B.buttons([
        { label: 'View booking', href: '{{bookingUrl}}' },
        { label: 'Manage payment method', href: '{{managePaymentUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const paymentReminder = {
  key: 'payment-reminder',
  name: 'Customer · Payment reminder',
  build() {
    return B.shell('Upcoming payment for your booking', `
      ${B.hero({ heading: 'Your payment is coming up', badgeText: 'Payment reminder', badgeColor: 'warning' })}
      ${B.paragraph('We will collect <strong>{{paymentAmountLabel}}</strong> on <strong>{{paymentDateLabel}}</strong> for your upcoming experience.')}
      ${B.sectionTitle('Booking summary')}
      ${B.detailRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Tour date', value: '{{dateLabel}}' },
        { label: 'Payment date', value: '{{paymentDateLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      ${B.buttonPrimary('Review payment details', '{{managePaymentUrl}}')}
    `);
  },
};

const paymentSuccessful = {
  key: 'payment-successful',
  name: 'Customer · Payment successful',
  build() {
    return B.shell('Payment received', `
      ${B.hero({ heading: 'Your payment was successful', badgeText: '&#10003;&nbsp;&nbsp;Paid', badgeColor: 'accent' })}
      ${B.paragraph('We successfully received <strong>{{paymentAmountLabel}}</strong> for your booking.')}
      ${B.sectionTitle('Payment details')}
      ${B.detailRows([
        { label: 'Payment reference', value: '{{paymentReference}}', if: '{{paymentReference}}' },
        { label: 'Amount paid', value: '{{paymentAmountLabel}}' },
        { label: 'Outstanding balance', value: '{{outstandingBalanceLabel}}' },
        { label: 'Payment status', value: 'Paid' },
      ])}
      ${B.buttons([
        { label: 'View receipt', href: '{{bookingUrl}}' },
        { label: 'View booking', href: '{{bookingUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const paymentUnsuccessful = {
  key: 'payment-unsuccessful',
  name: 'Customer · Payment unsuccessful',
  build() {
    return B.shell('Action required: We couldn\u2019t process your payment', `
      ${B.hero({ heading: 'Please update your payment method', badgeText: 'Action required', badgeColor: 'danger' })}
      ${B.paragraph('We could not collect <strong>{{paymentAmountLabel}}</strong> for booking <strong>#{{bookingNumber}}</strong>.')}
      ${B.callout('Please update your payment method by <strong>{{deadlineLabel}}</strong> to keep your booking.', 'danger')}
      ${B.paragraph('If payment is not completed before the deadline, the booking may be cancelled automatically.', { muted: true, small: true })}
      ${B.buttonPrimary('Update payment method', '{{managePaymentUrl}}')}
    `);
  },
};

const customerBookingChanged = {
  key: 'customer-booking-changed',
  name: 'Customer · Changes confirmed',
  build() {
    return B.shell('Your booking has been updated', `
      ${B.hero({ heading: 'Your requested changes are confirmed', badgeText: 'Updated', badgeColor: 'info' })}
      ${B.paragraph('The changes you requested have been successfully applied.')}
      ${B.diffTable()}
      ${B.divider()}
      ${B.sectionTitle('Price adjustment')}
      ${B.summaryRows([
        { label: 'Previous total', value: '{{previousTotalLabel}}' },
        { label: 'Additional charge / refund', value: '{{adjustmentLabel}}' },
        { label: 'New total', value: '{{newTotalLabel}}', total: true },
      ])}
      ${B.detailRows([
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
      ])}
      ${B.callout('Your previous voucher is no longer valid.', 'warning')}
      ${B.buttons([
        { label: 'View updated booking', href: '{{bookingUrl}}' },
        { label: 'Download updated voucher', href: '{{voucherUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const pickupDetailsUpdated = {
  key: 'pickup-details-updated',
  name: 'Customer · Pickup details updated',
  build() {
    return B.shell('Your pickup information has been updated', `
      ${B.hero({ heading: 'Pickup information updated', badgeText: 'Updated', badgeColor: 'info' })}
      ${B.detailRows([
        { label: 'Previous pickup location', value: '{{previousPickupLocation}}', if: '{{previousPickupLocation}}' },
        { label: 'New pickup location', value: '{{pickupLocation}}' },
        { label: 'Pickup date', value: '{{dateLabel}}' },
        { label: 'Pickup time / window', value: '{{pickupTime}}', if: '{{pickupTime}}' },
      ])}
      {{#if pickupInstructions}}
      ${B.paragraph('Instructions: <strong>{{pickupInstructions}}</strong>')}
      {{/if}}
      ${B.paragraph('All other booking details remain unchanged.', { muted: true })}
      ${B.buttonPrimary('View booking', '{{bookingUrl}}')}
    `);
  },
};

const pickupLocationRequired = {
  key: 'pickup-location-required',
  name: 'Customer · Add pickup location',
  build() {
    return B.shell('Action required: Add your pickup location', `
      ${B.hero({ heading: 'Where should we pick you up?', badgeText: 'Action required', badgeColor: 'warning' })}
      ${B.paragraph('You selected \u201cI\u2019ll choose later\u201d during booking. Please provide your pickup location before <strong>{{deadlineLabel}}</strong>.')}
      ${B.detailRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Date', value: '{{dateLabel}}' },
        { label: 'Starting time', value: '{{timeLabel}}' },
      ])}
      ${B.buttonPrimary('Add pickup location', '{{pickupUrl}}')}
    `);
  },
};

const bookingReminder = {
  key: 'booking-reminder',
  name: 'Customer · Booking reminder',
  build() {
    return B.shell('Your experience is coming up', `
      ${B.hero({ heading: 'Get ready for your experience!', badgeText: 'Coming up', badgeColor: 'info' })}
      ${B.paragraph('Your experience begins on <strong>{{dateLabel}}</strong>.')}
      ${B.detailRows([
        { label: 'Tour', value: '{{tourTitle}}' },
        { label: 'Date', value: '{{dateLabel}}' },
        { label: 'Starting time', value: '{{timeLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
        { label: 'Pickup / meeting point', value: '{{locationLabel}}', if: '{{locationLabel}}' },
        { label: 'Pickup / meeting time', value: '{{pickupTime}}', if: '{{pickupTime}}' },
        { label: 'Guide / supplier contact', value: '{{supplierContact}}', if: '{{supplierContact}}' },
      ])}
      ${B.divider()}
      ${B.sectionTitle('Before you go')}
      ${B.bulletList()}
      ${B.buttons([
        { label: 'View voucher', href: '{{voucherUrl}}' },
        { label: 'Get directions', href: '{{directionsUrl}}', kind: 'secondary' },
        { label: 'Contact support', href: '{{supportUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const customerCancelledFullRefund = {
  key: 'customer-cancelled-full-refund',
  name: 'Customer · Cancelled with full refund',
  build() {
    return B.shell('Your booking has been cancelled', `
      ${B.hero({ heading: 'Your booking is cancelled', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.paragraph('Your cancellation has been completed.')}
      ${B.sectionTitle('Cancellation details')}
      ${B.detailRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Original date', value: '{{dateLabel}}' },
        { label: 'Cancelled by', value: 'Customer' },
        { label: 'Cancellation date', value: '{{cancelledAtLabel}}' },
        { label: 'Cancellation reason', value: '{{cancellationReason}}', if: '{{cancellationReason}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund status', value: 'Processing' },
        { label: 'Expected arrival', value: 'Usually 5\u201310 business days' },
      ])}
      ${B.callout('Your booking voucher is no longer valid.', 'warning')}
      ${B.buttons([
        { label: 'View cancellation', href: '{{cancellationUrl}}' },
        { label: 'Book another experience', href: '{{browseUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const customerCancelledNoRefund = {
  key: 'customer-cancelled-no-refund',
  name: 'Customer · Cancelled without refund',
  build() {
    return B.shell('Your booking has been cancelled', `
      ${B.hero({ heading: 'Your booking is cancelled', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.paragraph('Your cancellation was made after the free-cancellation deadline.')}
      ${B.detailRows([
        { label: 'Cancellation deadline', value: '{{cancellationDeadlineLabel}}' },
        { label: 'Cancellation time', value: '{{cancelledAtLabel}}' },
        { label: 'Cancellation fee', value: '{{cancellationFeeLabel}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund status', value: 'Not eligible' },
      ])}
      ${B.buttons([
        { label: 'View cancellation', href: '{{cancellationUrl}}' },
        { label: 'Contact support', href: '{{supportUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const refundProcessing = {
  key: 'refund-processing',
  name: 'Customer · Refund processing',
  build() {
    return B.shell('Your refund is being processed', `
      ${B.hero({ heading: 'We\u2019re processing your refund', badgeText: 'Processing', badgeColor: 'info' })}
      ${B.detailRows([
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund method', value: 'Original payment method' },
        { label: 'Refund reference', value: '{{refundReference}}', if: '{{refundReference}}' },
        { label: 'Expected arrival', value: '5\u201310 business days' },
        { label: 'Status', value: 'Processing' },
      ])}
      ${B.buttonPrimary('View refund', '{{refundUrl}}')}
    `);
  },
};

const refundCompleted = {
  key: 'refund-completed',
  name: 'Customer · Refund completed',
  build() {
    return B.shell('Your refund has been issued', `
      ${B.hero({ heading: 'Your refund is complete', badgeText: '&#10003;&nbsp;&nbsp;Refunded', badgeColor: 'accent' })}
      ${B.paragraph('We have issued <strong>{{refundAmountLabel}}</strong> to your original payment method.')}
      ${B.detailRows([
        { label: 'Refund reference', value: '{{refundReference}}', if: '{{refundReference}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund issued', value: '{{refundedAtLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
        { label: 'Status', value: 'Completed' },
      ])}
      ${B.paragraph('Your bank may take additional time to display the funds.', { muted: true, small: true })}
      ${B.buttonPrimary('View refund details', '{{refundUrl}}')}
    `);
  },
};

const supplierChangedBooking = {
  key: 'supplier-changed-booking',
  name: 'Customer · Supplier changed booking',
  build() {
    return B.shell('Important update to your booking', `
      ${B.hero({ heading: 'Your booking details have changed', badgeText: 'Important', badgeColor: 'info' })}
      ${B.paragraph('We\u2019re contacting you because a change has been made to your experience.')}
      ${B.diffTable()}
      ${B.divider()}
      {{#if changeReason}}
      ${B.sectionTitle('Reason')}
      ${B.paragraph('{{changeReason}}')}
      {{/if}}
      {{#if needsAcceptance}}
      ${B.callout('If the change is significant, let us know what works best for you.', 'warning')}
      ${B.buttons([
        { label: 'Accept changes', href: '{{acceptUrl}}' },
        { label: 'Choose another date', href: '{{rescheduleUrl}}', kind: 'secondary' },
        { label: 'Cancel for a full refund', href: '{{cancelUrl}}', kind: 'secondary' },
      ])}
      {{else}}
      ${B.buttonPrimary('View updated booking', '{{bookingUrl}}')}
      {{/if}}
    `);
  },
};

const supplierCancelledBooking = {
  key: 'supplier-cancelled-booking',
  name: 'Customer · Supplier cancelled booking',
  build() {
    return B.shell('Important: Your booking has been cancelled', `
      ${B.hero({ heading: 'We\u2019re sorry\u2014your experience has been cancelled', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.paragraph('Unfortunately, the supplier can no longer operate your experience.')}
      ${B.detailRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Original date', value: '{{dateLabel}}' },
        { label: 'Reason', value: '{{cancellationReason}}', if: '{{cancellationReason}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund status', value: 'Processing' },
      ])}
      ${B.buttons([
        { label: 'Find another experience', href: '{{browseUrl}}' },
        { label: 'View refund', href: '{{refundUrl}}', kind: 'secondary' },
        { label: 'Contact support', href: '{{supportUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const reviewRequest = {
  key: 'review-request',
  name: 'Customer · Review request',
  build() {
    return B.shell('How was your experience?', `
      ${B.hero({ heading: 'Tell us about your experience', badgeText: 'Review', badgeColor: 'accent' })}
      ${B.paragraph('Thank you for booking with {{brandName}}. We hope you had a memorable {{tourTitle}} experience.')}
      ${B.paragraph('Your review helps other travellers make better choices.')}
      ${B.buttons([
        { label: 'Write a review', href: '{{reviewUrl}}' },
        { label: 'Explore more experiences', href: '{{browseUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Supplier emails
// ────────────────────────────────────────────────────────────────────────────

const supplierNewBooking = {
  key: 'supplier-new-booking',
  name: 'Supplier · New confirmed booking',
  build() {
    return B.shell('New confirmed booking', `
      ${B.hero({ heading: 'You have a new confirmed booking', badgeText: '&#10003;&nbsp;&nbsp;Confirmed', badgeColor: 'accent', subtitle: 'Hello {{supplierName}},<br>A new booking has been added to your supplier dashboard.' })}
      ${B.sectionTitle('Booking details')}
      ${supplierBookingDetailsRows()}
      {{#if specialRequirements}}
      ${B.detailRows([
        { label: 'Special requirements', value: '{{specialRequirements}}' },
      ])}
      {{/if}}
      ${B.divider()}
      ${B.sectionTitle('Customer details')}
      ${customerContactRows()}
      ${B.divider()}
      ${B.sectionTitle('Supplier payout')}
      ${B.summaryRows([
        { label: 'Retail value', value: '{{totalLabel}}' },
        { label: 'Commission', value: '{{commissionLabel}}' },
        { label: 'Supplier payout', value: '{{payoutAmountLabel}}', total: true },
      ])}
      ${B.detailRows([
        { label: 'Payout status', value: 'Scheduled' },
      ])}
      ${B.buttonPrimary('View booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierBookingChanged = {
  key: 'supplier-booking-changed',
  name: 'Supplier · Customer changed booking',
  build() {
    return B.shell('A confirmed booking has been updated', `
      ${B.hero({ heading: 'A confirmed booking has changed', badgeText: 'Updated', badgeColor: 'info' })}
      ${B.paragraph('The customer has updated this booking. Availability and payment have been updated automatically.')}
      ${B.diffTable()}
      ${B.divider()}
      ${B.sectionTitle('Updated payout')}
      ${B.summaryRows([
        { label: 'Previous payout', value: '{{previousPayoutLabel}}' },
        { label: 'Payout adjustment', value: '{{payoutAdjustmentLabel}}' },
        { label: 'New payout', value: '{{newPayoutLabel}}', total: true },
      ])}
      ${B.callout('Use only the updated booking details. No confirmation is required.', 'info')}
      ${B.buttonPrimary('View updated booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierContactUpdated = {
  key: 'supplier-customer-contact-updated',
  name: 'Supplier · Customer contact updated',
  build() {
    return B.shell('Traveller details have changed', `
      ${B.hero({ heading: 'Traveller details have changed', badgeText: 'Updated', badgeColor: 'info' })}
      ${B.stackedRows([
        { label: 'Lead traveller', value: '{{customerName}}' },
        { label: 'Updated telephone', value: '{{customerPhone}}' },
        { label: 'Updated email', value: '{{customerEmail}}' },
        { label: 'Emergency contact', value: '{{emergencyContact}}', if: '{{emergencyContact}}' },
      ])}
      ${B.paragraph('All other booking details remain unchanged.', { muted: true })}
      ${B.buttonPrimary('View booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierPickupUpdated = {
  key: 'supplier-pickup-updated',
  name: 'Supplier · Customer pickup updated',
  build() {
    return B.shell('Customer pickup location updated', `
      ${B.hero({ heading: 'Pickup information has changed', badgeText: 'Updated', badgeColor: 'info' })}
      ${B.detailRows([
        { label: 'Previous location', value: '{{previousPickupLocation}}', if: '{{previousPickupLocation}}' },
        { label: 'New location', value: '{{pickupLocation}}' },
        { label: 'Pickup date', value: '{{dateLabel}}' },
        { label: 'Pickup time', value: '{{pickupTime}}', if: '{{pickupTime}}' },
      ])}
      {{#if pickupInstructions}}
      ${B.paragraph('Instructions: <strong>{{pickupInstructions}}</strong>')}
      {{/if}}
      ${B.callout('Please update your guide, driver and vehicle schedule.', 'info')}
      ${B.buttonPrimary('View booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierBookingReminder = {
  key: 'supplier-booking-reminder',
  name: 'Supplier · Upcoming booking reminder',
  build() {
    return B.shell('Upcoming booking reminder', `
      ${B.hero({ heading: 'This booking is coming up', badgeText: 'Reminder', badgeColor: 'info' })}
      ${B.detailRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Date', value: '{{dateLabel}}' },
        { label: 'Starting time', value: '{{timeLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
        { label: 'Customer', value: '{{customerName}}' },
        { label: 'Telephone', value: '{{customerPhone}}', if: '{{customerPhone}}' },
        { label: 'Pickup / meeting point', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
      ])}
      {{#if specialRequirements}}
      ${B.detailRows([
        { label: 'Special requirements', value: '{{specialRequirements}}' },
      ])}
      {{/if}}
      ${B.buttonPrimary('View booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierCustomerCancelledFree = {
  key: 'supplier-customer-cancelled-free',
  name: 'Supplier · Customer cancelled (free period)',
  build() {
    return B.shell('Booking cancelled — do not operate', `
      ${B.hero({ heading: 'This booking has been cancelled', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.callout('DO NOT OPERATE THIS BOOKING', 'danger')}
      ${B.detailRows([
        { label: 'Cancelled by', value: 'Customer' },
        { label: 'Cancellation time', value: '{{cancelledAtLabel}}' },
        { label: 'Experience date', value: '{{dateLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
        { label: 'Cancellation policy', value: 'Free cancellation' },
        { label: 'Supplier payout', value: '{{payoutAmountLabel}}' },
        { label: 'Availability', value: 'Automatically restored' },
      ])}
      ${B.callout('Remove the customer from all guide, driver, vehicle and pickup schedules.', 'warning')}
      ${B.buttonPrimary('View cancelled booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierCustomerCancelledLate = {
  key: 'supplier-customer-cancelled-late',
  name: 'Supplier · Customer cancelled (late)',
  build() {
    return B.shell('Late customer cancellation', `
      ${B.hero({ heading: 'Booking cancelled after the deadline', badgeText: 'Late cancellation', badgeColor: 'danger' })}
      ${B.callout('DO NOT OPERATE UNLESS SUPPORT INSTRUCTS OTHERWISE', 'danger')}
      ${B.detailRows([
        { label: 'Cancelled by', value: 'Customer' },
        { label: 'Cancellation deadline', value: '{{cancellationDeadlineLabel}}' },
        { label: 'Cancellation time', value: '{{cancelledAtLabel}}' },
        { label: 'Cancellation status', value: 'Late cancellation' },
        { label: 'Cancellation payout', value: '{{payoutAmountLabel}}' },
        { label: 'Payout status', value: 'Scheduled' },
      ])}
      ${B.buttonPrimary('View cancellation and payout', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierPlatformCancelled = {
  key: 'supplier-platform-cancelled',
  name: 'Supplier · Platform cancelled booking',
  build() {
    return B.shell('Booking cancelled by Expedition-Go Tours', `
      ${B.hero({ heading: 'Do not operate this booking', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.paragraph('{{brandName}} has cancelled this booking.')}
      ${B.detailRows([
        { label: 'Reason', value: '{{cancellationReason}}', if: '{{cancellationReason}}' },
        { label: 'Customer notified', value: 'Yes' },
        { label: 'Customer refund', value: 'Full refund' },
        { label: 'Supplier cancellation compensation', value: '{{compensationLabel}}' },
        { label: 'Availability', value: 'Automatically restored' },
      ])}
      ${B.buttonPrimary('View cancellation', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierCancellationRecorded = {
  key: 'supplier-cancellation-recorded',
  name: 'Supplier · Supplier cancellation recorded',
  build() {
    return B.shell('Supplier cancellation confirmed', `
      ${B.hero({ heading: 'Your cancellation has been recorded', badgeText: 'Recorded', badgeColor: 'warning' })}
      ${B.paragraph('The customer has been notified and will receive a full refund.')}
      ${B.detailRows([
        { label: 'Cancellation reason', value: '{{cancellationReason}}', if: '{{cancellationReason}}' },
        { label: 'Customer refund', value: '{{refundAmountLabel}}' },
        { label: 'Supplier payout', value: '{{payoutAmountLabel}}' },
        { label: 'Supplier cancellation impact', value: 'Recorded according to supplier policy' },
      ])}
      ${B.callout('Frequent supplier cancellations may affect ranking, availability privileges and account performance.', 'warning')}
      ${B.buttonPrimary('View cancellation', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierPayoutScheduled = {
  key: 'supplier-payout-scheduled',
  name: 'Supplier · Payout scheduled',
  build() {
    return B.shell('Payout scheduled', `
      ${B.hero({ heading: 'Your payout is scheduled', badgeText: 'Scheduled', badgeColor: 'info' })}
      ${supplierPayoutRows()}
      ${B.buttonPrimary('View payout', '{{supplierPayoutUrl}}')}
    `);
  },
};

const supplierPayoutCompleted = {
  key: 'supplier-payout-completed',
  name: 'Supplier · Payout completed',
  build() {
    return B.shell('Payout sent', `
      ${B.hero({ heading: 'Your payout has been sent', badgeText: '&#10003;&nbsp;&nbsp;Completed', badgeColor: 'accent' })}
      ${supplierPayoutRows()}
      ${B.buttonPrimary('View payout statement', '{{supplierPayoutUrl}}')}
    `);
  },
};

const supplierPayoutFailed = {
  key: 'supplier-payout-failed',
  name: 'Supplier · Payout failed',
  build() {
    return B.shell('Action required: Supplier payout unsuccessful', `
      ${B.hero({ heading: 'We couldn\u2019t complete your payout', badgeText: 'Action required', badgeColor: 'danger' })}
      ${B.paragraph('We could not send the payout for booking <strong>#{{bookingNumber}}</strong>.')}
      ${B.detailRows([
        { label: 'Payout amount', value: '{{payoutAmountLabel}}' },
        { label: 'Reason', value: '{{payoutReason}}', if: '{{payoutReason}}' },
        { label: 'Status', value: 'Action required' },
      ])}
      ${B.buttonPrimary('Review payout details', '{{supplierPayoutUrl}}')}
    `);
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Registry + build
// ────────────────────────────────────────────────────────────────────────────

const TEMPLATE_DEFS = [
  customerBookingConfirmed,
  reserveLaterConfirmed,
  paymentReminder,
  paymentSuccessful,
  paymentUnsuccessful,
  customerBookingChanged,
  pickupDetailsUpdated,
  pickupLocationRequired,
  bookingReminder,
  customerCancelledFullRefund,
  customerCancelledNoRefund,
  refundProcessing,
  refundCompleted,
  supplierChangedBooking,
  supplierCancelledBooking,
  reviewRequest,
  supplierNewBooking,
  supplierBookingChanged,
  supplierContactUpdated,
  supplierPickupUpdated,
  supplierBookingReminder,
  supplierCustomerCancelledFree,
  supplierCustomerCancelledLate,
  supplierPlatformCancelled,
  supplierCancellationRecorded,
  supplierPayoutScheduled,
  supplierPayoutCompleted,
  supplierPayoutFailed,
];

function buildAll() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const written = [];
  for (const def of TEMPLATE_DEFS) {
    const html = def.build();
    const file = path.join(OUT_DIR, `${def.key}.html`);
    fs.writeFileSync(file, html, 'utf-8');
    written.push({ key: def.key, name: def.name, file });
  }
  return written;
}

module.exports = { TEMPLATE_DEFS, buildAll, OUT_DIR };

if (require.main === module) {
  const written = buildAll();
  console.log(`[EmailTemplates] Wrote ${written.length} templates to ${OUT_DIR}`);
  for (const w of written) console.log(`  - ${w.key}`);
}
