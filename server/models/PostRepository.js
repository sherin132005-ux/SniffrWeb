import BaseRepository from './BaseRepository.js';
import db from '../db/connection.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';

function attachPostPremium(post) {
  post.is_premium = !!(hasCurrentAccess({
    subscription_status: post.owner_subscription_status,
    plan_expiry_date: post.owner_plan_expiry_date,
  }) && post.owner_premium_badge_enabled);
  return post;
}

class PostRepository extends BaseRepository {
  constructor() { super('posts'); }

  async getFeed(page = 1, limit = 10, userId = null) {
    const offset = (page - 1) * limit;
    // Over-fetch by one row to detect "is there a next page" instead of a
    // separate SELECT COUNT(*) FROM posts -- at scale that count is a full
    // table scan repeated on every single page request (10x more query work
    // than the actual feed page itself), and the value was never even
    // consumed by any caller (frontend never reads `total`). Fetching
    // limit+1 costs nothing extra over the existing query plan and slicing
    // the spare row off before returning gives the same hasMore signal.
    //
    // is_liked is cast to ::int (like every other COUNT(*) here) -- without
    // it, Postgres returns a BIGINT, which the pg driver hands back as a
    // STRING ("0"/"1") to avoid precision loss. "0" is truthy in JS, so
    // every post rendered as already-liked and toggling it decremented the
    // count instead of incrementing -- this was the actual bug, not a
    // frontend issue. userId is now a bound parameter instead of being
    // string-interpolated into the query text.
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    const params = userId ? [userId, limit + 1, offset] : [limit + 1, offset];
    const rows = await db.all(`
      SELECT p.*, pet.name as pet_name, pet.pet_username, pet.avatar_url as pet_avatar,
        pet.breed_name, pet.age as pet_age, pet.location_text, pet.type as pet_type, pet.id as author_pet_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        u.username as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.is_flagged = 0
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, params);
    const hasMore = rows.length > limit;
    const posts = hasMore ? rows.slice(0, limit) : rows;
    posts.forEach(attachPostPremium);
    return { posts, hasMore };
  }

  async findById(postId, userId = null) {
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    const params = userId ? [userId, postId] : [postId];
    const post = await db.get(`
      SELECT p.*, pet.name as pet_name, pet.pet_username, pet.avatar_url as pet_avatar,
        pet.breed_name, pet.age as pet_age, pet.location_text, pet.type as pet_type, pet.id as author_pet_id,
        pet.user_id as owner_user_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        u.username as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.id = ?
    `, params);
    return post ? attachPostPremium(post) : post;
  }

  async getNewPosts(afterTimestamp, userId = null) {
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    const params = userId ? [userId, afterTimestamp] : [afterTimestamp];
    const posts = await db.all(`
      SELECT p.*, pet.name as pet_name, pet.pet_username, pet.avatar_url as pet_avatar,
        pet.breed_name, pet.age as pet_age, pet.location_text, pet.type as pet_type, pet.id as author_pet_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        u.username as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.is_flagged = 0 AND p.created_at > ?
      ORDER BY p.created_at DESC
    `, params);
    posts.forEach(attachPostPremium);
    return { posts };
  }

  async getByPetId(petId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return db.all(`
      SELECT p.*,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
      (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count
      FROM posts p WHERE p.pet_id = ? AND p.is_flagged = 0 ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `, [petId, limit, offset]);
  }

  // Single atomic statement instead of a SELECT-then-INSERT/DELETE: two
  // near-simultaneous toggles for the same (post, user) -- e.g. a
  // double-tap gesture racing a button click, a flaky network retry, the
  // same account open in two tabs -- used to be able to interleave (both
  // read "not liked", both branch the same way) and leave the row in the
  // wrong final state. Deleting first and only inserting when nothing was
  // deleted keeps the whole toggle inside one statement, so Postgres
  // serializes concurrent callers on the same row via the unique index
  // instead of leaving a gap between the check and the write.
  async toggleLike(postId, userId) {
    const row = await db.get(
      `WITH deleted AS (
         DELETE FROM likes WHERE post_id = ? AND user_id = ? RETURNING 1
       ), inserted AS (
         INSERT INTO likes (post_id, user_id)
         SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted)
         RETURNING 1
       )
       SELECT EXISTS(SELECT 1 FROM inserted) AS liked`,
      [postId, userId, postId, userId]
    );
    return { liked: !!row.liked };
  }

  async getLikeCount(postId) {
    const row = await db.get('SELECT COUNT(*) as count FROM likes WHERE post_id = ?', [postId]);
    return Number(row.count);
  }

  // Returns a flat list (top-level comments and replies interleaved by
  // created_at) rather than a nested tree. Each row's `parent_comment_id`
  // is enough for the client to group replies under their parent -- this
  // matches how the rest of the repo works (flat rows + simple JOINs,
  // no server-built nested structures) and keeps pagination trivial since
  // replies are just more rows, not a second query per parent.
  async getComments(postId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const comments = await db.all(`
      SELECT c.*, u.username, u.full_name, u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date,
        (COALESCE((SELECT avatar_url FROM pets WHERE id = u.active_pet_id), (SELECT avatar_url FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))) as avatar_url
      FROM comments c JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? ORDER BY c.created_at ASC LIMIT ? OFFSET ?
    `, [postId, limit, offset]);
    comments.forEach(c => { c.is_premium = !!(hasCurrentAccess(c) && c.premium_badge_enabled); });
    return comments;
  }

  async addComment(postId, userId, content, parentCommentId = null) {
    // Threads are flattened to one level (like Instagram): replying to a
    // reply still attaches to that reply's top-level ancestor, so a
    // thread never nests more than one level deep. The client already
    // does this when it sends parentCommentId, but resolve it here too
    // so the invariant holds even if a client ever sends a reply's id.
    let resolvedParentId = parentCommentId;
    if (resolvedParentId) {
      const parent = await db.get('SELECT id, parent_comment_id FROM comments WHERE id = ?', [resolvedParentId]);
      if (!parent) {
        resolvedParentId = null;
      } else if (parent.parent_comment_id) {
        resolvedParentId = parent.parent_comment_id;
      }
    }

    const result = await db.run(
      'INSERT INTO comments (post_id, user_id, content, parent_comment_id) VALUES (?, ?, ?, ?) RETURNING id',
      [postId, userId, content, resolvedParentId]
    );
    const newId = result.rows[0].id;
    const comment = await db.get(
      'SELECT c.*, u.username, u.full_name, u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?',
      [newId]
    );
    comment.is_premium = !!(hasCurrentAccess(comment) && comment.premium_badge_enabled);
    return comment;
  }

  async sharePost(postId, userId) {
    await db.run('INSERT INTO shares (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    const row = await db.get('SELECT COUNT(*) as count FROM shares WHERE post_id = ?', [postId]);
    return Number(row.count);
  }

  async reportPost(postId, userId, reason) {
    const existing = await db.get('SELECT id FROM post_reports WHERE post_id = ? AND user_id = ?', [postId, userId]);
    if (!existing) {
      await db.run('INSERT INTO post_reports (post_id, user_id, reason) VALUES (?, ?, ?)', [postId, userId, reason]);
      await db.run('UPDATE posts SET reported_count = reported_count + 1 WHERE id = ?', [postId]);

      const row = await db.get('SELECT reported_count FROM posts WHERE id = ?', [postId]);
      const count = row.reported_count;
      if (count >= 5) {
        await db.run("UPDATE posts SET is_flagged = 1, moderation_status = 'flagged' WHERE id = ?", [postId]);
      }
    }
    return true;
  }

  async toggleReaction(postId, userId, reaction) {
    const existing = await db.get('SELECT id, reaction FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
    if (existing) {
      if (existing.reaction === reaction) {
        await db.run('DELETE FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
        return { removed: true, reaction };
      } else {
        await db.run('UPDATE reactions SET reaction = ? WHERE post_id = ? AND user_id = ?', [reaction, postId, userId]);
        return { updated: true, reaction };
      }
    }
    await db.run('INSERT INTO reactions (post_id, user_id, reaction) VALUES (?, ?, ?)', [postId, userId, reaction]);
    return { added: true, reaction };
  }

  async getReactionCounts(postId) {
    return db.all('SELECT reaction, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY reaction', [postId]);
  }

  async getPostReactions(postId) {
    const rows = await db.all('SELECT reaction, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY reaction', [postId]);
    const result = {};
    rows.forEach(r => { result[r.reaction] = Number(r.count); });
    return result;
  }

  async getUserReaction(postId, userId) {
    const row = await db.get('SELECT reaction FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return row ? row.reaction : null;
  }

  async getReactionUsers(postId) {
    return db.all(`
      SELECT r.reaction, r.user_id, p.name as pet_name, p.avatar_url as pet_avatar, p.pet_username
      FROM reactions r
      JOIN pets p ON r.user_id = p.user_id
      WHERE r.post_id = ?
    `, [postId]);
  }

  // Update a post's caption. Ownership is verified by the calling route
  // BEFORE this is called -- this method itself just performs the update.
  async updateCaption(postId, caption) {
    await db.run('UPDATE posts SET caption = ? WHERE id = ?', [caption, postId]);
    return this.findById(postId);
  }

  async deletePost(postId, userId) {
    const post = await db.get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) return null;

    const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [post.pet_id, userId]);
    if (!pet) return { forbidden: true };

    // likes/comments/reactions/shares/post_reports all have
    // ON DELETE CASCADE on post_id -- deleting the post row alone removes
    // all of them atomically in one statement. The previous 5 separate
    // DELETEs were both redundant and non-atomic among themselves: a
    // dropped connection/timeout partway through could leave engagement
    // data partially wiped while the post row itself still existed.
    await db.run('DELETE FROM posts WHERE id = ?', [postId]);

    return { success: true, pet_id: post.pet_id };
  }

  async deleteComment(commentId, userId) {
    const comment = await db.get('SELECT * FROM comments WHERE id = ?', [commentId]);
    if (!comment) return null;
    if (comment.user_id !== userId) return { forbidden: true };

    // No FK cascade exists on parent_comment_id (see migrations.js) -- a
    // deleted top-level comment must take its own replies with it, or
    // they'd linger in the table pointing at a parent that no longer
    // exists (invisible to the client, but permanently orphaned in the DB).
    await db.run('DELETE FROM comments WHERE parent_comment_id = ?', [commentId]);
    await db.run('DELETE FROM comments WHERE id = ?', [commentId]);

    return { success: true, post_id: comment.post_id, parent_comment_id: comment.parent_comment_id };
  }
}

export default new PostRepository();