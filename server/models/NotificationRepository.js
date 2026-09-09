import BaseRepository from './BaseRepository.js';
import db, { withTransaction } from '../db/connection.js';
import PetRepo from './PetRepository.js';
import MatchRepo from './MatchRepository.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';

class NotificationRepository extends BaseRepository {
  constructor() {
    super('notifications');
  }

  // The sender's pet name is already baked into `title`/`description` as
  // flat text at creation time (e.g. "Rex liked your post"), so there's no
  // structured pet object to attach a badge to per-notification card --
  // this looks up the sender pet's owner premium status once and attaches
  // it as `is_premium` so the UI can render the badge alongside the title.
  async _attachSenderPremium(notif) {
    if (!notif) return notif;
    if (!notif.sender_pet_id) { notif.is_premium = false; return notif; }
    const owner = await db.get(
      `SELECT u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date
       FROM pets p JOIN users u ON p.user_id = u.id WHERE p.id = ?`,
      [notif.sender_pet_id]
    );
    notif.is_premium = !!(owner && hasCurrentAccess(owner) && owner.premium_badge_enabled);
    return notif;
  }

  async getPreferences(userId) {
    let pref = await db.get('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
    if (!pref) {
      await db.run(
        'INSERT INTO notification_preferences (user_id, matches, activity, pawcircle, nearby, offers, email) VALUES (?, 1, 1, 1, 1, 1, 1)',
        [userId]
      );
      pref = await db.get('SELECT * FROM notification_preferences WHERE user_id = ?', [userId]);
    }
    return pref;
  }

  async updatePreferences(userId, prefs) {
    const current = await this.getPreferences(userId);
    const keys = ['matches', 'activity', 'pawcircle', 'nearby', 'offers', 'email'];
    const updates = {};
    keys.forEach(k => {
      if (prefs[k] !== undefined) updates[k] = prefs[k] ? 1 : 0;
    });

    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    if (setClause) {
      await db.run(`UPDATE notification_preferences SET ${setClause} WHERE user_id = ?`, [...Object.values(updates), userId]);
    }
    return this.getPreferences(userId);
  }

  async getUnreadCount(userId) {
    const row = await db.get('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0', [userId]);
    return row ? Number(row.count) : 0;
  }

  async getByUserId(userId, { page = 1, limit = 20, category = 'all' } = {}) {
    const offset = (page - 1) * limit;
    let whereSql = 'WHERE user_id = ?';
    const params = [userId];

    if (category && category !== 'all') {
      whereSql += ' AND category = ?';
      params.push(category);
    }

    const notifications = await db.all(
      `SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    await Promise.all(notifications.map(n => this._attachSenderPremium(n)));

    const totalRow = await db.get(`SELECT COUNT(*) as count FROM notifications ${whereSql}`, params);
    const total = totalRow ? Number(totalRow.count) : 0;
    const unreadCount = await this.getUnreadCount(userId);

    return {
      notifications,
      total,
      unreadCount,
      hasMore: offset + limit < total,
      page,
    };
  }

  async markAsRead(id, userId) {
    await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
    return db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  }

  async markAllAsRead(userId) {
    await db.run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
    return { success: true };
  }

  async deleteById(id) {
    const result = await db.run('DELETE FROM notifications WHERE id = ? RETURNING *', [id]);
    return result.rows[0] || null;
  }

  // Writes the past-tense action_status the UI actually checks for
  // ('accepted'/'declined') -- NOT the bare verb from a request body
  // ('accept'/'decline'), which previously caused an accepted request to
  // mis-render as "Request Declined" in NotificationsPanel.jsx.
  async markActionStatus(notificationId, actionStatus) {
    await db.run('UPDATE notifications SET action_status = ?, is_read = 1 WHERE id = ?', [actionStatus, notificationId]);
    return this.findById(notificationId);
  }

  // Accept/Reject pressed directly on a "sniff request" notification card.
  // Delegates the actual state-machine work to MatchRepository so this path
  // and the Pending-tab's POST /matches/pending/:petId/respond share one
  // implementation -- neither duplicates the other's business logic.
  async respondToMatchRequest(notificationId, userId, action) {
    const notif = await db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [notificationId, userId]);
    if (!notif || !notif.sender_pet_id) return null;

    const activePet = await PetRepo.getActivePet(userId);
    if (!activePet) return null;

    let matchResult;
    if (action === 'accept') {
      matchResult = await MatchRepo.acceptMeetRequest(activePet.id, notif.sender_pet_id);
      await this.markActionStatus(notificationId, matchResult.matched ? 'accepted' : 'declined');
    } else {
      matchResult = await MatchRepo.rejectMeetRequest(activePet.id, notif.sender_pet_id);
      await this.markActionStatus(notificationId, 'declined');
    }

    return {
      notification: await this.findById(notificationId),
      matchResult,
      requesterPetId: notif.sender_pet_id,
    };
  }

  // ── Shared grouping helper for lick/comment notifications ──────────
  // Both types now work identically: track actual actor names in
  // metadata_json from the very first event, never parse names out of
  // old title text (that was the root cause of the "New and X others"
  // bug -- it was literally grabbing the word "New" from a hardcoded
  // title string).
  async _createGroupedActivityNotification({
    userId, category, type, targetId, senderPetId, actionStatus,
    avatarUrl, actorName, singleDescription,
  }) {
    // Locked on (userId, type, targetId) -- without this, two near-
    // simultaneous likes/comments on the same post could both read "no
    // recent grouped notification" before either write commits, each
    // INSERTing its own row instead of merging into one, inflating the
    // unread count for what should read as a single grouped notification.
    return withTransaction((tx) => this._createGroupedActivityNotificationLocked(tx, {
      userId, category, type, targetId, senderPetId, actionStatus, avatarUrl, actorName, singleDescription,
    }));
  }

  async _createGroupedActivityNotificationLocked(tx, {
    userId, category, type, targetId, senderPetId, actionStatus,
    avatarUrl, actorName, singleDescription,
  }) {
    await tx.run('SELECT pg_advisory_xact_lock(hashtext(?))', [`notif:${userId}:${type}:${targetId}`]);

    const recent = await tx.get(
      "SELECT * FROM notifications WHERE user_id = ? AND type = ? AND target_id = ? AND created_at > NOW() - INTERVAL '12 hours'",
      [userId, type, targetId]
    );

    let names = [actorName];
    if (recent) {
      try {
        const meta = recent.metadata_json ? JSON.parse(recent.metadata_json) : { names: [] };
        const existingNames = Array.isArray(meta.names) ? meta.names : [];
        names = [actorName, ...existingNames.filter(n => n !== actorName)];
      } catch (e) {
        names = [actorName];
      }
    }

    const count = names.length;
    const verb = type === 'lick' ? 'liked your post' : 'commented on your post';
    let groupedTitle;
    let groupedDescription;

    if (count === 1) {
      // Single actor: show the specific detail (e.g. the actual comment text)
      groupedTitle = type === 'lick' ? `${names[0]} liked your post 🐾` : `${names[0]} commented on your post 💬`;
      groupedDescription = singleDescription || groupedTitle;
    } else if (count === 2) {
      groupedTitle = `${names[0]} and 1 other ${verb} ${type === 'lick' ? '🐾' : '💬'}`;
      // '' not null -- notifications.description is NOT NULL. The client
      // renders this in a bare <p> with no falsy-check, so '' and null are
      // visually identical (an empty line), but null crashed the INSERT/
      // UPDATE outright with a not-null-constraint violation -- this
      // wasn't a race-only bug, it broke on ANY second like/comment on the
      // same post within 12 hours, sequential or not.
      groupedDescription = '';
    } else {
      groupedTitle = `${names[0]} and ${count - 1} others ${verb} ${type === 'lick' ? '🐾' : '💬'}`;
      groupedDescription = '';
    }

    const updatedMeta = JSON.stringify({ names });

    if (recent) {
      await tx.run(
        "UPDATE notifications SET title = ?, description = ?, avatar_url = ?, metadata_json = ?, is_read = 0, created_at = CURRENT_TIMESTAMP WHERE id = ?",
        [groupedTitle, groupedDescription, avatarUrl, updatedMeta, recent.id]
      );
      const updated = await tx.get('SELECT * FROM notifications WHERE id = ?', [recent.id]);
      return this._attachSenderPremium(updated);
    } else {
      const result = await tx.run(
        `INSERT INTO notifications (user_id, category, type, title, description, avatar_url, target_id, sender_pet_id, action_status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [userId, category, type, groupedTitle, groupedDescription, avatarUrl, targetId, senderPetId, actionStatus, updatedMeta]
      );
      const created = await tx.get('SELECT * FROM notifications WHERE id = ?', [result.rows[0].id]);
      return this._attachSenderPremium(created);
    }
  }

  async createNotification({
    userId,
    category,
    type,
    title,
    description,
    avatarUrl = null,
    targetId = null,
    senderPetId = null,
    actionStatus = 'pending',
    metadata = null,
    actorName = null,
  }) {
    // Check preferences
    const prefs = await this.getPreferences(userId);
    if (prefs[category] === 0) return null;

    if ((type === 'lick' || type === 'comment') && targetId && actorName) {
      return this._createGroupedActivityNotification({
        userId, category, type, targetId, senderPetId, actionStatus,
        avatarUrl, actorName, singleDescription: description,
      });
    }

    const metaStr = metadata ? JSON.stringify(metadata) : null;
    const result = await db.run(
      `INSERT INTO notifications (user_id, category, type, title, description, avatar_url, target_id, sender_pet_id, action_status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [userId, category, type, title, description, avatarUrl, targetId, senderPetId, actionStatus, metaStr]
    );

    const created = await db.get('SELECT * FROM notifications WHERE id = ?', [result.rows[0].id]);
    return this._attachSenderPremium(created);
  }
}

export default new NotificationRepository();