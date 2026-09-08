import MessageRepo from '../models/MessageRepository.js';
import db from '../db/connection.js';

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();
// Track who's typing in which conversation: conversationId -> Map(userId -> timeout)
const typingTimeouts = new Map();

export function setupChatSocket(io) {
  io.on('connection', (socket) => {
    const userId = Number(socket.user.id);

    // Register online immediately -- listeners below must be attached
    // synchronously, before any `await`, so a client that emits
    // 'join_conversation'/'send_message' right after 'connect' (as
    // ChatPage.jsx does) can never race ahead of them and get silently
    // dropped by Socket.IO (an event with no registered listener is just
    // discarded, not queued).
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);
    socket.broadcast.emit(
    "user_online",
    { userId }
);
socket.emit("online_users_list", {
    onlineUserIds: getOnlineUsers()
});
    // Join conversation room
  socket.on('join_conversation', async ({ conversationId }) => {
  // Without this check, any authenticated socket could join any
  // conv_<id> room by guessing/knowing the ID and silently receive every
  // future message in a conversation it isn't part of -- the REST layer
  // already enforces this (MessageRepo.canAccessConversation), but the
  // realtime layer bypassed it entirely until now.
  const access = await MessageRepo.canAccessConversation(conversationId, userId);
  if (!access) return;

  socket.join(`conv_${conversationId}`);

  await MessageRepo.markSeen(conversationId, userId);

  io.to(`conv_${conversationId}`).emit('messages_seen', {
    conversationId,
    userId
  });

  const updatedMessages =
    await MessageRepo.getSeenMessages(conversationId);

  // One batched event for the whole conversation instead of one
  // 'message_updated' per message -- opening a conversation with N
  // unseen messages used to fire N separate socket events, and the
  // client's handler ran a full conversations-list refetch on EACH one
  // (see ChatPage.jsx), turning "open a chat with 30 unread messages"
  // into 30 redundant API calls. A single array event fixes that at
  // the source.
  if (updatedMessages.length) {
    io.to(`conv_${conversationId}`).emit('messages_updated', {
      conversationId,
      messages: updatedMessages
    });
  }
});

    socket.on('leave_conversation', ({ conversationId }) => {
      socket.leave(`conv_${conversationId}`);
    });

    // ── Typing indicators ──────────────────────────────────────
    // Debounced: client sends 'typing_start' on keystroke, we broadcast
    // to the other party and auto-clear after 4s of silence (protects
    // against a client that never sends 'typing_stop' due to a tab close
    // or crash -- the indicator can't get stuck on forever).
    socket.on('typing_start', ({ conversationId }) => {
      io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: true });

      const key = `${conversationId}_${userId}`;
      if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));
      const timeout = setTimeout(() => {
        io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: false });
        typingTimeouts.delete(key);
      }, 4000);
      typingTimeouts.set(key, timeout);
    });

    socket.on('typing_stop', ({ conversationId }) => {
      const key = `${conversationId}_${userId}`;
      if (typingTimeouts.has(key)) {
        clearTimeout(typingTimeouts.get(key));
        typingTimeouts.delete(key);
      }
      io.to(`conv_${conversationId}`).emit('user_typing', { conversationId, userId, isTyping: false });
    });

    // ── Send message (now with an acknowledgment callback) ─────────
    // IMPORTANT: the third argument here is a Socket.IO acknowledgment
    // callback. If the client provides one (see ChatPage.jsx), it will
    // be called with either { success: true, message } or an error --
    // this is what lets the frontend detect a failed/lost send (e.g. the
    // socket disconnected mid-request) and show a "failed to send, tap
    // to retry" state instead of the message silently vanishing.
    socket.on('send_message', async ({ conversationId, content, mediaUrl, messageType, replyToId, clientTempId }, ack) => {
      try {
        const access = await MessageRepo.canAccessConversation(conversationId, userId);
        if (!access) {
          if (typeof ack === 'function') ack({ success: false, error: 'NO_ACCESS', clientTempId });
          return;
        }

        const message = await MessageRepo.sendMessage(conversationId, userId, content, mediaUrl, messageType || 'text', replyToId || null);

        // Send to all in conversation
        io.to(`conv_${conversationId}`).emit('message_received', message);

        // Check if recipient is online and in conversation — mark delivered
        const recipientSockets = getConversationRecipientSockets(io, conversationId, userId);
        if (recipientSockets.length > 0) {

    await MessageRepo.markDelivered(message.id);

const updated = await MessageRepo.getMessageById(message.id);

io.to(`conv_${conversationId}`).emit(
  "message_updated",
  updated
);
}

        if (typeof ack === 'function') ack({ success: true, message, clientTempId });
      } catch (err) {
        console.error('[send_message error]', err.message);
        if (typeof ack === 'function') ack({ success: false, error: err.message, clientTempId });
      }
    });

    // Message delivered acknowledgment
       //deleted

    // Messages seen
    socket.on('messages_seen', async ({ conversationId }) => {
  await MessageRepo.markSeen(conversationId, userId);

  const updatedMessages =
    await MessageRepo.getSeenMessages(conversationId);

  // One batched event for the whole conversation instead of one
  // 'message_updated' per message -- opening a conversation with N
  // unseen messages used to fire N separate socket events, and the
  // client's handler ran a full conversations-list refetch on EACH one
  // (see ChatPage.jsx), turning "open a chat with 30 unread messages"
  // into 30 redundant API calls. A single array event fixes that at
  // the source.
  if (updatedMessages.length) {
    io.to(`conv_${conversationId}`).emit('messages_updated', {
      conversationId,
      messages: updatedMessages
    });
  }
});

    // ── Message reactions ────────────────────────────────────────
    socket.on('react_to_message', async ({ messageId, conversationId, reaction }) => {
      try {
        const existing = await db.get(
          'SELECT id, reaction FROM message_reactions WHERE message_id = ? AND user_id = ?',
          [messageId, userId]
        );

        if (existing && existing.reaction === reaction) {
          // Tapping the same reaction again removes it
          await db.run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [messageId, userId]);
        } else if (existing) {
          await db.run('UPDATE message_reactions SET reaction = ? WHERE message_id = ? AND user_id = ?', [reaction, messageId, userId]);
        } else {
          await db.run('INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (?, ?, ?)', [messageId, userId, reaction]);
        }

        const rows = await db.all('SELECT reaction, COUNT(*)::int as count FROM message_reactions WHERE message_id = ? GROUP BY reaction', [messageId]);
        const reactions = {};
        rows.forEach(r => { reactions[r.reaction] = r.count; });

        io.to(`conv_${conversationId}`).emit('message_reaction_updated', { messageId, reactions });
      } catch (err) {
        console.error('[react_to_message error]', err.message);
      }
    });

    // Fetch back message
    socket.on('fetch_back_message', async ({ messageId }) => {
      const updated = await MessageRepo.fetchBackMessage(messageId, userId);
      if (updated && updated.conversation_id) {
        io.to(`conv_${updated.conversation_id}`).emit('message_updated', updated);
      }
    });

    // Deferred initialization -- runs after every listener above is
    // already attached, so it can safely `await` without risking a race
    // against early client emits (see comment at the top of this handler).
    (async () => {
      try {
        await db.run("UPDATE users SET last_active_at = NOW() WHERE id = ?", [userId]);

        // Sync undelivered messages on reconnect
        const undelivered = await MessageRepo.getUndelivered(userId);
        for (const msg of undelivered) {
          socket.emit('message_received', msg);
          await MessageRepo.markDelivered(msg.id);
          const updated = await MessageRepo.getMessageById(msg.id);
          io.to(`conv_${msg.conversation_id}`).emit('message_updated', updated);
        }
      } catch (err) {
        console.error('[chat connection init error]', err.message);
      }
    })();

    // Disconnect
