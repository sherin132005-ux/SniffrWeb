import db from '../db/connection.js';
import {
  getPlan,
  LAUNCH_OFFER_PLAN,
  LAUNCH_OFFER_USER_LIMIT,
} from '../config/plans.js';
import { getGateway } from './paymentGateway.js';
import storage from '../storage/index.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { sendPaymentApprovedEmail, sendPaymentRejectedEmail, sendAdminPaymentReviewEmail } from '../utils/mailer.js';
import config from '../config.js';

// Calendar-month addition, not months*30 days -- so Plus (1mo)/Gold (3mo)/
// Platinum (12mo) expire on the same day-of-month they were purchased
// (Jan 10 -> Feb 10 / Apr 10 / Jan 10 next year) instead of drifting.
// Clamps the day into the target month when it doesn't exist there
// (Jan 31 + 1mo -> Feb 28/29, not spilling into March) -- the same
// end-of-month behavior billing systems like Stripe use.
function addMonths(date, months) {
  const d = new Date(date);
  const targetMonthIndex = d.getMonth() + months;
  const daysInTargetMonth = new Date(d.getFullYear(), targetMonthIndex + 1, 0).getDate();
  const result = new Date(d);
  result.setDate(1); // park on a safe day before changing month, so setMonth can't overflow
  result.setMonth(targetMonthIndex);
  result.setDate(Math.min(d.getDate(), daysInTargetMonth));
  return result;
}

// "Has premium access right now" -- true for 'active' (will auto-renew) and
// for 'cancelled' (won't renew, but the already-paid-for period hasn't
// ended yet). Only 'expired'/'inactive' actually lose access. Exported so
// PetRepository can compute the same is_premium/badge logic in one place
// (see attachCompletionStats) rather than duplicating the rule.
export function hasCurrentAccess(user) {
  if (user.subscription_status !== 'active' && user.subscription_status !== 'cancelled') return false;
  if (!user.plan_expiry_date) return false;
  return new Date(user.plan_expiry_date) > new Date();
}

export function emitPremiumUpdate(io, user) {
  if (!io) return;
  io.to(`user_${user.id}`).emit('premium_status_updated', serializePremiumState(user));
}

// Emits an already-built state object as-is (used when the caller needs to
// attach extra fields getFullPremiumState computes, e.g. hasPendingCheckout,
// that serializePremiumState alone can't see since it never touches the DB).
export function emitPremiumState(io, userId, state) {
  if (!io) return;
  io.to(`user_${userId}`).emit('premium_status_updated', state);
}

// Billing status is a small state machine derived from the same two fields
// hasCurrentAccess() already reads -- kept here as the single place that
// decides the label so the frontend never hardcodes this text itself.
const BILLING_STATUS_LABELS = {
  active: 'Active',
  cancelled: 'Cancelled (active until renewal date)',
  expired: 'Expired',
  inactive: 'Active (Free Tier)',
};

function getBillingStatus(user, active) {
  if (active) return user.subscription_status === 'cancelled' ? 'cancelled' : 'active';
  return user.subscription_status === 'expired' ? 'expired' : 'inactive';
}

