import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';

const router = Router();
router.use(authenticateAccess);
router.use(rateLimiter(config.RATE_LIMIT.GET));

// GET /api/calls/ice-servers -- called by the client right before it
// builds an RTCPeerConnection for a call. TURN credentials must never live
// in the client bundle (anyone can read them straight out of the shipped
// JS), so they stay in server env vars and get handed out here instead,
// to any authenticated user, at the moment they're actually needed.
// STUN is always included as a baseline; TURN is appended only if fully
// configured, so an unset TURN_* leaves calls working exactly as before
// (STUN-only) rather than breaking anything.
router.get('/ice-servers', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (config.TURN_URLS.length && config.TURN_USERNAME && config.TURN_CREDENTIAL) {
    iceServers.push({
      urls: config.TURN_URLS,
      username: config.TURN_USERNAME,
      credential: config.TURN_CREDENTIAL,
    });
  }

  res.json({ iceServers });
});

export default router;
