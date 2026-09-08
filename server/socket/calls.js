import CallRepo from '../models/CallRepository.js';
import PetRepo from '../models/PetRepository.js';
import UserRepo from '../models/UserRepository.js';

// User call availability: userId -> 'available' | 'busy' | 'in-call'
const userCallState = new Map();
// Active calls: callId -> { from, to, callerPetId, receiverPetId, type, start_time, startedAt, answered, ringTimeout }
const activeCalls = new Map();

// How long an outgoing call rings before it's auto-cancelled as unanswered.
// Previously nothing expired an unanswered call server-side -- if the
// receiving client's app was killed/backgrounded and never sent
// call_reject, the caller's UI (and the callee's call_incoming) could be
// left ringing indefinitely with no server-driven cleanup.
const RING_TIMEOUT_MS = 45 * 1000;

async function endUnansweredCall(io, callId, status) {
  const call = activeCalls.get(callId);
  if (!call) return;
  activeCalls.delete(callId);
  userCallState.set(call.from, 'available');
  userCallState.set(call.to, 'available');

  try {
    await CallRepo.log({
      callerPetId: call.callerPetId,
      receiverPetId: call.receiverPetId,
      type: call.type,
      status,
      duration: 0,
      start_time: call.start_time,
      end_time: new Date().toISOString()
    });
  } catch (err) {
    console.error('Call timeout logging failed:', err.message);
  }

  io.to(`user_${call.from}`).emit('call_timeout', { callId });
  io.to(`user_${call.to}`).emit('call_timeout', { callId });
}

