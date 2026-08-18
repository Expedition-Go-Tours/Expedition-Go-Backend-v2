/**
 * Supplier verification controller — per-document, vehicle and guide
 * verification, plus the admin quality-control dashboard.
 *
 * Admin endpoints are guarded in the router by restrictTo('admin') +
 * requirePermission(...). Supplier endpoints scope everything to the
 * authenticated supplier's profile.
 */

const prisma = require('../utils/prismaClient');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const { logActivity } = require('../utils/auditLogger');
const { enqueueNotification } = require('../utils/queue');
const { notifyAdmin } = require('../utils/adminNotificationService');
const { deleteCloudinaryImage, isValidCloudinaryUrl } = require('../utils/cloudinaryHelper');
const { parseDocuments, parseVehiclePhotos, parseVehicles } = require('../utils/supplierVerification');
const logger = require('../utils/logger');

const DOCUMENT_REPLACEABLE = ['REJECTED', 'REPLACEMENT_REQUESTED', 'EXPIRED'];

async function resolveProfileByUserId(userId) {
  return prisma.supplierProfile.findUnique({ where: { userId } });
}

/** Append a verification history event (used across actions). */
function recordEvent({ supplierProfileId, entityType, entityId, action, actorId = 'SYSTEM', note }) {
  return prisma.verificationEvent.create({
    data: {
      supplierId: supplierProfileId,
      entityType,
      entityId: entityId || null,
      action,
      actorId,
      note: note || null,
    },
  });
}

/** Bring an EXPIRED supplier back to ACTIVE when no approved docs are expired. */
async function maybeRestoreExpiredSupplier(supplierProfileId, actorId) {
  const profile = await prisma.supplierProfile.findUnique({ where: { id: supplierProfileId } });
  if (!profile || profile.status !== 'EXPIRED') return null;

  const expiredCount = await prisma.supplierDocument.count({
    where: { supplierId: supplierProfileId, status: 'EXPIRED' },
  });

  if (expiredCount === 0) {
    const updated = await prisma.supplierProfile.update({
      where: { id: supplierProfileId },
      data: { status: 'ACTIVE' },
    });
    await recordEvent({
      supplierProfileId,
      entityType: 'SUPPLIER',
      entityId: supplierProfileId,
      action: 'STATUS_CHANGE',
      actorId,
      note: 'Supplier reactivated after expired documents were renewed and approved',
    });
    await enqueueNotification({
      userId: profile.userId,
      type: 'SUPPLIER_APPROVED',
      title: 'Account reactivated',
      message: 'Your expired documents have been approved. Your account is active again.',
      data: { supplierId: supplierProfileId },
    }).catch(() => {});
    return updated;
  }
  return null;
}

// ================================
// SUPPLIER-FACING (owner-scoped)
// ================================

const KNOWN_DOCUMENT_TYPES = [
  'GHANA_CARD', 'NATIONAL_ID', 'TOUR_GUIDE_LICENCE', 'DRIVERS_LICENCE',
  'BUSINESS_CERTIFICATE', 'GTA_CERTIFICATE', 'PROOF_OF_ADDRESS', 'PROFILE_PHOTO',
  'PASSENGER_TRANSPORT_LICENCE', 'VEHICLE_REGISTRATION', 'VEHICLE_OWNERSHIP',
  'VEHICLE_ROADWORTHINESS', 'VEHICLE_INSURANCE', 'OTHER',
];

/**
 * POST /suppliers/documents
 * Supplier uploads an additional document for review (not a replacement).
 */
