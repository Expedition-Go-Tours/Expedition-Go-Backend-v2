/**
 * Stays verification — accommodation-specific KYC, deliberately separate from
 * the tour/experience supplier application. A supplier can be verified for
 * tours and still owe accommodation documents (and vice versa).
 */

const prisma = require('../../core/services/prismaClient');
const AppError = require('../../core/services/appError');
const catchAsync = require('../../core/services/catchAsync');
const { supplierIdFor, objectOrEmpty } = require('./staysShared');

const GRACE_DAYS = 30;

const DEFAULT_REQUIREMENTS = {
  documents: [
    {
      type: 'GHANA_CARD',
      label: 'Ghana Card',
      detail: 'Upload one Ghana Card, passport or another accepted government-issued ID. Your details should match the information on your profile.',
      required: true,
      timing: 'upfront',
      enforced: true,
    },
    {
      type: 'BUSINESS_CERTIFICATE',
      label: 'Business registration certificate',
      detail: 'Upload your business registration certificate so we can confirm the business behind this supplier account.',
      required: true,
      timing: 'upfront',
      enforced: true,
    },
    {
      type: 'GTA_CERTIFICATE',
      label: 'Ghana Tourism Authority certificate',
      detail: 'Required for accommodation providers before your property becomes bookable.',
      required: true,
      timing: 'later',
      enforced: false,
    },
    {
      type: 'PROOF_OF_ADDRESS',
      label: 'Proof of address',
      detail: 'A recent utility bill or bank statement in the business name.',
      required: true,
      timing: 'later',
      enforced: false,
    },
  ],
  propertyDocuments: [
    {
      type: 'PROPERTY_OWNERSHIP',
      label: 'Ownership or lease',
      detail: 'Ownership document or lease agreement for the property.',
      required: true,
      timing: 'per_property',
      ownerType: 'PROPERTY',
    },
    {
      type: 'GTA_PROPERTY_CERTIFICATE',
      label: 'Property GTA certificate',
      detail: 'The GTA classification certificate for this property.',
      required: true,
      timing: 'per_property',
      ownerType: 'PROPERTY',
    },
    {
      type: 'UTILITY_BILL',
      label: 'Utility bill',
      detail: 'A recent utility bill showing the property address.',
      required: true,
      timing: 'per_property',
      ownerType: 'PROPERTY',
    },
  ],
  properties: 'required',
  vehicles: 'hidden',
  guides: 'hidden',
  documentationGraceDays: GRACE_DAYS,
  documentationDeadline: null,
};

const DOCUMENT_TYPES = new Set(DEFAULT_REQUIREMENTS.documents.map((doc) => doc.type)
  .concat(DEFAULT_REQUIREMENTS.propertyDocuments.map((doc) => doc.type))
  .concat([
    'NATIONAL_ID',
    'PROFILE_PHOTO',
    'OTHER',
  ]));

function serializeDocument(document) {
  return {
    id: document.id,
    type: document.type,
    ownerType: document.ownerType,
    ownerId: document.ownerId,
    status: document.status,
    url: document.url || '',
    fileName: document.fileName || '',
    expiryDate: document.expiryDate,
    reviewNote: document.reviewNote || null,
    uploadedAt: document.uploadedAt,
  };
}

async function getOrCreateProfile(supplierId) {
  let profile = await prisma.stayVerificationProfile.findUnique({ where: { supplierId } });
  if (!profile) {
    profile = await prisma.stayVerificationProfile.create({
      data: {
        supplierId,
        status: 'PENDING',
        documentationDeadline: new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000),
        requirements: DEFAULT_REQUIREMENTS,
      },
    });
  }
  return profile;
}

exports.getVerification = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  const profile = await getOrCreateProfile(supplierId);

  const [documents, properties] = await Promise.all([
    prisma.stayVerificationDocument.findMany({
      where: { supplierId },
      orderBy: { uploadedAt: 'desc' },
    }),
    prisma.stayProperty.findMany({
      where: { supplierId, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true, city: true, status: true, data: true },
      orderBy: { updatedAt: 'desc' },
    }),
  ]);

  const requirements = {
    ...(objectOrEmpty(profile.requirements).documents ? profile.requirements : DEFAULT_REQUIREMENTS),
    documentationDeadline: profile.documentationDeadline,
  };

  res.status(200).json({
    status: 'success',
    data: {
      profile: {
        supplierType: 'ACCOMMODATION_PROVIDER',
        documents: documents.map(serializeDocument),
        properties: properties.map((property) => ({
          id: property.id,
          name: property.name,
          city: property.city || objectOrEmpty(property.data).city || '',
          region: objectOrEmpty(property.data).region || '',
          status: property.status === 'ACTIVE' ? 'VERIFIED' : 'PENDING',
        })),
      },
      requirements,
    },
  });
});

exports.addDocument = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  if (!req.file) throw new AppError('Attach the document file', 400);

  const type = typeof req.body?.type === 'string' ? req.body.type.trim() : '';
  if (!type) throw new AppError('Select a document type', 400);
  if (!DOCUMENT_TYPES.has(type)) throw new AppError('Unknown document type', 400);

  const ownerType = req.body?.ownerType === 'PROPERTY' ? 'PROPERTY' : 'SUPPLIER';
  const ownerId = ownerType === 'PROPERTY' ? req.body?.ownerId || null : null;

  let propertyId = null;
  if (ownerType === 'PROPERTY') {
    if (!ownerId) throw new AppError('Choose the property this document belongs to', 400);
    const property = await prisma.stayProperty.findFirst({
      where: { id: ownerId, supplierId },
      select: { id: true },
    });
    if (!property) throw new AppError('Property not found', 404);
    propertyId = property.id;
  }

  let expiryDate = null;
  if (req.body?.expiryDate) {
    const parsed = new Date(req.body.expiryDate);
    if (Number.isNaN(parsed.getTime())) throw new AppError('Invalid expiry date', 400);
    expiryDate = parsed;
  }

  await getOrCreateProfile(supplierId);

  const document = await prisma.stayVerificationDocument.create({
    data: {
      supplierId,
      propertyId,
      type,
      ownerType,
      ownerId,
      status: 'PENDING',
      url: req.file.path || null,
      fileName: req.file.originalname || null,
      expiryDate,
      uploadedAt: new Date(),
    },
  });

  res.status(201).json({
    status: 'success',
    data: { document: serializeDocument(document) },
  });
});

exports.replaceDocument = catchAsync(async (req, res) => {
  const supplierId = supplierIdFor(req);
  if (!req.file) throw new AppError('Attach the replacement file', 400);

  const existing = await prisma.stayVerificationDocument.findFirst({
    where: { id: req.params.id, supplierId },
    select: { id: true },
  });
  if (!existing) throw new AppError('Document not found', 404);

  const document = await prisma.stayVerificationDocument.update({
    where: { id: existing.id },
    data: {
      status: 'PENDING',
      url: req.file.path || null,
      fileName: req.file.originalname || null,
      reviewNote: null,
      uploadedAt: new Date(),
    },
  });

  res.status(200).json({
    status: 'success',
    data: { document: serializeDocument(document) },
  });
});

exports._private = { DEFAULT_REQUIREMENTS, serializeDocument };
