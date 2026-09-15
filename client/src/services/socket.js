import { io } from 'socket.io-client';
import { getAccessToken } from './api';

let socket = null;

export function connectSocket() {
  if (socket?.connected) return socket;
  // Same VITE_API_URL fallback as api.js, so the socket always targets the same backend as REST calls.
  const socketUrl = import.meta.env.VITE_API_URL || window.location.origin;
  socket = io(socketUrl, {
    auth: { token: getAccessToken() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
  });

  return socket;
}

export function getSocket() { return socket; }

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
