/**
 * Field definitions for the supplier application upload (POST /suppliers/apply,
 * multipart) and the total file cap derived from them.
 *
 * The cap is DERIVED from the per-field `maxCount`s on purpose. The two had
 * drifted: the upload hard-coded `files: 9`, which was exactly the sum of the
 * legacy named fields (1+1+1+1+5) and was never updated when the generic
 * `documents` and `vehiclePhotos` fields were added. A Transportation Provider
 * must send 6 supplier documents plus 4 per vehicle — 10 for a single vehicle —
 * so that supplier type could not submit at all.
 *
 * Keeping both numbers computed from one array means they cannot disagree.
 * `config/cloudinary.js` uses MAX_SUPPLIER_DOCUMENT_FILES for the multer
 * limit; `middleware/uploadMiddleware.js` uses the array for `.fields()`.
 */

const SUPPLIER_DOCUMENT_FIELDS = [
  // Legacy named fields (kept for backward compatibility with existing clients)
  { name: 'registrationDocument', maxCount: 1 },
  { name: 'taxDocument', maxCount: 1 },
  { name: 'proofOfAddress', maxCount: 1 },
  { name: 'idDocument', maxCount: 1 },
  { name: 'licenses', maxCount: 5 },
  // Generic per-type document upload (paired with `documentMeta` in the body)
  { name: 'documents', maxCount: 30 },
  // Vehicle photos (paired with `vehiclePhotoMeta` — NOT verification documents)
  { name: 'vehiclePhotos', maxCount: 30 },
];

/** Total files accepted by a single /suppliers/apply request. */
const MAX_SUPPLIER_DOCUMENT_FILES = SUPPLIER_DOCUMENT_FIELDS.reduce(
  (total, field) => total + field.maxCount,
  0
);

module.exports = { SUPPLIER_DOCUMENT_FIELDS, MAX_SUPPLIER_DOCUMENT_FILES };