exports.addDocument = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const file = req.file;
  const type = req.body?.type ? String(req.body.type).toUpperCase() : '';
  if (!file || !isValidCloudinaryUrl(file.path)) {
    return next(new AppError('A valid document file is required', 400));
  }
  if (!KNOWN_DOCUMENT_TYPES.includes(type)) {
    return next(new AppError('A valid document type is required', 400));
  }

  const doc = await prisma.supplierDocument.create({
    data: {
      supplierId: profile.id,
      ownerType: 'SUPPLIER',
      ownerId: profile.id,
      type,
      url: file.path,
      filename: file.originalname || null,
      expiryDate: req.body?.expiryDate ? new Date(req.body.expiryDate) : null,
      status: 'PENDING',
    },
  });

  await recordEvent({
    supplierProfileId: profile.id,
    entityType: 'SUPPLIER',
    entityId: doc.id,
    action: 'APPLICATION_UPDATED',
    actorId: req.user.id,
  });

  await notifyAdmin({
    type: 'NEW_SUPPLIER_APPLICATION',
    title: 'New document uploaded',
    message: `A supplier added "${type}" for review.`,
    data: { supplierId: profile.id, documentId: doc.id, documentType: type },
  }).catch(() => {});

  res.status(201).json({ status: 'success', data: { document: doc } });
});

/**
 * POST /suppliers/documents/:docId/replace
 * Supplier re-uploads a rejected / replacement-requested / expired document.
 */
exports.replaceDocument = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const doc = await prisma.supplierDocument.findFirst({
    where: { id: req.params.docId, supplierId: profile.id },
  });
  if (!doc) return next(new AppError('Document not found', 404));

  if (!DOCUMENT_REPLACEABLE.includes(doc.status)) {
    return next(new AppError(`Document cannot be replaced in ${doc.status} status`, 400));
  }

  const file = req.file;
  const newUrl = file?.path;
  if (!newUrl || !isValidCloudinaryUrl(newUrl)) {
    return next(new AppError('A valid document file is required', 400));
  }

  if (doc.url && doc.url !== newUrl) {
    deleteCloudinaryImage(doc.url, 3, { userId: req.user.id }).catch((err) =>
      logger.warn('[supplier] delete replaced document failed:', err?.message));
  }

  const updated = await prisma.supplierDocument.update({
    where: { id: doc.id },
    data: { url: newUrl, filename: file.originalname || null, status: 'PENDING', reviewNote: null },
  });

  await recordEvent({
    supplierProfileId: profile.id,
    entityType: 'SUPPLIER',
    entityId: doc.id,
    action: 'REPLACEMENT_UPLOADED',
    actorId: req.user.id,
  });

  await notifyAdmin({
    type: 'NEW_SUPPLIER_APPLICATION',
    title: 'Document re-uploaded',
    message: `A supplier re-uploaded document "${doc.type}".`,
    data: { supplierId: profile.id, documentId: doc.id, documentType: doc.type },
  }).catch(() => {});

  res.status(200).json({ status: 'success', data: { document: updated } });
});

/**
 * POST /suppliers/vehicles — add a vehicle (+ documents/photos).
 */
exports.addVehicle = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));
  if (!['PENDING', 'UNDER_REVIEW'].includes(profile.status)) {
    return next(new AppError(`Vehicles cannot be added in ${profile.status} status`, 400));
  }

  const vehicles = parseVehicles(req.body);
  const vehiclePhotos = parseVehiclePhotos(req);
  const documents = parseDocuments(req);

  await prisma.$transaction(async (tx) => {
    // Create the vehicle and return its id so documents can link to it.
    for (const v of vehicles) {
      const created = await tx.vehicle.create({
        data: {
          supplierId: profile.id,
          make: v.make,
          model: v.model,
          year: v.year || null,
          registrationNumber: v.registrationNumber,
          photos: vehiclePhotos[v.key] || [],
          status: 'PENDING',
        },
      });
      for (const d of documents) {
        if (d.ownerType === 'VEHICLE' && d.ownerKey === v.key) {
          await tx.supplierDocument.create({
            data: {
              supplierId: profile.id,
              ownerType: 'VEHICLE',
              ownerId: created.id,
              type: d.type,
              url: d.url,
              filename: d.filename || null,
              expiryDate: d.expiryDate || null,
              status: 'PENDING',
            },
          });
        }
      }
    }
  });

  await recordEvent({
    supplierProfileId: profile.id,
    entityType: 'VEHICLE',
    action: 'APPLICATION_UPDATED',
    actorId: req.user.id,
  });

  res.status(201).json({ status: 'success', message: 'Vehicle added successfully' });
});

