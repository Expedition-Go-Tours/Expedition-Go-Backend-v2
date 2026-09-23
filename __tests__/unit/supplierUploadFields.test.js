const {
  SUPPLIER_DOCUMENT_FIELDS,
  MAX_SUPPLIER_DOCUMENT_FILES,
} = require('../../config/supplierUploadFields');

describe('supplierUploadFields', () => {
  it('keeps the documented field names (and order) stable', () => {
    expect(SUPPLIER_DOCUMENT_FIELDS.map((f) => f.name)).toEqual([
      'registrationDocument',
      'taxDocument',
      'proofOfAddress',
      'idDocument',
      'licenses',
      'documents',
      'vehiclePhotos',
    ]);
  });

  it('derives the total file cap from the per-field maxCounts', () => {
    const sum = SUPPLIER_DOCUMENT_FIELDS.reduce((total, f) => total + f.maxCount, 0);
    expect(MAX_SUPPLIER_DOCUMENT_FILES).toBe(sum);
  });

  it('does not cap the upload at the legacy named fields only', () => {
    // Regression guard: the multer limit used to be a flat 9, which happened to
    // equal the five legacy fields (1+1+1+1+5) and silently ignored the generic
    // `documents` and `vehiclePhotos` fields added later.
    const legacyOnly = SUPPLIER_DOCUMENT_FIELDS
      .filter((f) => !['documents', 'vehiclePhotos'].includes(f.name))
      .reduce((total, f) => total + f.maxCount, 0);
    expect(legacyOnly).toBe(9);
    expect(MAX_SUPPLIER_DOCUMENT_FILES).toBeGreaterThan(legacyOnly);
  });

  it('accepts a Transportation Provider application (6 supplier docs + 4 per vehicle)', () => {
    // A Transportation Provider requires 6 supplier documents plus 4 vehicle
    // documents — 10 for one vehicle — so a cap of 9 rejected every such
    // application with a 400 "Too many files uploaded".
    const supplierDocuments = 6;
    const vehicleDocuments = 4;
    expect(MAX_SUPPLIER_DOCUMENT_FILES).toBeGreaterThanOrEqual(supplierDocuments + vehicleDocuments);
  });

  it('accepts a vehicle-based application with vehicle photos attached', () => {
    // 5 supplier docs + 4 vehicle docs + a few vehicle photos.
    expect(MAX_SUPPLIER_DOCUMENT_FILES).toBeGreaterThanOrEqual(5 + 4 + 5);
  });
});
