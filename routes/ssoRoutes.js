const express = require('express');
const catchAsync = require('../src/core/services/catchAsync');
const AppError = require('../src/core/services/appError');
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const { mintSchema, exchangeSchema } = require('../src/core/services/ssoValidation');
const { mintTicket, exchangeTicket } = require('../src/core/services/ssoService');
const { getAllowedClientOrigins, normalizeOrigin } = require('../src/core/services/clientOrigin');

/**
 * `/api/sso` — hand a signed-in user from one storefront to another.
 *
 * Mounted apart from `/api/auth` on purpose: that mount carries a
 * 20 requests / 15 minutes / IP limiter aimed at credential attempts, and
 * minting happens during ordinary browsing. Sharing it would let a normal
 * session lock a household (or an office NAT) out of logging in.
 */

const router = express.Router();

// Session-bearing responses must never be cached by an intermediary.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

/** Only sites we own may be named as a ticket's destination. */
function requireAllowedDestination(destination) {
  const origin = normalizeOrigin(destination);
  if (!origin || !getAllowedClientOrigins().has(origin)) {
    throw new AppError('destination: not an allowed site', 400);
  }
  return origin;
}

/**
 * @swagger
 * /api/sso/mint:
 *   post:
 *     summary: Mint a one-time ticket for a tour click to another storefront
 *     description: Issues a 120-second, single-use, destination-bound ticket. Grants nothing on its own — the receiving site must exchange it.
 *     tags: [Authentication]
 *     security:
 *       - bearerAuth: []
 */
router.post(
  '/mint',
  protect,
  validate(mintSchema),
  catchAsync(async (req, res) => {
    const destination = requireAllowedDestination(req.body.destination);
    const { ticket, expiresIn } = mintTicket(req.user.id, destination);
    res.status(200).json({ status: 'success', data: { ticket, expiresIn, destination } });
  }),
);

/**
 * @swagger
 * /api/sso/exchange:
 *   post:
 *     summary: Redeem a ticket for a session on the receiving storefront
 *     description: Verifies signature, expiry, destination and single use, then mints a fresh token pair. Public by necessity — the caller has no session yet.
 *     tags: [Authentication]
 */
router.post(
  '/exchange',
  validate(exchangeSchema),
  catchAsync(async (req, res) => {
    const destination = requireAllowedDestination(req.body.destination);
    const session = await exchangeTicket(req.body.ticket, destination);
    res.status(200).json({ status: 'success', data: session });
  }),
);

module.exports = router;
