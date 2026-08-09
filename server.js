console.log('[BOOT] server.js started');

const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
const { setIO, setupPrismaMiddleware } = require('./utils/dataChangeEmitter');
const { registerWorkers, closeAll, enqueueNotification, enqueueCleanup, enqueueAggregation, enqueueEvent, probe, startResumeMonitor } = require('./utils/queue');
const redisClient = require('./utils/redisClient');
const logger = require('./utils/logger');
 

let server;
let io;

const shutdown = async (reason, err) => {
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
    await prisma.$disconnect();
    console.log('Prisma disconnected');
  } catch (e) {
    console.error('Error disconnecting Prisma:', e?.message || e);
  }

  try {
    if (server) {
      server.close(() => {
        closeAll().finally(() => redisClient.quit().finally(() => process.exit(1)));
      });
    } else {
      closeAll().finally(() => redisClient.quit().finally(() => process.exit(1)));
    }
  } catch {
    process.exit(1);
  }
};

process.on('uncaughtException', (err) => {
  shutdown('UNCAUGHT EXCEPTION', err);
});

dotenv.config({ path: './.env' });

const { validateEnv } = require('./config/validateEnv');
validateEnv();

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

server = http.createServer(app);

// Listen immediately so Render health checks pass while async init completes
server.listen(port, '0.0.0.0', () => {
  console.log(`[Startup] HTTP server listening on ${port}`);
  console.log(`[Startup] Environment: ${process.env.NODE_ENV}`);
});

setupSocketIO();

// Async initialization (Prisma, Redis, queue workers) — non-blocking
(async () => {
  try {
    await prisma.$connect();
    console.log('[Startup] PostgreSQL connected');
  } catch (err) {
    console.error('[Startup] PostgreSQL connection failed:', err?.message || err);
  }

  setupPrismaMiddleware(prisma);
  setupRedisAdapter();
  await setupQueueWorkers();
})();

function setupRedisAdapter() {
  if (!process.env.REDIS_URL) return;
  (async () => {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('redis');
      const pubClient = createClient({
        url: process.env.REDIS_URL,
        socket: { connectTimeout: 10000, reconnectStrategy: false },
      });
      const subClient = pubClient.duplicate();
      await Promise.all([pubClient.connect(), subClient.connect()]);
      io.adapter(createAdapter(pubClient, subClient));
      console.log('[Socket.IO] Redis adapter connected');
    } catch (err) {
      console.warn('[Socket.IO] Redis adapter unavailable:', err?.message);
    }
  })();
}

