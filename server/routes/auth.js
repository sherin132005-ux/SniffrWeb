import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import UserRepo from '../models/UserRepository.js';
import PetRepo from '../models/PetRepository.js';
import {
  generateAccessToken, generateRefreshToken,
  verifyRefreshToken, revokeRefreshToken,
  authenticateAccess,
} from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import config from '../config.js';
import { sendPawCodeEmail, sendPasswordResetEmail, sendVerificationEmail } from '../utils/mailer.js';
import db from '../db/connection.js';
import { grantLaunchOfferIfEligible, getUserWithFreshPlanState } from '../services/subscriptionService.js';
import { sendServerError } from '../utils/errors.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { getAnonClient, getAdminClient } from '../lib/supabase.js';

const router = Router();
router.use(rateLimiter(config.RATE_LIMIT.AUTH));

// Verification/reset tokens are emailed as raw random hex, but only their
// SHA-256 hash is ever persisted -- a DB read (backup leak, SQL injection,
// etc.) can't be turned into a usable link, since the raw value that
// satisfies the hash was never stored anywhere.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return email || '';
  const [name, domain] = email.split('@');
  if (name.length <= 2) return `${name[0]}*@${domain}`;
  const maskedName = `${name[0]}***${name[name.length - 1]}`;
  return `${maskedName}@${domain}`;
}

// Helper: issue session tokens
// supabaseSession (optional): when the email/password path authenticated
// via Supabase Auth, pass its { access_token, refresh_token } here instead
// of minting our own -- the response envelope stays identical either way,
// so the frontend needs no knowledge of which system issued the tokens.
async function issueSession(user, req, res, extraData = {}, supabaseSession = null) {
  const io            = req.app.get('io');
  // Fresh plan-state read (not the raw `user` row) so a subscription that
  // expired since the last login is corrected right here at sign-in time,
  // same lazy-expiry path every other premium read goes through.
  const freshUser      = await getUserWithFreshPlanState(user.id, io) || user;
  const pet          = await PetRepo.getActivePet(user.id);
  const allPets      = await PetRepo.findAllByUserId(user.id);
  const deviceInfo   = req.headers['user-agent'] || 'unknown';
  const accessToken  = supabaseSession ? supabaseSession.access_token  : generateAccessToken(user);
  const refreshToken = supabaseSession ? supabaseSession.refresh_token : await generateRefreshToken(user, deviceInfo);
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      full_name: user.full_name,
      pawprint_2fa_enabled: user.pawprint_2fa_enabled ? 1 : 0,
      super_sniff_enabled: user.super_sniff_enabled ? 1 : 0,
      email_verified: user.email_verified ? 1 : 0,
      is_admin: user.is_admin,
      current_plan: freshUser.current_plan,
      subscription_status: freshUser.subscription_status,
      is_founding_member: freshUser.is_founding_member ? 1 : 0,
      welcome_slider_seen: freshUser.welcome_slider_seen ? 1 : 0,
      premium_badge_enabled: freshUser.premium_badge_enabled ? 1 : 0,
    },
    pet:  pet || null,
    allPets: allPets || [],
    accessToken,
    refreshToken,
    ...extraData
  });
}

// Helper: find or prepare social user prefill
async function findOrPrepSocialUser(email, fullName, provider) {
  const existing = await UserRepo.findByEmail(email);
  if (existing) return { user: existing, isNew: false };
  return { user: null, isNew: true, prefill: { email, full_name: fullName || '', provider } };
}

// Helper: validate password complexity
function validatePassword(password) {
  if (!password || password.length < 8 || password.length > 20) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^a-zA-Z0-9]/.test(password)) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// EMAIL VERIFICATION — shared cooldown-guarded sender
// ═══════════════════════════════════════════════════════════════
// Shared cooldown tracker: userId -> timestamp of last send. Used by
// BOTH the automatic signup send and manual resend clicks, so there is
// only ever ONE source of truth for "when was the last email sent" —
// this guarantees only one active token can exist and that a rapid
// double-click (or a race between auto-send and a fast manual click)
// cannot generate two different tokens in quick succession.
const verificationCooldowns = new Map();
const VERIFICATION_COOLDOWN_MS = 60 * 1000; // 60 seconds

