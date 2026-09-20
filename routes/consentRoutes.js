const express = require('express');
const { createLimiter } = require('../middleware/dynamicRateLimiter');
const { optionalAuth } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const consentController = require('../src/core/domain/consentController');
const { consentSchema } = require('../src/core/services/consentValidation');

const router = express.Router();

/**
 * Cookie-consent audit endpoint.
 *
 * Public and unauthenticated by design — consent is collected from anonymous
 * visitors before anything optional is allowed to run, so requiring a session
 * would defeat the purpose. `optionalAuth` merely attaches the user when one
 * happens to be signed in.
 */
const consentLimiter = createLimiter({
  name: 'consent',
  defaultMax: 30,
  defaultWindowMs: 60 * 1000,
  message: { status: 'fail', message: 'Too many consent updates, please try again later.' },
});

/**
 * @swagger
 * /api/consent:
 *   post:
 *     summary: Record a cookie-consent decision
 *     description: |
 *       Stores an audit record of what a visitor agreed to, against which
 *       policy version, and when. The visitor's browser remains the source of
 *       truth for applying the choice; this is the compliance trail.
 *     tags: [Consent]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [version, source]
 *             properties:
 *               version:
 *                 type: integer
 *                 example: 1
 *               necessary:
 *                 type: boolean
 *                 example: true
 *               functional:
 *                 type: boolean
 *                 example: false
 *               analytics:
 *                 type: boolean
 *                 example: false
 *               marketing:
 *                 type: boolean
 *                 example: false
 *               source:
 *                 type: string
 *                 enum: [accept-all, reject-non-essential, preferences]
 *               policyPath:
 *                 type: string
 *                 example: /cookies-policy
 *               decidedAt:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Consent recorded
 *       400:
 *         description: Invalid payload
 *       429:
 *         description: Too many requests
 */
router.post('/', consentLimiter, optionalAuth, validate(consentSchema), consentController.recordConsent);

module.exports = router;
