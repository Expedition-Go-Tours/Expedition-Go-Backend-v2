const express = require('express');
const emailInboundController = require('../controllers/emailInboundController');

const router = express.Router();

// POST /api/email/inbound — Resend email.received webhook (raw JSON body,
// Svix-signed). Handled by the express.raw() parser mounted in app.js.
router.post('/', emailInboundController.receive);

module.exports = router;
