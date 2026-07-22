const logger = require('../utils/logger');

function sanitizeValue(value) {
  if (typeof value === 'string') {
    return value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/<[^>]*>/g, '');
  }
  return value;
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizeValue(value);
    } else if (value !== null && typeof value === 'object') {
      result[key] = sanitizeObject(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function sanitize(req, res, next) {
  const original = JSON.stringify({ body: req.body, query: req.query, params: req.params });
  req.body = sanitizeObject(req.body);
  req.query = sanitizeObject(req.query);
  req.params = sanitizeObject(req.params);
  const sanitized = JSON.stringify({ body: req.body, query: req.query, params: req.params });
  if (original !== sanitized) {
    logger.warn('[XSS] Sanitized request input');
  }
  next();
}

module.exports = sanitize;