async function triggerVerificationEmail(user, options = {}) {
  const { isWelcome = false } = options;
  const now = Date.now();
  const lastSent = verificationCooldowns.get(user.id);

  if (lastSent && now - lastSent < VERIFICATION_COOLDOWN_MS) {
    return {
      sent: false,
      throttled: true,
      cooldownUntil: lastSent + VERIFICATION_COOLDOWN_MS,
    };
  }

  // Record the cooldown SYNCHRONOUSLY, before any await below. This is
  // what closes the race window: even if two calls arrive back-to-back
  // (e.g. signup's auto-send and an immediate manual click), the second
  // one will see this Map entry already set and be rejected above,
  // since there is no `await` between the check and this line.
  const cooldownUntil = now + VERIFICATION_COOLDOWN_MS;
  verificationCooldowns.set(user.id, now);

  // Fire-and-forget: the token write + actual email delivery happen in the
  // background instead of being awaited by the caller. A slow or
  // misconfigured SMTP connection (or a slow DNS/TCP handshake to the mail
  // provider) used to block the ENTIRE signup/login response until it
  // resolved or timed out -- the account was already committed to the DB
  // by then, but the browser never got a response back to apply the
  // session, which is exactly what looked like "saved in Supabase but the
  // site never updated, had to refresh and log in".
  (async () => {
    try {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
      await db.run(
        'UPDATE users SET email_verify_token = ?, email_verify_expires_at = ? WHERE id = ?',
        [hashToken(token), expiresAt, user.id]
      );
      const verifyLink = `${config.CLIENT_URL || 'http://localhost:5173'}/verify-email?token=${token}`;
      // Only printed when there's no real email provider to actually deliver
      // it -- never logged once SMTP is configured. See AUDIT_REPORT.md.
      if (!process.env.SMTP_USER) console.log(`[DEV ONLY] Email verification link for ${user.email}: ${verifyLink}`);
      await sendVerificationEmail(user.email, verifyLink, { isWelcome, fullName: user.full_name });
    } catch (err) {
      console.error('[triggerVerificationEmail error]:', err.message);
    }
  })();

  return { sent: true, throttled: false, cooldownUntil };
}

const VERIFY_REMINDER_TYPE = 'email_verify_reminder';
const VERIFY_REMINDER_MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000; // don't nag someone who just signed up

async function maybeSendVerifyReminder(user, io) {
  const accountAge = Date.now() - new Date(user.created_at).getTime();
  if (accountAge < VERIFY_REMINDER_MIN_ACCOUNT_AGE_MS) return;

  const recent = await db.get(
    "SELECT id FROM notifications WHERE user_id = ? AND type = ? AND created_at > (NOW() - INTERVAL '7 days') LIMIT 1",
    [user.id, VERIFY_REMINDER_TYPE]
  );
  if (recent) return;

  await sendRealtimeNotification(io, user.id, {
    category: 'activity',
    type: VERIFY_REMINDER_TYPE,
    title: '📧 Verify your email',
    description: "You haven't verified your email yet — verify it to keep your account secure and unlock PawPrint Verification.",
  });
}

