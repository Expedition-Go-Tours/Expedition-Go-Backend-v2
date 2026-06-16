const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

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
    maxTravelersPerBooking: 15,
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
