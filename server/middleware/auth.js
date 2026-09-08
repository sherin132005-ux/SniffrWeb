import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import config from '../config.js';
import db from '../db/connection.js';
import { getAnonClient } from '../lib/supabase.js';

export function generateAccessToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, config.JWT_ACCESS_SECRET, { expiresIn: config.ACCESS_TOKEN_EXPIRY });
}

export async function generateRefreshToken(user, deviceInfo = 'unknown') {
  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_EXPIRY_MS).toISOString();
  await db.run('INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at) VALUES (?, ?, ?, ?)',
    [user.id, tokenHash, deviceInfo, expiresAt]);
  return token;
}

export function verifyAccessToken(token) {
  return jwt.verify(token, config.JWT_ACCESS_SECRET);
}

export async function verifyRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await db.get(
    "SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at > NOW()",
    [tokenHash]
  );
  return record || null;
}

export async function revokeRefreshToken(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [tokenHash]);
}

export async function revokeAllUserTokens(userId) {
  await db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [userId]);
}

// ── Dual-path token resolution ──────────────────────────────────
// Two kinds of valid access token exist side by side:
//   1. Our own custom JWT (still issued by /api/auth/google -- Google
//      Sign-In deliberately keeps its existing implementation, untouched
//      by the Supabase Auth migration).
//   2. A Supabase Auth session token (email/password login path).
// Both resolve to the SAME internal { id, email } shape (id = the
// integer public.users.id every route/repository already expects), via
// the auth_user_id link column for path 2 -- so nothing downstream of
// this middleware needs to know or care which path a given user took.
//
// Path 1 is checked first and is a fast, local, no-network signature
// check (as it always was). Path 2 costs one network round-trip to
// Supabase's Auth API per request (getUser() verifies the token
// regardless of whether the project uses legacy or asymmetric JWT
// signing) -- acceptable at current scale; if this ever needs to be
// faster, switch to local JWKS verification (see server/lib/supabase.js)
// once the project's signing-key mode is confirmed.
class AuthResolutionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function resolveUserFromToken(token) {
  try {
    const decoded = jwt.verify(token, config.JWT_ACCESS_SECRET);
    return { id: decoded.id, email: decoded.email };
  } catch (customJwtErr) {
    if (customJwtErr.name === 'TokenExpiredError') {
      throw new AuthResolutionError('TOKEN_EXPIRED');
    }
    // Not (or no longer) a valid custom JWT -- try it as a Supabase
    // Auth session token instead.
  }

  let supabaseUser;
  try {
    const { data, error } = await getAnonClient().auth.getUser(token);
    if (error || !data?.user) {
      const expired = /expired/i.test(error?.message || '');
      throw new AuthResolutionError(expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN');
    }
    supabaseUser = data.user;
  } catch (err) {
    if (err instanceof AuthResolutionError) throw err;
    throw new AuthResolutionError('INVALID_TOKEN');
  }

  const user = await db.get('SELECT id, email FROM users WHERE auth_user_id = ?', [supabaseUser.id]);
  if (!user) throw new AuthResolutionError('INVALID_TOKEN');
  return { id: user.id, email: user.email };
}

export async function authenticateAccess(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'NO_TOKEN', message: 'Access token required' });
  }
  try {
    req.user = await resolveUserFromToken(authHeader.split(' ')[1]);
    next();
  } catch (err) {
    const code = err instanceof AuthResolutionError ? err.code : 'INVALID_TOKEN';
    const message = code === 'TOKEN_EXPIRED' ? 'Access token expired' : 'Invalid access token';
    return res.status(401).json({ error: code, message });
  }
}

export async function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = await resolveUserFromToken(token);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
}