/**
 * Email template preview — renders one compiled template with realistic sample
 * data and writes a standalone HTML file you can open in a browser. No email
 * is sent and no DB/queue is touched.
 *
 * Usage:
 *   node scripts/preview-email-template.js supplier-reserve-later
 *   node scripts/preview-email-template.js booking-confirmed
 *
 * The output path is printed on the last line.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TEMPLATE_DEFS } = require('./buildEmailTemplates');
const { render } = require('../src/core/services/emailRenderer');

const OUT_DIR = path.join(os.tmpdir(), 'opencode');

// Shell vars — mirror resolveShellVars() for the Ghana brand.
const SHELL = {
  brandName: 'Travio Ghana',
  supportEmail: 'support@travioghana.com',
  logoUrl: 'https://res.cloudinary.com/dfpagrtoy/image/upload/v1789926536/TravioG_csfsyl.png',
  poweredByLabel: '',
  year: new Date().getFullYear(),
  preheader: 'New reservation TRG-48808538-2026-11, payment pending',
};

// A fully-populated sample booking so every conditional row renders.
const SAMPLE = {
  // identity / links
  bookingNumber: 'TRG-48808538-2026-11',
  supplierReference: '',
  brandName: 'Travio Ghana',
  customerName: 'My Pascaline',
  customerInitials: 'MP',
  // Google OAuth avatar (User.photoURL) — the contact card prefers this and
  // falls back to the initials circle above when it's empty.
  customerAvatarUrl:
    'https://lh3.googleusercontent.com/a/ACg8ocIDHfos_zC5JpkJMBLqkhgh4YIwiKORGVBRCyRMs4-JA5XhNtOkMg=s192-c',
  customerEmail: 'pasci231@gmail.com',
  customerPhone: '+27 82 555 0142',
  supplierName: 'Expedition Go Travel and Tours Ltd',

  // lead traveler (the person going on the trip)
  leadTravelerName: 'My Pascaline',
  leadTravelerEmail: 'pasci231@gmail.com',
  leadTravelerPhone: '+27 82 555 0142',

  // experience
  tourTitle: 'Accra Flying Dress Experience',
  tourImageUrl:
    'https://res.cloudinary.com/dfpagrtoy/image/upload/c_fill,g_auto,w_1200,h_520/v1787749419/user-photos/f7k7m3eeasci5xgt0csk.png',
  dateLabel: 'Wed, 4 Nov 2026',
  experienceDateLabel: 'Wed, 4 Nov 2026',
  timeLabel: '09:00',
  durationLabel: '6 hours',
  languageLabel: 'English',
  travelersLabel: '2 adults, 1 child',
  bookingTypeLabel: 'Reserve now, pay later',
  specialRequirements: 'Vegetarian meals for all travellers, please.',

  // pickup
  pickupRequiredLabel: 'Yes',
  pickupIncludedLabel: 'Yes',
  pickupLocation: 'Kempinski Hotel Gold Coast City, Accra',
  pickupTime: '08:15',
  meetingPoint: 'Kempinski Hotel lobby',
  meetingTime: '08:30',
  directionsUrl: 'https://www.google.com/maps/dir/?api=1&destination=Kempinski%20Hotel%20lobby',

  // money
  totalLabel: '$385.00',
  commissionLabel: '$57.75',
  payoutAmountLabel: '$327.25',
  amountPaidLabel: '$385.00',
  amountPaidTodayLabel: '$0.00',
  scheduledPaymentLabel: '$385.00',
  paymentAmountLabel: '$385.00',
  paymentMethodLabel: 'Visa •••• 4242',
  paymentStatusLabel: 'Pending',

  // pay-later timing
  chargeDateLabel: 'Tue, 3 Nov 2026',
  chargeAtLabel: 'Tue, 3 Nov 2026, 00:15 GMT',
  bookedAtLabel: '9 Oct 2026',
  cancellationPolicyText: 'Free cancellation up to 24 hours before your experience.',
  cancelDeadlineLabel: 'November 3, 2026, 9:00 AM',

  // links
  bookingUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau',
  manageUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/manage',
  managePaymentUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/payment',
  voucherUrl: 'https://travioghana.com/bookings/cmv2v1rxj0200i4nqlq9n1fau/voucher',
  supplierBookingUrl: 'https://supplier.travioghana.com/bookings?bookingId=cmv2v1rxj0200i4nqlq9n1fau',
  dashboardUrl: 'https://supplier.travioghana.com/',
};

function main() {
  const key = process.argv[2] || 'supplier-reserve-later';
  const def = TEMPLATE_DEFS.find((d) => d.key === key);
  if (!def) {
    console.error(`Unknown template key: ${key}`);
    console.error(`Known keys: ${TEMPLATE_DEFS.map((d) => d.key).join(', ')}`);
    process.exit(1);
  }

  const data = { ...SHELL, ...SAMPLE };
  const html = render(def.build(data), data);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `${key}-preview.html`);
  fs.writeFileSync(out, html, 'utf-8');

  console.log(`[Preview] ${key} → ${out}`);
  return out;
}

main();