export function setupCallSocket(io) {
  io.on('connection', (socket) => {
    const userId = socket.user.id;
    userCallState.set(userId, 'available');

    socket.join(`user_${userId}`);

    socket.on('call_initiate', async ({ to, type }) => {
      if (userCallState.get(userId) === 'in-call') {
        return socket.emit('call_error', { message: 'You are already in a call' });
      }

      const recipientState = userCallState.get(to);
      if (recipientState === 'in-call' || recipientState === 'busy') {
        return socket.emit('call_busy', { userId: to });
      }

      // A block should stop calls the same way it already stops
      // chat/swipe/share (see AUDIT_REPORT.md) -- without this, a blocked
      // user could still voice/video-call the person who blocked them.
      if (await UserRepo.isBlocked(userId, to)) {
        return socket.emit('call_error', { message: 'You cannot call this user' });
      }

      const callerPet = await PetRepo.getActivePet(userId);
      const receiverPet = await PetRepo.getActivePet(to);
      if (!callerPet || !receiverPet) {
        return socket.emit('call_error', { message: 'Registered pet profiles not found' });
      }

      const callId = `${userId}_${to}_${Date.now()}`;
      const ringTimeout = setTimeout(() => endUnansweredCall(io, callId, 'missed'), RING_TIMEOUT_MS);
      activeCalls.set(callId, {
        from: userId,
        to,
        callerPetId: callerPet.id,
        receiverPetId: receiverPet.id,
        type,
        start_time: new Date().toISOString(),
        startedAt: null,
        answered: false,
        ringTimeout
      });

      userCallState.set(userId, 'busy');
      userCallState.set(to, 'busy');

      // Include caller's pet info directly so the receiving client doesn't
      // need to guess which profile to fetch (avoids "wrong pet shown" bugs).
      io.to(`user_${to}`).emit('call_incoming', {
        callId,
        from: userId,
        type,
        callerPet: {
          id: callerPet.id,
          name: callerPet.name,
          avatar_url: callerPet.avatar_url,
          pet_username: callerPet.pet_username,
        }
      });
      socket.emit('call_ringing', { callId, to });
    });

    socket.on('call_accept', ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      clearTimeout(call.ringTimeout);
      call.startedAt = Date.now();
      call.answered = true;

      userCallState.set(call.from, 'in-call');
      userCallState.set(call.to, 'in-call');

      io.to(`user_${call.from}`).emit('call_connected', { callId });
      io.to(`user_${call.to}`).emit('call_connected', { callId });
    });

    socket.on('call_reject', async ({ callId, reason }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      clearTimeout(call.ringTimeout);

      userCallState.set(call.from, 'available');
      userCallState.set(call.to, 'available');
      activeCalls.delete(callId);

      try {
        await CallRepo.log({
          callerPetId: call.callerPetId,
          receiverPetId: call.receiverPetId,
          type: call.type,
          status: reason === 'declined' ? 'declined' : 'missed',
          duration: 0,
          declinedBy: reason === 'declined' ? 'receiver' : null,
          start_time: call.start_time,
          end_time: new Date().toISOString()
        });
      } catch (err) {
        console.error('Call reject logging failed:', err.message);
      }

      io.to(`user_${call.from}`).emit('call_rejected', { callId, reason: reason || 'declined' });
      io.to(`user_${call.to}`).emit('call_rejected', { callId, reason: reason || 'declined' });
    });

    socket.on('call_end', async ({ callId }) => {
      const call = activeCalls.get(callId);
      if (!call) return;
      clearTimeout(call.ringTimeout);

      userCallState.set(call.from, 'available');
      userCallState.set(call.to, 'available');
      activeCalls.delete(callId);

      try {
        const endTime = new Date().toISOString();
        const duration = call.answered && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
        await CallRepo.log({
          callerPetId: call.callerPetId,
          receiverPetId: call.receiverPetId,
          type: call.type,
          status: call.answered ? 'completed' : 'missed',
          duration,
          start_time: call.start_time,
          end_time: endTime
        });
      } catch (err) {
        console.error('Call end logging failed:', err.message);
      }

      io.to(`user_${call.from}`).emit('call_ended', { callId });
      io.to(`user_${call.to}`).emit('call_ended', { callId });
    });

    // Signaling relays are restricted to two sockets that actually have an
    // active call between them -- without this, any authenticated socket
    // could send a bare webrtc_offer/ice_candidate to any userId and get
    // relayed straight into their call UI, with no call having ever been
    // initiated/accepted through call_initiate/call_accept.
    function hasActiveCallWith(a, b) {
      for (const call of activeCalls.values()) {
        if ((call.from === a && call.to === b) || (call.from === b && call.to === a)) return true;
      }
      return false;
    }

    socket.on('webrtc_offer', ({ to, sdp }) => {
      if (!hasActiveCallWith(userId, to)) return;
      io.to(`user_${to}`).emit('webrtc_offer', { from: userId, sdp });
    });
    socket.on('webrtc_answer', ({ to, sdp }) => {
      if (!hasActiveCallWith(userId, to)) return;
      io.to(`user_${to}`).emit('webrtc_answer', { from: userId, sdp });
    });
    socket.on('webrtc_ice_candidate', ({ to, candidate }) => {
      if (!hasActiveCallWith(userId, to)) return;
      io.to(`user_${to}`).emit('webrtc_ice_candidate', { from: userId, candidate });
    });

    // Pure relay, same shape as the ICE-candidate one above -- lets the
    // remote party's UI show "X is muted" instead of just going silent
    // with no indication of why.
    socket.on('call_mute_state', ({ to, muted }) => {
      if (!hasActiveCallWith(userId, to)) return;
      io.to(`user_${to}`).emit('call_mute_state', { from: userId, muted });
    });

    socket.on('disconnect', async () => {
      for (const [callId, call] of activeCalls) {
        if (call.from === userId || call.to === userId) {
          clearTimeout(call.ringTimeout);
          const other = call.from === userId ? call.to : call.from;
          userCallState.set(other, 'available');
          activeCalls.delete(callId);

          try {
            const endTime = new Date().toISOString();
            const duration = call.answered && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
            await CallRepo.log({
              callerPetId: call.callerPetId,
              receiverPetId: call.receiverPetId,
              type: call.type,
              status: call.answered ? 'completed' : 'failed',
              duration,
              start_time: call.start_time,
              end_time: endTime
            });
          } catch (err) {
            console.error('Call disconnect logging failed:', err.message);
          }

          io.to(`user_${other}`).emit('call_ended', { callId, reason: 'disconnected' });
        }
      }
      userCallState.delete(userId);
    });
  });
}

export function getUserCallState(userId) {
  return userCallState.get(userId) || 'available';
}