async function setupQueueWorkers() {
  console.log('[Startup] Checking Redis for queue workers...');
  startResumeMonitor();
  // Real-command probe (not PING) so a quota-exhausted boot doesn't register
  // workers that immediately start hammering Upstash.
  const redisOk = await probe();
  if (!redisOk) {
    console.warn('[Queue] Redis unavailable — using inline fallback');
    return;
  }

  registerWorkers(app);
  console.log('[Queue] Workers registered');

  const intervals = [];

  intervals.push(setInterval(() => {
    enqueueCleanup('cleanup-expired-cart').catch((err) => logger.warn('[scheduler] cleanup-expired-cart failed:', err?.message));
  }, 5 * 60 * 1000));

  intervals.push(setInterval(() => {
    enqueueCleanup('cleanup-stale-bookings').catch((err) => logger.warn('[scheduler] cleanup-stale-bookings failed:', err?.message));
  }, 5 * 60 * 1000));

  intervals.push(setInterval(() => {
    enqueueAggregation('refresh-popularity').catch((err) => logger.warn('[scheduler] refresh-popularity failed:', err?.message));
  }, 60 * 60 * 1000));

  intervals.push(setInterval(() => {
    enqueueAggregation('cleanup-events').catch((err) => logger.warn('[scheduler] cleanup-events failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  intervals.push(setInterval(() => {
    enqueueCleanup('cleanup-notifications').catch((err) => logger.warn('[scheduler] cleanup-notifications failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  intervals.push(setInterval(() => {
    enqueueCleanup('cleanup-audit-logs').catch((err) => logger.warn('[scheduler] cleanup-audit-logs failed:', err?.message));
  }, 24 * 60 * 60 * 1000));

  enqueueCleanup('cleanup-expired-cart').catch((err) => logger.warn('[scheduler] startup cleanup-expired-cart failed:', err?.message));
  enqueueCleanup('cleanup-stale-bookings').catch((err) => logger.warn('[scheduler] startup cleanup-stale-bookings failed:', err?.message));
  enqueueAggregation('refresh-popularity').catch((err) => logger.warn('[scheduler] startup refresh-popularity failed:', err?.message));
  enqueueAggregation('cleanup-events').catch((err) => logger.warn('[scheduler] startup cleanup-events failed:', err?.message));
  enqueueCleanup('cleanup-notifications').catch((err) => logger.warn('[scheduler] startup cleanup-notifications failed:', err?.message));
  enqueueCleanup('cleanup-audit-logs').catch((err) => logger.warn('[scheduler] startup cleanup-audit-logs failed:', err?.message));
}

function setupSocketIO() {
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
    transports: ['polling', 'websocket'],
    allowEIO3: true,
  });

  app.set('io', io);
  setIO(io);

  console.log('[Startup] Socket.IO configured');

  io.engine.on('connection_error', (err) => {
    console.warn('Socket.IO connection error:', err.message);
  });

  const connectionAttempts = new Map();
  const RATE_LIMIT = 10;
  const RATE_WINDOW = 60 * 1000;

  io.use(async (socket, next) => {
    try {
      const ip = socket.handshake.address;
      const now = Date.now();
      const attempts = connectionAttempts.get(ip) || [];
      const recent = attempts.filter(t => now - t < RATE_WINDOW);
      if (recent.length >= RATE_LIMIT) {
        return next(new Error('Too many connection attempts'));
      }
      recent.push(now);
      connectionAttempts.set(ip, recent);

      const parseCookies = (h) => (h || '').split(';').reduce((o, p) => {
        const [k, ...v] = p.trim().split('=');
        if (k) o[k.trim()] = v.join('=');
        return o;
      }, {});
      const cookies = parseCookies(socket.handshake.headers.cookie);
      const token = socket.handshake.auth?.token || cookies.accessToken;

      if (!token) {
        return next(new Error('No token provided'));
      }

      let decoded;
      try {
        const { verifyAccessToken } = require('./config/jwt');
        decoded = verifyAccessToken(token);
      } catch {
        return next(new Error('Invalid token'));
      }

      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, roles: true, active: true, name: true },
      });

      if (!user || !user.active) {
        return next(new Error('User not found or inactive'));
      }

      socket.userId = user.id;
      socket.userRoles = user.roles;
      socket.userName = user.name || 'Unknown';

      const ttl = decoded.exp * 1000 - Date.now();
      if (ttl > 0) {
        setTimeout(() => {
          socket.emit('auth:expired', { message: 'Token expired, please reconnect' });
          socket.disconnect(true);
        }, ttl);
      }

      next();
    } catch {
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id, { userId: socket.userId, roles: socket.userRoles });

    if (socket.userRoles.includes('admin')) {
      socket.join('admin-room');
      const chatService = require('./utils/chatService');
      chatService.getSharedAdminId().then(sharedId => {
        if (sharedId) socket.join(`user:${sharedId}`);
      });
    }

    if (socket.userRoles.includes('expedition')) {
      socket.join('expedition-room');
      const chatService = require('./utils/chatService');
      chatService.getSharedExpeditionId().then(sharedId => {
        if (sharedId) socket.join(`user:${sharedId}`);
      });
    }

    socket.join(`user:${socket.userId}`);

    socket.on('review:respond', async (payload, ack) => {
      try {
        const { reviewId, response } = payload || {};
        if (!reviewId || !response || !response.trim()) {
          return ack?.({ status: 'error', message: 'reviewId and response are required' });
        }
        if (!socket.userRoles.includes('supplier')) {
          return ack?.({ status: 'error', message: 'Only suppliers can respond to reviews' });
        }

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

        io.to(`user:${review.customerId}`).emit('review:response', {
          reviewId: updated.id,
          tourId: updated.tourId,
          tourTitle: review.tour.title,
          supplierResponse: updated.supplierResponse,
          supplierResponseAt: updated.supplierResponseAt
        });

        enqueueNotification({
          userId: review.customerId,
          type: 'REVIEW_RECEIVED',
          title: 'Supplier Responded to Your Review',
          message: `The supplier responded to your review for "${review.tour.title}"`,
          data: { reviewId: review.id, tourId: review.tourId }
        }).catch((err) => console.error('[Notification] enqueueNotification failed:', err.message));

        ack?.({ status: 'success', data: { review: updated } });

        enqueueEvent({
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
        if (!conversationId) return ack?.({ status: 'error', message: 'conversationId required' });

        const effectiveUserId = socket.userRoles.includes('admin')
          ? (await chatService.getSharedAdminId()) || socket.userId
          : socket.userId;

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

        socket.leave(`conversation:${conversationId}`);
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

        if (!participant) {
          console.warn(`[chat:typing] Participant not found: conv=${conversationId}, userId=${effectiveUserId}, socketUserId=${socket.userId}`);
          return;
        }

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

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return ack?.({ status: 'error', message: 'Access denied' });

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

        const participant = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId: effectiveUserId } }
        });

        if (!participant) return;

        socket.to(`conversation:${conversationId}`).emit('chat:delivered', {
          conversationId,
          messageIds,
          deliveredTo: effectiveUserId,
        });

        const recipient = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: { not: effectiveUserId } },
          select: { userId: true }
        });
        if (recipient) {
          io.to(`user:${recipient.userId}`).emit('chat:delivered', {
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

  // Socket.IO manages its own heartbeat (pingInterval/pingTimeout). A
  // socket-level timeout here would destroy idle long-poll and pooled
  // keep-alive connections with no HTTP response (net::ERR_EMPTY_RESPONSE).
  server.timeout = 0;
}
