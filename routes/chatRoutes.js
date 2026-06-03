const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { uploadChatImage } = require('../middleware/uploadMiddleware');
const chatController = require('../controllers/chatController');

router.use(protect);

router.get('/conversations', chatController.getConversations);
router.post('/conversations', chatController.getOrCreateConversation);
router.get('/conversations/unread-count', chatController.getUnreadCount);
router.post('/upload', uploadChatImage, chatController.uploadImage);
router.get('/conversations/:id/messages', chatController.getMessages);
router.post('/conversations/:id/messages', chatController.sendMessage);
router.patch('/conversations/:id/read', chatController.markAsRead);

module.exports = router;