// ═══════════════════════════════════════════════════════════════
// GOOGLE  /api/auth/google
// ═══════════════════════════════════════════════════════════════
router.post('/google', async (req, res) => {
  try {
    const { credential, email: bodyEmail, full_name: bodyName } = req.body;
    let email    = bodyEmail || '';
    let fullName = bodyName  || '';

    if (credential) {
      if (!config.GOOGLE_CLIENT_ID) {
        // Never silently accept a Google token without an audience check --
        // that would let anyone log in with an ID token issued to ANY
        // Google OAuth app for their account, not just this one.
        console.error('[/auth/google] GOOGLE_CLIENT_ID is not configured -- refusing to verify Google tokens');
        return res.status(503).json({ error: 'GOOGLE_NOT_CONFIGURED', message: 'Google Sign-In is not available right now.' });
      }

      const verifyRes = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`,
        { signal: AbortSignal.timeout(8000) }
      );
      const payload = await verifyRes.json();

      // tokeninfo already validates the signature and rejects an expired
      // token (payload.error === 'invalid_token' in that case), but aud/iss
      // are OUR app's checks, not Google's -- tokeninfo will happily
      // "verify" a perfectly valid token issued to a completely different
      // Google OAuth client or a different identity provider.
      if (!verifyRes.ok || payload.error) {
        return res.status(401).json({ error: 'INVALID_TOKEN', message: payload.error_description || 'Google token verification failed' });
      }
      if (payload.aud !== config.GOOGLE_CLIENT_ID) {
        return res.status(401).json({ error: 'WRONG_AUDIENCE', message: 'Token audience mismatch' });
      }
      if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
        return res.status(401).json({ error: 'WRONG_ISSUER', message: 'Token not issued by Google' });
      }
      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        return res.status(401).json({ error: 'EMAIL_NOT_VERIFIED', message: "Google account's email is not verified" });
      }
      email    = payload.email || email;
      fullName = payload.name  || fullName;
    }

    if (!email) {
      return res.status(400).json({ error: 'NO_EMAIL', message: 'Could not extract email from Google account' });
    }

    const { user, isNew, prefill } = await findOrPrepSocialUser(email, fullName, 'google');
    if (!isNew) return await issueSession(user, req, res);
    return res.status(200).json({ needsSignup: true, prefill });

  } catch (err) {
    if (err.name === 'TimeoutError') return res.status(503).json({ error: 'TIMEOUT', message: 'Google verification timed out' });
    console.error('[/auth/google]', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Google authentication encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// SOCIAL COMPLETE
// Google already verifies the person's email ownership before we ever
// see it, so accounts created via this path are auto-verified.
// (Apple Sign-In removed for now -- was never wired into the frontend UI,
// see git history if it needs to come back later.)
// ═══════════════════════════════════════════════════════════════
router.post('/social-complete', async (req, res) => {
  try {
    const { email, username, full_name } = req.body;
    if (!email || !username) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'email and username are required' });

    if (await UserRepo.findByEmail(email))       return res.status(409).json({ error: 'EMAIL_EXISTS',    message: 'Looks like this pet parent is already part of Sniffr. Try signing in instead.' });
    if (await UserRepo.findByUsername(username)) return res.status(409).json({ error: 'USERNAME_TAKEN',  message: '🐾 Oops! That pet tag is already taken. Try another one.' });

    const password_hash = await bcrypt.hash(Math.random().toString(36) + Date.now() + Math.random(), 12);
    const user = await UserRepo.create({ email, username, password_hash, full_name: full_name || username });
    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [user.id]);
    user.email_verified = 1;

    return await issueSession(user, req, res);
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Social profile setup encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STANDARD EMAIL / PASSWORD SIGN UP
// ═══════════════════════════════════════════════════════════════
router.post('/signup', async (req, res) => {
  try {
    const { email, password, confirmPassword, username, full_name } = req.body;
    const errors = [];

    // 1. Full Name Validation
    if (!full_name || !full_name.trim()) {
      errors.push({ field: 'full_name', message: 'Full name is required.' });
    } else if (!/[a-zA-Z]/.test(full_name)) {
      errors.push({ field: 'full_name', message: 'Full name cannot contain numbers or special characters only.' });
    }

    // 2. Username Validation
    if (!username || !username.trim()) {
      errors.push({ field: 'username', message: 'Username is required.' });
    } else if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
      errors.push({ field: 'username', message: 'Username must be 4–20 characters and contain only letters, numbers, and underscores.' });
    } else if (await UserRepo.findByUsername(username)) {
      errors.push({ field: 'username', message: '🐾 Oops! That pet tag is already taken. Try another one.' });
    }

    // 3. Email Validation
    if (!email || !email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ field: 'email', message: "🐾 That doesn't look like a valid email. Check the address and try again." });
    } else if (await UserRepo.findByEmail(email)) {
      errors.push({ field: 'email', message: '🐾 Looks like this pet parent is already part of Sniffr. Try signing in instead.' });
    }

    // 4. Password Validation
    if (!password || !validatePassword(password)) {
      errors.push({
        field: 'password',
        message: '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    // 5. Confirm Password Validation
    if (password !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "🐾 Those passwords don't match. Give it another sniff." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    // Password custody now lives in Supabase Auth, not this app -- create
    // the Supabase identity first (source of truth for the credential),
    // then our own users row links to it via auth_user_id. email_confirm:
    // true means Supabase itself won't send its own confirmation email;
    // our existing custom-branded verification flow (triggerVerificationEmail
    // below) still runs exactly as before and still gates whatever features
    // email_verified controls -- the two are deliberately independent.
    const { data: authData, error: authErr } = await getAdminClient().auth.admin.createUser({
      email, password, email_confirm: true,
    });
    if (authErr || !authData?.user) {
      console.error('[signup] Supabase Auth user creation failed:', authErr?.message);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Registration encountered a problem.' });
    }

    // password_hash is schema-required (NOT NULL) but never read for a
    // Supabase-backed account (auth_user_id set) -- same "unusable random
    // hash" placeholder already used for Google/Apple social signups.
    const password_hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const user = await UserRepo.create({ email, username, password_hash, full_name: full_name.trim() });
    await db.run('UPDATE users SET auth_user_id = ? WHERE id = ?', [authData.user.id, user.id]);
    user.auth_user_id = authData.user.id;

    // Launch offer: first 100 signups get free Sniffr Gold. COUNT(*) here
    // includes the row just inserted above, so "count <= limit" is exactly
    // "this user is among the first `limit` ever created" -- see
    // grantLaunchOfferIfEligible for the exact boundary logic.
    await grantLaunchOfferIfEligible(user.id, req.app.get('io'));

    // Automatic welcome + verification email. isWelcome:true gives the
    // first-time-user version with the warm welcome copy; any later
    // manual resend (see /resend-verification below) uses the plain
    // version instead, since by then they're not "new" anymore.
    const verificationResult = await triggerVerificationEmail(user, { isWelcome: true });

    // Real session, minted by Supabase (admin.createUser doesn't return one).
    const { data: signInData, error: signInErr } = await getAnonClient().auth.signInWithPassword({ email, password });
    if (signInErr || !signInData?.session) {
      console.error('[signup] Post-signup sign-in failed:', signInErr?.message);
      return res.status(500).json({ error: 'SERVER_ERROR', message: 'Account created, but starting your session failed -- please sign in.' });
    }

    return await issueSession(user, req, res, { verificationCooldownUntil: verificationResult.cooldownUntil }, signInData.session);
  } catch (err) {
    console.error('[signup]', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Registration encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// EMAIL VERIFICATION ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /api/auth/verify-email?token=...
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'MISSING_TOKEN', message: 'Verification token is required.' });

    const user = await db.get('SELECT * FROM users WHERE email_verify_token = ?', [hashToken(token)]);
    if (!user) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'This verification link is invalid or has already been used.' });
    }
    if (!user.email_verify_expires_at || new Date(user.email_verify_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_TOKEN', message: 'This verification link has expired. Please request a new one.' });
    }

    await db.run(
      'UPDATE users SET email_verified = 1, email_verify_token = NULL, email_verify_expires_at = NULL WHERE id = ?',
      [user.id]
    );

    return res.json({ success: true, message: '🐾 Your email has been verified successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Email verification encountered a problem.' });
  }
});

// POST /api/auth/resend-verification  (authenticated)
router.post('/resend-verification', authenticateAccess, async (req, res) => {
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (user.email_verified) {
      return res.json({ success: true, alreadyVerified: true, message: 'Your email is already verified! 🐾' });
    }

    const result = await triggerVerificationEmail(user);
    if (result.throttled) {
      const waitSeconds = Math.ceil((result.cooldownUntil - Date.now()) / 1000);
      return res.status(429).json({
        error: 'COOLDOWN',
        message: `Please wait ${waitSeconds}s before requesting another verification email.`,
        cooldownUntil: result.cooldownUntil,
        waitSeconds
      });
    }

    return res.json({ success: true, message: '🐾 Verification email sent! Please check your inbox.', cooldownUntil: result.cooldownUntil });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to resend verification email.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// STANDARD EMAIL / PASSWORD SIGN IN
// ═══════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const identifier = req.body.email || req.body.username || req.body.emailOrUsername;
    const password = req.body.password;
    const deviceToken = req.headers['x-device-token'] || req.body.deviceToken;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: "🐾 Looks like something's missing." });
    }

    let user = null;
    if (identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier);
    }
    if (!user) {
      user = await UserRepo.findByUsername(identifier);
    }
    if (!user && !identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier);
    }

    if (!user) {
      return res.status(401).json({ error: 'NOT_FOUND', message: "🐾 We couldn't sniff out that account." });
    }

    // Migrated (or newly signed-up) accounts have auth_user_id set and
    // authenticate via Supabase Auth. Accounts not yet migrated (the
    // one-time migration script hasn't run for them yet) fall back to the
    // original bcrypt check -- this is what makes the migration safe to
    // run without forcing every existing user to reset their password.
    let supabaseSession = null;
    if (user.auth_user_id) {
      const { data, error } = await getAnonClient().auth.signInWithPassword({ email: user.email, password });
      if (error || !data?.session) {
        return res.status(401).json({ error: 'BAD_PASSWORD', message: "🐾 That password doesn't match our records. Give it another sniff." });
      }
      supabaseSession = data.session;
    } else if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'BAD_PASSWORD', message: "🐾 That password doesn't match our records. Give it another sniff." });
    }

    // Check PawPrint 2FA
    if (user.pawprint_2fa_enabled === 1) {
      if (!(await UserRepo.isDeviceTrusted(user.id, deviceToken))) {
        // Device is untrusted: Generate Paw Code & 10m temp token
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);
        if (!process.env.SMTP_USER) console.log(`[DEV ONLY] PawPrint code for ${user.email}: ${code}`);
        sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

        // The password was already verified above (Supabase or bcrypt,
        // whichever applies) -- if that was a Supabase session, its tokens
        // ride along inside this short-lived tempToken so /2fa/verify-login
        // can complete the session without re-asking for the password.
        const tempToken = jwt.sign(
          { id: user.id, is2FATemp: true, sat: supabaseSession?.access_token, srt: supabaseSession?.refresh_token },
          config.JWT_ACCESS_SECRET,
          { expiresIn: '10m' }
        );
        return res.json({
          requires2FA: true,
          tempToken,
          email: maskEmail(user.email)
        });
      }
    }

    return await issueSession(user, req, res, {}, supabaseSession);
  } catch (err) {
    console.error('[LOGIN ERROR]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Sign in encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// PAWPRINT VERIFICATION (2FA) ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Shared cooldown tracker for the "send a code to enable PawPrint" step --
// same synchronous-set-before-await shape as verificationCooldowns
// elsewhere in this file, so a rapid double-tap can't generate two
// different codes for the same pair of requests.
const pawprintEnableCodeCooldowns = new Map(); // userId -> last-sent timestamp
const PAWPRINT_ENABLE_CODE_COOLDOWN_MS = 60 * 1000;

// Brute-force guard shared by both code-verification endpoints
// (/2fa/verify-enable and /2fa/verify-login) -- a 6-digit code is only
// ~1e6 possibilities, so without this a script could just try all of them
// inside the 10-minute window. After PAW_CODE_MAX_ATTEMPTS wrong guesses,
// the account is locked out of verifying (existing or future codes) for
// PAW_CODE_LOCKOUT_MS regardless of how many new codes get requested in the
// meantime -- requesting a new code does not clear an active lock.
const pawCodeAttempts = new Map(); // userId -> { count, lockedUntil }
const PAW_CODE_MAX_ATTEMPTS = 5;
const PAW_CODE_LOCKOUT_MS = 15 * 60 * 1000;

function pawCodeLockSecondsRemaining(userId) {
  const rec = pawCodeAttempts.get(userId);
  if (rec?.lockedUntil && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}

function registerPawCodeFailure(userId) {
  const rec = pawCodeAttempts.get(userId) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= PAW_CODE_MAX_ATTEMPTS) {
    rec.count = 0;
    rec.lockedUntil = Date.now() + PAW_CODE_LOCKOUT_MS;
  }
  pawCodeAttempts.set(userId, rec);
}

function clearPawCodeAttempts(userId) {
  pawCodeAttempts.delete(userId);
}

// 1. Send Paw Code for Enablement (Authenticated)
router.post('/2fa/send-code', authenticateAccess, async (req, res) => {
  try {
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    if (user.pawprint_2fa_enabled) {
      return res.json({ success: true, alreadyEnabled: true, message: 'PawPrint Verification is already enabled! 🐾' });
    }
    if (!user.email_verified) {
      return res.status(400).json({ error: 'EMAIL_NOT_VERIFIED', message: 'Please verify your account email first, then enable PawPrint.' });
    }

    const now = Date.now();
    const lastSent = pawprintEnableCodeCooldowns.get(user.id);
    if (lastSent && now - lastSent < PAWPRINT_ENABLE_CODE_COOLDOWN_MS) {
      const waitSeconds = Math.ceil((lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS - now) / 1000);
      return res.status(429).json({
        error: 'COOLDOWN',
        message: `Please wait ${waitSeconds}s before requesting another code.`,
        cooldownUntil: lastSent + PAWPRINT_ENABLE_CODE_COOLDOWN_MS,
        waitSeconds,
      });
    }
    pawprintEnableCodeCooldowns.set(user.id, now);

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(now + 10 * 60 * 1000).toISOString(); // 10 mins
    await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);

    if (!process.env.SMTP_USER) console.log(`[DEV ONLY] PawPrint code for ${user.email}: ${code}`);
    sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

    return res.json({ success: true, message: 'Paw Code sent to your registered email.', cooldownUntil: now + PAWPRINT_ENABLE_CODE_COOLDOWN_MS });
  } catch (err) {
    console.error('[/2fa/send-code error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to send Paw Code.' });
  }
});

// 2. Verify Code & Enable 2FA (Authenticated)
router.post('/2fa/verify-enable', authenticateAccess, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'MISSING_CODE', message: 'Please enter the Paw Code.' });
    }

    const lockedSeconds = pawCodeLockSecondsRemaining(req.user.id);
    if (lockedSeconds > 0) {
      return res.status(429).json({ error: 'LOCKED', message: `Too many incorrect attempts. Try again in ${lockedSeconds}s.`, waitSeconds: lockedSeconds });
    }

    const pawData = await UserRepo.getPawCode(req.user.id);
    if (!pawData || !pawData.paw_code) {
      return res.status(400).json({ error: 'INVALID_CODE', message: 'No verification code requested. Please request a new code.' });
    }

    if (pawData.paw_code !== hashToken(code.trim())) {
      registerPawCodeFailure(req.user.id);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    if (!pawData.paw_code_expires_at || new Date(pawData.paw_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    await UserRepo.set2FAStatus(req.user.id, 1);
    await UserRepo.clearPawCode(req.user.id);
    clearPawCodeAttempts(req.user.id);

    return res.json({ success: true, message: 'PawPrint Verification enabled successfully! 🐾' });
  } catch (err) {
    console.error('[/2fa/verify-enable error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to verify Paw Code.' });
  }
});

// 3. Disable 2FA (Authenticated)
router.post('/2fa/disable', authenticateAccess, async (req, res) => {
  try {
    await UserRepo.set2FAStatus(req.user.id, 0);
    await UserRepo.clearPawCode(req.user.id);
    await UserRepo.clearTrustedDevices(req.user.id);
    clearPawCodeAttempts(req.user.id);
    return res.json({ success: true, message: 'PawPrint Verification disabled.' });
  } catch (err) {
    console.error('[/2fa/disable error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to disable PawPrint Verification.' });
  }
});

// 4. Verify 2FA on Login (Public with tempToken)
router.post('/2fa/verify-login', async (req, res) => {
  try {
    const { tempToken, code, trustDevice } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Missing token or verification code.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(tempToken, config.JWT_ACCESS_SECRET);
    } catch (err) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Verification session expired. Please sign in again.' });
    }

    if (!decoded.is2FATemp || !decoded.id) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Invalid verification session.' });
    }

    const user = await UserRepo.findById(decoded.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const lockedSeconds = pawCodeLockSecondsRemaining(user.id);
    if (lockedSeconds > 0) {
      return res.status(429).json({ error: 'LOCKED', message: `Too many incorrect attempts. Try again in ${lockedSeconds}s.`, waitSeconds: lockedSeconds });
    }

    const pawData = await UserRepo.getPawCode(user.id);
    if (!pawData || !pawData.paw_code || pawData.paw_code !== hashToken(code.trim())) {
      registerPawCodeFailure(user.id);
      return res.status(400).json({ error: 'INVALID_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    if (!pawData.paw_code_expires_at || new Date(pawData.paw_code_expires_at) < new Date()) {
      return res.status(400).json({ error: 'EXPIRED_CODE', message: 'The Paw Code is incorrect or has expired. Please try again.' });
    }

    // Code is valid! Clear code.
    await UserRepo.clearPawCode(user.id);
    clearPawCodeAttempts(user.id);

    let newDeviceToken = null;
    if (trustDevice) {
      newDeviceToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      const deviceInfo = req.headers['user-agent'] || 'Browser';
      await UserRepo.addTrustedDevice(user.id, newDeviceToken, deviceInfo, expiresAt);
    }

    const supabaseSession = decoded.sat ? { access_token: decoded.sat, refresh_token: decoded.srt } : null;
    return await issueSession(user, req, res, { deviceToken: newDeviceToken }, supabaseSession);
  } catch (err) {
    console.error('[/2fa/verify-login error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Verification failed.' });
  }
});

// 5. Resend Code (Public or Auth)
router.post('/2fa/resend-code', async (req, res) => {
  try {
    const { tempToken } = req.body;
    let userId = null;

    if (tempToken) {
      try {
        const decoded = jwt.verify(tempToken, config.JWT_ACCESS_SECRET);
        userId = decoded.id;
      } catch {
        return res.status(400).json({ error: 'INVALID_TOKEN', message: 'Verification session expired. Please sign in again.' });
      }
    } else {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          const decoded = jwt.verify(authHeader.split(' ')[1], config.JWT_ACCESS_SECRET);
          userId = decoded.id;
        } catch {}
      }
    }

    if (!userId) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'Cannot resend code. Please try again.' });
    }

    const user = await UserRepo.findById(userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await UserRepo.setPawCode(user.id, hashToken(code), expiresAt);

    if (!process.env.SMTP_USER) console.log(`[DEV ONLY] PawPrint code (resent) for ${user.email}: ${code}`);
    sendPawCodeEmail(user.email, code).catch(err => console.error("[sendPawCodeEmail error]:", err.message));

    return res.json({ success: true, message: 'A new Paw Code has been sent to your registered email.' });
  } catch (err) {
    console.error('[/2fa/resend-code error]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to resend Paw Code.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// FORGOT PASSWORD
// ═══════════════════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body;
    if (!identifier || !identifier.trim()) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: "🐾 Looks like something's missing." });
    }

    let user = null;
    if (identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier.trim());
    }
    if (!user) {
      user = await UserRepo.findByUsername(identifier.trim());
    }
    if (!user && !identifier.includes('@')) {
      user = await UserRepo.findByEmail(identifier.trim());
    }

    if (!user) {
      return res.status(404).json({ error: 'NOT_FOUND', message: "🐾 We couldn't find that pet parent. Double-check and try again." });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour expiry
    await UserRepo.updateResetToken(user.id, hashToken(token), expiresAt);

    const resetLink = `${config.CLIENT_URL || 'http://localhost:5173'}/reset-password?token=${token}`;
    if (!process.env.SMTP_USER) console.log(`[DEV ONLY] Password reset link for ${user.email}: ${resetLink}`);
    await sendPasswordResetEmail(user.email, resetLink);

    return res.json({ message: "🐾 A password reset link has been sent to your linked email. Check your inbox and follow the instructions." });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Forgot password operation encountered a problem.' });
  }
});

// ═══════════════════════════════════════════════════════════════
// RESET PASSWORD
// ═══════════════════════════════════════════════════════════════
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'NO_TOKEN', message: "🐾 That password reset link is invalid or has expired. Give it another sniff." });
    }

    const user = await UserRepo.findByResetToken(hashToken(token));
    if (!user || new Date(user.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'INVALID_TOKEN', message: "🐾 That password reset link is invalid or has expired. Give it another sniff." });
    }

    const errors = [];

    // Validate Password
    if (!password || !validatePassword(password)) {
      errors.push({
        field: 'password',
        message: '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    // Validate Confirm Password
    if (password !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "🐾 Those passwords don't match. Give it another sniff." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    if (user.auth_user_id) {
      // Migrated/Supabase-backed account -- the real password lives in
      // Supabase now. password_hash is still updated too (harmless, keeps
      // the NOT NULL column populated) but is never read for this account.
      const { error } = await getAdminClient().auth.admin.updateUserById(user.auth_user_id, { password });
      if (error) {
        console.error('[reset-password] Supabase update failed:', error.message);
        return res.status(500).json({ error: 'SERVER_ERROR', message: 'Password reset encountered a problem.' });
      }
      // Note: Supabase has no "revoke all sessions by user id" without an
      // existing valid access token to submit (this is a forgot-password
      // flow -- the user has none). Already-issued access tokens remain
      // valid until their own (short) expiry; only future refreshes are
      // blocked once a new password is set. See change-password below for
      // the fully-revoking version, usable when the user has an active
      // session token to pass along.
    } else {
      const password_hash = await bcrypt.hash(password, 12);
      await UserRepo.updatePassword(user.id, password_hash);
    }
    await UserRepo.clearResetToken(user.id);

    return res.json({ message: "🐾 Password updated successfully. Try signing in!" });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Password reset encountered a problem.' });
  }
});

// ── Change Password ─────────────────────────────────────────
router.post('/change-password', authenticateAccess, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const user = await UserRepo.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    if (!currentPassword) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Current password is required' }] });
    }

    if (user.auth_user_id) {
      const { error: verifyErr } = await getAnonClient().auth.signInWithPassword({ email: user.email, password: currentPassword });
      if (verifyErr) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Incorrect current password' }] });
      }
    } else if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors: [{ field: 'currentPassword', message: 'Incorrect current password' }] });
    }

    const errors = [];
    if (!newPassword || !validatePassword(newPassword)) {
      errors.push({
        field: 'newPassword',
        message: 'Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character'
      });
    }

    if (newPassword !== confirmPassword) {
      errors.push({ field: 'confirmPassword', message: "Passwords don't match." });
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', errors });
    }

    if (user.auth_user_id) {
      const { error } = await getAdminClient().auth.admin.updateUserById(user.auth_user_id, { password: newPassword });
      if (error) return sendServerError(res, new Error(error.message));
      // Unlike reset-password, we DO have a live access token here -- use
      // it to revoke every OTHER session for this user right now (closes
      // the exact gap flagged earlier: a stolen session staying valid
      // through a password change), while leaving the device that just
      // made this request logged in ('others', not 'global' -- the user
      // shouldn't be logged out of their own change-password action).
      // Best-effort: the password change itself already succeeded
      // regardless of this outcome.
      const accessToken = req.headers.authorization?.split(' ')[1];
      if (accessToken) {
        await getAdminClient().auth.admin.signOut(accessToken, 'others').catch(err => {
          console.error('[change-password] Supabase signOut failed:', err.message);
        });
      }
    } else {
      const password_hash = await bcrypt.hash(newPassword, 12);
      await UserRepo.updatePassword(user.id, password_hash);
    }

    return res.json({ success: true, message: 'Password updated successfully!' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── Refresh ───────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'NO_TOKEN' });

    const record = await verifyRefreshToken(refreshToken);
    if (record) {
      // Existing custom-JWT path (Google Sign-In users) -- unchanged.
      await revokeRefreshToken(refreshToken);
      const user = await UserRepo.findById(record.user_id);
      if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });

      const newAccessToken  = generateAccessToken(user);
      const newRefreshToken = await generateRefreshToken(user, record.device_info);
      return res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
    }

    // Not a token we issued -- try it as a Supabase Auth refresh token
    // (email/password path). Supabase refresh tokens rotate on use too,
    // same guarantee the custom path already had.
    const { data, error } = await getAnonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'INVALID_REFRESH', message: 'Invalid or expired refresh token' });
    }
    const user = await db.get('SELECT id, email FROM users WHERE auth_user_id = ?', [data.session.user.id]);
    if (!user) return res.status(401).json({ error: 'USER_NOT_FOUND' });
    res.json({ accessToken: data.session.access_token, refreshToken: data.session.refresh_token });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Token refresh encountered a problem.' });
  }
});

// ── Logout ────────────────────────────────────────────────────
router.post('/logout', authenticateAccess, async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const user = await UserRepo.findById(req.user.id);
    if (user?.auth_user_id) {
      // Supabase Auth path -- revoke only THIS session ('local'), matching
      // the existing custom-JWT logout's per-device semantics (it only
      // ever revoked the one refresh token the client sent, not every
      // device). Best-effort: logout must still succeed client-side even
      // if this call fails.
      const accessToken = req.headers.authorization?.split(' ')[1];
      if (accessToken) {
        await getAdminClient().auth.admin.signOut(accessToken, 'local').catch(err => {
          console.error('[logout] Supabase signOut failed:', err.message);
        });
      }
    } else if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }
    res.json({ message: 'Logged out' });
  } catch (err) {
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Logout encountered a problem.' });
  }
});

// ── /me ───────────────────────────────────────────────────────
router.get('/me', authenticateAccess, async (req, res) => {
  try {
    const io = req.app.get('io');
    const user = await getUserWithFreshPlanState(req.user.id, io);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
    const pet = await PetRepo.getActivePet(user.id);
    const allPets = await PetRepo.findAllByUserId(user.id);

    // Best-effort, non-blocking verification reminder -- fires on session
    // checks (app loads) rather than a cron job, since there's no scheduler
    // in this codebase. Gated so it can only ever fire once per 7 days per
    // user: reuses the notifications table itself as the cooldown record
    // instead of adding a new column.
    if (!user.email_verified && io) {
      maybeSendVerifyReminder(user, io).catch(() => {});
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        full_name: user.full_name,
        pawprint_2fa_enabled: user.pawprint_2fa_enabled ? 1 : 0,
        super_sniff_enabled: user.super_sniff_enabled ? 1 : 0,
        email_verified: user.email_verified ? 1 : 0,
        is_admin: user.is_admin,
        current_plan: user.current_plan,
        subscription_status: user.subscription_status,
        is_founding_member: user.is_founding_member ? 1 : 0,
        welcome_slider_seen: user.welcome_slider_seen ? 1 : 0,
        premium_badge_enabled: user.premium_badge_enabled ? 1 : 0,
      },
      pet: pet || null,
      allPets: allPets || [],
    });
  } catch (err) {
    console.error('[/me ERROR]:', err);
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Profile retrieval encountered a problem.' });
  }
});

export default router;