socket.on('disconnect', async () => {
  const sockets = onlineUsers.get(userId);

  if (sockets) {
    sockets.delete(socket.id);

    if (sockets.size === 0) {
      onlineUsers.delete(userId);

      // Clear this user's typing indicator(s) immediately instead of
      // leaving the other party staring at a stale "Typing..." for up to
      // the 4s safety-net window below -- a dropped connection should
      // read the same as the user having stopped typing right away.
      for (const [key, timeout] of typingTimeouts) {
        if (key.endsWith(`_${userId}`)) {
          clearTimeout(timeout);
          typingTimeouts.delete(key);
          const conversationId = key.slice(0, -`_${userId}`.length);
          io.to(`conv_${conversationId}`).emit('user_typing', { conversationId: Number(conversationId), userId, isTyping: false });
        }
      }

      const lastActiveAt = new Date().toISOString();

      await db.run(
    "UPDATE users SET last_active_at = ? WHERE id = ?",
    [lastActiveAt, userId]
);

    socket.broadcast.emit(
    "user_offline",
    {
        userId,
        lastActiveAt
    }
);
    }
  }
});
  });
}

function getConversationRecipientSockets(io, conversationId, senderId) {
  const room = io.sockets.adapter.rooms.get(`conv_${conversationId}`);
  if (!room) return [];
  const sockets = [];
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.user.id !== senderId) sockets.push(s);
  }
  return sockets;
}

export function getOnlineUsers() { return [...onlineUsers.keys()]; }