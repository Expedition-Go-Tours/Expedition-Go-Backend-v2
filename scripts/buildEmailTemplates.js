/**
 * Email Template Definitions — all transactional emails.
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
  return B.detailCard([
    { label: 'Booking reference', value: '{{bookingNumber}}' },
    { label: 'Experience', value: '{{tourTitle}}' },
    { label: 'Activity date', value: '{{dateLabel}}' },
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
    ${B.detailCard([
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
    ${B.buttons([{ label: 'Get directions', href: '{{directionsUrl}}', kind: 'secondary' }])}
    {{/if}}`;
}

function supplierBookingDetailsRows() {
  return B.detailCard([
    { label: 'Booking reference', value: '{{bookingNumber}}' },
    { label: 'Supplier reference', value: '{{supplierReference}}', if: '{{supplierReference}}' },
    { label: 'Experience', value: '{{tourTitle}}' },
    { label: 'Activity date', value: '{{dateLabel}}' },
    { label: 'Starting time', value: '{{timeLabel}}', if: '{{timeLabel}}' },
    { label: 'Travellers', value: '{{travelersLabel}}' },
    { label: 'Language', value: '{{languageLabel}}' },
    { label: 'Booking type', value: '{{bookingTypeLabel}}' },
    { label: 'Pickup required', value: '{{pickupRequiredLabel}}' },
    { label: 'Pickup / meeting location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
  ]);
}

function customerContactRows() {
  return B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{customerInitials}}' });
}

// ────────────────────────────────────────────────────────────────────────────
// Customer emails
// ────────────────────────────────────────────────────────────────────────────

const customerBookingConfirmed = {
  key: 'booking-confirmed',
  name: 'Customer · Booking confirmed',
  build(data) {
    return B.shell('Your booking is confirmed', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#10003;&nbsp;&nbsp;Confirmed',
        badgeColor: 'accent',
        heading: 'Your booking is confirmed',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{customerName}}, thank you for booking with {{brandName}}. Your experience is confirmed and everything you need is below.')}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{dateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tone: 'blue', if: '{{timeLabel}}' },
        { icon: 'duration', label: 'Duration', value: '{{durationLabel}}', tone: 'amber', if: '{{durationLabel}}' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Booked via', value: '{{brandName}}' },
        { label: 'Language', value: '{{languageLabel}}' },
        { label: 'Booking type', value: '{{bookingTypeLabel}}' },
        { label: 'Supplier', value: '{{supplierName}}' },
      ])}
      ${B.sectionTitle('Lead traveller')}
      ${B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{leadTravelerInitials}}', avatarVar: 'leadTravelerAvatarUrl' })}
      ${B.sectionTitle('Pickup & meeting')}
      ${B.detailCard([
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
      ${B.buttons([{ label: 'Get directions', href: '{{directionsUrl}}', kind: 'secondary' }])}
      {{/if}}
      ${B.sectionTitle('Payment')}
      ${B.detailCard([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount paid', value: '{{amountPaidLabel}}' },
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      ${B.sectionTitle('Cancellation policy')}
      {{#if cancelDeadlineLabel}}
      ${B.callout('Free cancellation until <strong>{{cancelDeadlineLabel}}</strong>.', 'success')}
      ${B.paragraph('{{cancellationPolicyText}}', { small: true, muted: true })}
      {{else}}
      ${B.callout('{{cancellationPolicyText}}', 'warning')}
      {{/if}}
      ${B.sectionTitle('What happens next')}
      ${B.stepList([
        { title: 'Show your mobile voucher at the meeting point', body: 'Download it below or open it any time from your booking.' },
        { title: 'Arrive 10 minutes before the start time', body: 'A little leeway keeps check-in smooth and the group on schedule.' },
      ])}
      ${B.buttons([
        { label: 'Download voucher', href: '{{voucherUrl}}' },
        { label: 'View the experience', href: '{{tourUrl}}', kind: 'secondary' },
        { label: 'View booking', href: '{{bookingUrl}}', kind: 'secondary' },
        { label: 'Manage booking', href: '{{manageUrl}}', kind: 'secondary' },
      ])}
      ${B.recommendations('Similar activities', 'More experiences travellers love in the same destination.')}
    `);
  },
};

const reserveLaterConfirmed = {
  key: 'reserve-later-confirmed',
  name: 'Customer · Reserve now, pay later',
  build() {
    return B.shell('Your booking is confirmed: payment scheduled', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Reserved',
        badgeColor: 'info',
        heading: 'Your experience is reserved!',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{customerName}}, your booking is confirmed. No payment has been taken yet.')}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{experienceDateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Payment date', value: '{{chargeDateLabel}}', tone: 'amber' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Booking details')}
      ${customerBookingDetailsRows()}
      ${B.sectionTitle('Payment schedule')}
      ${B.detailCard([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount paid today', value: '{{amountPaidTodayLabel}}' },
        { label: 'Scheduled payment', value: '{{scheduledPaymentLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      ${B.callout('We will remind you before the payment is collected. You can update your card at any time.', 'info')}
      ${customerPickupSection()}
      ${B.sectionTitle('Cancellation policy')}
      {{#if cancelDeadlineLabel}}
      ${B.callout('Free cancellation until <strong>{{cancelDeadlineLabel}}</strong>.', 'success')}
      ${B.paragraph('{{cancellationPolicyText}}', { small: true, muted: true })}
      {{else}}
      ${B.callout('{{cancellationPolicyText}}', 'warning')}
      {{/if}}
      ${B.buttons([
        { label: 'View booking', href: '{{bookingUrl}}' },
        { label: 'Manage payment method', href: '{{managePaymentUrl}}', kind: 'secondary' },
        { label: 'Manage booking', href: '{{manageUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const paymentReminder = {
  key: 'payment-reminder',
  name: 'Customer · Payment reminder',
  build() {
    return B.shell('Upcoming payment for your booking', `
      ${B.hero({ heading: 'Your payment is coming up', badgeText: 'Payment reminder', badgeColor: 'warning', subtitle: 'Hello {{customerName}},<br>We will collect <strong>{{paymentAmountLabel}}</strong> on <strong>{{chargeDateLabel}}</strong> for <strong>{{tourTitle}}</strong>.' })}
      ${B.sectionTitle('Booking summary')}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{experienceDateLabel}}' },
        { label: 'Payment date', value: '{{chargeDateLabel}}' },
        { label: 'Payment method', value: '{{paymentMethodLabel}}', if: '{{paymentMethodLabel}}' },
      ])}
      {{#if cancelDeadlineLabel}}
      ${B.callout('Free cancellation until <strong>{{cancelDeadlineLabel}}</strong>. Update your payment method before then to keep your booking.', 'warning')}
      {{/if}}
      ${B.buttonPrimary('Review payment details', '{{managePaymentUrl}}')}
    `);
  },
};

const paymentSuccessful = {
  key: 'payment-successful',
  name: 'Customer · Payment successful',
  build() {
    return B.shell('Payment received', `
      ${B.hero({ heading: 'Your payment was successful', badgeText: '&#10003;&nbsp;&nbsp;Paid', badgeColor: 'accent', subtitle: 'Hello {{customerName}},<br>We successfully received <strong>{{paymentAmountLabel}}</strong> for <strong>{{tourTitle}}</strong>.' })}
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
      ])}
      ${B.sectionTitle('Payment details')}
      ${B.detailCard([
        { label: 'Payment reference', value: '{{paymentReference}}', if: '{{paymentReference}}' },
        { label: 'Amount paid', value: '{{paymentAmountLabel}}' },
        { label: 'Outstanding balance', value: '{{outstandingBalanceLabel}}' },
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
      ])}
      ${B.buttons([
        { label: 'View receipt', href: '{{bookingUrl}}' },
        { label: 'View booking', href: '{{bookingUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const payLaterCharged = {
  key: 'pay-later-charged',
  name: 'Customer · Reservation charged & confirmed',
  build() {
    return B.shell('Your reservation is confirmed: payment collected', `
      ${B.hero({ heading: 'Your reservation is now confirmed', badgeText: '&#10003;&nbsp;&nbsp;Paid', badgeColor: 'accent', subtitle: 'Hello {{customerName}},<br>Your reserved experience has been charged and is now fully confirmed.' })}
      ${B.sectionTitle('Booking details')}
      ${customerBookingDetailsRows()}
      ${customerPickupSection()}
      ${B.sectionTitle('Payment')}
      ${B.detailCard([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount charged', value: '{{amountChargedLabel}}' },
        { label: 'Charged on', value: '{{chargedAtLabel}}' },
        { label: 'Payment reference', value: '{{paymentReference}}', if: '{{paymentReference}}' },
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
      ])}
      ${B.callout('This payment was the scheduled collection for your reserve-now-pay-later booking.', 'success')}
      ${B.buttons([
        { label: 'View booking', href: '{{bookingUrl}}' },
        { label: 'Download voucher', href: '{{voucherUrl}}' },
        { label: 'Manage booking', href: '{{manageUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const awaitingConfirmation = {
  key: 'awaiting-confirmation',
  name: 'Customer · Payment received, awaiting confirmation',
  build() {
    return B.shell('Payment received: awaiting confirmation', `
      ${B.hero({ heading: 'Payment received', badgeText: 'Paid', badgeColor: 'info', subtitle: 'Hello {{customerName}},<br>Your payment for <strong>{{tourTitle}}</strong> has been received. Your booking is not confirmed yet. The tour provider will confirm it shortly.' })}
      ${B.sectionTitle('Booking details')}
      ${customerBookingDetailsRows()}
      ${B.sectionTitle('Payment')}
      ${B.detailCard([
        { label: 'Booking total', value: '{{totalLabel}}' },
        { label: 'Amount received', value: '{{amountPaidLabel}}' },
        { label: 'Received on', value: '{{paidAtLabel}}' },
        { label: 'Payment reference', value: '{{paymentReference}}', if: '{{paymentReference}}' },
        { label: 'Payment status', value: '{{paymentStatusLabel}}' },
      ])}
      ${B.callout('Your booking is awaiting confirmation from the tour provider. We will email you as soon as it is confirmed.', 'info')}
      ${B.buttons([
        { label: 'View booking', href: '{{bookingUrl}}' },
        { label: 'Manage booking', href: '{{manageUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const paymentUnsuccessful = {
  key: 'payment-unsuccessful',
  name: 'Customer · Payment unsuccessful',
  build() {
    return B.shell('Action required: We could not process your payment', `
      ${B.hero({ heading: 'Please update your payment method', badgeText: 'Action required', badgeColor: 'danger', subtitle: 'Hello {{customerName}},<br>We could not collect <strong>{{paymentAmountLabel}}</strong> for <strong>{{tourTitle}}</strong>.' })}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Amount due', value: '{{paymentAmountLabel}}' },
      ])}
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
      ${B.detailCard([
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
    return B.shell('Your pickup information has been updated (Ref: {{bookingNumber}})', `
      ${B.hero({ heading: 'Pickup information updated', badgeText: 'Updated', badgeColor: 'info' })}
    ${B.detailCard([
      { label: 'Booking reference', value: '{{bookingNumber}}' },
      { label: 'Activity', value: '{{tourTitle}}' },
      { label: 'Lead traveller', value: '{{leadTravelerName}}' },
    ])}
    ${B.detailCard([
      { label: 'Previous pickup location', value: '{{previousPickupLocation}}', if: '{{previousPickupLocation}}', strike: true },
      { label: 'New pickup location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
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
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
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
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Coming up',
        badgeColor: 'info',
        heading: 'Get ready for your experience!',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{customerName}}, your experience begins on <strong>{{dateLabel}}</strong>. Here is everything you need before you go.')}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{dateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tone: 'blue', if: '{{timeLabel}}' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Pickup & meeting')}
      ${B.detailCard([
        { label: 'Pickup / meeting point', value: '{{locationLabel}}', if: '{{locationLabel}}' },
        { label: 'Pickup / meeting time', value: '{{pickupTime}}', if: '{{pickupTime}}' },
        { label: 'Guide / supplier contact', value: '{{supplierContact}}', if: '{{supplierContact}}' },
      ])}
      {{#if cancelDeadlineLabel}}
      ${B.callout('Free cancellation until <strong>{{cancelDeadlineLabel}}</strong>. This is your last chance to cancel for free.', 'warning')}
      {{/if}}
      ${B.sectionTitle('Before you go')}
      ${B.bulletList()}
      {{#if directionsUrl}}
      ${B.buttons([{ label: 'Get directions', href: '{{directionsUrl}}', kind: 'secondary' }])}
      {{/if}}
      ${B.buttons([
        { label: 'View voucher', href: '{{voucherUrl}}' },
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
      ${B.hero({ heading: 'Your booking is cancelled', badgeText: 'Cancelled', badgeColor: 'danger', subtitle: 'Hello {{customerName}},<br>Your cancellation for <strong>{{tourTitle}}</strong> has been completed.' })}
      ${B.sectionTitle('Cancellation details')}
      ${B.detailCard([
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
      ${B.detailCard([
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
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#9203;&nbsp;&nbsp;Processing',
        badgeColor: 'info',
        heading: 'We are processing your refund',
        subtitle: '{{tourTitle}} &middot; {{dateLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: 'Refund in progress' })}
      ${B.paragraph('Hello {{customerName}}, we have started your refund for <strong>{{tourTitle}}</strong>. No action is needed from you.')}
      ${B.statusStrip([
        { label: 'Requested', sublabel: 'Refund requested' },
        { label: 'Processing', sublabel: 'On its way to you' },
        { label: 'Completed', sublabel: 'Funds returned' },
      ], 1)}
      ${B.sectionTitle('Refund details')}
      ${B.summaryRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Lead traveller', value: '{{leadTravelerName}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Refund method', value: 'Original payment method' },
        { label: 'Refund reference', value: '{{refundReference}}', if: '{{refundReference}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}', total: true },
      ])}
      ${B.callout('Refunds usually arrive within <strong>5-10 business days</strong>. We will email you the moment it is complete.', 'info')}
      ${B.buttonPrimary('View refund', '{{refundUrl}}')}
    `);
  },
};

const refundCompleted = {
  key: 'refund-completed',
  name: 'Customer · Refund completed',
  build() {
    return B.shell('Your refund has been issued', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#10003;&nbsp;&nbsp;Refunded',
        badgeColor: 'accent',
        heading: 'Your refund is complete',
        subtitle: '{{refundAmountLabel}} returned for {{tourTitle}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if refundedAtLabel}}Refunded {{refundedAtLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{customerName}}, we have issued <strong>{{refundAmountLabel}}</strong> for <strong>{{tourTitle}}</strong>. Here is the full breakdown.')}
      ${B.statusStrip([
        { label: 'Requested', sublabel: 'Refund requested' },
        { label: 'Processing', sublabel: 'Sent to your bank' },
        { label: 'Completed', sublabel: 'Funds returned' },
      ], 2)}
      ${B.sectionTitle('Refund details')}
      ${B.summaryRows([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Lead traveller', value: '{{leadTravelerName}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Refund method', value: 'Original payment method' },
        { label: 'Refund reference', value: '{{refundReference}}', if: '{{refundReference}}' },
        { label: 'Refund issued', value: '{{refundedAtLabel}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}', total: true },
      ])}
      ${B.callout('The refund is on its way to your original payment method. Your bank may take additional time to display the funds.', 'success')}
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
      ${B.hero({ heading: "We're sorry, your experience has been cancelled", badgeText: 'Cancelled', badgeColor: 'danger' })}
      {{#if choiceUrl}}
      ${B.paragraph('You can choose a new date for this experience, or take a full refund, no questions asked. If we don\u2019t hear from you, a full refund is issued automatically.')}
      {{else}}
      ${B.paragraph('Unfortunately, the supplier can no longer operate your experience. Your refund is on its way back to your original payment method.')}
      {{/if}}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Original date', value: '{{dateLabel}}' },
        { label: 'Reason', value: '{{cancellationReason}}', if: '{{cancellationReason}}' },
        { label: 'Refund amount', value: '{{refundAmountLabel}}' },
        { label: 'Refund status', value: '{{refundStatusLabel}}' },
        { label: 'Decide by', value: '{{choiceDeadlineLabel}}', if: '{{choiceDeadlineLabel}}' },
      ])}
      {{#if choiceUrl}}
      ${B.buttons([
        { label: 'Choose a new date', href: '{{choiceUrl}}' },
        { label: 'Get a full refund', href: '{{choiceUrl}}', kind: 'secondary' },
      ])}
      {{/if}}
      ${B.buttons([
        { label: 'Find another experience', href: '{{browseUrl}}' },
        { label: 'View refund', href: '{{refundUrl}}', kind: 'secondary' },
        { label: 'Contact support', href: '{{supportUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const adminCancellationRequest = {
  key: 'admin-cancellation-request',
  name: 'Admin · Supplier cancellation request (approval needed)',
  build() {
    return B.shell('Action needed: supplier cancellation request', `
      ${B.hero({ heading: 'A supplier has requested a cancellation', badgeText: 'Approval needed', badgeColor: 'warning' })}
      ${B.paragraph('No money has moved and the customer has not been notified. Review the request in the admin Cancellations queue, then approve or reject it.')}
      ${B.detailCard([
        { label: 'Booking', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Supplier', value: '{{supplierName}}' },
        { label: 'Activity date', value: '{{travelDateLabel}}' },
        { label: 'Refund to customer', value: '{{refundLabel}}' },
        { label: 'Cancellation fee', value: '{{feeLabel}}' },
        { label: 'Counts toward rate', value: '{{rateLabel}}' },
        { label: 'Category', value: '{{categoryLabel}}' },
        { label: 'Reason', value: '{{reasonLabel}}' },
        { label: 'Requested', value: '{{requestedAt}}' },
        { label: 'Scope', value: '{{scopeLabel}}' },
      ])}
      ${B.buttonPrimary('Review in admin', '{{reviewUrl}}')}
    `);
  },
};

const supplierCancellationDecision = {
  key: 'supplier-cancellation-decision',
  name: 'Supplier · Cancellation request decision',
  build() {
    return B.shell('Your cancellation request has been reviewed', `
      {{#if approved}}
      ${B.hero({ heading: 'Cancellation approved', badgeText: '&#10003;&nbsp;&nbsp;Approved', badgeColor: 'accent' })}
      ${B.paragraph('Your cancellation request was approved. The customer has been notified and their refund is on its way; any applicable cancellation fee will be netted off your next payout.')}
      {{else}}
      ${B.hero({ heading: 'Cancellation request rejected', badgeText: 'Rejected', badgeColor: 'danger' })}
      ${B.paragraph('Your cancellation request was reviewed and rejected. The booking remains confirmed. The experience is still expected to run as scheduled.')}
      {{/if}}
      ${B.detailCard([
        { label: 'Booking', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Decision', value: '{{decisionLabel}}' },
        { label: 'Note from our team', value: '{{note}}', if: '{{note}}' },
      ])}
      ${B.buttonPrimary('Open your bookings', '{{bookingUrl}}')}
    `);
  },
};

const supplierCancellationFee = {
  key: 'supplier-cancellation-fee',
  name: 'Supplier · Cancellation fee applied',
  build() {
    return B.shell('Cancellation fee applied', `
      ${B.hero({ heading: 'A cancellation fee has been applied to your account', badgeText: 'Fee', badgeColor: 'danger' })}
      ${B.paragraph('Because this cancellation was for an operational reason within your control, a {{feePctLabel}} cancellation fee (of the booking\u2019s retail price) applies. The customer has been fully refunded. The fee will be deducted automatically from your next payout.')}
      ${B.detailCard([
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Booking retail price', value: '{{grossAmountLabel}}' },
        { label: 'Refund to customer', value: '{{refundAmountLabel}}' },
        { label: 'Cancellation fee ({{feePctLabel}})', value: '{{feeAmountLabel}}' },
      ])}
      ${B.buttons([
        { label: 'View earnings', href: '{{payoutsUrl}}' },
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
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Review',
        badgeColor: 'accent',
        heading: 'How was your experience?',
        subtitle: '{{tourTitle}} &middot; {{dateLabel}}',
      })}
      ${B.paragraph('Hello {{customerName}}, thank you for booking with {{brandName}}. We hope you had a memorable experience.')}
      ${B.paragraph('Your review helps other travellers make better choices. It only takes a minute.')}
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
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#10003;&nbsp;&nbsp;Confirmed',
        badgeColor: 'accent',
        heading: 'New confirmed booking',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}' })}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{dateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tone: 'blue', if: '{{timeLabel}}' },
        { icon: 'duration', label: 'Duration', value: '{{durationLabel}}', tone: 'amber', if: '{{durationLabel}}' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Booking details')}
      ${supplierBookingDetailsRows()}
      {{#if specialRequirements}}
      ${B.paragraph('Special requests: <strong>{{specialRequirements}}</strong>')}
      {{/if}}
      ${B.sectionTitle('Lead traveller')}
      ${B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{leadTravelerInitials}}', avatarVar: 'leadTravelerAvatarUrl' })}
      ${B.sectionTitle('Payment & payout')}
      ${B.payoutPanel({
        rows: [
          { label: 'Retail value', value: '{{totalLabel}}' },
          { label: 'Platform commission', value: '{{commissionLabel}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#9679;&nbsp; Scheduled',
      })}
      ${B.buttons([
        { label: 'View booking', href: '{{supplierBookingUrl}}' },
        { label: 'View the experience', href: '{{tourUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const supplierReserveLater = {
  key: 'supplier-reserve-later',
  name: 'Supplier · New reservation (pay later)',
  build() {
    return B.shell('New reservation: payment pending', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#9203;&nbsp;&nbsp;Payment pending',
        badgeColor: 'warning',
        heading: 'New reservation received',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: 'Reserved {{bookedAtLabel}}' })}
      ${B.statusStrip([
        { label: 'Reserved', sublabel: 'Slot held for customer' },
        { label: 'Charge', sublabel: '{{chargeDateLabel}}' },
        { label: 'Confirmed', sublabel: 'After charge clears' },
        { label: 'Complete', sublabel: 'After travel' },
      ], 0)}
      ${B.callout('Reserve now, pay later. The customer&#8217;s card has <strong>not been charged yet</strong>. We charge it automatically on <strong>{{chargeDateLabel}}</strong>. Please hold this slot until then.', 'warning')}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{dateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tone: 'blue' },
        { icon: 'duration', label: 'Duration', value: '{{durationLabel}}', tone: 'amber' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Booking details')}
      ${supplierBookingDetailsRows()}
      ${B.divider()}
      ${B.sectionTitle('Customer')}
      ${B.contactCard({ name: '{{customerName}}', email: '{{customerEmail}}', phone: '{{customerPhone}}', initials: '{{customerInitials}}' })}
      {{#if specialRequirements}}
      ${B.paragraph('Special requests: <strong>{{specialRequirements}}</strong>')}
      {{/if}}
      ${B.divider()}
      ${B.sectionTitle('Payment & payout')}
      ${B.payoutPanel({
        rows: [
          { label: 'Retail value', value: '{{totalLabel}}' },
          { label: 'Platform commission', value: '{{commissionLabel}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#9679;&nbsp; Awaiting card charge &middot; released after travel',
      })}
      ${B.divider()}
      ${B.sectionTitle('What happens next')}
      ${B.stepList([
        { title: '{{chargeDateLabel}}: we charge the saved card', body: 'The customer added a payment method when they reserved. No action is needed from you.' },
        { title: 'On success, the booking is confirmed automatically', body: 'You will receive a &#8220;Reservation payment collected&#8221; email with the final pickup details, and this booking becomes ready to operate.' },
        { title: 'If the charge fails, we handle it and keep you posted', body: 'We contact the customer to update their card and email you the outcome. Please keep this slot held until you hear from us.' },
      ])}
      ${B.divider()}
      ${B.paragraph('{{cancellationPolicyText}}', { small: true, muted: true })}
      ${B.buttons([
        { label: 'View booking', href: '{{supplierBookingUrl}}' },
        { label: 'Open dashboard', href: '{{dashboardUrl}}', kind: 'secondary' },
      ])}
    `);
  },
};

const supplierPayLaterCharged = {
  key: 'supplier-pay-later-charged',
  name: 'Supplier · Reservation charged & confirmed',
  build() {
    return B.shell('Reservation payment collected: booking confirmed', `
      ${B.hero({ heading: 'Reservation payment collected', badgeText: '&#10003;&nbsp;&nbsp;Paid', badgeColor: 'accent', subtitle: 'Hello {{supplierName}},<br>The payment for a reserved booking has been collected. This booking is now confirmed and ready to operate.' })}
      ${B.callout('This was a reserve-now-pay-later booking. The customer\'s card has now been charged.', 'success')}
      ${B.sectionTitle('Booking details')}
      ${supplierBookingDetailsRows()}
      {{#if specialRequirements}}
      ${B.paragraph('Special requests: <strong>{{specialRequirements}}</strong>')}
      {{/if}}
      ${B.sectionTitle('Lead traveller')}
      ${customerContactRows()}
      ${B.sectionTitle('Payment & payout')}
      ${B.payoutPanel({
        rows: [
          { label: 'Retail value', value: '{{totalLabel}}' },
          { label: 'Platform commission', value: '{{commissionLabel}}' },
          { label: 'Payment collected', value: '{{chargedAtLabel}}', if: '{{chargedAtLabel}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#9679;&nbsp; Scheduled',
      })}
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
    return B.shell('Customer pickup location updated (Ref: {{bookingNumber}})', `
      ${B.hero({ heading: 'Pickup information has changed', badgeText: 'Updated', badgeColor: 'info' })}
    ${B.detailCard([
      { label: 'Booking reference', value: '{{bookingNumber}}' },
      { label: 'Activity', value: '{{tourTitle}}' },
      { label: 'Lead traveller', value: '{{leadTravelerName}}' },
    ])}
    ${B.detailCard([
      { label: 'Previous location', value: '{{previousPickupLocation}}', if: '{{previousPickupLocation}}', strike: true },
      { label: 'New location', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
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

const supplierPickupRequired = {
  key: 'supplier-pickup-required',
  name: 'Supplier · Pickup details required',
  build() {
    return B.shell('Action required: Confirm pickup details', `
      ${B.hero({ heading: 'Pickup details still needed', badgeText: 'Action required', badgeColor: 'danger' })}
      ${B.paragraph('Booking <strong>#{{bookingNumber}}</strong> for <strong>{{tourTitle}}</strong> includes pickup, but the pickup location has not been confirmed yet.')}
      ${B.detailCard([
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{deadlineLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
      ])}
      ${B.callout('Please confirm the pickup time and location for this booking before the activity date.', 'info')}
      ${B.buttonPrimary('Coordinate pickup', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierBookingReminder = {
  key: 'supplier-booking-reminder',
  name: 'Supplier · Upcoming booking reminder',
  build() {
    return B.shell('Upcoming booking reminder', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Coming up',
        badgeColor: 'info',
        heading: 'This booking is coming up',
        subtitle: '{{tourTitle}} &middot; {{travelersLabel}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if bookedAtLabel}}Booked {{bookedAtLabel}}{{/if}}' })}
      ${B.sectionTitle('Key facts')}
      ${B.statGrid([
        { icon: 'calendar', label: 'Activity date', value: '{{dateLabel}}', tone: 'green' },
        { icon: 'clock', label: 'Start time', value: '{{timeLabel}}', tone: 'blue', if: '{{timeLabel}}' },
        { icon: 'users', label: 'Travellers', value: '{{travelersLabel}}', tone: 'purple' },
      ])}
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Customer', value: '{{customerName}}' },
        { label: 'Telephone', value: '{{customerPhone}}', if: '{{customerPhone}}' },
        { label: 'Pickup / meeting point', value: '{{pickupLocation}}', if: '{{pickupLocation}}' },
      ])}
      {{#if specialRequirements}}
      ${B.paragraph('Special requests: <strong>{{specialRequirements}}</strong>')}
      {{/if}}
      ${B.buttonPrimary('View booking', '{{supplierBookingUrl}}')}
    `);
  },
};

const supplierCustomerCancelledFree = {
  key: 'supplier-customer-cancelled-free',
  name: 'Supplier · Customer cancelled (free period)',
  build() {
    return B.shell('Booking cancelled: do not operate', `
      ${B.hero({ heading: 'This booking has been cancelled', badgeText: 'Cancelled', badgeColor: 'danger' })}
      ${B.callout('DO NOT OPERATE THIS BOOKING', 'danger')}
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Start time', value: '{{timeLabel}}', if: '{{timeLabel}}' },
        { label: 'Duration', value: '{{durationLabel}}', if: '{{durationLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
      ])}
      ${B.sectionTitle('Lead traveller')}
      ${B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{customerInitials}}' })}
      ${B.sectionTitle('Cancellation details')}
      ${B.detailCard([
        { label: 'Cancelled by', value: 'Customer' },
        { label: 'Cancellation time', value: '{{cancelledAtLabel}}' },
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
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
      ])}
      ${B.sectionTitle('Lead traveller')}
      ${B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{customerInitials}}' })}
      ${B.sectionTitle('Cancellation details')}
      ${B.detailCard([
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
      ${B.hero({ heading: 'Do not operate this booking', badgeText: 'Cancelled', badgeColor: 'danger', subtitle: '{{brandName}} has cancelled this booking.' })}
      ${B.sectionTitle('Booking details')}
      ${B.detailCard([
        { label: 'Booking reference', value: '{{bookingNumber}}' },
        { label: 'Experience', value: '{{tourTitle}}' },
        { label: 'Activity date', value: '{{dateLabel}}' },
        { label: 'Travellers', value: '{{travelersLabel}}' },
      ])}
      ${B.sectionTitle('Lead traveller')}
      ${B.contactCard({ name: '{{leadTravelerName}}', email: '{{leadTravelerEmail}}', phone: '{{leadTravelerPhone}}', initials: '{{customerInitials}}' })}
      ${B.sectionTitle('Cancellation details')}
      ${B.detailCard([
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
      ${B.detailCard([
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
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Scheduled',
        badgeColor: 'info',
        heading: 'Your payout is scheduled',
        subtitle: '{{tourTitle}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if payoutDateLabel}}Due {{payoutDateLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{supplierName}}, your payout for <strong>{{tourTitle}}</strong> has been scheduled. No action is needed from you.')}
      ${B.statusStrip([
        { label: 'Delivered', sublabel: 'Experience complete' },
        { label: 'Scheduled', sublabel: 'Awaiting release' },
        { label: 'Paid', sublabel: 'Funds in your account' },
      ], 1)}
      ${B.payoutPanel({
        rows: [
          { label: 'Booking reference', value: '{{bookingNumber}}' },
          { label: 'Experience', value: '{{tourTitle}}' },
          { label: 'Payout reference', value: '{{payoutReference}}', if: '{{payoutReference}}' },
          { label: 'Payment destination', value: '{{paymentDestination}}', if: '{{paymentDestination}}' },
          { label: 'Payout date', value: '{{payoutDateLabel}}', if: '{{payoutDateLabel}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#9679;&nbsp; Scheduled',
      })}
      ${B.buttonPrimary('View payout', '{{supplierPayoutUrl}}')}
    `);
  },
};

const supplierPayoutCompleted = {
  key: 'supplier-payout-completed',
  name: 'Supplier · Payout completed',
  build() {
    return B.shell('Payout sent', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#10003;&nbsp;&nbsp;Paid',
        badgeColor: 'accent',
        heading: 'Your payout has been sent',
        subtitle: '{{tourTitle}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: '{{#if payoutDateLabel}}Paid {{payoutDateLabel}}{{/if}}' })}
      ${B.paragraph('Hello {{supplierName}}, we have sent your payout for <strong>{{tourTitle}}</strong>. Here is the summary.')}
      ${B.statusStrip([
        { label: 'Delivered', sublabel: 'Experience complete' },
        { label: 'Scheduled', sublabel: 'Payout queued' },
        { label: 'Paid', sublabel: 'Funds sent' },
      ], 2)}
      ${B.payoutPanel({
        rows: [
          { label: 'Booking reference', value: '{{bookingNumber}}' },
          { label: 'Experience', value: '{{tourTitle}}' },
          { label: 'Payout reference', value: '{{payoutReference}}', if: '{{payoutReference}}' },
          { label: 'Payment destination', value: '{{paymentDestination}}', if: '{{paymentDestination}}' },
          { label: 'Payout date', value: '{{payoutDateLabel}}', if: '{{payoutDateLabel}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#10003;&nbsp; Paid',
      })}
      ${B.callout('Funds can take 1-3 business days to appear, depending on your bank. A payout statement is always available in your dashboard.', 'success')}
      ${B.buttonPrimary('View payout statement', '{{supplierPayoutUrl}}')}
    `);
  },
};

const supplierPayoutFailed = {
  key: 'supplier-payout-failed',
  name: 'Supplier · Payout failed',
  build() {
    return B.shell('Action required: Supplier payout unsuccessful', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: 'Action required',
        badgeColor: 'danger',
        heading: 'We could not complete your payout',
        subtitle: '{{tourTitle}}',
      })}
      ${B.referenceBar({ reference: '{{bookingNumber}}', right: 'Payout unsuccessful' })}
      ${B.paragraph('Hello {{supplierName}}, your payout for <strong>{{tourTitle}}</strong> could not be sent. This usually means the payout details on file need to be updated.')}
      {{#if payoutReason}}
      ${B.callout('Reason: <strong>{{payoutReason}}</strong>', 'warning')}
      {{/if}}
      ${B.payoutPanel({
        rows: [
          { label: 'Booking reference', value: '{{bookingNumber}}' },
          { label: 'Experience', value: '{{tourTitle}}' },
        ],
        total: '{{payoutAmountLabel}}',
        statusLabel: '&#9679;&nbsp; Action required',
      })}
      ${B.sectionTitle('What to do next')}
      ${B.stepList([
        { title: 'Check your payout details', body: 'Confirm your bank account or payout method in the dashboard.' },
        { title: 'Update anything that has changed', body: 'Once saved, we retry the payout automatically on the next cycle.' },
      ])}
      ${B.buttonPrimary('Review payout details', '{{supplierPayoutUrl}}')}
    `);
  },
};

// ---------------------------------------------------------------------------
// Product submission / update review notifications
// ---------------------------------------------------------------------------
const supplierProductSubmitted = {
  key: 'supplier-product-submitted',
  name: 'Supplier · Product submitted for review',
  build() {
    return B.shell('Your product has been submitted for review', `
      ${B.hero({ heading: 'Your product has been submitted for review', subtitle: 'Hello {{supplierName}},<br>Thank you for submitting <strong>{{tourTitle}}</strong> to {{brandName}}.', badgeText: 'Under review', badgeColor: 'info' })}
      ${B.paragraph('We\u2019ve successfully received your product and it is now under review by our team.')}
      ${B.callout('Due to the volume of submissions we receive, the review process may take approximately 2\u20133 working days.', 'info')}
      ${B.paragraph('Please keep an eye on your email during this period. If we need any additional information or changes from you, we\u2019ll contact you.')}
      ${B.paragraph('We\u2019ll notify you once the review is complete and your product has been approved, or if any further action is required.')}
      ${B.paragraph('Thank you for partnering with {{brandName}}.', { muted: true, small: true })}
      ${B.buttonPrimary('Go to my products', '{{supplierProductsUrl}}')}
    `);
  },
};

const supplierProductUpdateSubmitted = {
  key: 'supplier-product-update-submitted',
  name: 'Supplier · Product update submitted for review',
  build() {
    return B.shell('Your product update is under review', `
      ${B.hero({ heading: 'Your product update is under review', subtitle: 'Hello {{supplierName}},<br>We\u2019ve received your recent updates to <strong>{{tourTitle}}</strong>.', badgeText: 'Update received', badgeColor: 'info' })}
      ${B.paragraph('The changes are now being reviewed by our team.')}
      ${B.callout('Once approved, please allow 24\u201348 hours for the updated information to reflect on the {{brandName}} platform.', 'info')}
      ${B.paragraph('If we need any additional information or changes from you, we\u2019ll contact you.')}
      ${B.paragraph('Thank you for partnering with {{brandName}}.', { muted: true, small: true })}
      ${B.buttonPrimary('View my product', '{{supplierProductUrl}}')}
    `);
  },
};

// ---------------------------------------------------------------------------
// Review invite — the supplier forwards the guest's review link after the
// activity is marked complete (customer-facing link, supplier-facing email).
// ---------------------------------------------------------------------------
const supplierReviewInvite = {
  key: 'supplier-review-invite',
  name: 'Supplier · Activity completed review link',
  build() {
    return B.shell('Invite {{guestName}} to review their experience', `
      ${B.mediaHeader({
        imageVar: 'tourImageUrl',
        badgeText: '&#10003;&nbsp;&nbsp;Completed',
        badgeColor: 'success',
        heading: 'Invite {{guestName}} to review their experience',
        subtitle: '{{tourTitle}}{{#if dateLabel}} &middot; {{dateLabel}}{{/if}}',
      })}
      ${B.paragraph('Hi {{supplierName}},')}
      ${B.paragraph('Your activity, {{tourTitle}}, with {{guestName}}{{#if dateLabel}} on {{dateLabel}}{{/if}} has been marked as completed.')}
      ${B.paragraph('Now is a good time to follow up with your guest and invite them to share their experience. Honest reviews help future travellers know what to expect and give you useful feedback to improve the experiences you offer.')}
      ${B.sectionTitle('Review link for {{guestName}}')}
      ${B.paragraph('Share the link below with your guest so they can leave a review of their experience.')}
      ${B.copyLink('{{reviewUrl}}')}
      ${B.paragraph(`Prefer to check the reservation first? <a href="{{supplierBookingUrl}}" class="dm-accent" style="color:${B.COLORS.accent};font-weight:700;text-decoration:none;">View booking</a>`)}
      {{#if bookingNumber}}
      ${B.referenceBar({ reference: '{{bookingNumber}}' })}
      {{/if}}
      ${B.paragraph('Please let your guest share their own experience in their own words. There is no need to suggest a particular rating or response.', { muted: true, small: true })}
      ${B.paragraph('Thank you for delivering memorable experiences with {{brandName}}.')}
    `);
  },
};

// ---------------------------------------------------------------------------
// Chat & messaging notifications (GetYourGuide / Viator-style)
// ---------------------------------------------------------------------------
const chatNewMessage = {
  key: 'chat-new-message',
  name: 'Chat New message',
  build() {
    return B.shell('You have a new message', `
      ${B.chatHeader()}
      ${B.senderRow('{{senderName}}', '{{senderRoleLabel}}', '{{senderAvatarUrl}}', '{{senderInitials}}')}
      ${B.messageCard('{{senderMessageHtml}}', '{{attachmentThumbUrl}}', '{{attachmentDocLabel}}')}
      ${B.contextRow('{{tourTitle}}', '{{bookingNumber}}')}
      ${B.buttonPrimary('View conversation', '{{chatUrl}}')}
      ${B.paragraph('Reply to this email to send a reply back in this conversation.', { center: true, muted: true, small: true })}
    `);
  },
};


// ────────────────────────────────────────────────────────────────────────────
// Registry + build
// ────────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────────
// Team invitations
// ────────────────────────────────────────────────────────────────────────────

/**
 * Who invited them, rendered as a person rather than a logo — invite emails
 * convert on the human connection, and it is the strongest phishing signal
 * ("this is the colleague who mentioned it").
 */
