import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import MessageRepo from '../models/MessageRepository.js';
import CallRepo from '../models/CallRepository.js';
import PetRepo from '../models/PetRepository.js';
import UserRepo from '../models/UserRepository.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // Includes ALLOWED_AUDIO_TYPES -- without it, voice notes (audio/webm)
    // were silently dropped by this filter: Multer just skips a rejected
    // file with no error, so the message got created with no media
    // attached at all, which is why it could never play back.
    const allowed = [...config.ALLOWED_IMAGE_TYPES, ...config.ALLOWED_VIDEO_TYPES, ...config.ALLOWED_AUDIO_TYPES];
    cb(null, allowed.includes(file.mimetype));
  }
});

router.get('/conversations', async (req, res) => {
  try {
    const conversations = await MessageRepo.getConversations(req.user.id);
    res.json({ conversations });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/conversations', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { recipientPetId } = req.body;
    const senderPet = await PetRepo.findByUserId(req.user.id);
    if (!senderPet) return res.status(404).json({ error: 'NO_PET' });

    const recipientPet = await PetRepo.findById(parseInt(recipientPetId));
    if (!recipientPet) return res.status(404).json({ error: 'RECIPIENT_NOT_FOUND' });
    if (await UserRepo.isBlocked(req.user.id, recipientPet.user_id)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'You cannot start a conversation with this user.' });
    }

    const conv = await MessageRepo.findOrCreateConversation(senderPet.id, parseInt(recipientPetId));
    res.json({ conversation: conv });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/conversations/:id', async (req, res) => {
  try {
    const deleted = await MessageRepo.deleteEmptyConversation(parseInt(req.params.id), req.user.id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'CANNOT_DELETE', message: 'Only empty conversations can be removed.' });
    }
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/messages/:conversationId', async (req, res) => {
  try {
    const access = await MessageRepo.canAccessConversation(parseInt(req.params.conversationId), req.user.id);
    if (!access) return res.status(403).json({ error: 'FORBIDDEN' });
    const page = parseInt(req.query.page) || 1;
    const messages = await MessageRepo.getMessages(parseInt(req.params.conversationId), page);
    res.json({ messages });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/messages/:id/fetch-back', async (req, res) => {
  try {
    const updated = await MessageRepo.fetchBackMessage(parseInt(req.params.id), req.user.id);
    if (!updated) {
      return res.status(400).json({ error: 'CANNOT_FETCH_BACK', message: 'Message not found or you are not the sender.' });
    }
    const io = req.app.get('io');
    if (io && updated.conversation_id) {
      io.to(`conv_${updated.conversation_id}`).emit('message_updated', updated);
    }
    res.json({ success: true, message: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/messages', rateLimiter(config.RATE_LIMIT.POST), upload.single('media'), async (req, res) => {
  try {
    const { conversationId, content } = req.body;
    const access = await MessageRepo.canAccessConversation(parseInt(conversationId), req.user.id);
    if (!access) return res.status(403).json({ error: 'FORBIDDEN' });

    const otherUserId = await MessageRepo.getOtherParticipantUserId(parseInt(conversationId), req.user.id);
    if (otherUserId && await UserRepo.isBlocked(req.user.id, otherUserId)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'You cannot message this user.' });
    }

    let mediaUrl = null;
    let messageType = 'text';
    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'chat');
      mediaUrl = uploaded.url;
      messageType = req.file.mimetype.startsWith('audio') ? 'voice'
        : req.file.mimetype.startsWith('video') ? 'video' : 'image';
    }

    const message = await MessageRepo.sendMessage(parseInt(conversationId), req.user.id, content || '', mediaUrl, messageType);

    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${conversationId}`).emit('message_received', message);
    }

    res.status(201).json(message);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.patch('/messages/seen/:conversationId', async (req, res) => {
  try {
    const conversationId = parseInt(req.params.conversationId);
    const access = await MessageRepo.canAccessConversation(conversationId, req.user.id);
    if (!access) return res.status(403).json({ error: 'FORBIDDEN' });
    await MessageRepo.markSeen(conversationId, req.user.id);
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/share', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { postId, recipientPetId, recipientIds, recipientPetIds } = req.body;
    const targetPetId = recipientPetId ||
      (Array.isArray(recipientIds) ? recipientIds[0] : null) ||
      (Array.isArray(recipientPetIds) ? recipientPetIds[0] : null);

    if (!targetPetId) {
      return res.status(400).json({ error: 'INVALID_RECIPIENT', message: 'Unable to send the post. Please try again.' });
    }

    const senderPet = await PetRepo.findByUserId(req.user.id);
    if (!senderPet) return res.status(404).json({ error: 'NO_PET', message: 'Unable to send the post. Please try again.' });

    const recipientPet = await PetRepo.findById(targetPetId);
    if (!recipientPet) {
      return res.status(404).json({ error: 'RECIPIENT_NOT_FOUND', message: 'Unable to send the post. Please try again.' });
    }
    if (await UserRepo.isBlocked(req.user.id, recipientPet.user_id)) {
      return res.status(403).json({ error: 'BLOCKED', message: 'Unable to send the post. Please try again.' });
    }

    const conv = await MessageRepo.findOrCreateConversation(senderPet.id, targetPetId);
    if (!conv) {
      return res.status(500).json({ error: 'CONVERSATION_FAILED', message: 'Unable to send the post. Please try again.' });
    }

    const content = `🐾 Shared a post: https://sniffr.app/post/${postId}`;
    const message = await MessageRepo.sendMessage(conv.id, req.user.id, content, String(postId), 'shared_post');

    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${conv.id}`).emit('message_received', message);
    }

    res.json({
      success: true,
      sharedWith: recipientPet.name,
      conversationId: conv.id,
      message
    });
  } catch (err) {
    console.error('Share error:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Unable to send the post. Please try again.' });
  }
});

// ─── Call History ───────────────────────────────────────────
router.get('/calls/history', async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(404).json({ error: 'NO_PET' });
    const history = await CallRepo.getHistory(pet.id);
    res.json({ history });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Log a call after it ends
router.post('/calls/log', async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(404).json({ error: 'NO_PET' });

    const { receiverPetId, type, status, duration, declinedBy, start_time, end_time } = req.body;

    // Validate inputs
    const validTypes = ['audio', 'video'];
    const validStatuses = ['completed', 'missed', 'declined', 'failed'];
    if (!validTypes.includes(type)) return res.status(400).json({ error: 'INVALID_TYPE' });
    if (!validStatuses.includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });

    const call = await CallRepo.log({
      callerPetId: pet.id,
      receiverPetId: parseInt(receiverPetId),
      type,
      status,
      duration: parseInt(duration) || 0,
      declinedBy: declinedBy || null,
      start_time: start_time || null,
      end_time: end_time || null,
    });
    res.status(201).json({ call });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ─── Search ─────────────────────────────────────────────────
/**
 * Search pets by name or username.
 * Returns "No wagging tails" message is handled client-side.
 */
router.get('/search', async (req, res) => {
  try {
    const query = (req.query.q || '').trim();
    if (!query) return res.json({ results: [] });

    const myPet = await PetRepo.findByUserId(req.user.id);
    const results = await PetRepo.searchByQuery(query, myPet?.id);
    const blockedUserIds = await UserRepo.getBlockedUserIds(req.user.id);
    res.json({ results: results.filter(p => !blockedUserIds.includes(p.user_id)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

/**
 * Get nearby pets for the chat "Nearby Pets" section.
 * Uses the same haversine logic as discover but without swipe exclusions.
 */
router.get('/nearby', async (req, res) => {
  try {
    const myPet = await PetRepo.findByUserId(req.user.id);
    if (!myPet) return res.json({ pets: [] });

    // Honest fallback chain: real query params (live GPS from the client) >
    // the pet's own saved profile location (real data) > explicit
    // NO_LOCATION -- never a hardcoded coordinate that implies location
    // data which doesn't actually exist. isNaN checks (not `||`) because a
    // real lat of 0 (the equator) is falsy and would otherwise be
    // incorrectly treated as "not provided".
    const queryLat = parseFloat(req.query.lat);
    const queryLng = parseFloat(req.query.lng);
    const lat = !isNaN(queryLat) ? queryLat : myPet.latitude;
    const lng = !isNaN(queryLng) ? queryLng : myPet.longitude;

    if (lat == null || lng == null) {
      return res.json({ error: 'NO_LOCATION', pets: [] });
    }

    const radius = Math.min(parseFloat(req.query.radius) || 25, 100);

    const pets = await PetRepo.findNearbyAll(lat, lng, radius, myPet.id, 20);
    const blockedUserIds = await UserRepo.getBlockedUserIds(req.user.id);
    res.json({ pets: pets.filter(p => !blockedUserIds.includes(p.user_id)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/meetup/:messageId', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({ error: 'INVALID_STATUS' });
    }

    const messageId = parseInt(req.params.messageId);
    const msg = await MessageRepo.findById(messageId);
    if (!msg) return res.status(404).json({ error: 'NOT_FOUND' });

    const access = await MessageRepo.canAccessConversation(msg.conversation_id, req.user.id);
    if (!access) return res.status(403).json({ error: 'FORBIDDEN' });

    let parsed;
    try {
      parsed = JSON.parse(msg.content);
    } catch {
      return res.status(400).json({ error: 'INVALID_MEETUP_MESSAGE' });
    }

    parsed.status = status;
    const updatedContent = JSON.stringify(parsed);
    const updatedMessage = await MessageRepo.updateMessageContent(messageId, updatedContent);

    const io = req.app.get('io');
    if (io) {
      io.to(`conv_${msg.conversation_id}`).emit('message_received', updatedMessage);
    }

    res.json({ message: updatedMessage });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;