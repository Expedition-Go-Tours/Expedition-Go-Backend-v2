/**
 * Webhook Routes - Production Ready
 * Handles webhook endpoints for external services
 * 
 * @author Tour Platform Team
 * @version 1.0.0
 */

const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

/**
 * @swagger
 * /webhooks/stripe:
 *   post:
 *     summary: Handle Stripe webhooks
 *     description: |
 *       Endpoint for receiving and processing Stripe webhook events.
 *       This endpoint handles various Stripe events including:
 *       - payment_intent.succeeded - Payment completed successfully
 *       - payment_intent.payment_failed - Payment failed
 *       
 *       **Security:** Webhook signature verification is required.
 *       The endpoint validates the Stripe signature header to ensure authenticity.
 *       
 *       **Note:** This endpoint expects raw body (not JSON parsed).
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *                 description: Unique event identifier
 *                 example: evt_1234567890abcdef
 *               type:
 *                 type: string
 *                 description: Event type
 *                 example: payment_intent.succeeded
 *               data:
 *                 type: object
 *                 description: Event data payload
 *               created:
 *                 type: integer
 *                 description: Unix timestamp of event creation
 *                 example: 1620000000
 *     responses:
 *       200:
 *         description: Webhook received and processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 received:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid webhook signature or payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Webhook signature verification failed
 */
router.post('/stripe', express.raw({ type: 'application/json' }), webhookController.handleStripeWebhook);

/**
 * @swagger
 * /webhooks/test:
 *   post:
 *     summary: Test webhook endpoint (development only)
 *     description: |
 *       Test endpoint for webhook development and debugging.
 *       This endpoint is only available in development mode.
 *       
 *       **Use cases:**
 *       - Testing webhook payload structures
 *       - Debugging webhook handlers
 *       - Simulating webhook events
 *       
 *       **Note:** This endpoint is disabled in production for security.
 *     tags: [Webhooks]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               eventType:
 *                 type: string
 *                 description: Type of event to simulate
 *                 default: test.event
 *                 example: payment_intent.succeeded
 *               data:
 *                 type: object
 *                 description: Event data payload
 *                 example:
 *                   bookingId: cmp2hql3c0001tzv0460pbckm
 *                   amount: 10110
 *                   currency: usd
 *           example:
 *             eventType: payment_intent.succeeded
 *             data:
 *               bookingId: cmp2hql3c0001tzv0460pbckm
 *               amount: 10110
 *               currency: usd
 *     responses:
 *       200:
 *         description: Test webhook received
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Test webhook received
 *                 data:
 *                   type: object
 *                   description: Echo of received data
 *       404:
 *         description: Not available in production
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Test webhooks are only available in development mode
 */
router.post('/test', webhookController.testWebhook);

module.exports = router;