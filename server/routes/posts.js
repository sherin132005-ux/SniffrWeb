import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import PostRepo from '../models/PostRepository.js';
import PetRepo from '../models/PetRepository.js';
import SpotlightRepo from '../models/SpotlightRepository.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { checkSpotlightAchievementsForPet } from '../services/spotlightAchievements.js';
import { sendServerError } from '../utils/errors.js';

const router = Router();
router.use(authenticateAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = [...config.ALLOWED_IMAGE_TYPES, ...config.ALLOWED_VIDEO_TYPES];
    cb(null, allowed.includes(file.mimetype));
  }
});

// ── Helper: parse @mentions out of any text (caption OR comment) and
// notify each mentioned pet's owner (skipping the author themselves).
// Reused by both post creation and comment creation below, so mentioning
// someone works the same way no matter where you do it.
async function notifyMentionedPets({ text, authorPet, targetId, io, sourceLabel }) {
  if (!text || !io) return;
  const usernames = [...new Set((text.match(/@([a-zA-Z0-9_]+)/g) || []).map(m => m.slice(1).toLowerCase()))];
  if (usernames.length === 0) return;

  for (const uname of usernames) {
    try {
      const mentionedPet = await db.get(
        "SELECT * FROM pets WHERE LOWER(REPLACE(pet_username, '@', '')) = ?",
        [uname]
      );
      if (!mentionedPet) continue;
      if (mentionedPet.user_id === authorPet.user_id) continue; // never notify yourself

      await sendRealtimeNotification(io, mentionedPet.user_id, {
        category: 'activity',
        type: 'mention',
        title: `${authorPet.name} tagged you in a ${sourceLabel} 🐾`,
        description: `${authorPet.name} mentioned you: "${text.length > 80 ? text.slice(0, 80) + '...' : text}"`,
        avatarUrl: authorPet.avatar_url || null,
        targetId: String(targetId),
        senderPetId: authorPet.id,
      });
    } catch (err) {
      console.error(`[notifyMentionedPets] Failed to notify @${uname}:`, err.message);
    }
  }
}

