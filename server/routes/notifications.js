import { Router } from 'express';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import NotificationRepo from '../models/NotificationRepository.js';
import PetRepo from '../models/PetRepository.js';
import { notifyMeetMatch } from '../services/meetNotifications.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);
router.use(rateLimiter(config.RATE_LIMIT.GET));

// GET /api/notifications (with pagination & category filtering)
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const category = req.query.category || 'all';

    const result = await NotificationRepo.getByUserId(req.user.id, { page, limit, category });
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req, res) => {
  try {
    const unreadCount = await NotificationRepo.getUnreadCount(req.user.id);
    res.json({ unreadCount });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res) => {
  try {
    const updated = await NotificationRepo.markAsRead(parseInt(req.params.id, 10), req.user.id);
    if (!updated) return res.status(404).json({ error: 'NOT_FOUND' });
    const unreadCount = await NotificationRepo.getUnreadCount(req.user.id);
    res.json({ success: true, notification: updated, unreadCount });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await NotificationRepo.markAllAsRead(req.user.id);
    res.json({ success: true, unreadCount: 0 });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/notifications/match-request/:id/respond
// Handles Accept/Reject pressed directly on a sniff-request notification
// card. Shares its actual state-machine logic with
// POST /matches/pending/:petId/respond via
// MatchRepository.acceptMeetRequest/rejectMeetRequest (see
// NotificationRepository.respondToMatchRequest) -- this route only owns the
// HTTP shape and the resulting notification fan-out.
router.post('/match-request/:id/respond', async (req, res) => {
  try {
    const { action } = req.body; // 'accept' | 'decline'
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ error: 'INVALID_ACTION', message: 'action must be accept or decline' });
    }

    const result = await NotificationRepo.respondToMatchRequest(parseInt(req.params.id, 10), req.user.id, action);
    if (!result) return res.status(404).json({ error: 'NOT_FOUND' });

    if (result.matchResult && !result.matchResult.matched && !result.matchResult.rejected) {
      return res.status(410).json({ error: 'EXPIRED', message: 'This request is no longer available.' });
    }

    const io = req.app.get('io');
    if (io) {
      const myPet = await PetRepo.getActivePet(req.user.id);
      const requesterPet = result.requesterPetId ? await PetRepo.findById(result.requesterPetId) : null;

      if (action === 'accept' && result.matchResult?.matched && myPet && requesterPet) {
        // Notifies BOTH users -- "🐾 The sniff was mutual!" -- one shared implementation.
        await notifyMeetMatch(io, result.matchResult.matchId, myPet, requesterPet);
      } else if (action === 'decline' && requesterPet) {
        // No visible notification is ever sent on reject (per spec) -- this is a
        // silent, non-notification socket signal purely so the requester's own
        // device drops the resolved entry from Requested without a manual reload.
        io.to(`user_${requesterPet.user_id}`).emit('meet_request_declined', {
          fromPetId: result.requesterPetId,
          toPetId: myPet?.id,
        });
      }
    }

    const unreadCount = await NotificationRepo.getUnreadCount(req.user.id);
    res.json({ success: true, ...result, unreadCount });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/notifications/preferences
router.get('/preferences', async (req, res) => {
  try {
    const preferences = await NotificationRepo.getPreferences(req.user.id);
    res.json({ preferences });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST /api/notifications/preferences
router.post('/preferences', async (req, res) => {
  try {
    const preferences = await NotificationRepo.updatePreferences(req.user.id, req.body);
    res.json({ success: true, preferences });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;