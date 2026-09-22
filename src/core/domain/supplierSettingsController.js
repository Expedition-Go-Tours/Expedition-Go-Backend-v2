const prisma = require('../services/prismaClient');
const catchAsync = require('../services/catchAsync');
const AppError = require('../services/appError');
const notificationRecipientService = require('../services/notificationRecipientService');
const { renderNotificationRecipientPage } = require('../services/notificationRecipientPage');
const { sendNotificationRecipientVerificationEmail } = require('../services/emailService');
const { logActivity } = require('../services/auditLogger');
const { getBrandEmail } = require('../../../config/brands');
const emailUrls = require('../../../config/emailUrls');

/**
 * Brand context for the public result page. The recipient is not a dashboard
 * user, so the page is branded from the supplier's account.
 */
async function resultPageContext(supplierId) {
  const fallbackEmail = getBrandEmail('africa');
  const fallback = {
    brandName: fallbackEmail.brandName,
    logoUrl: fallbackEmail.logoUrl,
    supportEmail: fallbackEmail.supportEmail,
    supplierName: '',
    dashboardUrl: '',
  };
  if (!supplierId) return fallback;

  const user = await prisma.user.findUnique({
    where: { id: supplierId },
    select: { name: true, roles: true },
  });
  if (!user) return fallback;

  const roles = Array.isArray(user.roles) ? user.roles : [];
  const emailBrand = getBrandEmail(roles.includes('ghana') ? 'ghana' : 'africa');
  return {
    brandName: emailBrand.brandName,
    logoUrl: emailBrand.logoUrl,
    supportEmail: emailBrand.supportEmail,
    supplierName: user.name || '',
    dashboardUrl: emailUrls.supplierNotificationSettings(user),
  };
}

exports.getBusinessProfile = catchAsync(async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
    select: { businessInfo: true, operatingInfo: true }
  });

  res.status(200).json({
    status: 'success',
    data: {
      businessInfo: profile?.businessInfo || {},
      operatingInfo: profile?.operatingInfo || {},
    },
  });
});

exports.updateBusinessProfile = catchAsync(async (req, res, next) => {
  const { businessInfo, operatingInfo } = req.body;

  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
  });

  if (!profile) {
    return next(new AppError('Supplier profile not found', 404));
  }

  const updated = await prisma.supplierProfile.update({
    where: { userId: req.supplierId },
    data: {
      businessInfo: businessInfo ? { ...(profile.businessInfo || {}), ...businessInfo } : undefined,
      operatingInfo: operatingInfo ? { ...(profile.operatingInfo || {}), ...operatingInfo } : undefined,
    },
  });

  res.status(200).json({
    status: 'success',
    data: {
      businessInfo: updated.businessInfo,
      operatingInfo: updated.operatingInfo,
    },
  });
});

exports.getNotificationPreferences = catchAsync(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { notificationPreferences: true },
  });

  const defaults = {
    emailNotifications: { bookings: true, reviews: true, payments: true, systemAlerts: true },
    pushNotifications: { bookings: true, reviews: true, payments: true, systemAlerts: true },
  };

  res.status(200).json({
    status: 'success',
    data: user?.notificationPreferences || defaults,
  });
});

exports.updateNotificationPreferences = catchAsync(async (req, res, next) => {
  const { emailNotifications, pushNotifications } = req.body;

  if (!emailNotifications && !pushNotifications) {
    return next(new AppError('Provide emailNotifications or pushNotifications', 400));
  }

  const existing = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { notificationPreferences: true },
  });

  const current = existing?.notificationPreferences || {};

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      notificationPreferences: {
        ...current,
        ...(emailNotifications && { emailNotifications }),
        ...(pushNotifications && { pushNotifications }),
      },
    },
    select: { notificationPreferences: true },
  });

  res.status(200).json({
    status: 'success',
    data: updated.notificationPreferences,
  });
});

exports.getTaxInfo = catchAsync(async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
    select: { businessDocuments: true, compliance: true },
  });

  res.status(200).json({
    status: 'success',
    data: {
      taxInfo: profile?.compliance?.taxInfo || {},
      documents: profile?.businessDocuments || {},
    },
  });
});

exports.updateTaxInfo = catchAsync(async (req, res, next) => {
  const { taxId, taxCountry, legalBusinessName, businessType } = req.body;

  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
  });

  if (!profile) {
    return next(new AppError('Supplier profile not found', 404));
  }

  const currentCompliance = profile.compliance || {};
  const currentBusinessInfo = profile.businessInfo || {};

  const updated = await prisma.supplierProfile.update({
    where: { userId: req.supplierId },
    data: {
      compliance: {
        ...currentCompliance,
        taxInfo: {
          ...(currentCompliance.taxInfo || {}),
          taxId,
          taxCountry,
          legalBusinessName,
          businessType,
        },
      },
      businessInfo: {
        ...currentBusinessInfo,
        ...(legalBusinessName && { legalBusinessName }),
        ...(businessType && { businessType }),
      },
    },
  });

  res.status(200).json({
    status: 'success',
    data: {
      taxInfo: updated.compliance?.taxInfo || {},
      documents: updated.businessDocuments || {},
    },
  });
});

exports.getBookingRules = catchAsync(async (req, res) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
    select: { operatingInfo: true },
  });

  const defaults = {
    confirmationType: 'INSTANT',
    maxParticipants: 15,
    minAdvanceHours: 24,
    maxAdvanceDays: 365,
    cancellationPolicy: 'Free cancellation up to 24 hours before start time',
    cancellationWindowHours: 24,
  };

  res.status(200).json({
    status: 'success',
    data: profile?.operatingInfo?.bookingRules || defaults,
  });
});