// The one shape every route/socket event sends to the client -- so the
// frontend never has to re-derive "am I premium" from raw DB fields itself.
export function serializePremiumState(user) {
  const active = hasCurrentAccess(user);
  const effectivePlanKey = active ? user.current_plan : 'free';
  const plan = getPlan(effectivePlanKey);
  const billingStatus = getBillingStatus(user, active);
  return {
    currentPlan: effectivePlanKey,
    planSource: user.plan_source,
    subscriptionStatus: user.subscription_status,
    planStartDate: user.plan_start_date,
    planExpiryDate: user.plan_expiry_date,
    autoRenew: !!user.auto_renew,
    premiumBadgeEnabled: !!user.premium_badge_enabled,
    isFoundingMember: !!user.is_founding_member,
    isPremium: active && effectivePlanKey !== 'free',
    boostCreditsRemaining: active ? user.boost_credits_remaining : 0,
    hasEarlyAccess: active && plan.hasEarlyAccess,
    canUndoLike: active && plan.canUndoLike,
    canUseSuperSniff: active && plan.canUseSuperSniff,
    limits: {
      maxCommunitiesJoined: plan.maxCommunitiesJoined,
      maxCommunitiesCreated: plan.maxCommunitiesCreated,
      maxPets: plan.maxPets,
    },
    adFrequency: plan.adFrequency,
    billingStatus,
    billingStatusLabel: BILLING_STATUS_LABELS[billingStatus],
    // Only getFullPremiumState() (which does an extra DB read) can know this
    // is actually true -- default false here so every other emit path stays
    // correct without needing to know about payment_sessions at all.
    hasPendingCheckout: false,
  };
}

// Lazily expires a subscription whose period has ended. Called on every
// plan-state read, so an expiry is reflected on the very next request/gate
// check without needing a background cron job -- and fires the same
// realtime event a real expiry job would.
async function checkAndExpireIfNeeded(user, io = null) {
  if (user.subscription_status !== 'active' && user.subscription_status !== 'cancelled') return user;
  if (!user.plan_expiry_date || new Date(user.plan_expiry_date) > new Date()) return user;

  await db.run("UPDATE users SET subscription_status = 'expired', boost_credits_remaining = 0 WHERE id = ?", [user.id]);
  await db.run(
    'INSERT INTO plan_history (user_id, plan, source, action) VALUES (?, ?, ?, ?)',
    [user.id, user.current_plan, user.plan_source, 'expired']
  );

  const updated = { ...user, subscription_status: 'expired', boost_credits_remaining: 0 };
  emitPremiumUpdate(io, updated);
  return updated;
}

export async function getUserWithFreshPlanState(userId, io = null) {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return null;
  return checkAndExpireIfNeeded(user, io);
}

