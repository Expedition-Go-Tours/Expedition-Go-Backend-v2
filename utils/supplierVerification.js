/**
 * Supplier verification helpers — parse + persist per-type documents,
 * vehicles, guides and their verification records.
 *
 * All file uploads are already handled by uploadMiddleware (Cloudinary),
 * which stores the public URL on `file.path`. These helpers only normalize
 * the multipart payload into Prisma rows and never touch the filesystem.
 */

const { isValidCloudinaryUrl } = require('./cloudinaryHelper');

/** Parse a JSON string/array field from a multipart body. */
function parseJson(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Parse an array field that may arrive as a JSON string. */
function parseJsonArray(value) {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Normalize generic `documents` files + `documentMeta` into document rows.
 * Returns an array of { url, type, ownerType, ownerKey } (ownerKey only for
 * VEHICLE/GUIDE docs so the caller can resolve it to a created record id).
 */
function parseDocuments(req) {
  const files = req.files?.documents || [];
  if (files.length === 0) return [];

  const meta = parseJsonArray(req.body?.documentMeta) || [];
  return files
    .map((file, i) => {
      const m = meta[i] || {};
      const url = file.path;
      if (!url || !isValidCloudinaryUrl(url)) return null;
      const type = m.type ? String(m.type) : 'OTHER';
      const ownerType = m.ownerType === 'VEHICLE' || m.ownerType === 'GUIDE' ? m.ownerType : 'SUPPLIER';
      return {
        url,
        type,
        ownerType,
        ownerKey: ownerType !== 'SUPPLIER' && m.ownerKey ? String(m.ownerKey) : undefined,
        expiryDate: m.expiryDate ? new Date(m.expiryDate) : undefined,
        filename: file.originalname,
      };
    })
    .filter(Boolean);
}

/**
 * Normalize `vehiclePhotos` files + `vehiclePhotoMeta` into a map of
 * vehicleKey -> photo URLs.
 */
function parseVehiclePhotos(req) {
  const files = req.files?.vehiclePhotos || [];
  const meta = parseJsonArray(req.body?.vehiclePhotoMeta) || [];
  const map = {};
  files.forEach((file, i) => {
    const vehicleKey = (meta[i] && meta[i].vehicleKey) ? String(meta[i].vehicleKey) : null;
    if (!file.path || !isValidCloudinaryUrl(file.path)) return;
    if (!vehicleKey) return;
    if (!map[vehicleKey]) map[vehicleKey] = [];
    map[vehicleKey].push(file.path);
  });
  return map;
}

/** Parse vehicles array payload (array of { key, make, model, year, registrationNumber }). */
function parseVehicles(body) {
  const arr = parseJsonArray(body?.vehicles) || [];
  return arr
    .map((v) => ({
      key: v.key ? String(v.key) : null,
      make: String(v.make || '').trim(),
      model: String(v.model || '').trim(),
      year: v.year ? parseInt(v.year, 10) : null,
      registrationNumber: String(v.registrationNumber || '').trim(),
    }))
    .filter((v) => v.make && v.model && v.registrationNumber);
}

/** Parse guides array payload (array of { key, fullName, phone, email }). */
function parseGuides(body) {
  const arr = parseJsonArray(body?.guides) || [];
  return arr
    .map((g) => ({
      key: g.key ? String(g.key) : null,
      fullName: String(g.fullName || '').trim(),
      phone: g.phone ? String(g.phone) : null,
      email: g.email ? String(g.email) : null,
    }))
    .filter((g) => g.fullName);
}

/**
 * Persist documents, vehicles and guides for a supplier profile in a single
 * transaction. Creates vehicles/guides first (capturing their ids so document
 * ownerKeys can be resolved), then the SupplierDocument rows.
 *
 * @param {import('@prisma/client').PrismaClient} tx
 * @param {object} opts { profileId, documents, vehicles, guides, vehiclePhotos, action }
 */
async function upsertVerificationRecords(tx, opts) {
  const { profileId, documents = [], vehicles = [], guides = [], vehiclePhotos = {}, action = 'APPLICATION' } = opts;

  const photoMap = vehiclePhotos || {};

  // 1) Create vehicles, building key -> id
  const keyToVehicleId = {};
  for (const v of vehicles) {
    const created = await tx.vehicle.create({
      data: {
        supplierId: profileId,
        make: v.make,
        model: v.model,
        year: v.year && !Number.isNaN(v.year) ? v.year : null,
        registrationNumber: v.registrationNumber,
        photos: photoMap[v.key] || [],
        status: 'PENDING',
      },
    });
    if (v.key) keyToVehicleId[v.key] = created.id;
  }

  // 2) Create guides, building key -> id
  const keyToGuideId = {};
  for (const g of guides) {
    const created = await tx.guide.create({
      data: {
        supplierId: profileId,
        fullName: g.fullName,
        phone: g.phone || null,
        email: g.email || null,
        status: 'PENDING',
      },
    });
    if (g.key) keyToGuideId[g.key] = created.id;
  }

  // 3) Create documents, resolving ownerIds from the key maps
  for (const d of documents) {
    let ownerId = profileId;
    let ownerType = d.ownerType || 'SUPPLIER';
    if (ownerType === 'VEHICLE' && d.ownerKey && keyToVehicleId[d.ownerKey]) {
      ownerId = keyToVehicleId[d.ownerKey];
    } else if (ownerType === 'GUIDE' && d.ownerKey && keyToGuideId[d.ownerKey]) {
      ownerId = keyToGuideId[d.ownerKey];
    } else {
      ownerType = 'SUPPLIER';
      ownerId = profileId;
    }
    await tx.supplierDocument.create({
      data: {
        supplierId: profileId,
        ownerType,
        ownerId,
        type: d.type || 'OTHER',
        url: d.url,
        filename: d.filename || null,
        expiryDate: d.expiryDate || null,
        status: 'PENDING',
      },
    });
  }

  if (action) {
    await tx.verificationEvent.create({
      data: {
        supplierId: profileId,
        entityType: 'SUPPLIER',
        entityId: profileId,
        action,
      },
    });
  }
}

module.exports = {
  parseJson,
  parseJsonArray,
  parseDocuments,
  parseVehiclePhotos,
  parseVehicles,
  parseGuides,
  upsertVerificationRecords,
};