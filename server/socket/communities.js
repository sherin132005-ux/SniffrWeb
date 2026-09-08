import CommunityRepo from '../models/CommunityRepository.js';
import db from '../db/connection.js';

// Track who's typing in which PawCircle: `${communityId}_${userId}` -> timeout.
// Same shape/purpose as chat.js's typingTimeouts -- a client that never sends
// isTyping:false (crash, dropped connection) can't leave the indicator stuck
// on forever.
const typingTimeouts = new Map();

async function isCommunityMember(communityId, userId) {
  const member = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [communityId, userId]
  );
  return !!member;
}

export function setupCommunitySocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.user.id;

    socket.on('join_community_chat', async ({ communityId }) => {
      // Same class of gap as chat.js's join_conversation -- without this,
      // any authenticated socket could join any PawCircle's room and read
      // every message, bypassing the REST-level membership gate entirely.
      const isMember = await isCommunityMember(communityId, userId);
      if (!isMember) return;
      socket.join(`pawcircle_${communityId}`);
    });

    socket.on('leave_community_chat', ({ communityId }) => {
      socket.leave(`pawcircle_${communityId}`);
    });

    socket.on('community_typing', ({ communityId, isTyping }) => {
      socket.to(`pawcircle_${communityId}`).emit('community_user_typing', {
        communityId,
        userId,
        username: socket.user.username,
        isTyping
      });

      const key = `${communityId}_${userId}`;
      if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));

      if (isTyping) {
        const timeout = setTimeout(() => {
          socket.to(`pawcircle_${communityId}`).emit('community_user_typing', {
            communityId,
            userId,
            username: socket.user.username,
            isTyping: false
          });
          typingTimeouts.delete(key);
        }, 4000);
        typingTimeouts.set(key, timeout);
      } else {
        typingTimeouts.delete(key);
      }
    });

    socket.on('send_community_message', async ({ communityId, content, mediaUrl, replyToId }) => {
      try {
        // CommunityRepo.addMessage has no ownership/membership check of its
        // own -- without this, any authenticated user could post into any
        // PawCircle's chat without being a member.
        const isMember = await isCommunityMember(communityId, userId);
        if (!isMember) return;

        const message = await CommunityRepo.addMessage({
          community_id: communityId,
          sender_id: userId,
          content: content || '',
          media_url: mediaUrl || null,
          reply_to_id: replyToId || null
        });
        io.to(`pawcircle_${communityId}`).emit('community_message_received', message);
      } catch (e) {
        console.error('[send_community_message error]', e);
      }
    });

    // ── Message reactions (same toggle pattern as chat.js's react_to_message,
    // just against community_message_reactions instead of message_reactions) ──
    socket.on('react_to_community_message', async ({ messageId, communityId, reaction }) => {
      try {
        const existing = await db.get(
          'SELECT id, reaction FROM community_message_reactions WHERE community_message_id = ? AND user_id = ?',
          [messageId, userId]
        );

        if (existing && existing.reaction === reaction) {
          await db.run('DELETE FROM community_message_reactions WHERE community_message_id = ? AND user_id = ?', [messageId, userId]);
        } else if (existing) {
          await db.run('UPDATE community_message_reactions SET reaction = ? WHERE community_message_id = ? AND user_id = ?', [reaction, messageId, userId]);
        } else {
          await db.run('INSERT INTO community_message_reactions (community_message_id, user_id, reaction) VALUES (?, ?, ?)', [messageId, userId, reaction]);
        }

        const rows = await db.all('SELECT reaction, COUNT(*)::int as count FROM community_message_reactions WHERE community_message_id = ? GROUP BY reaction', [messageId]);
        const reactions = {};
        rows.forEach(r => { reactions[r.reaction] = r.count; });

        io.to(`pawcircle_${communityId}`).emit('community_message_reaction_updated', { messageId, reactions });
      } catch (err) {
        console.error('[react_to_community_message error]', err.message);
      }
    });

    // ── Fetch Back (delete-for-everyone-by-sender), same behavior as
    // chat.js's fetch_back_message ─────────────────────────────────────
    socket.on('fetch_back_community_message', async ({ messageId }) => {
      const updated = await CommunityRepo.fetchBackMessage(messageId, userId);
      if (updated && updated.community_id) {
        io.to(`pawcircle_${updated.community_id}`).emit('community_message_updated', updated);
      }
    });

    socket.on('disconnect', () => {
      for (const [key, timeout] of typingTimeouts) {
        if (key.endsWith(`_${userId}`)) {
          clearTimeout(timeout);
          typingTimeouts.delete(key);
          const communityId = key.slice(0, -`_${userId}`.length);
          socket.to(`pawcircle_${communityId}`).emit('community_user_typing', {
            communityId: Number(communityId),
            userId,
            username: socket.user.username,
            isTyping: false
          });
        }
      }
    });
  });
}