// Also attaches whether the user has a payment session awaiting
// confirmation (recent, unresolved) -- the one extra bit of state
// serializePremiumState() can't compute on its own since it's a pure
// function of the users row and never touches payment_sessions.
export async function getFullPremiumState(userId, io = null) {
  const user = await getUserWithFreshPlanState(userId, io);
  if (!user) return null;
  const state = serializePremiumState(user);

  // Abandoned/in-flight checkout: a session was created but payment hasn't
  // been attempted yet. Time-bounded so a checkout the user simply walked
  // away from doesn't show as "Pending" forever.
  const pendingSession = await db.get(
    `SELECT id FROM payment_sessions
     WHERE user_id = ? AND status = 'pending' AND created_at > NOW() - INTERVAL '30 minutes'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (pendingSession) {
    state.billingStatus = 'pending';
    state.billingStatusLabel = 'Pending';
    state.hasPendingCheckout = true;
    return state;
  }

  // Manual UPI payment submitted, awaiting admin review. Deliberately no
  // time window here (unlike 'pending' above) -- a real submitted payment
  // can legitimately sit unreviewed for hours or days, and it must keep
  // reading as pending the whole time rather than quietly going stale.
  const pendingReviewSession = await db.get(
    `SELECT id FROM payment_sessions
     WHERE user_id = ? AND status = 'pending_review'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (pendingReviewSession) {
    state.billingStatus = 'pending_review';
    state.billingStatusLabel = 'Payment Under Review';
    state.hasPendingCheckout = true;
  }

  return state;
}

// ─── Payment-abstraction-ready activation ──────────────────────────────
// Called only from confirmCheckoutSession() below (after the gateway has
// confirmed payment) or from grantLaunchOfferIfEligible() (free grant, no
// payment involved at all). Never called directly from a route anymore --
// there is no path from an HTTP request to an activated plan that skips
// checkout/confirm.
export async function subscribeToPlan(userId, planKey, { source = 'paid', amountPaid = null, io = null, paymentSessionId = null } = {}) {
  const plan = getPlan(planKey);
  const now = new Date();
  const expiry = addMonths(now, plan.durationMonths);
  const paid = amountPaid !== null ? amountPaid : plan.priceInr;

  const before = await db.get('SELECT current_plan, subscription_status, plan_expiry_date FROM users WHERE id = ?', [userId]);
  const hadActiveAccess = !!(before && hasCurrentAccess(before));

  // Classify the billing event so plan_history/Billing History can show
  // "Upgraded from Plus" vs. a plain "Subscribed" -- source='launch_offer'
  // always wins regardless of prior state (it's a gift, never a renewal).
  let action = 'subscribed';
  let previousPlan = null;
  if (source === 'launch_offer') {
    action = 'launch_offer_granted';
  } else if (hadActiveAccess) {
    previousPlan = before.current_plan;
    if (before.current_plan === planKey) {
      action = 'renewed';
    } else {
      action = getPlan(planKey).priceInr > getPlan(before.current_plan).priceInr ? 'upgraded' : 'downgraded';
    }
  }

  await db.run(
    `UPDATE users SET
       current_plan = ?, plan_source = ?, subscription_status = 'active',
       plan_start_date = ?, plan_expiry_date = ?, auto_renew = 1,
       boost_credits_remaining = ?, boost_credits_refreshed_at = ?
     WHERE id = ?`,
    [planKey, source, now.toISOString(), expiry.toISOString(), plan.boostCreditsPerCycle, now.toISOString(), userId]
  );
  await db.run(
    'INSERT INTO plan_history (user_id, plan, source, action, amount_paid, previous_plan, payment_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, planKey, source, action, paid, previousPlan, paymentSessionId]
  );

  const user = await getUserWithFreshPlanState(userId, io);
  emitPremiumUpdate(io, user);
  return user;
}

// ─── Checkout: Step 1 — create a payment session ───────────────────────
// Creates a session with the active gateway and records it as 'pending'.
// Crucially, this does NOT touch the user's plan at all -- an abandoned
// checkout has zero effect on their account. The live route
// (POST /premium/checkout) always passes provider='upi_manual' -- 'mock'
// is kept only as an explicit opt-in for local/dev use, never the default
// a real request goes through.
export async function createCheckoutSession(userId, planKey, provider = 'mock', io = null) {
  const plan = getPlan(planKey);
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('USER_NOT_FOUND');

  const gateway = getGateway(provider);
  const { providerReference, clientData } = await gateway.createSession({
    plan: planKey,
    amountInr: plan.priceInr,
    user,
  });

  const result = await db.run(
    `INSERT INTO payment_sessions (user_id, plan, amount, provider, status, provider_reference)
     VALUES (?, ?, ?, ?, 'pending', ?) RETURNING id`,
    [userId, planKey, plan.priceInr, provider, providerReference]
  );
  const sessionId = result.rows[0].id;

  // Live-reflect the new "Pending" billing status immediately, in case the
  // user has Manage Subscription open in another tab.
  const state = await getFullPremiumState(userId, io);
  emitPremiumState(io, userId, state);

  return { sessionId, plan: planKey, amount: plan.priceInr, provider, clientData, state };
}

// ─── Checkout: Step 2 (legacy/dev only) — confirm payment, then activate ──
// In production this is what a signature-verified provider webhook would
// call, NOT something the client invokes directly. The mock gateway has no
// real webhook, so the frontend used to call this itself once the
// (simulated) payment method step completed.
//
// IMPORTANT: this path is intentionally restricted to provider='mock' only.
// A real manual-UPI session (provider='upi_manual') must NEVER be
// activatable through a client-triggered confirm call -- the only way one
// reaches 'succeeded' is a future admin approval endpoint. Submitting
// payment proof (see submitManualPaymentProof below) moves a session to
// 'pending_review', not 'succeeded', and never calls subscribeToPlan().
export async function confirmCheckoutSession(userId, sessionId, io = null) {
  const session = await db.get('SELECT * FROM payment_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  if (!session) return { success: false, reason: 'SESSION_NOT_FOUND' };
  if (session.status === 'succeeded') return { success: false, reason: 'ALREADY_CONFIRMED' };
  if (session.status !== 'pending') return { success: false, reason: 'SESSION_NOT_PENDING' };
  if (session.provider !== 'mock') return { success: false, reason: 'MANUAL_REVIEW_REQUIRED' };

  const gateway = getGateway(session.provider);
  const result = await gateway.confirmSession(session);
  if (!result.success) {
    await db.run("UPDATE payment_sessions SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);
    return { success: false, reason: 'PAYMENT_FAILED' };
  }

  await db.run("UPDATE payment_sessions SET status = 'succeeded', completed_at = CURRENT_TIMESTAMP WHERE id = ?", [sessionId]);

  const user = await subscribeToPlan(userId, session.plan, {
    source: 'paid',
    amountPaid: Number(session.amount),
    io,
    paymentSessionId: sessionId,
  });

  return { success: true, user };
}

// ─── Manual UPI: submit payment proof for admin review ─────────────────
// Moves a session from 'pending' to 'pending_review'. This is as far as a
// normal authenticated user can ever push a manual-UPI session -- it never
// calls subscribeToPlan() and never sets status to 'succeeded'. Only a
// future admin-approval endpoint (not implemented yet) may do that.
// Ownership (user_id = ?), existence, and session-state eligibility are all
// enforced here so the route only has to worry about input-shape validation
// (payment_method/UTR format, file presence) before calling this.
export async function submitManualPaymentProof(userId, sessionId, { paymentMethod, upiTransactionId, file }, io = null) {
  const session = await db.get('SELECT * FROM payment_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]);
  if (!session) return { success: false, reason: 'SESSION_NOT_FOUND' };
  // Can't actually happen via createCheckoutSession (it already blocks
  // plan='free'), kept as defense-in-depth against a future change there.
  if (session.plan === 'free') return { success: false, reason: 'INVALID_PLAN' };
  // Guards against a stale/legacy session created under createCheckoutSession's
  // 'mock' default (still its signature default) ever being pushed into
  // manual-UPI review -- only sessions the live /checkout route actually
  // created (provider='upi_manual') are eligible for proof submission.
  if (session.provider !== 'upi_manual') return { success: false, reason: 'INVALID_PROVIDER' };
  if (session.status === 'succeeded') return { success: false, reason: 'ALREADY_CONFIRMED' };
  if (session.status === 'rejected') return { success: false, reason: 'SESSION_REJECTED' };
  if (session.status === 'pending_review') return { success: false, reason: 'ALREADY_SUBMITTED' };
  if (session.status !== 'pending') return { success: false, reason: 'SESSION_NOT_ELIGIBLE' };

  // Without this, the same real-world UTR could be submitted across
  // multiple sessions (own or another account's) and, if an admin
  // approves more than one without manually cross-referencing every prior
  // submission, one real payment activates Premium more than once. A
  // partial unique index on payment_sessions also enforces this at the DB
  // level as a race-proof backstop (see migration).
  const reused = await db.get(
    `SELECT id FROM payment_sessions
     WHERE upi_transaction_id = ? AND id != ? AND status IN ('pending_review', 'approval_in_progress', 'succeeded')`,
    [upiTransactionId, sessionId]
  );
  if (reused) return { success: false, reason: 'UTR_ALREADY_USED' };

  // Upload only after every DB-backed validation above has passed, so an
  // invalid/duplicate/foreign session never wastes a Cloudinary upload.
  const proofUrl = await storage.upload(file, 'payment_proofs');

  try {
    await db.run(
      `UPDATE payment_sessions
       SET payment_method = ?, upi_transaction_id = ?, proof_url = ?, submitted_at = CURRENT_TIMESTAMP, status = 'pending_review'
       WHERE id = ?`,
      [paymentMethod, upiTransactionId, proofUrl, sessionId]
    );
  } catch (err) {
    // 23505 = unique_violation -- the SELECT check above can't fully close
    // the race between two concurrent submissions of the same UTR; the
    // partial unique index on payment_sessions is the actual backstop.
    if (err.code === '23505') return { success: false, reason: 'UTR_ALREADY_USED' };
    throw err;
  }

  const state = await getFullPremiumState(userId, io);
  emitPremiumState(io, userId, state);

  // Notify every admin that a new payment needs review -- best-effort,
  // must never affect this already-successful submission (the row is
  // already 'pending_review' by this point). No "notify all admins"
  // helper exists in this codebase; this mirrors communities.js's
  // existing .map(member => sendRealtimeNotification(...)) shape for
  // notifying several recipients about one event, applied to
  // is_admin=true instead of a fixed community-member list. Fetched
  // directly (not via UserRepository.findAll(), which defaults to a
  // 20-row page and would silently under-notify past that).
  try {
    const admins = await db.all('SELECT id, email FROM users WHERE is_admin = TRUE');
    const submitter = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
    const submitterName = submitter?.username || 'A user';
    const plan = getPlan(session.plan);
    const reviewLink = `${config.CLIENT_URL || 'http://localhost:5173'}/admin/payments`;

    for (const admin of admins) {
      try {
        await sendRealtimeNotification(io, admin.id, {
          // 'activity' is the closest fit among the six notification_preferences
          // columns (matches/activity/pawcircle/nearby/offers/email) -- none is
          // a real match for "an admin task exists"; 'offers' is specifically
          // premium-promotional content going the other direction (to a user,
          // not from one), and 'email' isn't used as a content category
          // anywhere else in this codebase.
          category: 'activity',
          type: 'admin_payment_review_needed',
          title: `${submitterName} has requested ${plan.label}`,
          description: 'A new manual UPI payment is awaiting your review.',
          targetId: String(sessionId),
        });
      } catch (err) {
        console.error(`[submitManualPaymentProof] Failed to notify admin user_id=${admin.id} for payment_sessions.id=${sessionId}:`, err);
      }
      try {
        if (admin.email) {
          await sendAdminPaymentReviewEmail(admin.email, { submitterName, planLabel: plan.label, reviewLink });
        }
      } catch (err) {
        console.error(`[submitManualPaymentProof] Failed to email admin user_id=${admin.id} for payment_sessions.id=${sessionId}:`, err);
      }
    }
  } catch (err) {
    console.error(`[submitManualPaymentProof] Failed to notify admins for payment_sessions.id=${sessionId} (user_id=${userId}):`, err);
  }

  return { success: true, state };
}

// ─── Manual UPI: admin approval ─────────────────────────────────────────
// The only way a manual-UPI payment_sessions row can ever reach 'succeeded'
// and activate Premium. Uses a claim/commit pattern -- an atomic single-row
// UPDATE through an intermediate 'approval_in_progress' status -- instead
// of a DB transaction. This codebase has no transaction pattern anywhere
// (see server/db/connection.js: run/get/all/exec against a shared pg Pool,
// no BEGIN/COMMIT/pool.connect()), and subscribeToPlan() itself already
// does its two writes as plain sequential db.run() calls with no
// transaction, so this follows that same existing convention.
//
// ── Why a claim step ──
// A plain "pre-check then subscribeToPlan() then update" sequence has a
// race: two concurrent approve calls can both pass a non-atomic pre-check
// and both call subscribeToPlan() before either UPDATE lands. The atomic
// claim UPDATE below (status 'pending_review' -> 'approval_in_progress')
// closes that window -- only one request's UPDATE can ever match the row
// (rowCount === 1), so only one request can ever reach subscribeToPlan()
// for a given session. The loser doesn't retry/wait; it re-reads the row
// and returns whichever outcome actually matches its current state --
// idempotent success if it's already 'succeeded', a clear conflict if
// another request is still processing it.
export async function approveManualPayment(sessionId, adminUserId, io = null) {
  const session = await db.get('SELECT * FROM payment_sessions WHERE id = ?', [sessionId]);
  if (!session) return { success: false, reason: 'SESSION_NOT_FOUND' };
  if (session.provider !== 'upi_manual') return { success: false, reason: 'INVALID_PROVIDER' };

  // Step 1 -- atomic claim.
  const claim = await db.run(
    `UPDATE payment_sessions
     SET status = 'approval_in_progress', reviewed_by = ?
     WHERE id = ? AND status = 'pending_review'`,
    [adminUserId, sessionId]
  );

  if (claim.rowCount === 0) {
    // Didn't win the claim -- re-read to find out why, rather than
    // assuming, and return the outcome matching its actual current state.
    const current = await db.get('SELECT * FROM payment_sessions WHERE id = ?', [sessionId]);
    if (!current) return { success: false, reason: 'SESSION_NOT_FOUND' };

    if (current.status === 'succeeded') {
      // Idempotency case: already approved (by this call racing itself via
      // a retry, or by a concurrent request). Do NOT call subscribeToPlan()
      // again -- just report the same success shape a fresh approval
      // would, sourced from the row's own stored user_id.
      const user = await getUserWithFreshPlanState(current.user_id, io);
      return { success: true, user };
    }
    if (current.status === 'approval_in_progress') {
      return { success: false, reason: 'APPROVAL_IN_PROGRESS' };
    }
    // 'rejected', or anything else not eligible.
    return { success: false, reason: 'SESSION_NOT_PENDING_REVIEW' };
  }

  // Step 2 -- activate. Only the request that won the claim above ever
  // reaches here, so only one request can ever call subscribeToPlan() for
  // this session.
  try {
    const user = await subscribeToPlan(session.user_id, session.plan, {
      source: 'paid',
      amountPaid: Number(session.amount),
      io,
      paymentSessionId: session.id,
    });

    const commit = await db.run(
      `UPDATE payment_sessions
       SET status = 'succeeded', reviewed_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'approval_in_progress'`,
      [sessionId]
    );
    if (commit.rowCount === 0) {
      // Should not happen -- this request held the exclusive claim from
      // Step 1. Not thrown (the plan IS activated at this point), just
      // made loud so it's never silently missed.
      console.error(
        `[approveManualPayment] Unexpected state: held exclusive claim on payment_sessions.id=${sessionId} (user_id=${session.user_id}) but the commit UPDATE affected 0 rows after subscribeToPlan() succeeded.`
      );
    }

    // Billing history: subscribeToPlan() above already wrote the
    // plan_history row for this activation (action classified from the
    // user's prior state, amount_paid = session.amount,
    // payment_session_id = session.id) -- nothing more to record here.

    // Best-effort notifications about the already-finalized approval.
    // Premium is already active at this point regardless of what happens
    // below -- each is independently wrapped so a failure in one (e.g.
    // email) can never block or affect the other (e.g. notification), and
    // neither can turn this already-successful approval into a failure.
    const plan = getPlan(session.plan);
    try {
      await sendRealtimeNotification(io, session.user_id, {
        category: 'offers',
        type: 'premium_payment_approved',
        title: `✨ ${plan.label} is now active!`,
        description: `Your manual UPI payment was approved and ${plan.label} has been activated on your account.`,
        targetId: String(session.id),
      });
    } catch (err) {
      console.error(`[approveManualPayment] Failed to send notification for payment_sessions.id=${session.id} (user_id=${session.user_id}):`, err);
    }
    try {
      if (user?.email) {
        await sendPaymentApprovedEmail(user.email, { planLabel: plan.label, expiryDate: user.plan_expiry_date });
      }
    } catch (err) {
      console.error(`[approveManualPayment] Failed to send approval email for payment_sessions.id=${session.id} (user_id=${session.user_id}):`, err);
    }

    return { success: true, user };
  } catch (err) {
    // subscribeToPlan() failed -- release the claim so the session is
    // retryable instead of stuck at 'approval_in_progress' forever.
    await db.run(
      `UPDATE payment_sessions
       SET status = 'pending_review', reviewed_by = NULL
       WHERE id = ? AND status = 'approval_in_progress'`,
      [sessionId]
    );
    throw err;
  }
}

// No existing text-field length convention in this codebase to follow
// (rejection_reason is plain TEXT, no DB constraint) -- 500 is a sane cap
// per the task, not derived from an existing pattern.
const REJECTION_REASON_MAX_LENGTH = 500;

// ─── Manual UPI: admin rejection ────────────────────────────────────────
// Same claim/commit shape as approveManualPayment(), but simpler: rejection
// never touches Premium activation, so there's no external side effect
// that can fail and nothing to revert-on-failure -- the commit step below
// is a pure DB write.
export async function rejectManualPayment(sessionId, adminUserId, rejectionReason, io = null) {
  const session = await db.get('SELECT * FROM payment_sessions WHERE id = ?', [sessionId]);
  if (!session) return { success: false, reason: 'SESSION_NOT_FOUND' };
  if (session.provider !== 'upi_manual') return { success: false, reason: 'INVALID_PROVIDER' };

  const trimmedReason = typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
  if (!trimmedReason) return { success: false, reason: 'REJECTION_REASON_REQUIRED' };
  if (trimmedReason.length > REJECTION_REASON_MAX_LENGTH) return { success: false, reason: 'REJECTION_REASON_TOO_LONG' };

  // Step 1 -- atomic claim (mirrors approveManualPayment()'s claim, using
  // 'rejection_in_progress' instead of 'approval_in_progress').
  const claim = await db.run(
    `UPDATE payment_sessions
     SET status = 'rejection_in_progress', reviewed_by = ?
     WHERE id = ? AND status = 'pending_review'`,
    [adminUserId, sessionId]
  );

  if (claim.rowCount === 0) {
    const current = await db.get('SELECT * FROM payment_sessions WHERE id = ?', [sessionId]);
    if (!current) return { success: false, reason: 'SESSION_NOT_FOUND' };

    if (current.status === 'rejected') {
      // Idempotency case -- do NOT overwrite an existing rejection_reason
      // with whatever was passed on this replay call.
      return { success: true, sessionId, rejection_reason: current.rejection_reason };
    }
    if (current.status === 'succeeded') {
      // Premium was already activated for this session -- it must never
      // become rejectable after the fact.
      return { success: false, reason: 'ALREADY_APPROVED' };
    }
    if (current.status === 'approval_in_progress' || current.status === 'rejection_in_progress') {
      return { success: false, reason: 'REVIEW_IN_PROGRESS' };
    }
    return { success: false, reason: 'SESSION_NOT_PENDING_REVIEW' };
  }

  // Step 2 -- commit. Pure DB update, no try/catch-and-revert needed the
  // way approve needed one for subscribeToPlan().
  const commit = await db.run(
    `UPDATE payment_sessions
     SET status = 'rejected', rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'rejection_in_progress'`,
    [trimmedReason, sessionId]
  );
  if (commit.rowCount === 0) {
    // Should not happen -- this request held the exclusive claim from
    // Step 1. Logged loudly rather than silently missed.
    console.error(
      `[rejectManualPayment] Unexpected state: held exclusive claim on payment_sessions.id=${sessionId} (user_id=${session.user_id}) but the commit UPDATE affected 0 rows.`
    );
  }

  // Billing history: record this rejection as its own plan_history row, per
  // updated product requirement -- rejections should now be visible there.
  // No real plan transition happened, so this mirrors how 'cancelled'/
  // 'expired' rows already work: `plan` records what the event concerns,
  // `previous_plan` stays NULL (never a real from->to change), `source`
  // is 'none' (nothing was ever granted). Does NOT call subscribeToPlan()
  // -- this is a direct, minimal insert, matching this file's existing
  // raw-query style. payment_session_id is set so GET /premium/history can
  // join back to payment_sessions for rejection_reason without a new
  // column (see premium.js) -- the row itself doesn't duplicate that text.
  // Same resilience treatment as the notification/email side effects
  // below: independently wrapped, logged, never allowed to fail this
  // already-finalized rejection.
  try {
    await db.run(
      `INSERT INTO plan_history (user_id, plan, source, action, amount_paid, previous_plan, payment_session_id)
       VALUES (?, ?, 'none', 'payment_rejected', 0, NULL, ?)`,
      [session.user_id, session.plan, session.id]
    );
  } catch (err) {
    console.error(`[rejectManualPayment] Failed to record billing history for payment_sessions.id=${session.id} (user_id=${session.user_id}):`, err);
  }

  // Best-effort notifications about the already-finalized rejection. The
  // rejection is already correctly recorded regardless of what happens
  // below -- each is independently wrapped so a failure in one can never
  // block or affect the other, and neither can undo the rejection.
  const plan = getPlan(session.plan);
  try {
    await sendRealtimeNotification(io, session.user_id, {
      category: 'offers',
      type: 'premium_payment_rejected',
      title: `Your ${plan.label} payment couldn't be verified`,
      description: trimmedReason,
      targetId: String(session.id),
    });
  } catch (err) {
    console.error(`[rejectManualPayment] Failed to send notification for payment_sessions.id=${session.id} (user_id=${session.user_id}):`, err);
  }
  try {
    const user = await db.get('SELECT email FROM users WHERE id = ?', [session.user_id]);
    if (user?.email) {
      await sendPaymentRejectedEmail(user.email, { planLabel: plan.label, rejectionReason: trimmedReason });
    }
  } catch (err) {
    console.error(`[rejectManualPayment] Failed to send rejection email for payment_sessions.id=${session.id} (user_id=${session.user_id}):`, err);
  }

  return { success: true, sessionId, rejection_reason: trimmedReason };
}

// Stops auto-renew but keeps access until the already-paid-for period ends
// (realistic SaaS behavior) -- checkAndExpireIfNeeded() flips it to
// 'expired' once plan_expiry_date actually passes.
export async function cancelSubscription(userId, io = null) {
  await db.run(
    "UPDATE users SET auto_renew = 0, subscription_status = 'cancelled' WHERE id = ? AND subscription_status = 'active'",
    [userId]
  );
  const user = await getUserWithFreshPlanState(userId, io);
  if (user) {
    await db.run(
      'INSERT INTO plan_history (user_id, plan, source, action) VALUES (?, ?, ?, ?)',
      [userId, user.current_plan, user.plan_source, 'cancelled']
    );
    emitPremiumUpdate(io, user);
  }
  return user;
}

// Launch offer: first LAUNCH_OFFER_USER_LIMIT signups get free
// LAUNCH_OFFER_PLAN, tracked as plan_source='launch_offer' (never 'paid')
// so a later real subscription can't be confused with this grant.
// Call this AFTER the new user row has already been inserted, so
// COUNT(*) includes the new user itself -- COUNT<=limit is then exactly
// "this user is among the first `limit` ever created."
export async function grantLaunchOfferIfEligible(userId, io = null) {
  const countRow = await db.get('SELECT COUNT(*) as count FROM users');
  const totalUsers = Number(countRow?.count || 0);
  if (totalUsers > LAUNCH_OFFER_USER_LIMIT) return null;

  await db.run('UPDATE users SET is_founding_member = 1, welcome_slider_seen = 0 WHERE id = ?', [userId]);
  return subscribeToPlan(userId, LAUNCH_OFFER_PLAN, { source: 'launch_offer', amountPaid: 0, io });
}

export async function markWelcomeSliderSeen(userId) {
  await db.run('UPDATE users SET welcome_slider_seen = 1 WHERE id = ?', [userId]);
}
