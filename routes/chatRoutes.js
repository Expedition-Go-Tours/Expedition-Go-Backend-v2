const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { requirePermission } = require('../middleware/permissionMiddleware');
const { uploadChatImage } = require('../middleware/uploadMiddleware');
const chatController = require('../controllers/chatController');

router.use(protect);

/**
 * @swagger
 * /api/chat/admin-support:
 *   get:
 *     summary: Get admin support conversation
 *     description: Returns the shared admin user ID for supplier-to-admin support conversations. No permission check required beyond authentication.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin support user ID
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     adminId:
 *                       type: string
 *                       format: uuid
 *                       description: The admin user ID to start a conversation with
 *                       example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *       404:
 *         description: Admin support is not configured yet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/admin-support', chatController.getAdminSupport);
router.get('/expedition-support', chatController.getExpeditionSupport);

router.use(requirePermission('chat.suppliers', 'chat.customers', 'chat.expedition'));

/**
 * @swagger
 * /api/chat/conversations:
 *   get:
 *     summary: Get user's conversations
 *     description: Retrieves all conversations for the authenticated user, filtered by their permission level (SUPPLIER_ADMIN or USER_SUPPORT).
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     conversations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           type:
 *                             type: string
 *                             enum: [SUPPLIER_ADMIN, SUPPLIER_CUSTOMER, USER_SUPPORT]
 *                           participants:
 *                             type: array
 *                             items:
 *                               type: object
 *                               properties:
 *                                 id:
 *                                   type: string
 *                                   format: uuid
 *                                 name:
 *                                   type: string
 *                                 email:
 *                                   type: string
 *                                   format: email
 *                           lastMessage:
 *                             type: object
 *                             properties:
 *                               content:
 *                                 type: string
 *                               senderId:
 *                                 type: string
 *                               createdAt:
 *                                 type: string
 *                                 format: date-time
 *                           unreadCount:
 *                             type: integer
 *                             description: Number of unread messages in this conversation
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                           updatedAt:
 *                             type: string
 *                             format: date-time
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Insufficient permissions
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/conversations', chatController.getConversations);
/**
 * @swagger
 * /api/chat/conversations:
 *   post:
 *     summary: Get or create a conversation
 *     description: Finds an existing conversation between the authenticated user and the specified recipient, or creates a new one. The conversation type can be auto-detected based on participant roles or explicitly set.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - recipientId
 *             properties:
 *               recipientId:
 *                 type: string
 *                 format: uuid
 *                 description: The ID of the user to converse with
 *                 example: b2c3d4e5-f6a7-8901-bcde-f12345678901
 *               type:
 *                 type: string
 *                 enum: [SUPPLIER_ADMIN, SUPPLIER_CUSTOMER, USER_SUPPORT]
 *                 description: Conversation type (auto-detected from roles if omitted)
 *                 example: SUPPLIER_ADMIN
 *     responses:
 *       201:
 *         description: Conversation found or created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     conversation:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         type:
 *                           type: string
 *                         participants:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Missing recipientId or attempting to create conversation with yourself
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Insufficient permissions for this conversation type
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Recipient not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/conversations', chatController.getOrCreateConversation);
/**
 * @swagger
 * /api/chat/conversations/unread-count:
 *   get:
 *     summary: Get unread message count
 *     description: Returns the total number of unread messages across all conversations for the authenticated user.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalUnread:
 *                       type: integer
 *                       description: Total unread messages across all conversations
 *                       example: 12
 *                     conversations:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           conversationId:
 *                             type: string
 *                             format: uuid
 *                           unreadCount:
 *                             type: integer
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/conversations/unread-count', chatController.getUnreadCount);
/**
 * @swagger
 * /api/chat/upload:
 *   post:
 *     summary: Upload chat image
 *     description: Uploads an image file to be used as an attachment in chat messages. Accepts image files via multipart/form-data.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Image file to upload (jpg, png, gif, webp)
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     url:
 *                       type: string
 *                       description: URL to the uploaded image
 *                       example: /uploads/chat/abc123.jpg
 *                     type:
 *                       type: string
 *                       example: image
 *       400:
 *         description: No file provided
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/upload', uploadChatImage, chatController.uploadImage);
/**
 * @swagger
 * /api/chat/conversations/{id}/messages:
 *   get:
 *     summary: Get messages for a conversation
 *     description: Retrieves paginated messages for a conversation using cursor-based pagination. Messages are returned in reverse chronological order.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *       - in: query
 *         name: cursor
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Cursor for pagination (message ID after which to fetch older messages)
 *         example: m1n2o3p4-q5r6-7890-abcd-ef1234567890
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Number of messages to return (max 100)
 *         example: 25
 *     responses:
 *       200:
 *         description: Paginated messages
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     messages:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                             format: uuid
 *                           content:
 *                             type: string
 *                             description: Message text content
 *                           senderId:
 *                             type: string
 *                             format: uuid
 *                           sender:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               avatar:
 *                                 type: string
 *                           attachmentUrl:
 *                             type: string
 *                             description: URL to attached file
 *                           attachmentType:
 *                             type: string
 *                             enum: [image, file]
 *                           isEdited:
 *                             type: boolean
 *                           editedAt:
 *                             type: string
 *                             format: date-time
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                     nextCursor:
 *                       type: string
 *                       format: uuid
 *                       nullable: true
 *                       description: Cursor for fetching the next page of older messages
 *                     hasMore:
 *                       type: boolean
 *                       description: Whether more messages are available
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not a participant of this conversation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get('/conversations/:id/messages', chatController.getMessages);
/**
 * @swagger
 * /api/chat/conversations/{id}/messages:
 *   post:
 *     summary: Send a message in a conversation
 *     description: Sends a text message with optional attachment to an existing conversation. Emits real-time events via Socket.IO to participants and the conversation room.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
 *                 description: Message text content (required if attachmentUrl is not provided)
 *                 example: Hello, I need help with an order
 *               attachmentUrl:
 *                 type: string
 *                 description: URL of an uploaded attachment (required if content is not provided)
 *                 example: /uploads/chat/abc123.jpg
 *               attachmentType:
 *                 type: string
 *                 enum: [image, file]
 *                 description: Type of attachment
 *                 example: image
 *     responses:
 *       201:
 *         description: Message sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         content:
 *                           type: string
 *                         senderId:
 *                           type: string
 *                           format: uuid
 *                         attachmentUrl:
 *                           type: string
 *                         attachmentType:
 *                           type: string
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Message content or attachment is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not a participant of this conversation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post('/conversations/:id/messages', chatController.sendMessage);
/**
 * @swagger
 * /api/chat/conversations/{id}/read:
 *   patch:
 *     summary: Mark conversation as read
 *     description: Marks all unread messages in a conversation as read for the authenticated user. Emits a real-time event to the other participant via Socket.IO.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *     responses:
 *       200:
 *         description: Conversation marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     lastReadAt:
 *                       type: string
 *                       format: date-time
 *                       description: Timestamp when the conversation was marked as read
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not a participant of this conversation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch('/conversations/:id/read', chatController.markAsRead);
/**
 * @swagger
 * /api/chat/conversations/{id}/messages/{messageId}:
 *   put:
 *     summary: Update a message
 *     description: Edits the text content of an existing message. Only the message author can update it. Emits a real-time event to the conversation room via Socket.IO.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Message ID to update
 *         example: m1n2o3p4-q5r6-7890-abcd-ef1234567890
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *                 description: Updated message text
 *                 example: I meant to say this instead
 *     responses:
 *       200:
 *         description: Message updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                           format: uuid
 *                         content:
 *                           type: string
 *                         isEdited:
 *                           type: boolean
 *                         editedAt:
 *                           type: string
 *                           format: date-time
 *                         updatedAt:
 *                           type: string
 *                           format: date-time
 *       400:
 *         description: Message content is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not the message author or not a participant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Message or conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.put('/conversations/:id/messages/:messageId', chatController.updateMessage);
/**
 * @swagger
 * /api/chat/conversations/{id}/messages/{messageId}:
 *   delete:
 *     summary: Delete a message
 *     description: Deletes a message from a conversation. Only the message author can delete it. Emits a real-time event to the conversation room via Socket.IO.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *       - in: path
 *         name: messageId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Message ID to delete
 *         example: m1n2o3p4-q5r6-7890-abcd-ef1234567890
 *     responses:
 *       200:
 *         description: Message deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: null
 *                   example: null
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not the message author or not a participant
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Message or conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/conversations/:id/messages/:messageId', chatController.deleteMessage);
/**
 * @swagger
 * /api/chat/conversations/{id}:
 *   delete:
 *     summary: Delete a conversation
 *     description: Deletes an entire conversation and all its messages. Emits a global real-time event via Socket.IO. Only participants can delete their conversations.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Conversation ID to delete
 *         example: a1b2c3d4-e5f6-7890-abcd-ef1234567890
 *     responses:
 *       200:
 *         description: Conversation deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: null
 *                   example: null
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       403:
 *         description: Not a participant of this conversation
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: Conversation not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.delete('/conversations/:id', chatController.deleteConversation);

module.exports = router;
