const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
const event = require('./utils/eventEmitter');
const { setIO, setupPrismaMiddleware } = require('./utils/dataChangeEmitter');
const { registerWorkers, closeAll, enqueueNotification, enqueueCleanup, enqueueAggregation, isRedisAvailable } = require('./utils/queue');
 

let server;
let io;

const shutdown = (reason, err) => {
  console.log(`${reason}! Shutting down...`);

  if (err) {
    console.log(err.name, err.message);
    console.error(err.stack);
  }

  try {
    if (io) {
      io.close(() => console.log('Socket.IO closed'));
    }
  } catch (e) {
    console.error('Error closing Socket.IO:', e?.message || e);
  }

  try {
    if (server) {
      server.close(() => {
        closeAll().finally(() => process.exit(1));
      });
    } else {
      closeAll().finally(() => process.exit(1));
    }
  } catch {
    process.exit(1);
  }
};

process.on('uncaughtException', (err) => {
  shutdown('UNCAUGHT EXCEPTION', err);
});

dotenv.config({ path: './.env' });

const app = require('./app');

const port = process.env.PORT || 5000;

process.on('unhandledRejection', (err) => {
  shutdown('UNHANDLED REJECTION', err);
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM received');
});

process.on('SIGINT', () => {
  shutdown('SIGINT received');
});

