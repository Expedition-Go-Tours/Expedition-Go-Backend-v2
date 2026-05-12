const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');
const prisma = require('./utils/prismaClient');
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
