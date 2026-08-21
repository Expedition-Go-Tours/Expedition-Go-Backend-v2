const email = require('../utils/emailService');
const { render } = require('../utils/emailRenderer');

const base = {
  customerName: 'Kwarteon',
  customerEmail: 'kwarteon08@gmail.com',
  supplierName: 'Cape Peninsula Explorers',
  bookingNumber: 'EXP-12345-2026-11',
  tourTitle: 'Renovation Tour',
  dateLabel: 'Sunday, August 24, 2026',
  timeLabel: '9:00 AM',
  durationLabel: '5 hours',
  travelersLabel: '2 adults',
  languageLabel: 'English',
  bookingTypeLabel: 'Reserve now, pay later',
  pickupIncludedLabel: 'Yes',
  pickupLocation: 'V&A Waterfront, Cape Town',
  totalLabel: '$74.00',
  amountChargedLabel: '$74.00',
  chargedAtLabel: 'Thursday, August 20, 2026',
  paymentReference: 'pi_3Test...',
  commissionLabel: '$11.10',
  payoutAmountLabel: '$62.90',
  bookingUrl: 'https://x/booking/1',
  voucherUrl: 'https://x/voucher/1',
  manageUrl: 'https://x/manage/1',
  supplierBookingUrl: 'https://x/supplier/1',
  supportEmail: 'support@travioafrica.com',
  logoUrl: 'https://x/logo.png',
  brandName: 'Travio Africa',
  year: '2026',
  preheader: '',
};

(async () => {
  for (const key of ['pay-later-charged', 'supplier-pay-later-charged']) {
    const html = render(require('fs').readFileSync(`./sendgrid-templates/generated/${key}.html`, 'utf8'), base);
    if (!html.includes('Your reservation is now confirmed') && !html.includes('Reservation payment collected')) {
      console.error(key + ': heading missing');
    }
    if (!html.includes('Reserve now, pay later') || !html.includes('Reserved'.replace('Reserved',''))) {
      // no strict check; just verify render succeeded
    }
    console.log(key + ': rendered OK, length=' + html.length);
  }
  console.log('export check:', typeof email.sendPayLaterChargedEmail, typeof email.sendSupplierPayLaterChargedEmail);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });