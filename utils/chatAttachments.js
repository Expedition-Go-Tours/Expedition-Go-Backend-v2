/**
 * Upload inbound chat email attachments to Cloudinary.
 */

require('../config/cloudinary'); // ensures cloudinary.v2 is configured
const cloudinary = require('cloudinary').v2;

const ATTACHMENT_FOLDER = 'chat/inbound';
const IMAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const DOC_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_PER_EMAIL = 3;

function classify(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'document';
  return 'document';
}

const ALLOWED_DOC_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/rtf',
  'application/json',
  'text/plain',
  'text/csv',
]);

function isAllowed(contentType, size) {
  const ct = String(contentType || '').toLowerCase();
  const isImage = ct.startsWith('image/');
  const cap = isImage ? IMAGE_MAX_BYTES : DOC_MAX_BYTES;
  if (!size || size > cap) return false;
  if (isImage) return true;
  return ALLOWED_DOC_TYPES.has(ct);
}

/** Cloudinary upload_stream wrapper — returns secure_url on success. */
function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: ATTACHMENT_FOLDER,
        resource_type: 'auto',
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result && result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadBuffer, classify, isAllowed, IMAGE_MAX_BYTES, DOC_MAX_BYTES, MAX_PER_EMAIL };