router.get('/', rateLimiter(config.RATE_LIMIT.GET), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await PostRepo.getFeed(page, limit, req.user.id);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

const incrementalHandler = async (req, res) => {
  try {
    const after = req.body.after || req.query.after;
    if (!after) return res.status(400).json({ error: 'MISSING_AFTER_TIMESTAMP' });
    const result = await PostRepo.getNewPosts(after, req.user.id);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
};

router.post('/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);
router.post('/:id/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);

router.post('/', rateLimiter(config.RATE_LIMIT.POST), upload.single('media'), async (req, res) => {
  try {
    const pet = await PetRepo.findByUserId(req.user.id);
    if (!pet) return res.status(400).json({ error: 'NO_PET', message: 'Create a pet profile first' });

    let mediaUrl = null;
    let mediaType = 'image';
    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'posts');
      mediaUrl = uploaded.url;
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    }

    const caption = req.body.caption || '';
    const post = await PostRepo.create({
      pet_id: pet.id, caption, media_url: mediaUrl, media_type: mediaType
    });

    const postWithAuthor = {
      ...post,
      pet_name: pet.name,
      pet_username: pet.pet_username,
      pet_avatar: pet.avatar_url,
      breed_name: pet.breed_name,
      location_text: pet.location_text,
      pet_type: pet.type,
      author_pet_id: pet.id,
      like_count: 0,
      comment_count: 0,
      share_count: 0,
      is_liked: 0,
      is_premium: pet.is_premium
    };

    const io = req.app.get('io');
    if (io) {
      io.emit('new_post', postWithAuthor);
      const updatedPet = await PetRepo.findById(pet.id);
      io.emit('profile_updated', { pet_id: pet.id, pet: updatedPet });

      await notifyMentionedPets({ text: caption, authorPet: pet, targetId: post.id, io, sourceLabel: 'post' });
    }

    res.status(201).json(postWithAuthor);
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── PUT /api/posts/:id — Edit a post's caption ──────────────────
router.put('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (isNaN(postId)) return res.status(400).json({ error: 'INVALID_ID' });

    const { caption } = req.body;
    if (caption === undefined || caption === null) {
      return res.status(400).json({ error: 'MISSING_CAPTION', message: 'Caption is required' });
    }

    const post = await db.get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) return res.status(404).json({ error: 'POST_NOT_FOUND' });

    const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [post.pet_id, req.user.id]);
    if (!pet) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only edit your own posts.' });

    const updated = await PostRepo.updateCaption(postId, caption.trim());

    const io = req.app.get('io');
    if (io) {
      io.emit('post_updated', { post_id: postId, caption: updated.caption });
    }

    res.json({ success: true, post: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/like', async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const result = await PostRepo.toggleLike(postId, req.user.id);
    const count = await PostRepo.getLikeCount(postId);

    SpotlightRepo.clearCache();

    const io = req.app.get('io');
    if (io) {
      io.emit('post_liked', { post_id: postId, liked: result.liked, like_count: count });
      io.emit('spotlight_updated');
    }

    if (result.liked && io) {
      const post = await PostRepo.findById(postId);
      if (post && post.author_pet_id) {
        const ownerPet = await PetRepo.findById(post.author_pet_id);
        
        // Check immediately if this new like pushed the post owner's
        // pet into a better Spotlight rank, instead of waiting for
        // someone to happen to visit the Spotlight page later.
        checkSpotlightAchievementsForPet(io, post.author_pet_id).catch(() => {});

        if (ownerPet && ownerPet.user_id !== req.user.id) {
        
          const likerPet = await PetRepo.findByUserId(req.user.id);
          if (!likerPet) {
            console.warn(`[posts:like] No active pet found for liking user_id=${req.user.id} -- notification will show a generic name.`);
          }
          const likerName = likerPet?.name || 'Someone';
          await sendRealtimeNotification(io, ownerPet.user_id, {
            category: 'activity',
            type: 'lick',
            title: `${likerName} liked your post 🐾`,
            description: `${likerName} liked your post.`,
            avatarUrl: post.media_url || likerPet?.avatar_url || null,
            targetId: String(postId),
            senderPetId: likerPet?.id || null,
            actorName: likerName,
          });
        }
      }
    }

    res.json({ ...result, likeCount: count });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/share', async (req, res) => {
  try {
    const count = await PostRepo.sharePost(parseInt(req.params.id), req.user.id);

    const io = req.app.get('io');
    if (io) {
      io.emit('post_shared', { post_id: parseInt(req.params.id), share_count: count });
    }

    res.json({ success: true, share_count: count });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/reports', async (req, res) => {
  try {
    const reports = await db.all(`
      SELECT pr.*, COALESCE(pr.status, 'Pending') as status, p.caption, p.media_url, pet.name as pet_name, pet.pet_username
      FROM post_reports pr
      LEFT JOIN posts p ON pr.post_id = p.id
      LEFT JOIN pets pet ON p.pet_id = pet.id
      WHERE pr.user_id = ?
      ORDER BY pr.created_at DESC
    `, [req.user.id]) || [];
    res.json({ reports });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/report', async (req, res) => {
  try {
    const { reason } = req.body;
    await PostRepo.reportPost(parseInt(req.params.id), req.user.id, reason || 'Other');
    res.json({ success: true, message: 'Post reported successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/comments', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const comments = await PostRepo.getComments(parseInt(req.params.id), page);
    res.json({ comments });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/comment', rateLimiter(config.RATE_LIMIT.POST), async (req, res) => {
  try {
    if (!req.body.content?.trim()) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Comment cannot be empty' });
    const postId = parseInt(req.params.id);
    const trimmedContent = req.body.content.trim();
    const parentCommentId = req.body.parentCommentId ? parseInt(req.body.parentCommentId) : null;
    const comment = await PostRepo.addComment(postId, req.user.id, trimmedContent, parentCommentId);

    const io = req.app.get('io');
    if (io) {
      io.emit('post_commented', { post_id: postId, comment });
    }

    if (io) {
      const post = await PostRepo.findById(postId);
      if (post && post.author_pet_id) {
        const ownerPet = await PetRepo.findById(post.author_pet_id);
        const commenterPet = await PetRepo.findByUserId(req.user.id);
        if (!commenterPet) {
          console.warn(`[posts:comment] No active pet found for commenting user_id=${req.user.id} -- notification will show a generic name.`);
        }

        // Notify the post owner about the new comment (skip if commenting on your own post)
        if (ownerPet && ownerPet.user_id !== req.user.id) {
          const commenterName = commenterPet?.name || 'Someone';
          const preview = trimmedContent.length > 80 ? `${trimmedContent.slice(0, 80)}...` : trimmedContent;
          await sendRealtimeNotification(io, ownerPet.user_id, {
            category: 'activity',
            type: 'comment',
            title: `${commenterName} commented on your post 💬`,
            description: `${commenterName} commented: "${preview}"`,
            avatarUrl: post.media_url || commenterPet?.avatar_url || null,
            targetId: String(postId),
            senderPetId: commenterPet?.id || null,
            actorName: commenterName,
          });
        }

        // ── Real "You were tagged" notification for @mentions INSIDE the comment itself ──
        // This is separate from the "new comment" notification above: if you write
        // "so cute @scooby_do" in a comment, Scooby's owner gets notified about being
        // mentioned specifically, even if they're not the post owner.
        if (commenterPet) {
          await notifyMentionedPets({ text: trimmedContent, authorPet: commenterPet, targetId: postId, io, sourceLabel: 'comment' });
        }

        // ── Notify the ORIGINAL comment's author when someone replies ──
        // Independent of the "commented on your post" notification above
        // (which goes to the post owner) -- this goes to whoever actually
        // wrote the comment being replied to, skipping self-replies.
        // comment.parent_comment_id reflects PostRepo.addComment's
        // flattening, so this is always the top-level comment's author.
        if (comment.parent_comment_id) {
          const parentComment = await db.get('SELECT user_id FROM comments WHERE id = ?', [comment.parent_comment_id]);
          if (parentComment && parentComment.user_id !== req.user.id) {
            const replierName = commenterPet?.name || 'Someone';
            const preview = trimmedContent.length > 80 ? `${trimmedContent.slice(0, 80)}...` : trimmedContent;
            await sendRealtimeNotification(io, parentComment.user_id, {
              category: 'activity',
              type: 'comment_reply',
              title: `${replierName} replied to your comment 💬`,
              description: `${replierName} replied: "${preview}"`,
              avatarUrl: post.media_url || commenterPet?.avatar_url || null,
              targetId: String(postId),
              senderPetId: commenterPet?.id || null,
              actorName: replierName,
            });
          }
        }
      }
    }

    res.status(201).json(comment);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Only the comment's own author can delete it -- enforced server-side in
// PostRepo.deleteComment (mirrors PostRepo.deletePost's forbidden check),
// never trusted from the client.
router.delete('/:postId/comment/:commentId', async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId, 10);
    const result = await PostRepo.deleteComment(commentId, req.user.id);
    if (!result) return res.status(404).json({ error: 'COMMENT_NOT_FOUND' });
    if (result.forbidden) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only delete your own comments.' });

    const io = req.app.get('io');
    if (io) {
      io.emit('comment_deleted', { post_id: result.post_id, comment_id: commentId, parent_comment_id: result.parent_comment_id });
    }

    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/react', async (req, res) => {
  try {
    const { reaction } = req.body;
    const validReactions = ['paw', 'bone', 'fish', 'sleep', 'love'];
    if (!validReactions.includes(reaction)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid reaction type' });
    }

    const result = await PostRepo.toggleReaction(parseInt(req.params.id), req.user.id, reaction);
    const reactions = await PostRepo.getPostReactions(parseInt(req.params.id));

    const io = req.app.get('io');
    if (io) {
      io.emit('post_reacted', { post_id: parseInt(req.params.id), reactions, result });
    }

    res.json({ success: true, ...result, reactions });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/reactions', async (req, res) => {
  try {
    const list = await PostRepo.getReactionUsers(parseInt(req.params.id));
    res.json({ reactions: list });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const result = await PostRepo.deletePost(postId, req.user.id);
    if (!result) return res.status(404).json({ error: 'POST_NOT_FOUND' });
    if (result.forbidden) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only delete your own posts.' });

    SpotlightRepo.clearCache();

    const io = req.app.get('io');
    if (io) {
      io.emit('post_deleted', { post_id: postId, pet_id: result.pet_id });
      const updatedPet = await PetRepo.findById(result.pet_id);
      if (updatedPet) {
        io.emit('profile_updated', { pet_id: result.pet_id, pet: updatedPet });
      }
      io.emit('spotlight_updated');
    }

    res.json({ success: true, message: 'Memory deleted permanently.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const post = await PostRepo.findById(parseInt(req.params.id), req.user.id);
    if (!post) return res.status(404).json({ error: 'POST_NOT_FOUND', message: 'Post not found' });
    // getFeed/getNewPosts already hide flagged posts -- this direct-fetch
    // route didn't, so a post auto-flagged after enough reports remained
    // fully viewable/likeable/commentable via its own URL even though it
    // had disappeared from the feed. The owner can still see their own
    // flagged post (e.g. to know it was flagged).
    if (post.is_flagged && post.owner_user_id !== req.user.id) {
      return res.status(404).json({ error: 'POST_NOT_FOUND', message: 'Post not found' });
    }
    res.json({ post });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;