/**
 * PATCH /suppliers/vehicles/:vehicleId — edit vehicle metadata (no docs).
 */
exports.updateVehicle = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.vehicleId, supplierId: profile.id },
  });
  if (!vehicle) return next(new AppError('Vehicle not found', 404));

  const { make, model, year, registrationNumber } = req.body;
  const data = {};
  if (make !== undefined) data.make = String(make);
  if (model !== undefined) data.model = String(model);
  if (year !== undefined) data.year = year ? parseInt(year, 10) : null;
  if (registrationNumber !== undefined) data.registrationNumber = String(registrationNumber);

  const updated = await prisma.vehicle.update({ where: { id: vehicle.id }, data });
  res.status(200).json({ status: 'success', data: { vehicle: updated } });
});

/**
 * DELETE /suppliers/vehicles/:vehicleId — remove an unverified vehicle.
 */
exports.deleteVehicle = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const vehicle = await prisma.vehicle.findFirst({
    where: { id: req.params.vehicleId, supplierId: profile.id },
    include: { _count: { select: { documents: true } } },
  });
  if (!vehicle) return next(new AppError('Vehicle not found', 404));

  // Delete Cloudinary photos before removing the row.
  (vehicle.photos || []).forEach((url) =>
    deleteCloudinaryImage(url, 3, { userId: req.user.id }).catch(() => {}));

  await prisma.vehicle.delete({ where: { id: vehicle.id } });
  res.status(200).json({ status: 'success', message: 'Vehicle removed' });
});

/**
 * POST /suppliers/guides — add a guide.
 */
exports.addGuide = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const { fullName, phone, email } = req.body;
  if (!fullName) return next(new AppError('Guide full name is required', 400));

  const guide = await prisma.guide.create({
    data: {
      supplierId: profile.id,
      fullName: String(fullName),
      phone: phone ? String(phone) : null,
      email: email ? String(email) : null,
      status: 'PENDING',
    },
  });

  res.status(201).json({ status: 'success', data: { guide } });
});

/**
 * PATCH /suppliers/guides/:guideId
 */
exports.updateGuide = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const guide = await prisma.guide.findFirst({
    where: { id: req.params.guideId, supplierId: profile.id },
  });
  if (!guide) return next(new AppError('Guide not found', 404));

  const { fullName, phone, email } = req.body;
  const data = {};
  if (fullName !== undefined) data.fullName = String(fullName);
  if (phone !== undefined) data.phone = phone ? String(phone) : null;
  if (email !== undefined) data.email = email ? String(email) : null;

  const updated = await prisma.guide.update({ where: { id: guide.id }, data });
  res.status(200).json({ status: 'success', data: { guide: updated } });
});

/**
 * DELETE /suppliers/guides/:guideId
 */
exports.deleteGuide = catchAsync(async (req, res, next) => {
  const profile = await resolveProfileByUserId(req.supplierId || req.user.id);
  if (!profile) return next(new AppError('No supplier application found', 404));

  const guide = await prisma.guide.findFirst({
    where: { id: req.params.guideId, supplierId: profile.id },
  });
  if (!guide) return next(new AppError('Guide not found', 404));

  await prisma.guide.delete({ where: { id: guide.id } });
  res.status(200).json({ status: 'success', message: 'Guide removed' });
});

// ================================
// ADMIN (review)
// ================================

/**
 * GET /suppliers/admin/:id/verification — all documents + vehicles + guides + history.
 */
exports.getSupplierVerification = catchAsync(async (req, res, next) => {
  const profile = await prisma.supplierProfile.findUnique({
    where: { id: req.params.id },
    include: {
      documents: { orderBy: { createdAt: 'asc' } },
      vehicles: { orderBy: { createdAt: 'asc' } },
      guides: { orderBy: { createdAt: 'asc' } },
      verificationEvents: { orderBy: { createdAt: 'desc' }, take: 100 },
    },
  });
  if (!profile) return next(new AppError('Supplier not found', 404));

  res.status(200).json({
    status: 'success',
    data: {
      supplierType: profile.supplierType,
      documents: profile.documents,
      vehicles: profile.vehicles,
      guides: profile.guides,
      history: profile.verificationEvents,
    },
  });
});

