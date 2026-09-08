import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { initDb, getDb } from './db/connection.js';
import { startCleanupJobs } from './db/cleanup.js';
import { authenticateSocket } from './middleware/auth.js';
import { setupChatSocket } from './socket/chat.js';
import { setupCallSocket } from './socket/calls.js';
import { setupNotificationSocket } from './socket/notifications.js';
import { setupCommunitySocket } from './socket/communities.js';
import { setupMeetSocket } from './socket/meet.js';
import { sendServerError } from './utils/errors.js';

import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import matchRoutes from './routes/matches.js';
import chatRoutes from './routes/chat.js';
import profileRoutes from './routes/profile.js';
import spotlightRoutes from './routes/spotlight.js';
import privacyRoutes from './routes/privacy.js';
import communityRoutes from './routes/communities.js';
import notificationRoutes from './routes/notifications.js';
import premiumRoutes from './routes/premium.js';
import ratingRoutes from './routes/ratings.js';
import adminRoutes from './routes/admin.js';
import callRoutes from './routes/calls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  // Initialize database (Postgres via Supabase)
  await initDb();
  startCleanupJobs();

  const app = express();

  // Behind Render's proxy
  app.set('trust proxy', 1);

  const server = createServer(app);

  const io = new Server(server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST']
    }
  });

  // Middleware
  app.set('io', io);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true
    })
  );

  // Dev-only request log -- unconditional console.log on every single
  // request is pure noise (and a minor perf cost) once this is deployed
  // and getting real traffic; nothing downstream depends on it.
  if (config.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      console.log('[REQ]', req.method, req.url, 'origin=' + req.headers.origin);
      next();
    });
  }

  app.use(express.json());

  // Static files
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/matches', matchRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/spotlight', spotlightRoutes);
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/communities', communityRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/premium', premiumRoutes);
  app.use('/api/ratings', ratingRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/calls', callRoutes);

  // Root route
  app.get('/', (req, res) => {
    res.json({
      status: 'online',
      app: 'Sniffr API',
      version: '1.0.0'
    });
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString()
    });
  });

  // 404 for unmatched API routes -- must come after every real /api/* route
  // above, otherwise it would shadow them. Otherwise an unmatched API path
  // falls through to Express's own default HTML "Cannot GET" page instead
  // of a clean JSON error.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  });

  // Centralized error handler -- Express requires exactly 4 params for this
  // to be recognized as an error handler (not a regular middleware). Without
  // this, an exception thrown synchronously in a route/middleware (not
  // caught by that route's own try/catch) crashes the whole process instead
  // of returning a clean 500.
  app.use((err, req, res, next) => {
    sendServerError(res, err);
  });

  // Socket.IO authentication
  io.use(authenticateSocket);

  // Socket handlers
  setupChatSocket(io);
  setupCallSocket(io);
  setupNotificationSocket(io);
  setupCommunitySocket(io);
  setupMeetSocket(io);

  // Graceful shutdown -- stop accepting new connections, let in-flight
  // HTTP requests and open sockets finish (bounded by a timeout so a stuck
  // connection can't block the shutdown forever), then close the DB pool.
  // Render sends SIGTERM before killing the process on every deploy/restart;
  // the previous immediate process.exit() dropped in-flight requests.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing gracefully...`);

    const forceExit = setTimeout(() => {
      console.warn('[shutdown] Timed out waiting for connections to close, forcing exit.');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    io.close();
    server.close(async () => {
      try {
        await getDb().end();
      } catch (err) {
        console.error('[shutdown] Error closing DB pool:', err.message);
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.PORT, () => {
    console.log(`🐾 Sniffr server running on http://localhost:${config.PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});