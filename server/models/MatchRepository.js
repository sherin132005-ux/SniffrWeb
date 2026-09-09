import BaseRepository from './BaseRepository.js';
import db, { withTransaction } from '../db/connection.js';

// Explicit sniff-request state machine (see swipes.request_status):
//   'awaiting'  -- a live request, pending the recipient's Accept/Reject
//   'accepted'  -- resolved into a real match (permanent, never expires)
//   'rejected'  -- a 30-day cooldown between these two pet profiles
// `expires_at` is set for BOTH 'awaiting' and 'rejected' (30 days out) and
// left NULL only for 'accepted' -- a single "is this row still active"
// check (`expires_at IS NULL OR expires_at > NOW()`) covers pending-request
// expiry and rejection-cooldown expiry with one predicate, and requires no
// cleanup job: the next swipe between the same pair just overwrites the
// stale row in place via the existing UNIQUE(from_pet_id, to_pet_id).
class MatchRepository extends BaseRepository {
  constructor() { super('matches'); }

  /**
   * Meet Feed Visibility Exclusions:
   * 1. Own Pet ID.
   * 2. Permanent Exclusion: real Meet matches only (matches.source = 'meet') --
   *    a match row created by direct-messaging a pet you never Meet-matched
   *    with (see MessageRepository.findOrCreateConversation) does NOT count.
   * 3. Already-chatting Exclusion: any pet you share a conversation with that
   *    has at least one real message, regardless of how that conversation
   *    started. An empty, message-less conversation does not exclude.
   * 4. Live Request/Cooldown Exclusion (bidirectional): any pet with an
   *    'awaiting' or 'rejected' swipes row between you that hasn't expired --
   *    covers both "there's a pending sniff in either direction" and the
   *    30-day rejection cooldown with one query.
   */
  async getExcludedMeetPetIds(petId) {
    const excluded = new Set();
    excluded.add(petId);

    const matches = await db.all(
      "SELECT pet1_id, pet2_id FROM matches WHERE source = 'meet' AND (pet1_id = ? OR pet2_id = ?)",
      [petId, petId]
    );
    matches.forEach(m => {
      excluded.add(m.pet1_id === petId ? m.pet2_id : m.pet1_id);
    });

    const chattingWith = await db.all(
      `SELECT DISTINCT CASE WHEN m.pet1_id = ? THEN m.pet2_id ELSE m.pet1_id END as other_pet_id
       FROM matches m
       JOIN conversations c ON c.match_id = m.id
       WHERE (m.pet1_id = ? OR m.pet2_id = ?)
         AND EXISTS (SELECT 1 FROM messages msg WHERE msg.conversation_id = c.id)`,
      [petId, petId, petId]
    );
    chattingWith.forEach(r => excluded.add(r.other_pet_id));

    const liveRequests = await db.all(
      `SELECT from_pet_id, to_pet_id FROM swipes
       WHERE request_status IN ('awaiting', 'rejected')
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (from_pet_id = ? OR to_pet_id = ?)`,
      [petId, petId]
    );
    liveRequests.forEach(r => {
      excluded.add(r.from_pet_id === petId ? r.to_pet_id : r.from_pet_id);
    });

    return Array.from(excluded);
  }

  async getSwipedIds(petId) {
    return this.getExcludedMeetPetIds(petId);
  }

