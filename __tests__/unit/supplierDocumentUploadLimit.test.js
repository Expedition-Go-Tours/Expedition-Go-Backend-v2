/**
 * End-to-end proof of the supplier-document file cap.
 *
 * Regression: the multer limit was a flat 9, which was exactly the sum of the
 * legacy named fields. A Transportation Provider submits 6 supplier documents
 * plus 4 per vehicle (10 for one vehicle), so every such application was
 * rejected with 400 "Too many files uploaded" before it reached the controller.
 */

// Must be set before config/cloudinary.js is loaded (it reads env at import time).
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key';
process.env.CLOUDINARY_API_SECRET = 'test-secret';

// Store uploads in memory so the test needs no Cloudinary credentials. This
// keeps the REAL multer instance (and therefore its limits) under test.
jest.mock('multer-storage-cloudinary', () => {
  const multer = require('multer');
  return { CloudinaryStorage: multer.memoryStorage };
});

jest.mock('../../src/core/services/prismaClient', () => ({
  media: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
}));

const express = require('express');
const request = require('supertest');

const { uploadSupplierDocuments } = require('../../middleware/uploadMiddleware');
const { MAX_SUPPLIER_DOCUMENT_FILES } = require('../../config/supplierUploadFields');

function buildApp() {
  const app = express();
  app.post('/apply', uploadSupplierDocuments, (req, res) => {
    const files = Object.values(req.files || {}).flat();
    res.json({ status: 'success', fileCount: files.length });
  });
  return app;
}

function postFiles(filesByField) {
  let req = request(buildApp()).post('/apply');
  for (const [field, count] of Object.entries(filesByField)) {
    for (let i = 0; i < count; i += 1) {
      req = req.attach(field, Buffer.from('file-bytes'), `${field}-${i}.pdf`);
    }
  }
  return req;
}

describe('supplier document upload limit', () => {
  it('accepts a Transportation Provider payload (6 supplier docs + 4 vehicle docs)', async () => {
    // Previously 400 "Too many files uploaded" — the whole point of the fix.
    const res = await postFiles({ documents: 10 });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(10);
  });

  it('accepts a vehicle-based application with vehicle photos attached', async () => {
    const res = await postFiles({ documents: 9, vehiclePhotos: 6 });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(15);
  });

  it('accepts exactly the derived cap when spread across the allowed fields', async () => {
    const res = await postFiles({
      registrationDocument: 1,
      taxDocument: 1,
      proofOfAddress: 1,
      idDocument: 1,
      licenses: 5,
      documents: 30,
      vehiclePhotos: 30,
    });
    expect(res.status).toBe(200);
    expect(res.body.fileCount).toBe(MAX_SUPPLIER_DOCUMENT_FILES);
    expect(MAX_SUPPLIER_DOCUMENT_FILES).toBe(69);
  });

  it('still enforces the per-field maxCount for documents', async () => {
    // The derived cap must not become a way to bypass the per-field allowlist.
    const res = await postFiles({ documents: 31 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unexpected file field');
  });

  it('rejects a file sent under an unknown field', async () => {
    const res = await postFiles({ notARealField: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Unexpected file field');
  });
});