exports.updateBookingRules = catchAsync(async (req, res, next) => {
  const rules = req.body;

  const profile = await prisma.supplierProfile.findUnique({
    where: { userId: req.supplierId },
  });

  if (!profile) {
    return next(new AppError('Supplier profile not found', 404));
  }

  const currentOperating = profile.operatingInfo || {};

  const updated = await prisma.supplierProfile.update({
    where: { userId: req.supplierId },
    data: {
      operatingInfo: {
        ...currentOperating,
        bookingRules: {
          ...(currentOperating.bookingRules || {}),
          ...rules,
        },
      },
    },
  });

  res.status(200).json({
    status: 'success',
    data: updated.operatingInfo?.bookingRules || {},
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Additional notification email addresses
// ─────────────────────────────────────────────────────────────────────────────

exports.listNotificationRecipients = catchAsync(async (req, res) => {
  const recipients = await notificationRecipientService.listRecipients(req.supplierId);
  res.status(200).json({ status: 'success', data: { recipients } });
});

exports.addNotificationRecipient = catchAsync(async (req, res) => {
  const { email, name, preferences } = req.body;
  const { record, rawToken } = await notificationRecipientService.addRecipient(
    req.supplierId,
    { email, name, preferences },
    req.user?.id,
  );

  const supplier = await prisma.user.findUnique({
    where: { id: req.supplierId },
    select: { name: true, roles: true },
  });

  try {
    await sendNotificationRecipientVerificationEmail({
      to: record.email,
      supplierName: supplier?.name || 'your supplier account',
      verifyUrl: emailUrls.supplierNotificationRecipientVerifyForUser(supplier, rawToken),
      types: notificationRecipientService.enabledTypeLabels(record.preferences),
    });
  } catch (err) {
    // Keep the row (the admin can resend) but surface the delivery failure.
    console.error('[NotificationRecipient] verification email failed:', err.message);
  }

  logActivity({
    userId: req.user?.id,
    action: 'notification_recipient.added',
    resource: 'SupplierNotificationRecipient',
    resourceId: record.id,
    metadata: { supplierId: req.supplierId, email: record.email },
  }).catch(() => {});

  res.status(201).json({ status: 'success', data: { recipient: record } });
});

exports.updateNotificationRecipient = catchAsync(async (req, res) => {
  const { name, preferences } = req.body;
  const recipient = await notificationRecipientService.updateRecipient(
    req.supplierId,
    req.params.id,
    { name, preferences },
  );
  res.status(200).json({ status: 'success', data: { recipient } });
});

exports.resendNotificationRecipient = catchAsync(async (req, res) => {
  const { record, rawToken } = await notificationRecipientService.resendVerification(
    req.supplierId,
    req.params.id,
  );

  const supplier = await prisma.user.findUnique({
    where: { id: req.supplierId },
    select: { name: true, roles: true },
  });

  await sendNotificationRecipientVerificationEmail({
    to: record.email,
    supplierName: supplier?.name || 'your supplier account',
    verifyUrl: emailUrls.supplierNotificationRecipientVerifyForUser(supplier, rawToken),
    types: notificationRecipientService.enabledTypeLabels(record.preferences),
  });

  res.status(200).json({ status: 'success', data: { recipient: record } });
});

exports.removeNotificationRecipient = catchAsync(async (req, res) => {
  const removed = await notificationRecipientService.removeRecipient(req.supplierId, req.params.id);

  logActivity({
    userId: req.user?.id,
    action: 'notification_recipient.removed',
    resource: 'SupplierNotificationRecipient',
    resourceId: removed.id,
    metadata: { supplierId: req.supplierId },
  }).catch(() => {});

  res.status(200).json({ status: 'success' });
});

// Public — the emailed token is the credential. Renders a standalone result
// page; the recipient is not a dashboard user, so we never send them to a login.
exports.verifyNotificationRecipient = catchAsync(async (req, res) => {
  const token = String(req.query.token || '');
  const known = await notificationRecipientService.findByRawToken(token);

  let state = 'invalid';
  let recipient = known;
  if (known) {
    const expired = known.tokenExpiresAt && new Date(known.tokenExpiresAt).getTime() < Date.now();
    if (known.status === 'VERIFIED') {
      state = 'verified';
    } else if (expired) {
      state = 'expired';
    } else {
      try {
        recipient = await notificationRecipientService.verifyByToken(token);
        state = 'verified';
      } catch (err) {
        state = err?.statusCode === 410 ? 'expired' : 'invalid';
      }
    }
  }

  const ctx = await resultPageContext(recipient?.supplierId);
  const types = state === 'verified'
    ? notificationRecipientService.enabledTypeLabels(recipient?.preferences)
    : [];
  const html = renderNotificationRecipientPage({
    state,
    ...ctx,
    recipientEmail: recipient?.email || '',
    types,
  });
  res.status(200).type('html').send(html);
});

// Public — signed token opts a single address out of every category.
exports.unsubscribeNotificationRecipient = catchAsync(async (req, res) => {
  const { id, token } = req.query;
  let state = 'invalid';
  let recipient = null;
  if (id && notificationRecipientService.verifyUnsubscribeToken(id, token)) {
    try {
      recipient = await notificationRecipientService.unsubscribeById(id);
      state = 'unsubscribed';
    } catch {
      state = 'invalid';
    }
  }
  const ctx = await resultPageContext(recipient?.supplierId);
  const html = renderNotificationRecipientPage({
    state,
    ...ctx,
    recipientEmail: recipient?.email || '',
  });
  res.status(200).type('html').send(html);
});