  /**
   * Fresh swipe-card action (right = 'awaiting', left = 'rejected'). Never
   * itself creates a match -- a swipe is not an Accept. If the OTHER pet
   * already has a live, unresolved request out to this pet, the swipe is
   * ignored entirely (no row written in either direction, no notification):
   * that existing request remains the single source of truth and must be
   * resolved via an explicit Accept/Reject, not by a swipe crossing it.
   * This is what structurally prevents a pending request from ever existing
   * in both directions at once.
   */
  async createPendingSwipeAction(fromPetId, toPetId, kind) {
    // Everything below runs inside one transaction holding a Postgres
    // advisory lock keyed on the unordered (fromPetId, toPetId) pair --
    // without it, two swipes racing within milliseconds (A->B and B->A at
    // the same instant, or the same swipe double-fired from a flaky
    // retry/double-tap) could both pass the "no reverse-awaiting row" /
    // "no existing row" checks before either write commits, either
    // leaving pending rows in both directions at once (violating the
    // invariant this function's callers rely on) or hitting the
    // swipes(from_pet_id, to_pet_id) unique constraint and crashing with
    // a raw 500 instead of being absorbed like every other concurrent
    // duplicate in this codebase. The lock serializes ALL swipe actions
    // between this specific pair of pets, in either direction, closing
    // both races with one mechanism.
    return withTransaction(async (tx) => {
      await tx.run('SELECT pg_advisory_xact_lock(?, ?)', [Math.min(fromPetId, toPetId), Math.max(fromPetId, toPetId)]);

      const reverseAwaiting = await tx.get(
        `SELECT id FROM swipes WHERE from_pet_id = ? AND to_pet_id = ?
           AND request_status = 'awaiting' AND (expires_at IS NULL OR expires_at > NOW())`,
        [toPetId, fromPetId]
      );
      if (reverseAwaiting) {
        return { type: 'absorbed' };
      }

      const action = kind === 'rejected' ? 'decline' : 'like';
      const existing = await tx.get('SELECT id FROM swipes WHERE from_pet_id = ? AND to_pet_id = ?', [fromPetId, toPetId]);
      if (existing) {
        await tx.run(
          `UPDATE swipes SET action = ?, request_status = ?, status = 'pending',
             notification_id = NULL, expires_at = NOW() + INTERVAL '30 days', created_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [action, kind, existing.id]
        );
        return { type: 'pending', swipeId: existing.id };
      }
      const result = await tx.run(
        `INSERT INTO swipes (from_pet_id, to_pet_id, action, request_status, status, expires_at)
         VALUES (?, ?, ?, ?, 'pending', NOW() + INTERVAL '30 days') RETURNING id`,
        [fromPetId, toPetId, action, kind]
      );
      return { type: 'pending', swipeId: result.rows[0].id };
    });
  }

  async attachNotificationId(swipeId, notificationId) {
    await db.run('UPDATE swipes SET notification_id = ? WHERE id = ?', [notificationId, swipeId]);
  }

  // Fires once the 5s undo window elapses. Purely flips the 5s pending/committed
  // flag -- matches are never formed here. A swipe never auto-resolves into a
  // match; only an explicit Accept (acceptMeetRequest) does that.
  async commitPendingSwipeAction(swipeId) {
    await db.run("UPDATE swipes SET status = 'committed' WHERE id = ? AND status = 'pending'", [swipeId]);
  }

  // Only undoes a swipe still within its 5s window AND not already resolved
  // by an explicit Accept/Reject in the meantime.
  async undoPendingSwipeAction(fromPetId, toPetId) {
    const result = await db.run(
      `DELETE FROM swipes WHERE from_pet_id = ? AND to_pet_id = ? AND status = 'pending'
         AND request_status IN ('awaiting', 'rejected')
       RETURNING id, notification_id`,
      [fromPetId, toPetId]
    );
    if (!result.rows.length) return null;
    return { swipeId: result.rows[0].id, notificationId: result.rows[0].notification_id };
  }

  // Explicit Accept of an existing incoming request -- the ONLY way a match
  // is ever created. Used by both the Pending-tab route and the
  // notification's own Accept button (single shared implementation).
  async acceptMeetRequest(recipientPetId, requesterPetId) {
    const result = await db.run(
      `UPDATE swipes SET request_status = 'accepted', status = 'committed', expires_at = NULL
       WHERE from_pet_id = ? AND to_pet_id = ? AND request_status = 'awaiting'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING notification_id`,
      [requesterPetId, recipientPetId]
    );
    if (!result.rows.length) return { matched: false, expired: true };

    const notificationId = result.rows[0].notification_id;
    const existingMatch = await db.get(
      'SELECT id FROM matches WHERE (pet1_id = ? AND pet2_id = ?) OR (pet1_id = ? AND pet2_id = ?)',
      [requesterPetId, recipientPetId, recipientPetId, requesterPetId]
    );
    if (existingMatch) {
      return { matched: true, matchId: existingMatch.id, fromPetId: requesterPetId, toPetId: recipientPetId, notificationId };
    }

    const matchResult = await db.run(
      "INSERT INTO matches (pet1_id, pet2_id, source) VALUES (?, ?, 'meet') RETURNING id",
      [requesterPetId, recipientPetId]
    );
    const matchId = matchResult.rows[0].id;
    await db.run('INSERT INTO conversations (match_id) VALUES (?)', [matchId]);

    return { matched: true, matchId, fromPetId: requesterPetId, toPetId: recipientPetId, notificationId };
  }

  // Explicit Reject of an existing incoming request. Starts the 30-day
  // cooldown. Shared by the Pending-tab route and the notification's own
  // Reject button.
  async rejectMeetRequest(recipientPetId, requesterPetId) {
    const result = await db.run(
      `UPDATE swipes SET request_status = 'rejected', status = 'committed', expires_at = NOW() + INTERVAL '30 days'
       WHERE from_pet_id = ? AND to_pet_id = ? AND request_status = 'awaiting'
         AND (expires_at IS NULL OR expires_at > NOW())
       RETURNING notification_id`,
      [requesterPetId, recipientPetId]
    );
    if (!result.rows.length) return { rejected: false };
    return { rejected: true, notificationId: result.rows[0].notification_id };
  }

  async getMatches(petId, page = 1, limit = 30) {
    const offset = (page - 1) * limit;
    const matches = await db.all(`
      SELECT m.*,
        CASE WHEN m.pet1_id = ? THEN p2.id ELSE p1.id END as matched_pet_id,
        CASE WHEN m.pet1_id = ? THEN p2.name ELSE p1.name END as matched_pet_name,
        CASE WHEN m.pet1_id = ? THEN p2.avatar_url ELSE p1.avatar_url END as matched_pet_avatar,
        CASE WHEN m.pet1_id = ? THEN p2.pet_username ELSE p1.pet_username END as matched_pet_username,
        CASE WHEN m.pet1_id = ? THEN p2.breed_name ELSE p1.breed_name END as matched_pet_breed,
        c.id as conversation_id
      FROM matches m
      JOIN pets p1 ON m.pet1_id = p1.id
      JOIN pets p2 ON m.pet2_id = p2.id
      LEFT JOIN conversations c ON c.match_id = m.id
      WHERE (m.pet1_id = ? OR m.pet2_id = ?) AND m.source = 'meet'
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `, [petId, petId, petId, petId, petId, petId, petId, limit, offset]);
    const totalRow = await db.get(
      "SELECT COUNT(*) as count FROM matches WHERE (pet1_id = ? OR pet2_id = ?) AND source = 'meet'",
      [petId, petId]
    );
    const total = totalRow ? Number(totalRow.count) : 0;
    return { matches, total, page, hasMore: offset + limit < total };
  }

  /**
   * Meet Activity Lists:
   * 1. Requested: outgoing 'awaiting' requests sent by petId, not yet expired.
   * 2. Pending: incoming 'awaiting' requests sent to petId, not yet expired.
   * 3. Accepted: real Meet mutual matches (source='meet').
   * An aged-out row (expires_at passed) simply stops matching these filters --
   * disappears silently, exactly as required, no explicit cleanup needed.
   */
  async getMeetActivityLists(petId) {
    const requested = await db.all(`
      SELECT p.id as pet_id, p.name, p.pet_username, p.avatar_url, p.breed_name, p.gender, p.age, s.created_at
      FROM swipes s
      JOIN pets p ON s.to_pet_id = p.id
      WHERE s.from_pet_id = ?
        AND s.request_status = 'awaiting'
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
      ORDER BY s.created_at DESC
    `, [petId]);

    const pending = await db.all(`
      SELECT p.id as pet_id, p.name, p.pet_username, p.avatar_url, p.breed_name, p.gender, p.age, s.created_at
      FROM swipes s
      JOIN pets p ON s.from_pet_id = p.id
      WHERE s.to_pet_id = ?
        AND s.request_status = 'awaiting'
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
      ORDER BY s.created_at DESC
    `, [petId]);

    const { matches: accepted } = await this.getMatches(petId, 1, 100);

    return { requested, pending, accepted };
  }
}

export default new MatchRepository();
