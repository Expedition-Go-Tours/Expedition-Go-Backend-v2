const express = require('express');
const emailWebhookController = require('../src/core/domain/emailWebhookController');

const router = express.Router();

// POST /api/email/webhook — Resend delivery events (bounced / complained),
// raw JSON body, Svix-signed. Handled by the express.raw() parser in app.js.
router.post('/', emailWebhookController.receive);

module.exports = router;
