// NEW SUPPLIER BOOKING NOTIFICATION TEMPLATE
// Replace the generateSupplierBookingNotificationTemplate function in utils/emailService.js with this

function generateSupplierBookingNotificationTemplate(data) {
  const brandName = 'Travio Africa';
  const brandSubtext = 'by Expedition-Go Tours';
  const logoUrl = process.env.LOGO_URL || '';
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@expeditiongo.com';
  const dashboardUrl = data.dashboardUrl || `${process.env.CLIENT_URL}/supplier/bookings`;
  const year = new Date().getFullYear();

  const html = `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light">
  <title>New Booking Received</title>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      background: #F7FAFC;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #0E224B;
    }
    table {
      border-collapse: collapse;
    }
    img {
      border: 0;
      outline: none;
      text-decoration: none;
      display: block;
      -ms-interpolation-mode: bicubic;
    }
    a {
      text-decoration: none;
    }
    .wrapper {
      width: 100%;
      background: #F7FAFC;
    }
    .container {
      width: 100%;
      max-width: 680px;
      background: #FFFFFF;
      border-radius: 28px;
      overflow: hidden;
      border: 1px solid #E8EEF3;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.06);
    }
    .muted {
      color: #64748B;
    }
    .navy {
      color: #0E224B;
    }
    .green {
      color: #159A5B;
    }
    .soft-green-bg {
      background: #EAF7F1;
    }
    .section-pad {
      padding-left: 34px;
      padding-right: 34px;
    }
    .hero-bg {
      background: linear-gradient(135deg, #E0F2FE 0%, #F0F9FF 100%);
      border-radius: 22px;
      position: relative;
      overflow: hidden;
    }
    .headline {
      margin: 0 0 18px 0;
      font-size: 36px;
      line-height: 1.1;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: #0E224B;
    }
    .body-copy {
      margin: 0;
      font-size: 15px;
      line-height: 1.7;
      color: #64748B;
    }
    .ref-text {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.32px;
      color: #64748B;
      margin: 0 0 8px 0;
    }
    .ref-number {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: 3px;
      font-family: 'Courier New', Courier, monospace;
      color: #0E224B;
      margin: 0;
      word-break: break-all;
    }
    .pill {
      display: inline-block;
      border: 1px solid #B7E4C6;
      background: #DFF4EA;
      border-radius: 999px;
      padding: 6px 16px 6px 12px;
      color: #159A5B;
      font-size: 13px;
      font-weight: 700;
      line-height: 1;
    }
    .detail-card {
      background: #FFFFFF;
      border: 1px solid #E8EEF3;
      border-radius: 22px;
    }
    .detail-row {
      padding: 16px 0;
      border-bottom: 1px solid #F0F0F0;
    }
    .detail-row:last-child {
      border-bottom: none;
    }
    .icon-circle {
      width: 40px;
      height: 40px;
      background: #DFF4EA;
      border-radius: 50%;
      text-align: center;
      vertical-align: middle;
      line-height: 40px;
    }
    .label-text {
      font-size: 11px;
      font-weight: 600;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      margin: 0 0 2px 0;
    }
    .value-text {
      font-size: 15px;
      font-weight: 600;
      color: #0E224B;
      margin: 0;
      line-height: 1.4;
    }
    .total-card {
      background: #DFF4EA;
      border-radius: 20px;
    }
    .total-label {
      font-size: 12px;
      font-weight: 600;
      color: #64748B;
      text-transform: uppercase;
      letter-spacing: 1.44px;
      margin: 0 0 4px 0;
    }
    .total-amount {
      font-size: 32px;
      font-weight: 800;
      color: #0E224B;
      margin: 0;
    }
    .check-circle {
      width: 56px;
      height: 56px;
      background: #159A5B;
      border-radius: 50%;
      text-align: center;
      vertical-align: middle;
      line-height: 56px;
    }
    .cta-button {
      display: inline-block;
      background: #159A5B;
      color: #FFFFFF !important;
      font-size: 15px;
      font-weight: 700;
      padding: 16px 28px;
      border-radius: 14px;
      white-space: nowrap;
    }
    .support-text {
      font-size: 14px;
      color: #64748B;
      margin: 0;
      line-height: 1.5;
    }
    .support-link {
      color: #159A5B;
      text-decoration: none;
      font-weight: 600;
    }
    @media only screen and (max-width: 600px) {
      .section-pad {
        padding-left: 18px !important;
        padding-right: 18px !important;
      }
      .headline {
        font-size: 28px !important;
      }
      .ref-number {
        font-size: 22px !important;
      }
      .detail-row {
        padding: 14px 0 !important;
      }
      .price-stack {
        display: block !important;
        width: 100% !important;
        text-align: center !important;
      }
      .date-time-row {
        display: block !important;
      }
      .date-time-col {
        display: block !important;
        width: 100% !important;
        padding: 0 !important;
        margin-bottom: 16px !important;
      }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F7FAFC;">
  <table role="presentation" class="wrapper" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F7FAFC">
    <tr>
      <td align="center" style="padding:28px 14px;">
        <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF">
          
          <!-- Header -->
          <tr>
            <td class="section-pad" style="padding-top:28px;padding-bottom:20px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="vertical-align:middle;">
                    ${logoUrl ? `<img src="${logoUrl}" alt="${brandName}" style="height:44px;width:auto;">` : `<div style="font-size:32px;font-weight:800;color:#0E224B;letter-spacing:-0.03em;">Travio<span class="green">Africa</span></div>`}
                    <div style="font-size:11px;line-height:1.2;color:#94A3B8;margin-top:4px;font-weight:400;letter-spacing:0.3px;">${brandSubtext}</div>
                  </td>
                  <td align="right" style="vertical-align:middle;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="soft-green-bg" style="border-radius:999px;padding:10px 16px 10px 14px;border:1px solid #DCEFE4;">
                          <span style="font-size:15px;color:#159A5B;vertical-align:middle;">&#128101;</span>
                          <span style="font-size:14px;font-weight:700;color:#0E224B;vertical-align:middle;margin-left:6px;">Supplier</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Hero Section -->
          <tr>
            <td class="section-pad" style="padding-bottom:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hero-bg">
                <tr>
                  <td style="padding:36px 32px;text-align:center;position:relative;">
                    <!-- Decorative plane icon -->
                    <div style="position:absolute;top:20px;right:30px;font-size:48px;opacity:0.15;">✈️</div>
                    
                    <h1 class="headline">New Booking Received</h1>

                    <!-- Status Pill -->
                    <table cellpadding="0" cellspacing="0" style="margin:0 auto 20px;">
                      <tr>
                        <td class="pill">
                          <span style="color:#159A5B;font-size:13px;font-weight:700;">&#x2713;</span>
                          <span style="color:#159A5B;font-size:13px;font-weight:700;letter-spacing:0.3px;margin-left:4px;">Confirmed</span>
                        </td>
                      </tr>
                    </table>

                    <!-- Booking Reference -->
                    <p class="ref-text">BOOKING REFERENCE</p>
                    <p class="ref-number">${data.bookingNumber}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Tour Details Card -->
          <tr>
            <td class="section-pad" style="padding-top:32px;padding-bottom:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="detail-card">
                <tr>
                  <td style="padding:24px 28px;border-bottom:1px solid #E5EEF2;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td style="width:40px;vertical-align:top;">
                          <div class="icon-circle">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                            </svg>
                          </div>
                        </td>
                        <td style="padding-left:14px;vertical-align:middle;">
                          <h2 style="font-size:20px;font-weight:700;color:#0E224B;margin:0 0 4px;">${data.tourTitle}</h2>
                          <p style="font-size:14px;color:#64748B;margin:0;line-height:1.5;">A guest has booked your tour. Details below.</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 28px;">

                    <!-- Customer -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="detail-row">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:40px;vertical-align:top;">
                                <div class="icon-circle">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="padding-left:14px;vertical-align:middle;">
                                <p class="label-text">CUSTOMER</p>
                                <p class="value-text">${data.customerName}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Phone -->
                    ${data.customerPhone ? `
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="detail-row">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:40px;vertical-align:top;">
                                <div class="icon-circle">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="padding-left:14px;vertical-align:middle;">
                                <p class="label-text">PHONE / WHATSAPP</p>
                                <p class="value-text">${data.customerPhone}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>` : ''}

                    <!-- Location -->
                    ${data.customerLocation ? `
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="detail-row">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:40px;vertical-align:top;">
                                <div class="icon-circle">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="padding-left:14px;vertical-align:middle;">
                                <p class="label-text">LOCATION</p>
                                <p class="value-text">${data.customerLocation}</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>` : ''}

                    <!-- Date & Time -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="detail-row">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="date-time-row">
                            <tr>
                              <td class="date-time-col" style="width:50%;vertical-align:top;padding-right:12px;">
                                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                                  <tr>
                                    <td style="width:40px;vertical-align:top;">
                                      <div class="icon-circle">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                                        </svg>
                                      </div>
                                    </td>
                                    <td style="padding-left:14px;vertical-align:middle;">
                                      <p class="label-text">DATE</p>
                                      <p class="value-text">${data.selectedDate}</p>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                              <td class="date-time-col" style="width:50%;vertical-align:top;padding-left:12px;">
                                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                                  <tr>
                                    <td style="width:40px;vertical-align:top;">
                                      <div class="icon-circle">
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                                        </svg>
                                      </div>
                                    </td>
                                    <td style="padding-left:14px;vertical-align:middle;">
                                      <p class="label-text">TIME</p>
                                      <p class="value-text">${data.selectedTime || '06:30 AM'}</p>
                                    </td>
                                  </tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Travelers -->
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td class="detail-row">
                          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                            <tr>
                              <td style="width:40px;vertical-align:top;">
                                <div class="icon-circle">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                                  </svg>
                                </div>
                              </td>
                              <td style="padding-left:14px;vertical-align:middle;">
                                <p class="label-text">TRAVELERS</p>
                                <p class="value-text">${data.travelerCount} guest(s)</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Total Paid Card -->
          <tr>
            <td class="section-pad" style="padding-top:32px;padding-bottom:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="total-card">
                <tr>
                  <td style="padding:24px 28px;vertical-align:middle;" class="price-stack">
                    <p class="total-label">TOTAL PAID</p>
                    <p class="total-amount">${data.currency} ${data.totalAmount}</p>
                  </td>
                  <td style="padding:24px 28px;text-align:right;vertical-align:middle;" class="price-stack">
                    <div class="check-circle">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          <tr>
            <td class="section-pad" style="padding-top:32px;padding-bottom:0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background-color:#159A5B;border-radius:14px;text-align:center;">
                    <a href="${dashboardUrl}" class="cta-button" style="display:block;padding:16px 24px;color:#FFFFFF;font-size:16px;font-weight:600;text-decoration:none;">View in Dashboard &rarr;</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Support -->
          <tr>
            <td class="section-pad" style="padding-top:32px;padding-bottom:28px;text-align:center;">
              <p class="support-text">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#159A5B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;">
                  <path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>
                </svg>
                Need help? Contact <a href="mailto:${supportEmail}" class="support-link">${supportEmail}</a>
              </p>
              <p style="font-size:12px;color:#94A3B8;margin:8px 0 0;">&copy; ${year} ${brandName}. All rights reserved.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `
NEW BOOKING RECEIVED
Ref: ${data.bookingNumber}
Status: Confirmed

${data.tourTitle}
A guest has booked your tour.

Customer: ${data.customerName}
${data.customerPhone ? 'Phone: ' + data.customerPhone : ''}
${data.customerLocation ? 'Location: ' + data.customerLocation : ''}
Date: ${data.selectedDate}
Time: ${data.selectedTime || '06:30 AM'}
Travelers: ${data.travelerCount} guest(s)

Total Paid: ${data.currency} ${data.totalAmount}

View in Dashboard: ${dashboardUrl}

Need help? Contact: ${supportEmail}
© ${year} ${brandName}. All rights reserved.
`;

  return { html, text };
}