function inviterBlock() {
  return `
  <tr><td class="pad" style="padding:20px 40px 0 40px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;">
      <tr>
        <td width="56" valign="middle" style="padding:14px 0 14px 16px;">
          <div style="width:40px;height:40px;border-radius:999px;background-color:{{accentColor}};color:#ffffff;font-family:${B.FONT};font-size:14px;font-weight:700;text-align:center;line-height:40px;letter-spacing:0.5px;">{{inviterInitials}}</div>
        </td>
        <td valign="middle" style="padding:14px 16px 14px 8px;">
          <p style="margin:0;font-family:${B.FONT};font-size:14px;font-weight:700;color:#001F3F;line-height:1.4;">{{inviterName}}</p>
          <p style="margin:2px 0 0 0;font-family:${B.FONT};font-size:12px;color:#64748B;line-height:1.5;">{{#if inviterEmail}}{{inviterEmail}} &middot; {{/if}}invited you to join {{supplierName}}</p>
        </td>
      </tr>
    </table>
  </td></tr>`;
}

/**
 * The access being granted, spelled out: a chip per role plus what each role
 * can actually do. Members can hold two roles, so this is a list.
 */
function roleAccessBlock() {
  return `
  <tr><td class="pad" style="padding:24px 40px 0 40px;">
    <p class="dm-muted" style="margin:0 0 10px 0;font-family:${B.FONT};font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${B.COLORS.faint};">Your access</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;">
      <tr><td style="padding:16px 18px;">
        <div style="margin:0 0 12px 0;">
          {{#each roles}}<span style="display:inline-block;background-color:{{bg}};color:{{fg}};font-family:${B.FONT};font-size:12px;font-weight:700;border-radius:999px;padding:5px 12px;margin:0 6px 6px 0;">{{label}}</span>{{/each}}
        </div>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
          {{#each roles}}
          <tr>
            <td valign="top" style="width:18px;padding:3px 0;font-family:${B.FONT};font-size:13px;line-height:1.6;color:${B.COLORS.accentDark};">&#10003;</td>
            <td style="padding:3px 0;font-family:${B.FONT};font-size:13px;line-height:1.6;color:#334155;"><strong>{{label}}</strong> &mdash; {{summary}}</td>
          </tr>
          {{/each}}
        </table>
      </td></tr>
    </table>
  </td></tr>`;
}

/** Fallback link for clients that strip buttons. */
function fallbackLinkBlock() {
  return `
  <tr><td class="pad" style="padding:4px 40px 0 40px;">
    <p style="margin:0;font-family:${B.FONT};font-size:12px;color:${B.COLORS.muted};line-height:1.6;word-break:break-all;" class="dm-muted">
      Button not working? Paste this link into your browser:<br>
      <a href="{{inviteUrl}}" class="dm-accent" style="color:{{accentColor}};text-decoration:underline;">{{inviteUrl}}</a>
    </p>
  </td></tr>`;
}

const teamInvite = {
  key: 'team-invite',
  name: 'Team invitation',
  build() {
    const body = [
      B.hero({
        heading: "You're invited to join {{supplierName}}",
        subtitle: 'A teammate has given you access to their supplier dashboard.',
        badgeText: 'Team invitation',
      }),
      inviterBlock(),
      roleAccessBlock(),
      B.buttonPrimary('Accept invitation', '{{inviteUrl}}', { color: '{{accentColor}}' }),
      B.paragraph(
        'This secure link only works for <strong>{{inviteeEmail}}</strong> and expires in {{expiresInHours}} hours. No password needed. Sign in with that address and you are in.',
        { center: true, muted: true, small: true },
      ),
      fallbackLinkBlock(),
      B.callout(
        "You're receiving this because {{inviterName}} added you to {{supplierName}}. If you weren't expecting this invitation, you can safely ignore this email. Nothing changes on your account until you accept.",
        'info',
      ),
    ].join('\n');
    return B.shell("You're invited to join {{supplierName}}", body);
  },
};