(async () => {
  try {
    // Test Prisma connection
    await prisma.$connect();
    console.log('PostgreSQL connection successful!');

    setupPrismaMiddleware(prisma);

    server = http.createServer(app);

    const allowedOrigins = [
      ...new Set([
        ...(process.env.ALLOWED_ORIGINS
          ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
          : []),
        'http://localhost:5173',
        'http://127.0.0.1:5173',
        'http://localhost:5174',
        'http://127.0.0.1:5174',
      ]),
    ];

    io = new Server(server, {
      cors: {
        origin: (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(null, false);
          }
        },
        credentials: true,
      },
    });

    app.set('io', io);
    setIO(io);

    io.engine.on('connection_error', (err) => {
      console.warn('Socket.IO connection error:', err.message);
    });

    io.on('connection', async (socket) => {
      const { token } = socket.handshake.auth || {};

      if (!token) {
        console.warn('Socket connection rejected: No token provided');
        socket.disconnect(true);
        return;
      }

      let decoded;
      try {
        const firebaseAdmin = require('./config/firebaseAdmin');
        decoded = await firebaseAdmin.auth().verifyIdToken(token);
      } catch (err) {
        console.warn('Socket connection rejected: Invalid token');
        socket.disconnect(true);
        return;
      }

      const user = await prisma.user.findUnique({
        where: { firebaseUid: decoded.uid },
        select: { id: true, roles: true, active: true, name: true },
      });

      if (!user || !user.active) {
        console.warn('Socket connection rejected: User not found or inactive');
        socket.disconnect(true);
        return;
      }

      socket.userId = user.id;
      socket.userRoles = user.roles;
      socket.userName = user.name || 'Unknown';
      console.log('Socket connected:', socket.id, { userId: user.id, roles: user.roles });

      if (user.roles.includes('admin')) {
        socket.join('admin-room');
        const chatService = require('./utils/chatService');
        chatService.getSharedAdminId().then(sharedId => {
          if (sharedId) socket.join(`user:${sharedId}`);
        });
      }

      socket.join(`user:${user.id}`);

      // Supplier responds to a review via WebSocket (real-time)
      socket.on('review:respond', async (payload, ack) => {
        try {
          const { reviewId, response } = payload || {};
          if (!reviewId || !response || !response.trim()) {
            return ack?.({ status: 'error', message: 'reviewId and response are required' });
          }
          if (!socket.userRoles.includes('supplier')) {
            return ack?.({ status: 'error', message: 'Only suppliers can respond to reviews' });
          }

          // Verify review exists and belongs to supplier's tour
          const review = await prisma.review.findFirst({
            where: {
              id: reviewId,
              tour: { supplierId: socket.userId },
              status: 'APPROVED'
            },
            include: {
              customer: { select: { id: true, name: true } },
              tour: { select: { id: true, title: true } }
            }
          });

          if (!review) {
            return ack?.({ status: 'error', message: 'Review not found or access denied' });
          }

          if (review.supplierResponse) {
            return ack?.({ status: 'error', message: 'Response already exists for this review' });
          }

          const updated = await prisma.review.update({
            where: { id: reviewId },
            data: {
              supplierResponse: response,
              supplierResponseAt: new Date()
            },
            include: {
              customer: { select: { id: true, name: true, photoURL: true } },
              tour: { select: { id: true, title: true } }
            }
          });

          // Notify the customer in real-time
          io.to(`user:${review.customerId}`).emit('review:response', {
            reviewId: updated.id,
            tourId: updated.tourId,
            tourTitle: review.tour.title,
            supplierResponse: updated.supplierResponse,
            supplierResponseAt: updated.supplierResponseAt
          });

          // Also create DB notification through the queue
          enqueueNotification({
            userId: review.customerId,
            type: 'REVIEW_RECEIVED',
            title: 'Supplier Responded to Your Review',
            message: `The supplier responded to your review for "${review.tour.title}"`,
            data: { reviewId: review.id, tourId: review.tourId }
          }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

          ack?.({ status: 'success', data: { review: updated } });

          event.emit({
            name: 'review.responded',
            userId: socket.userId,
            resource: 'Review',
            resourceId: reviewId,
            properties: { tourId: review.tourId, customerId: review.customerId },
            source: 'web',
          });
        } catch (err) {
          console.error('Socket review:respond error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      // ---- Chat socket handlers ----
      const chatService = require('./utils/chatService');

      socket.on('chat:join', async (payload, ack) => {
        try {
          const { conversationId } = payload || {};
          if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

          const effectiveUserId = socket.userRoles.includes('admin')
            ? (await chatService.getSharedAdminId()) || socket.userId
            : socket.userId;

          const participant = await prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
          });

          if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

          socket.join(`conversation:${conversationId}`);
          ack?.({ status: 'success' });
        } catch (err) {
          console.error('Socket chat:join error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      socket.on('chat:leave', async (payload, ack) => {
        try {
          const { conversationId } = payload || {};
          if (conversationId) {
            socket.leave(`conversation:${conversationId}`);
          }
          ack?.({ status: 'success' });
        } catch (err) {
          console.error('Socket chat:leave error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      socket.on('chat:message', async (payload, ack) => {
        try {
          const { conversationId, content, attachmentUrl, attachmentType } = payload || {};

          if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });
          if (!content && !attachmentUrl) return ack?.({ status: 'error', message: 'content or attachment required' });

          const effectiveUserId = socket.userRoles.includes('admin')
            ? (await chatService.getSharedAdminId()) || socket.userId
            : socket.userId;

          const participant = await prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
          });

          if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

          const message = await chatService.sendMessage(conversationId, effectiveUserId, content || '', {
            url: attachmentUrl,
            type: attachmentType,
          });

          io.to(`conversation:${conversationId}`).emit('chat:message', {
            conversationId,
            message,
          });

          const recipient = await prisma.conversationParticipant.findFirst({
            where: { conversationId, userId: { not: effectiveUserId } },
            select: { userId: true }
          });
          if (recipient) {
            io.to(`user:${recipient.userId}`).emit('chat:message', {
              conversationId,
              message,
            });
          }

          ack?.({ status: 'success', data: { message } });
        } catch (err) {
          console.error('Socket chat:message error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      socket.on('chat:typing', async (payload) => {
        try {
          const { conversationId, isTyping } = payload || {};
          if (!conversationId) return;

          const effectiveUserId = socket.userRoles.includes('admin')
            ? (await chatService.getSharedAdminId()) || socket.userId
            : socket.userId;

          const participant = await prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
          });

          if (!participant) return;

          socket.to(`conversation:${conversationId}`).emit('chat:typing', {
            conversationId,
            userId: effectiveUserId,
            isTyping: !!isTyping,
          });

          const recipient = await prisma.conversationParticipant.findFirst({
            where: { conversationId, userId: { not: effectiveUserId } },
            select: { userId: true },
          });
          if (recipient) {
            io.to(`user:${recipient.userId}`).emit('chat:typing', {
              conversationId,
              userId: effectiveUserId,
              isTyping: !!isTyping,
              userName: socket.userName || 'Someone',
            });
          }
        } catch (err) {
          console.error('Socket chat:typing error:', err);
        }
      });

      socket.on('chat:mark-read', async (payload, ack) => {
        try {
          const { conversationId } = payload || {};
          if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

          const effectiveUserId = socket.userRoles.includes('admin')
            ? (await chatService.getSharedAdminId()) || socket.userId
            : socket.userId;

          await chatService.markAsRead(conversationId, effectiveUserId);

          socket.to(`conversation:${conversationId}`).emit('chat:mark-read', {
            conversationId,
            readBy: effectiveUserId,
            readAt: new Date().toISOString(),
          });

          ack?.({ status: 'success' });
        } catch (err) {
          console.error('Socket chat:mark-read error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      socket.on('chat:delivered', async (payload) => {
        try {
          const { conversationId, messageIds } = payload || {};
          if (!conversationId || !messageIds?.length) return;

          let effectiveUserId = socket.userId;
          if (socket.userRoles.includes('admin')) {
            effectiveUserId = (await chatService.getSharedAdminId()) || socket.userId;
          }

          socket.to(`conversation:${conversationId}`).emit('chat:delivered', {
            conversationId,
            messageIds,
            deliveredTo: effectiveUserId,
          });

          const participant = await prisma.conversationParticipant.findFirst({
            where: { conversationId, userId: { not: effectiveUserId } },
            select: { userId: true }
          });
          if (participant) {
            io.to(`user:${participant.userId}`).emit('chat:delivered', {
              conversationId,
              messageIds,
              deliveredTo: effectiveUserId,
            });
          }
        } catch (err) {
          console.error('Socket chat:delivered error:', err);
        }
      });

      socket.on('error', (err) => {
        console.warn('Socket error:', socket.id, err.message);
      });

      socket.on('disconnect', (reason) => {
        console.log('Socket disconnected:', socket.id, reason);
      });
    });

    server.on('clientError', (err, socket) => {
      if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        return;
      }
      console.warn('HTTP client error:', err.message);
      socket.destroy(err);
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`App running on port ${port}...`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });

    // Initialise background queue workers after server starts
    const redisOk = await isRedisAvailable();
    if (redisOk) {
      registerWorkers(app);
      console.log('[Queue] Workers registered');

      // ----- Scheduled maintenance jobs (via BullMQ) -----
      const intervals = [];

      // Expired cart cleanup every 5 minutes
      intervals.push(setInterval(() => {
        enqueueCleanup('cleanup-expired-cart').catch(() => {});
      }, 5 * 60 * 1000));

      // Popularity cache refresh every hour
      intervals.push(setInterval(() => {
        enqueueAggregation('refresh-popularity').catch(() => {});
      }, 60 * 60 * 1000));

      // Old event cleanup once per day
      intervals.push(setInterval(() => {
        enqueueAggregation('cleanup-events').catch(() => {});
      }, 24 * 60 * 60 * 1000));

      // Old notification cleanup once per day
      intervals.push(setInterval(() => {
        enqueueCleanup('cleanup-notifications').catch(() => {});
      }, 24 * 60 * 60 * 1000));

      // Old audit log cleanup once per day
      intervals.push(setInterval(() => {
        enqueueCleanup('cleanup-audit-logs').catch(() => {});
      }, 24 * 60 * 60 * 1000));

      // Run each once on startup so the first cycle isn't delayed
      enqueueCleanup('cleanup-expired-cart').catch(() => {});
      enqueueAggregation('refresh-popularity').catch(() => {});
      enqueueAggregation('cleanup-events').catch(() => {});
      enqueueCleanup('cleanup-notifications').catch(() => {});
      enqueueCleanup('cleanup-audit-logs').catch(() => {});
    } else {
      console.warn('[Queue] Redis unavailable — emails and notifications will use inline fallback (no queue)');
    }
  } catch (err) {
    shutdown('DATABASE CONNECTION FAILED', err);
  }
})();
