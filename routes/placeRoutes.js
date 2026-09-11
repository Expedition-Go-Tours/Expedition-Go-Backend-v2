const express = require('express');
const placeController = require('../controllers/placeController');

const router = express.Router();

/**
 * @swagger
 * /places/suggest:
 *   get:
 *     summary: Grouped search suggestions (places to see + things to do)
 *     tags: [Places]
 *     parameters:
 *       - name: q
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Suggestions retrieved successfully
 */
router.get('/suggest', placeController.suggest);

module.exports = router;
