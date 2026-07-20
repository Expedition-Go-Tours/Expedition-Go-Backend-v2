const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const keywordController = require('../controllers/keywordController');

const router = express.Router();

router.get('/', keywordController.listKeywords);
router.post('/request', protect, keywordController.requestKeyword);

module.exports = router;
