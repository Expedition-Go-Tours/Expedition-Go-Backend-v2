const express = require('express');
const searchController = require('../src/core/domain/searchController');

const router = express.Router();

/**
 * @swagger
 * /search:
 *   get:
 *     summary: Unified search across tours, attractions, places, and regions
 *     tags: [Search]
 *     parameters:
 *       - name: q
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query (min 2 chars)
 *       - name: scope
 *         in: query
 *         schema:
 *           type: string
 *           enum: [expedition, ghana, all]
 *       - name: limit
 *         in: query
 *         schema:
 *           type: integer
 *           maximum: 20
 *     responses:
 *       200:
 *         description: Search results with scoring
 */
router.get('/', searchController.unifiedSearch);

/**
 * @swagger
 * /search/loose-resolve:
 *   get:
 *     summary: Fuzzy resolve an unknown query to the closest Ghana location
 *     tags: [Search]
 *     parameters:
 *       - name: q
 *         in: query
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Loose place resolution
 */
router.get('/loose-resolve', searchController.loosePlaceResolve);

module.exports = router;
