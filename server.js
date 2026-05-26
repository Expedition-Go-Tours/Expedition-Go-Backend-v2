const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
const event = require('./utils/eventEmitter');
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

    server = http.createServer(app);

    io = new Server(server, {
      cors: {
        origin: process.env.CLIENT_URL,
        credentials: true,
      },
    });

    app.set('io', io);

    io.engine.on('connection_error', (err) => {
      console.warn('Socket.IO connection error:', err.message);
    });

    io.on('connection', (socket) => {
      // WARNING: Currently trusting client-side data. 
      // Suggestion: Verify JWT here before proceeding.
      const { userId, role } = socket.handshake.auth || {};
      console.log('Socket connected:', socket.id, { userId, role });

      if (role === 'admin') { // This needs server-side validation
        socket.join('admin-room');
      }

      if (userId) {
        socket.join(`user:${userId}`);
      }

      // Supplier responds to a review via WebSocket (real-time)
      socket.on('review:respond', async (payload, ack) => {
        try {
          const { reviewId, response } = payload || {};
          if (!reviewId || !response || !response.trim()) {
            return ack?.({ status: 'error', message: 'reviewId and response are required' });
          }
          if (role !== 'supplier') {
            return ack?.({ status: 'error', message: 'Only suppliers can respond to reviews' });
          }

          // Verify review exists and belongs to supplier's tour
          const review = await prisma.review.findFirst({
            where: {
              id: reviewId,
              tour: { supplierId: userId },
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
          }).catch(() => {});

          ack?.({ status: 'success', data: { review: updated } });

          event.emit({
            name: 'review.responded',
            userId,
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