/**
 * PATCH /suppliers/admin/documents/:docId — approve / reject / request_replacement.
 */
exports.reviewDocument = catchAsync(async (req, res, next) => {
  const { action, note, expiryDate } = req.body;
  if (!['approve', 'reject', 'request_replacement'].includes(action)) {
    return next(new AppError('action must be approve, reject, or request_replacement', 400));
  }
  if (['reject', 'request_replacement'].includes(action) && !note) {
    return next(new AppError('A note is required for this action', 400));
  }

  const doc = await prisma.supplierDocument.findUnique({
    where: { id: req.params.docId },
    include: { supplier: { select: { id: true, userId: true, status: true } } },
  });
  if (!doc) return next(new AppError('Document not found', 404));

  const statusMap = {
    approve: 'APPROVED',
    reject: 'REJECTED',
    request_replacement: 'REPLACEMENT_REQUESTED',
  };

  const updated = await prisma.supplierDocument.update({
    where: { id: doc.id },
    data: {
      status: statusMap[action],
      reviewNote: note || null,
      reviewedBy: req.user.id,
      reviewedAt: new Date(),
      expiryDate: action === 'approve' && expiryDate ? new Date(expiryDate) : doc.expiryDate,
    },
  });

  await recordEvent({
    supplierProfileId: doc.supplierId,
    entityType: 'SUPPLIER',
    entityId: doc.id,
    action: action === 'request_replacement' ? 'REPLACEMENT_REQUESTED' : statusMap[action],
    actorId: req.user.id,
    note: note || undefined,
  });

  // Notify supplier
  const supplierUser = doc.supplier.userId;
  await prisma.user.findUnique({ where: { id: supplierUser } }).then((user) => {
    if (!user) return null;
    return enqueueNotification({
      userId: user.id,
      type: action === 'reject' ? 'DOCUMENT_REJECTED' : 'SYSTEM_ALERT',
      title: action === 'reject' ? 'Document rejected' : action === 'request_replacement' ? 'Document requires replacement' : 'Document approved',
      message: action === 'reject'
        ? (note || 'A document was rejected. Please upload a replacement.')
        : action === 'request_replacement'
          ? (note || 'Please upload a clearer copy of a document.')
          : 'A document was approved.',
      data: { documentId: doc.id, documentType: doc.type },
    });
  }).catch(() => {});

  // If this approval clears all expired documents, reactivate the supplier.
  if (action === 'approve') {
    await maybeRestoreExpiredSupplier(doc.supplierId, req.user.id);
  }

  await logActivity({
    userId: req.user.id,
    action: `supplier.document.${action === 'request_replacement' ? 'request_replacement' : action}`,
    resource: 'SupplierDocument',
    resourceId: doc.id,
    metadata: { action, supplierId: doc.supplierId },
  });

  res.status(200).json({ status: 'success', data: { document: updated } });
});

/**
 * PATCH /suppliers/admin/vehicles/:vehicleId — verify / reject a vehicle.
 */
exports.reviewVehicle = catchAsync(async (req, res, next) => {
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return next(new AppError('action must be approve or reject', 400));
  }
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: req.params.vehicleId },
    include: { supplier: { select: { id: true } } },
  });
  if (!vehicle) return next(new AppError('Vehicle not found', 404));

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      status: action === 'approve' ? 'VERIFIED' : 'REJECTED',
      reviewNote: note || null,
    },
  });

  await recordEvent({
    supplierProfileId: vehicle.supplierId,
    entityType: 'VEHICLE',
    entityId: vehicle.id,
    action: action === 'approve' ? 'APPROVED' : 'REJECTED',
    actorId: req.user.id,
    note: note || undefined,
  });

  res.status(200).json({ status: 'success', data: { vehicle: updated } });
});