const teamInviteRevoked = {
  key: 'team-invite-revoked',
  name: 'Team invitation revoked',
  build() {
    const body = [
      B.hero({
        heading: 'Your invitation was cancelled',
        subtitle: 'The team invitation for {{inviteeEmail}} is no longer active.',
        badgeText: 'Invitation revoked',
        badgeColor: 'danger',
      }),
      B.paragraph(
        '{{inviterName}} cancelled the invitation to join {{supplierName}} as <strong>{{rolesText}}</strong>. The link in the original email no longer works, so no action is needed from you.',
      ),
      B.callout(
        'Still need access? Ask {{inviterName}} to send a new invitation. It only takes a moment.',
        'warning',
      ),
      B.paragraph(
        'If you were not expecting this email, you can ignore it or contact support.',
        { muted: true, small: true },
      ),
    ].join('\n');
    return B.shell('Your invitation was cancelled', body);
  },
};

const TEMPLATE_DEFS = [
  customerBookingConfirmed,
  reserveLaterConfirmed,
  paymentReminder,
  paymentSuccessful,
  payLaterCharged,
  awaitingConfirmation,
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
  supplierCancellationFee,
  reviewRequest,
  supplierNewBooking,
  supplierReserveLater,
  supplierPayLaterCharged,
  supplierBookingChanged,
  supplierContactUpdated,
  supplierPickupUpdated,
  supplierPickupRequired,
  supplierBookingReminder,
  supplierCustomerCancelledFree,
  supplierCustomerCancelledLate,
  supplierPlatformCancelled,
  supplierCancellationRecorded,
  adminCancellationRequest,
  supplierCancellationDecision,
  supplierPayoutScheduled,
  supplierPayoutCompleted,
  supplierPayoutFailed,
  supplierProductSubmitted,
  supplierProductUpdateSubmitted,
  supplierReviewInvite,
  chatNewMessage,
  teamInvite,
  teamInviteRevoked,
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
