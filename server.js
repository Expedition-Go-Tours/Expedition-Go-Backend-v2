const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
const { sendNotification } = require('./utils/notificationService');
/* eslint-disable no-console */

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
      server.close(() => process.exit(1));
    } else {
      process.exit(1);
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

          // Also create DB notification
          sendNotification({
            userId: review.customerId,
            type: 'REVIEW_RECEIVED',
            title: 'Supplier Responded to Your Review',
            message: `The supplier responded to your review for "${review.tour.title}"`,
            data: { reviewId: review.id, tourId: review.tourId }
          }).catch(() => {});

          ack?.({ status: 'success', data: { review: updated } });
        } catch (err) {
          console.error('Socket review:respond error:', err);
          ack?.({ status: 'error', message: 'Internal server error' });
        }
      });

      socket.on('disconnect', () => {
        console.log('Socket disconnected:', socket.id);
      });
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`App running on port ${port}...`);
      console.log(`Environment: ${process.env.NODE_ENV}`);
    });
  } catch (err) {
    shutdown('DATABASE CONNECTION FAILED', err);
  }
})();