/**
 * PATCH /suppliers/admin/guides/:guideId — verify / reject a guide.
 */
exports.reviewGuide = catchAsync(async (req, res, next) => {
  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return next(new AppError('action must be approve or reject', 400));
  }
  const guide = await prisma.guide.findUnique({
    where: { id: req.params.guideId },
    include: { supplier: { select: { id: true } } },
  });
  if (!guide) return next(new AppError('Guide not found', 404));

  const updated = await prisma.guide.update({
    where: { id: guide.id },
    data: {
      status: action === 'approve' ? 'VERIFIED' : 'REJECTED',
      reviewNote: note || null,
    },
  });

  await recordEvent({
    supplierProfileId: guide.supplierId,
    entityType: 'GUIDE',
    entityId: guide.id,
    action: action === 'approve' ? 'APPROVED' : 'REJECTED',
    actorId: req.user.id,
    note: note || undefined,
  });

  res.status(200).json({ status: 'success', data: { guide: updated } });
});

/**
 * GET /suppliers/admin/qc-dashboard — aggregate quality-control counts.
 */
exports.getQcDashboard = catchAsync(async (req, res) => {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const inDays = (n) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  const [
    statusCounts,
    newThisWeek,
    docCounts,
    expiring60,
    expiring30,
    expiring7,
    expiredDocs,
    guideCounts,
    vehicleCounts,
  ] = await Promise.all([
    prisma.supplierProfile.groupBy({ by: ['status'], _count: true }),
    prisma.supplierProfile.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.supplierDocument.groupBy({ by: ['status'], _count: true }),
    prisma.supplierDocument.count({
      where: { status: 'APPROVED', expiryDate: { gte: now, lte: inDays(60) } },
    }),
    prisma.supplierDocument.count({
      where: { status: 'APPROVED', expiryDate: { gte: now, lte: inDays(30) } },
    }),
    prisma.supplierDocument.count({
      where: { status: 'APPROVED', expiryDate: { gte: now, lte: inDays(7) } },
    }),
    prisma.supplierDocument.count({ where: { status: 'EXPIRED' } }),
    prisma.guide.groupBy({ by: ['status'], _count: true }),
    prisma.vehicle.groupBy({ by: ['status'], _count: true }),
  ]);

  const byStatus = (rows) => Object.fromEntries(rows.map((r) => [r.status, r._count]));
  const supplier = byStatus(statusCounts);
  const documents = byStatus(docCounts);
  const guides = byStatus(guideCounts);
  const vehicles = byStatus(vehicleCounts);

  const businessesAwaiting =
    await prisma.supplierProfile.count({
      where: {
        status: { in: ['PENDING', 'UNDER_REVIEW'] },
        supplierType: { in: ['TOUR_COMPANY', 'TRANSPORTATION_PROVIDER', 'VEHICLE_OPERATOR'] },
      },
    });

  res.status(200).json({
    status: 'success',
    data: {
      newRegistrationsThisWeek: newThisWeek,
      pendingVerification: (supplier.PENDING || 0) + (supplier.UNDER_REVIEW || 0),
      pending: supplier.PENDING || 0,
      underReview: supplier.UNDER_REVIEW || 0,
      documentsAwaitingReview: documents.PENDING || 0,
      documentStatuses: documents,
      approvedSuppliers: (supplier.APPROVED || 0) + (supplier.ACTIVE || 0),
      rejected: supplier.REJECTED || 0,
      suspended: supplier.SUSPENDED || 0,
      expiredSuppliers: supplier.EXPIRED || 0,
      expiredDocuments: expiredDocs,
      expiringSoon: { within60: expiring60, within30: expiring30, within7: expiring7 },
      guidesAwaitingVerification: guides.PENDING || 0,
      businessesAwaitingVerification: businessesAwaiting,
      vehiclesAwaitingVerification: vehicles.PENDING || 0,
    },
  });
});

module.exports = exports;