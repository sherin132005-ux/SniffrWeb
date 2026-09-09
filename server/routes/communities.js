import { Router } from 'express';
import multer from 'multer';
import CommunityRepo from '../models/CommunityRepository.js';
import PetRepo from '../models/PetRepository.js';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { canCreateCommunity, canJoinCommunity } from '../services/premiumGate.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);

const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_VIDEO = ['video/mp4', 'video/quicktime', 'video/webm'];
const ALL_ALLOWED = [...ALLOWED_IMAGE, ...ALLOWED_VIDEO];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALL_ALLOWED.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPG, PNG, WEBP, MP4, MOV, WEBM.`));
    }
    cb(null, true);
  }
});

async function requireRole(communityId, userId, allowedRoles) {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [communityId, userId]
  );
  if (!member) return { ok: false, status: 403, error: 'NOT_A_MEMBER', message: 'You must be a member of this PawCircle to do this.' };
  if (!allowedRoles.includes(member.role)) {
    return { ok: false, status: 403, error: 'INSUFFICIENT_ROLE', message: 'Only the Owner or an Admin can do this.' };
  }
  return { ok: true, role: member.role };
}

router.get('/validate', async (req, res) => {
  try {
    const name = (req.query.name || '').trim();
    if (!name) return res.json({ available: false });
    const existing = await db.get('SELECT id FROM communities WHERE LOWER(name) = LOWER(?)', [name]);
    res.json({ available: !existing });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', available: false });
  }
});

router.get('/', async (req, res) => {
  try {
    const { q, category, breed, pet_type, city, tags, recommended } = req.query;
    const userId = req.user.id;

    if (recommended === 'true') {
      const pet = await PetRepo.findByUserId(userId);
      const recs = await CommunityRepo.getRecommendedForPet(pet);
      const withStatus = await Promise.all(recs.map(c => CommunityRepo.getDetailsWithStatus(c.id, userId)));
      return res.json({ communities: withStatus });
    }

    const results = await CommunityRepo.search({ q, category, breed, pet_type, city, tags });
    const withStatus = await Promise.all(results.map(c => CommunityRepo.getDetailsWithStatus(c.id, userId)));
    res.json({ communities: withStatus });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const io = req.app.get('io');
    const premiumCheck = await canCreateCommunity(req.user.id, io);
    if (!premiumCheck.allowed) {
      return res.status(403).json({
        error: premiumCheck.reason,
        message: `Free accounts can create up to ${premiumCheck.limit} PawCircles. Upgrade to Premium to create unlimited PawCircles.`,
        plan: premiumCheck.plan,
        limit: premiumCheck.limit,
      });
    }

    const {
      name, description, category, breed, pet_type, city,
      cover_image = '/communities/general.jpg',
      icon_image = 'groups',
      is_private = 0,
      rules = '1. Be kind and respectful to all pet parents.\n2. Keep vaccinations up to date.\n3. No spam.',
      tags
    } = req.body;

    if (!name) return res.status(400).json({ error: 'MISSING_NAME', message: 'Community name is required' });
    const existing = await db.get('SELECT id FROM communities WHERE LOWER(name) = LOWER(?)', [name.trim()]);
    if (existing) {
      return res.status(400).json({ error: 'DUPLICATE_NAME', message: 'This community name is already taken.' });
    }

    const invite_code = `PAW-${Math.random().toString(36).substring(2, 8).toUpperCase()}-${new Date().getFullYear()}`;
    const community = await CommunityRepo.create({
      name,
      description: description || '',
      category: category || 'General',
      breed: breed || '',
      pet_type: pet_type || 'All',
      city: city || 'India',
      cover_image,
      icon_image,
      is_private: is_private ? 1 : 0,
      rules,
      created_by: req.user.id,
      member_count: 1,
      invite_code,
      tags: tags || ''
    });

    await CommunityRepo.join(community.id, req.user.id, 'Owner');

    const details = await CommunityRepo.getDetailsWithStatus(community.id, req.user.id);
    res.status(201).json({ community: details });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const community = await CommunityRepo.getDetailsWithStatus(req.params.id, req.user.id);
    if (!community) return res.status(404).json({ error: 'NOT_FOUND', message: 'PawCircle community not found' });
    res.json({ community });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/delete-group', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const userId = req.user.id;
    await CommunityRepo.deleteGroupForUser(communityId, userId);
    res.json({ success: true, message: 'PawCircle group deleted locally.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/report', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const { reason, details } = req.body;
    await db.run(
      `INSERT INTO post_reports (user_id, reason, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [req.user.id, `Community #${req.params.id}: ${reason}${details ? ` - ${details}` : ''}`]
    );
    res.json({ success: true, message: 'Report submitted successfully.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/disable', async (req, res) => {
  try {
    const communityId = req.params.id;
    const community = await CommunityRepo.findById(communityId);
    if (!community) return res.status(404).json({ error: 'NOT_FOUND' });

    // Checks the live 'Owner' role in community_members, not the static
    // communities.created_by column -- Owner can be transferred to another
    // member (see POST /:id/members/:userId/role), and created_by is never
    // updated when that happens, which previously left the NEW Owner
    // unable to disable the community while the original creator (possibly
    // now just a Member) retained sole rights.
    const member = await db.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, req.user.id]);
    if (!member || member.role !== 'Owner') {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Only the Owner can disable this PawCircle.' });
    }

    await db.run('UPDATE communities SET is_private = 1 WHERE id = ?', [communityId]);
    await CommunityRepo.deleteGroupForUser(communityId, req.user.id);
    res.json({ success: true, message: 'PawCircle disabled successfully.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── POST /api/communities/:id/join ──────────────────────────────
// Now sends a REAL notification to the community's Owner and Admins
// (not just a chat system message, as before). Reuses the same
// sendRealtimeNotification infrastructure and category: 'pawcircle',
// which the frontend NotificationsPanel already knows how to route
// (navigates to /community/:id) -- no frontend changes were needed.
router.post('/:id/join', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const io = req.app.get('io');
    const premiumCheck = await canJoinCommunity(req.user.id, io);
    if (!premiumCheck.allowed) {
      return res.status(403).json({
        error: premiumCheck.reason,
        message: `Free accounts can join up to ${premiumCheck.limit} PawCircles. Upgrade to Premium to join unlimited PawCircles.`,
        plan: premiumCheck.plan,
        limit: premiumCheck.limit,
      });
    }

    const communityId = parseInt(req.params.id, 10);
    const updated = await CommunityRepo.join(communityId, req.user.id, 'Member');

    const pet = await PetRepo.findByUserId(req.user.id);
    const petName = pet ? pet.name : 'A new playmate';

    const welcomeMsg = await CommunityRepo.addMessage({
      community_id: communityId,
      sender_id: req.user.id,
      content: `🐾 ${petName} joined the pack!`,
      message_type: 'system'
    });

    if (io) {
      io.to(`pawcircle_${communityId}`).emit('community_message_received', welcomeMsg);

      // Notify Owner + Admins (never the joiner themselves)
      const community = await CommunityRepo.findById(communityId);
      const leadership = await db.all(
        "SELECT user_id FROM community_members WHERE community_id = ? AND role IN ('Owner', 'Admin')",
        [communityId]
      );
      for (const leader of leadership) {
        if (leader.user_id === req.user.id) continue;
        await sendRealtimeNotification(io, leader.user_id, {
          category: 'pawcircle',
          type: 'community_join',
          title: `${petName} joined ${community?.name || 'your PawCircle'}! 🐾`,
          description: `${petName} just joined your PawCircle.`,
          avatarUrl: pet?.avatar_url || null,
          targetId: String(communityId),
          senderPetId: pet?.id || null,
          metadata: { community_id: communityId },
        });
      }
    }

    res.json({ community: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/members/:userId/role', async (req, res) => {
  try {
    const { role } = req.body;
    const communityId = req.params.id;
    const targetUserId = parseInt(req.params.userId);
    const requesterId = req.user.id;

    const requesterMember = await db.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, requesterId]);
    if (!requesterMember) return res.status(403).json({ error: 'FORBIDDEN' });

    const allowedRoles = ['Owner', 'Admin', 'Moderator', 'Member'];
    if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'INVALID_ROLE' });

    const targetMember = await db.get('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, targetUserId]);
    if (!targetMember) return res.status(404).json({ error: 'MEMBER_NOT_FOUND' });

    if (requesterMember.role === 'Owner') {
      // Owner has full control
    } else if (requesterMember.role === 'Admin') {
      if (targetMember.role === 'Owner' || targetMember.role === 'Admin') {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
      if (role === 'Owner' || role === 'Admin') {
        return res.status(403).json({ error: 'FORBIDDEN' });
      }
    } else {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }

    await db.run('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?', [role, communityId, targetUserId]);
    res.json({ success: true, role });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/leave', async (req, res) => {
  try {
    const result = await CommunityRepo.leave(req.params.id, req.user.id);
    res.json({ success: true, deleted: !!result.deleted });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/members', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await CommunityRepo.getMembersPaginated(communityId, page, limit);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/announcements', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const announcements = await CommunityRepo.getAnnouncements(communityId, req.query.highlightId);
    res.json({ announcements });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/announcements', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);

    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const { title, content, latitude, longitude, is_event } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Title and content are required' });

    const isEvent = (is_event === true || is_event === 1 || is_event === '1') && latitude != null && longitude != null;
    const lat = isEvent ? parseFloat(latitude) : null;
    const lng = isEvent ? parseFloat(longitude) : null;

    const announcement = await CommunityRepo.addAnnouncement({
      community_id: communityId,
      sender_id: req.user.id,
      title,
      content,
      latitude: lat,
      longitude: lng,
      is_event: isEvent ? 1 : 0
    });

    const io = req.app.get('io');
    if (io) {
      const community = await CommunityRepo.findById(communityId);
      const preview = content.length > 100 ? `${content.slice(0, 100)}...` : content;

      const members = await CommunityRepo.getMembers(communityId);
      await Promise.all(members
        .filter(member => member.user_id !== req.user.id)
        .map(member => sendRealtimeNotification(io, member.user_id, {
          category: 'pawcircle',
          type: 'community_announcement',
          title: `${community?.name || 'PawCircle'} Announcement 📢`,
          description: `${title}: ${preview}`,
          avatarUrl: community?.icon_image || null,
          targetId: String(communityId),
          senderPetId: null,
          metadata: { community_id: communityId },
        })));

      if (isEvent) {
        const nearbyNonMembers = await CommunityRepo.getNearbyNonMembers(communityId, lat, lng, 20);
        await Promise.all(nearbyNonMembers
          .filter(target => target.user_id !== req.user.id)
          .map(target => sendRealtimeNotification(io, target.user_id, {
            category: 'nearby',
            type: 'nearby_event',
            title: 'Nearby Event 📍',
            description: `${title} — happening near you! Hosted by ${community?.name || 'a PawCircle'}.`,
            avatarUrl: community?.icon_image || null,
            targetId: String(communityId),
            senderPetId: null,
            metadata: { community_id: communityId, is_event: true },
          })));
      }
    }

    res.status(201).json({ announcement });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/messages', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const messages = await CommunityRepo.getMessages(communityId, req.user.id);
    res.json({ messages });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/messages', rateLimiter(config.RATE_LIMIT.POST), upload.single('media'), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const { content, reply_to_id } = req.body;
    let media_url = req.body.media_url || null;

    if (req.file) {
      const isImage = req.file.mimetype.startsWith('image/');
      if (isImage && req.file.size > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'Image must be under 10MB.' });
      }
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'community_media');
      media_url = uploaded.url;
    }

    if (!content && !media_url) return res.status(400).json({ error: 'MISSING_CONTENT' });

    const message = await CommunityRepo.addMessage({
      community_id: communityId,
      sender_id: req.user.id,
      content: content || '',
      media_url: media_url || null,
      reply_to_id: reply_to_id || null
    });

    const io = req.app.get('io');
    if (io) {
      io.to(`pawcircle_${communityId}`).emit('community_message_received', message);
    }

    res.status(201).json({ message });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/photos', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const photos = await CommunityRepo.getPhotos(communityId);
    res.json({ photos });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/photos', rateLimiter(config.RATE_LIMIT.POST), upload.single('media'), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    if (!req.file) return res.status(400).json({ error: 'MISSING_FILE', message: 'A photo or video is required.' });

    const isImage = req.file.mimetype.startsWith('image/');
    if (isImage && req.file.size > MAX_IMAGE_SIZE) {
      return res.status(400).json({ error: 'FILE_TOO_LARGE', message: 'Image must be under 10MB.' });
    }

    const uploaded = await uploadWithQuota(req.user.id, req.file, 'community_photos');
    const media_url = uploaded.url;

    const photo = await CommunityRepo.addPhoto({
      community_id: communityId,
      user_id: req.user.id,
      media_url,
      caption: req.body.caption || ''
    });
    res.status(201).json({ photo });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const events = await CommunityRepo.getEvents(communityId);
    res.json({ events });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/polls', async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const polls = await CommunityRepo.getPolls(communityId);
    res.json({ polls });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/polls/:pollId/vote', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    const communityId = parseInt(req.params.id, 10);
    const roleCheck = await requireRole(communityId, req.user.id, ['Owner', 'Admin', 'Moderator', 'Member']);
    if (!roleCheck.ok) {
      return res.status(roleCheck.status).json({ error: roleCheck.error, message: roleCheck.message });
    }

    const { optionIndex } = req.body;
    const updated = await CommunityRepo.votePoll(communityId, parseInt(req.params.pollId, 10), req.user.id, optionIndex);
    res.json({ poll: updated });
  } catch (err) {
    if (err.message === 'Poll not found') return res.status(404).json({ error: 'POLL_NOT_FOUND' });
    sendServerError(res, err);
  }
});

export default router;