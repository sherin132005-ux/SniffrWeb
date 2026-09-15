import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import api from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { useSocket } from '../../context/SocketContext';
import { usePremium } from '../../context/PremiumContext';
import { getCurrentGPSLocation, getStoredLocation } from '../../services/locationService';

const PLAN_LABELS = { free: 'Sniffr Free', plus: 'Sniffr Plus', gold: 'Sniffr Gold', platinum: 'Sniffr Platinum' };
const PLAN_EMOJI = { plus: '🌙', gold: '⭐', platinum: '👑' };

// Real UPI receiving details -- testing phase, personal account. Do not
// change without explicit instruction.
const SNIFFR_UPI_VPA = 'sherinpraisy06@okhdfcbank';
const SNIFFR_UPI_PAYEE_NAME = 'Sherin Praisy';

// Standard UPI deep-link format (NPCI): upi://pay?pa=...&pn=...&am=...&cu=INR&tn=...
// `am` uses two decimal places (the conventional/most widely-compatible
// format across UPI apps). `pa`/`cu` are left unencoded (VPAs and 'INR' need
// no escaping and this matches how real UPI links are conventionally
// written); `pn`/`tn` go through encodeURIComponent since they're
// free-text/contain spaces. Built entirely from data already on this
// screen (checkoutSession.amount, checkoutSession.plan) -- no new API call.
function buildUpiIntentUrl({ amount, planLabel }) {
  const amountStr = Number(amount).toFixed(2);
  // planLabel is already the full "Sniffr X" label (see PLAN_LABELS) -- no
  // extra "Sniffr " prefix here, or it doubles up into "Sniffr Sniffr Gold".
  const note = encodeURIComponent(planLabel);
  const payeeName = encodeURIComponent(SNIFFR_UPI_PAYEE_NAME);
  return `upi://pay?pa=${SNIFFR_UPI_VPA}&pn=${payeeName}&am=${amountStr}&cu=INR&tn=${note}`;
}

// Support Sniffr (Feed the Strays / For the Creators) -- untracked
// donations, same VPA/payee/encoding conventions as buildUpiIntentUrl()
// above, kept as a separate function rather than reusing it directly:
// donations need an amount-omitted variant (the `am` param is optional per
// the UPI deep-link spec -- omitting it lets the user's own UPI app prompt
// them for any amount, standard behavior for "pay what you like" QR codes),
// which buildUpiIntentUrl() doesn't support and isn't being changed to.
function buildDonationUpiUrl({ amount, note }) {
  const payeeName = encodeURIComponent(SNIFFR_UPI_PAYEE_NAME);
  const tn = encodeURIComponent(note);
  const amountParam = amount != null ? `&am=${Number(amount).toFixed(2)}` : '';
  return `upi://pay?pa=${SNIFFR_UPI_VPA}&pn=${payeeName}${amountParam}&cu=INR&tn=${tn}`;
}

// Same preset set/emoji pairings for both Support Sniffr variants (Feed the
// Strays / For the Creators) -- only title/subtitle/note text differ.
const DONATION_PRESETS = [
  { amount: 49, emoji: '🐾' },
  { amount: 99, emoji: '🐶' },
  { amount: 199, emoji: '❤️' },
  { amount: 299, emoji: '🐕' },
  { amount: 499, emoji: '🦴' },
  { amount: 999, emoji: '👑' },
];

// Display duration/price for the plan-selection cards below. This is
// UI-only -- checkout/payment amounts still come from the server's PLANS
// registry (server/config/plans.js) until the real payment flow lands, so
// these numbers intentionally don't have to match p.priceInr from
// GET /premium/plans yet.
const PLAN_PRICING = {
  plus:     { price: 99,  duration: '1 Month',   durationMonths: 1 },
  gold:     { price: 199, duration: '3 Months',  durationMonths: 3 },
  platinum: { price: 799, duration: '12 Months', durationMonths: 12 },
};

// Savings are always measured against the Plus 1-month baseline -- never
// by comparing one paid tier against another -- so a new tier or price
// change here recalculates correctly with no other edits required.
function getPlanSavings(planKey) {
  const plan = PLAN_PRICING[planKey];
  if (!plan) return 0;
  const baseline = PLAN_PRICING.plus.price * plan.durationMonths;
  return Math.max(0, baseline - plan.price);
}

// Every plan_history.action value in use today, mapped to display text.
// New billing events (e.g. 'refunded') just need one more entry here --
// action itself is free TEXT server-side, no migration required.
const BILLING_ACTION_LABELS = {
  subscribed: 'Subscribed',
  renewed: 'Renewed',
  upgraded: 'Upgraded',
  downgraded: 'Downgraded',
  cancelled: 'Cancelled',
  expired: 'Expired',
  launch_offer_granted: 'Gifted',
  payment_rejected: 'Payment Rejected',
};
// Only these actions represent an actual charge -- everything else
// (cancelled/expired) shows "-" instead of a price.
const BILLING_PAYMENT_ACTIONS = ['subscribed', 'renewed', 'upgraded', 'downgraded'];

export default function SettingsModals({ activeModal, onClose, onOpenModal }) {
  const navigate = useNavigate();
  const { user, pet: activePet, refreshProfile, logout } = useAuth();
  const { socket } = useSocket();
  const { premium, refresh: refreshPremium } = usePremium();

  // Toast notification state
  const [toast, setToast] = useState(null);

  // Form states
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordLoading, setPasswordLoading] = useState(false);

  // PawPrint Verification (enable-by-email-code) states
  const [pawCodeSent, setPawCodeSent] = useState(false);
  const [pawCodeInput, setPawCodeInput] = useState('');
  const [pawCodeLoading, setPawCodeLoading] = useState(false);
  const [pawCodeError, setPawCodeError] = useState('');
  const [pawCodeSuccess, setPawCodeSuccess] = useState('');
  const [resendTimer, setResendTimer] = useState(0);
  const [verifyEmailSending, setVerifyEmailSending] = useState(false);

  // Forgot password state (img1)
  const [forgotIdentifier, setForgotIdentifier] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotSuccess, setForgotSuccess] = useState('');

  const [contactForm, setContactForm] = useState({ subject: '', description: '', attachment: null });
  const [contactSubmitted, setContactSubmitted] = useState(false);

  const [bugForm, setBugForm] = useState({ category: 'UI Layout', description: '', screenshot: null });
  const [bugSubmitted, setBugSubmitted] = useState(false);

  const [featureForm, setFeatureForm] = useState({ title: '', description: '', screenshot: null });
  const [featureSubmitted, setFeatureSubmitted] = useState(false);

  const [rating, setRating] = useState(5);
  const [ratingSubmitted, setRatingSubmitted] = useState(false);
  const [ratingLoading, setRatingLoading] = useState(false);
  const [ratingAggregate, setRatingAggregate] = useState(null); // { average, count }

  const [selectedPlan, setSelectedPlan] = useState('gold'); // 'plus' | 'gold' | 'platinum'
  const [upgradeStep, setUpgradeStep] = useState('plans'); // 'plans' | 'payment' | 'pending_review' | 'success'
  const [checkoutSession, setCheckoutSession] = useState(null); // { sessionId, plan, amount, provider }
  // Computed once per checkoutSession change (not inline in JSX) so the QR
  // image and its tap-to-pay link always render from the exact same string.
  const upiIntentUrl = checkoutSession
    ? buildUpiIntentUrl({ amount: checkoutSession.amount, planLabel: PLAN_LABELS[checkoutSession.plan] || 'Sniffr Premium' })
    : null;
  const [checkingOut, setCheckingOut] = useState(false);
  // Manual UPI payment-proof submission (POST /premium/checkout/:id/submit)
  const [upiTransactionId, setUpiTransactionId] = useState('');
  const [paymentProof, setPaymentProof] = useState(null); // File object, not uploaded until submit
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [submissionError, setSubmissionError] = useState('');
  const [plansCatalog, setPlansCatalog] = useState([]);
  const [cancelling, setCancelling] = useState(false);
  const [billingHistory, setBillingHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Support Sniffr (Feed the Strays / For the Creators) -- entirely
  // untracked: no API call, no localStorage, nothing recorded anywhere in
  // Sniffr. Each preset amount carries its own emoji so the primary button
  // can echo it back ("<emoji> Contribute ₹<amount>").
  const [donationTier, setDonationTier] = useState(null); // { amount, emoji } | null
  const [donationQrView, setDonationQrView] = useState(null); // null | 'preset' | 'custom'

  const [reportsList, setReportsList] = useState([]);
  const [expandedFaq, setExpandedFaq] = useState(0);

  // Location permissions modal state
  const [locationData, setLocationData] = useState(null);
  const [permissionStatus, setPermissionStatus] = useState('');
  const [locationLoading, setLocationLoading] = useState(false);

  // Delete Account modal state (moved here from Privacy Policy page)
  const [deleteAccountPhase, setDeleteAccountPhase] = useState('confirm'); // 'confirm' | 'success'
  const [deleteAccountLoading, setDeleteAccountLoading] = useState(false);

  // Resend code countdown timer
  useEffect(() => {
    let interval = null;
    if (resendTimer > 0) {
      interval = setInterval(() => {
        setResendTimer(prev => prev - 1);
      }, 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [resendTimer]);

  // Reset password fields whenever activeModal changes
  useEffect(() => {
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    setPasswordErrors({});
    setPasswordLoading(false);
  }, [activeModal]);

  // Reset the Delete Account modal to its initial confirm step every time it's opened fresh
  useEffect(() => {
    if (activeModal === 'delete-account') {
      setDeleteAccountPhase('confirm');
      setDeleteAccountLoading(false);
    }
  }, [activeModal]);

  // Reset the Support Sniffr modals (Feed the Strays / For the Creators)
  // back to their amount-picker step every time either is opened fresh.
  useEffect(() => {
    if (activeModal === 'feed-strays' || activeModal === 'donate-creators') {
      setDonationTier(null);
      setDonationQrView(null);
    }
  }, [activeModal]);

  // Reset the PawPrint modal to its initial step every time it's opened fresh
  useEffect(() => {
    if (activeModal === 'pawprint-2fa') {
      setPawCodeSent(false);
      setPawCodeInput('');
      setPawCodeError('');
      setPawCodeSuccess('');
      setResendTimer(0);
    }
  }, [activeModal]);

  // Rate Sniffr -- load the live aggregate + this user's own existing
  // rating (if any) fresh each time the modal opens, so a user who already
  // rated sees their stars pre-filled and "Update Rating" wording instead
  // of being asked to rate again from scratch.
  useEffect(() => {
    if (activeModal !== 'rate-sniffr') return;
    api.get('/ratings')
      .then(res => {
        setRatingAggregate({ average: res.average, count: res.count });
        if (res.myRating) {
          setRating(res.myRating);
          setRatingSubmitted(true);
        } else {
          setRating(5);
          setRatingSubmitted(false);
        }
      })
      .catch(err => console.error('Failed to load rating:', err));
  }, [activeModal]);

  // Live aggregate updates -- fires for every connected user the instant
  // anyone (including this one) submits a rating, per the "every user
  // should immediately see the updated rating" requirement.
  useEffect(() => {
    if (!socket) return;
    const onAggregateUpdated = (aggregate) => setRatingAggregate(aggregate);
    socket.on('app_rating_updated', onAggregateUpdated);
    return () => socket.off('app_rating_updated', onAggregateUpdated);
  }, [socket]);

  const handleSubmitRating = async () => {
    setRatingLoading(true);
    try {
      const res = await api.post('/ratings', { rating });
      setRatingAggregate({ average: res.average, count: res.count });
      setRatingSubmitted(true);
      showToast('🐾 Thanks for rating Sniffr!');
    } catch (err) {
      showToast(err.message || 'Failed to submit rating. Please try again.');
    } finally {
      setRatingLoading(false);
    }
  };

  // Fetch the real plan catalog / billing history fresh each time their
  // modal opens -- these are never mocked, always live from the server.
  useEffect(() => {
    if (activeModal === 'upgrade-premium') {
      setUpgradeStep('plans');
      setCheckoutSession(null);
      api.get('/premium/plans').then(res => setPlansCatalog(res.plans || [])).catch(err => console.error('Failed to load plans:', err));
    }
    if (activeModal === 'billing-history') {
      setHistoryLoading(true);
      api.get('/premium/history')
        .then(res => setBillingHistory(res.history || []))
        .catch(err => console.error('Failed to load billing history:', err))
        .finally(() => setHistoryLoading(false));
    }
  }, [activeModal]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  // ── PawPrint Verification Handlers (enable-by-email-code) ──
  // Sends a 6-digit Paw Code to the account email; the account email must
  // already be verified (server enforces this too -- see EMAIL_NOT_VERIFIED
  // below). Same code mechanism already used for login-time 2FA, just gating
  // the enable step instead of a session.
  const handleSendPawCode = async () => {
    setPawCodeLoading(true);
    setPawCodeError('');
    try {
      const res = await api.post('/auth/2fa/send-code');
      if (res.alreadyEnabled) {
        await refreshProfile();
        showToast('🐾 PawPrint Verification is already enabled!');
        onClose();
        return;
      }
      setPawCodeSent(true);
      setPawCodeInput('');
      setResendTimer(60);
      showToast(res.message || 'Check your inbox for the Paw Code.');
    } catch (err) {
      setPawCodeError(err.message || 'Failed to send verification code.');
    } finally {
      setPawCodeLoading(false);
    }
  };

  // Confirms the code and flips PawPrint 2FA on -- the code must match the
  // one just emailed, same as the login-time verification.
  const handleVerifyPawCode = async (e) => {
    e.preventDefault();
    setPawCodeLoading(true);
    setPawCodeError('');
    try {
      await api.post('/auth/2fa/verify-enable', { code: pawCodeInput });
      await refreshProfile();
      showToast('🐾 PawPrint Verification enabled!');
      onClose();
    } catch (err) {
      setPawCodeError(err.message || 'The Paw Code is incorrect or has expired.');
    } finally {
      setPawCodeLoading(false);
    }
  };

  // Reuses the existing account-email resend-verification endpoint --
  // once that email is verified, the toggle re-checks and unlocks PawPrint.
  const handleSendAccountVerification = async () => {
    setVerifyEmailSending(true);
    setPawCodeError('');
    try {
      const res = await api.post('/auth/resend-verification');
      showToast(res.message || 'Verification email sent! Check your inbox.');
    } catch (err) {
      setPawCodeError(err.message || 'Failed to send verification email.');
    } finally {
      setVerifyEmailSending(false);
    }
  };

  const handleDisable2FA = async () => {
    setPawCodeLoading(true);
    try {
      await api.post('/auth/2fa/disable');
      await refreshProfile();
      showToast('PawPrint Verification disabled.');
      onClose();
    } catch (err) {
      setPawCodeError(err.message || 'Failed to disable 2FA.');
    } finally {
      setPawCodeLoading(false);
    }
  };

  // ── Delete Account Handler (moved here from Privacy Policy page) ──
  const handleDeleteAccount = async () => {
    setDeleteAccountLoading(true);
    try {
      await api.post('/privacy/delete');
      setDeleteAccountPhase('success');
    } catch (err) {
      showToast(err.message || 'Failed to delete account. Please try again.');
    } finally {
      setDeleteAccountLoading(false);
    }
  };

  // ── Real Premium checkout (server/routes/premium.js) ──
  // Tapping a plan never activates it directly -- it creates a payment
  // session first (Step 1, still 'pending'). Step 2 is the user paying
  // externally via UPI and submitting their transaction ID + a screenshot
  // (handleSubmitPayment below), which only moves the session to
  // 'pending_review' -- it can NEVER activate Premium by itself. Activation
  // only ever happens later, from a future admin-approval endpoint. See
  // subscriptionService.js's createCheckoutSession/submitManualPaymentProof.
  const handleSelectPlan = async (planKey) => {
    if (checkingOut) return;
    setSelectedPlan(planKey);
    setCheckingOut(true);
    setUpiTransactionId('');
    setPaymentProof(null);
    setSubmissionError('');
    try {
      const res = await api.post('/premium/checkout', { plan: planKey });
      setCheckoutSession(res);
      setUpgradeStep('payment');
    } catch (err) {
      showToast(err.message || 'Failed to start checkout. Please try again.');
    } finally {
      setCheckingOut(false);
    }
  };

  const handleSubmitPayment = async () => {
    if (!checkoutSession || submittingPayment) return;
    setSubmissionError('');

    const trimmedUtr = upiTransactionId.trim();
    if (!trimmedUtr) {
      setSubmissionError("Enter the UPI transaction ID so we can verify your payment.");
      return;
    }
    if (!paymentProof) {
      setSubmissionError('Attach a screenshot of your payment so we can verify it.');
      return;
    }

    setSubmittingPayment(true);
    try {
      await api.upload(
        `/premium/checkout/${checkoutSession.sessionId}/submit`,
        paymentProof,
        { payment_method: 'upi', upi_transaction_id: trimmedUtr }
      );
      await refreshPremium();
      setUpgradeStep('pending_review');
    } catch (err) {
      setSubmissionError(err.message || 'Failed to submit payment. Please try again.');
    } finally {
      setSubmittingPayment(false);
    }
  };

  const handleCancelSubscription = async () => {
    setCancelling(true);
    try {
      await api.post('/premium/cancel');
      await refreshPremium();
      showToast("🐾 Subscription cancelled. You'll keep Premium until your current period ends.");
    } catch (err) {
      showToast(err.message || 'Failed to cancel subscription.');
    } finally {
      setCancelling(false);
    }
  };

  if (!activeModal) return null;

  // ── Password Handler ──
  const handleChangePassword = async (e) => {
    e.preventDefault();
    setPasswordErrors({});
    setPasswordLoading(true);
    try {
      const res = await api.post('/auth/change-password', passwordForm);
      if (res && res.success) {
        showToast('🐾 Password updated successfully!');
        setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
        setTimeout(() => {
          onClose();
        }, 1200);
      }
    } catch (err) {
      if (err.data && err.data.errors) {
        const errMap = {};
        err.data.errors.forEach(item => { errMap[item.field] = item.message; });
        setPasswordErrors(errMap);
      } else {
        setPasswordErrors({ general: err.message || 'Failed to update password' });
      }
    } finally {
      setPasswordLoading(false);
    }
  };

  // ── Forgot Password Handler (img1 popup) ──
  const handleForgotSubmit = async (e) => {
    e.preventDefault();
    setForgotLoading(true);
    setForgotError('');
    setForgotSuccess('');
    try {
      const res = await api.post('/auth/forgot-password', { identifier: forgotIdentifier });
      setForgotSuccess(res.message || '🐾 A password reset link has been sent to your linked email.');
      setForgotIdentifier('');
    } catch (err) {
      setForgotError(err.message || "🐾 We couldn't find that pet parent. Double-check and try again.");
    } finally {
      setForgotLoading(false);
    }
  };

  // ── Mailto helper ──
  const sendEmailPayload = (type, subjectStr, bodyStr) => {
    const recipient = 'sherin13.2005@gmail.com';
    const mailtoUrl = `mailto:${recipient}?subject=${encodeURIComponent(`[Sniffr ${type}] ${subjectStr}`)}&body=${encodeURIComponent(bodyStr)}`;
    window.location.href = mailtoUrl;
  };

  // ── Save Bug Report to Safety Center History ──
  const handleBugSubmit = (e) => {
    e.preventDefault();
    const reporterName = activePet?.name || 'Pet Parent';
    const rawUsername = activePet?.pet_username ? activePet.pet_username.replace(/^@+/, '') : (activePet?.name ? activePet.name.toLowerCase().replace(/\s+/g, '') : 'user');
    const reporterUsername = `@${rawUsername}`;
    const nowStr = new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const newReport = {
      id: Date.now(),
      reporter_name: reporterName,
      reporter_username: reporterUsername,
      date: nowStr,
      category: bugForm.category,
      reason: `Bug Report: ${bugForm.category}`,
      description: bugForm.description,
      status: 'Under Review',
    };
    try {
      const existing = JSON.parse(localStorage.getItem('sniffr_user_reports') || '[]');
      const updated = [newReport, ...existing];
      localStorage.setItem('sniffr_user_reports', JSON.stringify(updated));
      setReportsList(updated);
    } catch (err) {
      console.error(err);
    }

    sendEmailPayload(
      'Bug Report',
      bugForm.category,
      `Reporter: ${reporterName} (${reporterUsername})\nCategory: ${bugForm.category}\nDate & Time: ${nowStr}\n\nDescription:\n${bugForm.description}`
    );
    setBugSubmitted(true);
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 select-none">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      {/* Modal Container */}
      <div className="relative w-full max-w-lg bg-white dark:bg-zinc-900 rounded-3xl border border-outline-variant/10 shadow-2xl z-[310] overflow-hidden max-h-[90vh] flex flex-col animate-scale-up">

        {/* ── 🐾 PAWPRINT VERIFICATION (ENABLE 2FA) ── */}
        {activeModal === 'pawprint-2fa' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🐾</span> PawPrint Verification
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-3">
              <div className="p-4 bg-primary/10 rounded-2xl border border-primary/20 flex items-start gap-3">
                <span className="material-symbols-outlined text-primary text-2xl mt-0.5">security</span>
                <div>
                  <p className="text-xs font-bold text-on-surface">Add an extra paw of protection to your account.</p>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
                    When enabled, signing in on a new device will require a one-time Paw Code sent to your registered email.
                  </p>
                </div>
              </div>

              {pawCodeError && (
                <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300 rounded-xl text-xs font-bold animate-fade-in flex items-center gap-2">
                  <span className="material-symbols-outlined text-base">error</span>
                  <span>{pawCodeError}</span>
                </div>
              )}

              {pawCodeSuccess && (
                <div className="p-3.5 bg-emerald-50 border border-emerald-200 text-emerald-600 dark:bg-emerald-950/40 dark:border-emerald-900/40 dark:text-emerald-300 rounded-xl text-xs font-bold animate-fade-in flex items-center gap-2">
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  <span>{pawCodeSuccess}</span>
                </div>
              )}

              {!user?.email_verified ? (
                // Gate: PawPrint needs a verified account email first. Reuses
                // the existing account-verification email (not a PawPrint-
                // specific one) since this step is about the account itself.
                <div className="space-y-3 pt-1">
                  <div className="p-3.5 bg-amber-50 border border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900/40 dark:text-amber-200 rounded-xl text-xs font-bold flex items-start gap-2">
                    <span className="material-symbols-outlined text-base mt-0.5">mail</span>
                    <span>Verify your account email before enabling PawPrint Verification.</span>
                  </div>
                  <button
                    onClick={handleSendAccountVerification}
                    disabled={verifyEmailSending}
                    className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {verifyEmailSending ? (
                      <span className="material-symbols-outlined text-base animate-spin">sync</span>
                    ) : (
                      <span>📧 Send Verification Email</span>
                    )}
                  </button>
                  <p className="text-[10px] text-zinc-400 text-center">Already verified? Come back and toggle PawPrint on again.</p>
                </div>
              ) : !pawCodeSent ? (
                <div className="pt-2">
                  <button
                    onClick={handleSendPawCode}
                    disabled={pawCodeLoading}
                    className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {pawCodeLoading ? (
                      <span className="material-symbols-outlined text-base animate-spin">sync</span>
                    ) : (
                      <span>🐾 Send Paw Code</span>
                    )}
                  </button>
                </div>
              ) : (
                <form onSubmit={handleVerifyPawCode} className="space-y-4 pt-1">
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400 text-center">
                    A 6-digit Paw Code was sent to <strong className="text-on-surface">{user?.email}</strong>. Enter it below to turn PawPrint Verification on.
                  </p>

                  <input
                    type="text"
                    maxLength="6"
                    autoFocus
                    required
                    value={pawCodeInput}
                    onChange={(e) => { setPawCodeInput(e.target.value.replace(/[^0-9]/g, '')); setPawCodeError(''); }}
                    placeholder="Enter the Paw Code"
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-base font-extrabold text-center tracking-[0.3em] text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
                  />

                  <button
                    type="submit"
                    disabled={pawCodeLoading || pawCodeInput.length < 6}
                    className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {pawCodeLoading ? (
                      <span className="material-symbols-outlined text-base animate-spin">sync</span>
                    ) : (
                      <span>Verify & Enable</span>
                    )}
                  </button>

                  <div className="text-center">
                    <button
                      type="button"
                      onClick={handleSendPawCode}
                      disabled={resendTimer > 0 || pawCodeLoading}
                      className={`text-xs font-bold transition-colors ${
                        resendTimer > 0 ? 'text-zinc-400 cursor-not-allowed' : 'text-primary hover:underline'
                      }`}
                    >
                      {resendTimer > 0 ? `Resend Code (${resendTimer}s)` : '🐾 Resend Code'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}


        {/* ── DISABLE PAWPRINT 2FA CONFIRMATION ── */}
        {activeModal === 'disable-pawprint-2fa' && (
          <div className="p-6 space-y-4 overflow-y-auto text-center">
            <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-300 flex items-center justify-center text-2xl mx-auto">
              🛡️
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-extrabold text-on-surface">Disable PawPrint Verification?</h2>
              <p className="text-xs text-zinc-500 font-medium">
                Disabling 2FA will make your account less secure when signing in from new devices.
              </p>
            </div>

            {pawCodeError && (
              <div className="p-3 bg-rose-50 text-rose-600 rounded-xl text-xs font-bold">{pawCodeError}</div>
            )}

            <div className="flex gap-2 pt-3">
              <button
                onClick={onClose}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl"
              >
                Keep Enabled
              </button>
              <button
                onClick={handleDisable2FA}
                disabled={pawCodeLoading}
                className="flex-1 py-3 bg-rose-500 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50"
              >
                {pawCodeLoading ? 'Disabling...' : 'Disable 2FA'}
              </button>
            </div>
          </div>
        )}

        {/* ── DELETE ACCOUNT (moved here from Privacy Policy page) ── */}
        {activeModal === 'delete-account' && (
          <div className="p-6 space-y-4 overflow-y-auto text-center">
            {deleteAccountPhase === 'confirm' ? (
              <>
                <div className="w-14 h-14 rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-300 flex items-center justify-center text-2xl mx-auto">
                  🗑️
                </div>
                <div className="space-y-1">
                  <h2 className="text-lg font-extrabold text-on-surface">Delete Account</h2>
                  <p className="text-xs text-zinc-500 font-medium leading-relaxed">
                    This action will permanently delete your Sniffr account and all associated pet profiles. This cannot be undone.
                  </p>
                </div>
                <div className="flex gap-2 pt-2">
                  <button
                    onClick={onClose}
                    disabled={deleteAccountLoading}
                    className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl active:scale-95 transition-transform disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteAccount}
                    disabled={deleteAccountLoading}
                    className="flex-1 py-3 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50"
                  >
                    {deleteAccountLoading ? 'Deleting...' : 'Continue'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center text-3xl mx-auto animate-bounce">
                  🐾
                </div>
                <div className="space-y-2">
                  <h3 className="text-base font-extrabold text-on-surface">Account Deleted</h3>
                  <p className="text-xs text-zinc-600 dark:text-zinc-300 font-medium leading-relaxed">
                    🐾 Your Sniffr account has been deleted successfully. You can always woof back using the same email anytime!
                  </p>
                </div>
                <button
                  onClick={() => {
                    onClose();
                    logout();
                    navigate('/');
                  }}
                  className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
                >
                  OK, Back to Sign In
                </button>
              </>
            )}
          </div>
        )}

        {/* ── 1. CHANGE PASSWORD ── */}
        {activeModal === 'change-password' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🔐</span> Change Password
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <form onSubmit={handleChangePassword} className="space-y-4">
              {passwordErrors.general && (
                <div className="p-3 bg-rose-50 text-rose-600 rounded-xl text-xs font-bold">{passwordErrors.general}</div>
              )}

              <div>
                <label className="block text-xs font-bold text-zinc-500 mb-1">Current Password</label>
                <input
                  type="password"
                  required
                  value={passwordForm.currentPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, currentPassword: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  placeholder="Enter current password"
                />
                {passwordErrors.currentPassword && <p className="text-[11px] text-rose-500 font-bold mt-1">{passwordErrors.currentPassword}</p>}
                
                <div className="mt-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => { if (onOpenModal) onOpenModal('forgot-password'); }}
                    className="text-[11px] font-extrabold text-rose-600 hover:underline"
                  >
                    Forgot Password?
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 mb-1">New Password</label>
                <input
                  type="password"
                  required
                  value={passwordForm.newPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, newPassword: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  placeholder="At least 8 chars, 1 uppercase, 1 number"
                />
                {passwordErrors.newPassword && <p className="text-[11px] text-rose-500 font-bold mt-1 whitespace-pre-line">{passwordErrors.newPassword}</p>}
              </div>

              <div>
                <label className="block text-xs font-bold text-zinc-500 mb-1">Confirm New Password</label>
                <input
                  type="password"
                  required
                  value={passwordForm.confirmPassword}
                  onChange={e => setPasswordForm({ ...passwordForm, confirmPassword: e.target.value })}
                  className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  placeholder="Repeat new password"
                />
                {passwordErrors.confirmPassword && <p className="text-[11px] text-rose-500 font-bold mt-1">{passwordErrors.confirmPassword}</p>}
              </div>

              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={passwordLoading}
                  className="flex-1 py-2.5 bg-primary text-white font-extrabold text-xs rounded-xl shadow-md hover:bg-primary-fixed-dim transition-all flex items-center justify-center gap-1.5"
                >
                  {passwordLoading ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── 1B. FORGOT PASSWORD MODAL (Matching img1 exactly) ── */}
        {activeModal === 'forgot-password' && (
          <div className="p-7 space-y-5 text-center overflow-y-auto relative bg-white dark:bg-zinc-900 rounded-3xl">
            <button
              onClick={onClose}
              className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg"
            >
              ✕
            </button>

            <div className="space-y-2 pt-2">
              <h2 className="text-2xl font-black text-[#802334] dark:text-rose-300 tracking-tight">
                Recover Password
              </h2>
              <p className="text-xs text-zinc-500 font-medium px-4 leading-relaxed">
                We will help you sniff it out! Enter your username or email address below.
              </p>
            </div>

            {forgotError && (
              <div className="p-3 bg-rose-50 text-rose-600 rounded-2xl text-xs font-bold animate-fade-in">
                {forgotError}
              </div>
            )}

            {forgotSuccess && (
              <div className="p-3 bg-emerald-50 text-emerald-700 rounded-2xl text-xs font-bold animate-fade-in">
                {forgotSuccess}
              </div>
            )}

            <form onSubmit={handleForgotSubmit} className="space-y-5 text-left pt-2">
              <div className="space-y-1.5">
                <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 px-1">
                  TYPE IN
                </label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 text-base">
                    person
                  </span>
                  <input
                    type="text"
                    required
                    placeholder="Enter your email or username"
                    value={forgotIdentifier}
                    onChange={e => setForgotIdentifier(e.target.value)}
                    disabled={forgotLoading}
                    className="w-full pl-11 pr-4 py-3.5 bg-zinc-100/70 dark:bg-zinc-800 rounded-full text-xs font-medium focus:ring-2 focus:ring-rose-400 outline-hidden border-none text-on-surface"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={forgotLoading || !forgotIdentifier.trim()}
                className="w-full py-3.5 rounded-full bg-gradient-to-r from-[#D9829A] to-[#EEA2B5] text-white font-extrabold text-sm shadow-md active:scale-95 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {forgotLoading ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  '🐾 Sniff'
                )}
              </button>
            </form>
          </div>
        )}

        {/* ── 2. UPGRADE TO PREMIUM (real: GET /premium/plans, POST /premium/checkout, POST /premium/checkout/:id/confirm) ── */}
        {/* Always shows the full plan grid, current-plan or not -- tapping a
            plan never activates it directly, it starts a checkout session
            and moves to the Payment Method step. Nothing here decides
            pricing/limits itself; plansCatalog comes straight from the
            server's PLANS registry. */}
        {activeModal === 'upgrade-premium' && (
          <div className="p-6 space-y-5 overflow-y-auto">
            <div className="flex justify-between items-center pb-2">
              <div>
                <span className="text-xs font-extrabold bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 px-2.5 py-0.5 rounded-full">
                  ✨ Sniffr Premium
                </span>
                <h2 className="text-xl font-extrabold text-on-surface mt-1">
                  {upgradeStep === 'payment' ? 'Payment Method' : upgradeStep === 'success' ? 'Subscription Activated' : 'Choose Your Plan'}
                </h2>
              </div>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {upgradeStep === 'plans' && (
              <>
                <div className="space-y-3">
                  {plansCatalog.filter(p => p.key !== 'free' && PLAN_PRICING[p.key]).map(p => {
                    const pricing = PLAN_PRICING[p.key];
                    const savings = getPlanSavings(p.key);
                    const isCurrent = premium?.isPremium && premium.currentPlan === p.key;
                    const isGold = p.key === 'gold';
                    const isCheckingOutThis = checkingOut && selectedPlan === p.key;
                    return (
                      <div
                        key={p.key}
                        onClick={() => handleSelectPlan(p.key)}
                        className={`p-4 rounded-2xl border-2 transition-all cursor-pointer relative ${checkingOut ? 'opacity-70 pointer-events-none' : ''} ${
                          isCurrent
                            ? 'border-emerald-400 bg-emerald-50/30 dark:bg-emerald-950/10'
                            : isGold
                            ? 'border-amber-400 bg-amber-50/40 dark:bg-amber-950/10 shadow-sm'
                            : 'border-zinc-200 dark:border-zinc-800 hover:border-amber-300'
                        }`}
                      >
                        {isCurrent ? (
                          <div className="absolute -top-3 right-4 bg-emerald-500 text-white text-[10px] font-extrabold px-3 py-0.5 rounded-full shadow-xs">
                            ✓ Current Plan
                          </div>
                        ) : isGold && (
                          <div className="absolute -top-3 right-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white text-[10px] font-extrabold px-3 py-0.5 rounded-full shadow-xs whitespace-nowrap">
                            ★ Most Preferred
                          </div>
                        )}

                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0">
                            <span className="font-extrabold text-sm text-on-surface truncate block">{PLAN_EMOJI[p.key]} {p.label}</span>
                            <p className="text-[11px] text-zinc-400 mt-1">{pricing.duration}</p>
                          </div>
                          <div className="text-right flex items-center gap-2 flex-shrink-0">
                            <div>
                              <div className="text-base font-extrabold text-amber-600 dark:text-amber-400">₹{pricing.price}</div>
                              {savings > 0 && (
                                <p className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 whitespace-nowrap">You save ₹{savings}</p>
                              )}
                            </div>
                            {isCheckingOutThis ? (
                              <div className="w-4 h-4 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <span className="material-symbols-outlined text-zinc-300 text-lg">chevron_right</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Trust row */}
                <div className="grid grid-cols-3 gap-2 pt-4 border-t border-zinc-100 dark:border-zinc-800">
                  {[
                    { icon: 'shield', title: 'Safe & Secure', desc: '100% secure payments' },
                    { icon: 'cancel', title: 'Cancel Anytime', desc: 'No questions asked' },
                    { icon: 'favorite', title: 'Created by a Pet Parent', desc: 'Made with love for pets' },
                  ].map(item => (
                    <div key={item.title} className="flex flex-col items-center text-center gap-1 px-1 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center flex-shrink-0">
                        <span className="material-symbols-outlined text-base">{item.icon}</span>
                      </div>
                      <p className="text-[10px] font-extrabold text-on-surface leading-tight">{item.title}</p>
                      <p className="text-[9px] text-zinc-400 leading-tight">{item.desc}</p>
                    </div>
                  ))}
                </div>

                <p className="text-[10px] text-zinc-400 text-center">
                  {premium?.isPremium ? 'Tap a plan to switch -- you can upgrade or downgrade anytime.' : 'Tap a plan to continue to payment.'}
                </p>
              </>
            )}

            {upgradeStep === 'payment' && checkoutSession && (
              <div className="space-y-5">
                <div className="p-4 bg-amber-50/50 dark:bg-amber-950/20 rounded-2xl border border-amber-200/40 flex justify-between items-center">
                  <div>
                    <p className="text-xs font-bold text-zinc-500">{PLAN_EMOJI[checkoutSession.plan]} {PLAN_LABELS[checkoutSession.plan] || checkoutSession.plan}</p>
                    <p className="text-[10px] text-zinc-400">{PLAN_PRICING[checkoutSession.plan]?.duration || 'One-time payment'}</p>
                  </div>
                  <p className="text-lg font-extrabold text-amber-600">₹{checkoutSession.amount}</p>
                </div>

                <div>
                  <p className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 mb-2">Payment Method</p>
                  <div className="w-full p-3.5 rounded-2xl border-2 border-amber-500 bg-amber-50/40 dark:bg-amber-950/20 flex items-center gap-3">
                    <span className="material-symbols-outlined text-amber-500">account_balance_wallet</span>
                    <span className="text-xs font-bold text-on-surface flex-1 text-left">UPI</span>
                    <span className="material-symbols-outlined text-amber-500 text-lg">check_circle</span>
                  </div>
                </div>

                {/* Real UPI QR -- tap to open a UPI app directly (mobile), or
                    scan with any UPI app (desktop). target="_blank" so that on
                    a device with no upi:// handler registered, the failed
                    navigation happens in a throwaway tab instead of this one. */}
                <a
                  href={upiIntentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-5 rounded-2xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 flex flex-col items-center justify-center gap-2 text-center hover:border-amber-300 transition-colors"
                >
                  <div className="p-2 bg-white rounded-xl">
                    <QRCodeSVG value={upiIntentUrl} size={140} />
                  </div>
                  <p className="text-[11px] font-bold text-zinc-400">Tap to pay, or scan with any UPI app</p>
                  <p className="text-[10px] text-zinc-400 max-w-[220px]">
                    Pay ₹{checkoutSession.amount} to Sniffr's UPI ID, then enter your transaction details below.
                  </p>
                </a>

                <div>
                  <label className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 mb-2 block">
                    UPI Transaction ID (UTR)
                  </label>
                  <input
                    type="text"
                    value={upiTransactionId}
                    onChange={(e) => { setUpiTransactionId(e.target.value); setSubmissionError(''); }}
                    placeholder="e.g. 123456789012"
                    disabled={submittingPayment}
                    className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-xs font-bold text-on-surface focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 mb-2 block">
                    Payment Screenshot
                  </label>
                  {paymentProof ? (
                    <div className="w-full p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
                      <span className="material-symbols-outlined text-emerald-500 text-lg">check_circle</span>
                      <span className="text-xs font-bold text-on-surface flex-1 truncate">{paymentProof.name}</span>
                      <button
                        type="button"
                        onClick={() => setPaymentProof(null)}
                        disabled={submittingPayment}
                        className="text-zinc-400 hover:text-rose-500 disabled:opacity-60"
                      >
                        <span className="material-symbols-outlined text-lg">close</span>
                      </button>
                    </div>
                  ) : (
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => { setPaymentProof(e.target.files[0] || null); setSubmissionError(''); }}
                      disabled={submittingPayment}
                      className="w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200 disabled:opacity-60"
                    />
                  )}
                </div>

                {submissionError && (
                  <div className="p-3.5 bg-rose-50 border border-rose-200 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300 rounded-xl text-xs font-bold animate-fade-in flex items-center gap-2">
                    <span className="material-symbols-outlined text-base">error</span>
                    <span>{submissionError}</span>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setUpgradeStep('plans');
                      setSubmissionError('');
                      setUpiTransactionId('');
                      setPaymentProof(null);
                    }}
                    disabled={submittingPayment}
                    className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-2xl disabled:opacity-60"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleSubmitPayment}
                    disabled={submittingPayment}
                    className="flex-[2] py-3 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white font-extrabold text-xs rounded-2xl shadow-lg hover:shadow-xl transition-all active:scale-95 flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {submittingPayment ? (
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      'Submit Payment for Review'
                    )}
                  </button>
                </div>
              </div>
            )}

            {upgradeStep === 'pending_review' && (
              <div className="text-center py-8 space-y-3">
                <div className="w-16 h-16 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-3xl mx-auto">
                  🐾
                </div>
                <h3 className="text-lg font-extrabold text-on-surface">Payment submitted 🐾</h3>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto">Your payment proof has been sent for verification.</p>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto">We'll activate Sniffr Premium once the payment is approved.</p>
                <button
                  onClick={onClose}
                  className="mt-4 px-6 py-2.5 bg-amber-500 text-white font-extrabold text-xs rounded-full shadow-lg"
                >
                  Got it
                </button>
              </div>
            )}

            {upgradeStep === 'success' && (
              <div className="text-center py-8 space-y-3">
                <div className="w-16 h-16 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-3xl mx-auto">
                  👑
                </div>
                <h3 className="text-lg font-extrabold text-on-surface">Welcome to {PLAN_LABELS[selectedPlan] || selectedPlan}! 🎉</h3>
                <p className="text-xs text-zinc-500 max-w-xs mx-auto">
                  Your subscription is now active. Enjoy unlimited pets, PawCircles, Undo Like, Super Sniff, and Spotlight Boosts!
                </p>
                <button
                  onClick={onClose}
                  className="mt-4 px-6 py-2.5 bg-amber-500 text-white font-extrabold text-xs rounded-full shadow-lg"
                >
                  Start Exploring Premium
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── 3. MANAGE SUBSCRIPTION (real: usePremium() + POST /premium/cancel) ── */}
        {activeModal === 'manage-subscription' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>💳</span> Manage Subscription
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-200 dark:border-zinc-700 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-zinc-500">Current Plan</span>
                <span className="text-xs font-extrabold text-zinc-700 dark:text-zinc-300 bg-zinc-200 dark:bg-zinc-700 px-2.5 py-0.5 rounded-full">
                  {PLAN_LABELS[premium?.currentPlan] || 'Sniffr Free'}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-zinc-500">Renewal Date</span>
                <span className="font-semibold text-zinc-400">
                  {premium?.planExpiryDate ? new Date(premium.planExpiryDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A'}
                </span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="font-bold text-zinc-500">Billing Status</span>
                {/* billingStatus/billingStatusLabel come straight from the backend
                    (server/services/subscriptionService.js) -- never derived here. */}
                <span className={`font-bold ${premium?.billingStatus === 'active' ? 'text-emerald-600' : premium?.billingStatus === 'pending' ? 'text-amber-600' : 'text-zinc-500'}`}>
                  {premium?.billingStatusLabel || 'Active (Free Tier)'}
                </span>
              </div>
              {premium?.isFoundingMember && (
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-zinc-500">Plan Source</span>
                  <span className="font-bold text-amber-600">🎉 Founding Member (Free)</span>
                </div>
              )}
              {premium?.isPremium && (
                <div className="flex justify-between items-center text-xs">
                  <span className="font-bold text-zinc-500">Spotlight Boosts Left</span>
                  <span className="font-bold text-on-surface">{premium.boostCreditsRemaining}</span>
                </div>
              )}
            </div>

            {!premium?.isPremium ? (
              <div className="p-4 bg-amber-50/50 dark:bg-amber-950/20 rounded-2xl border border-amber-200/40 text-center space-y-2">
                <p className="text-xs font-bold text-amber-800 dark:text-amber-200">You are currently using Sniffr Free.</p>
                <p className="text-[11px] text-zinc-500">Upgrade to unlock unlimited pets, unlimited PawCircles, Undo Like, Super Sniff, and Spotlight Boosts!</p>
                <button
                  onClick={() => onOpenModal('upgrade-premium')}
                  className="mt-1 px-5 py-2 bg-amber-500 text-white font-extrabold text-xs rounded-full shadow-md"
                >
                  Upgrade Now
                </button>
              </div>
            ) : (
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => onOpenModal('upgrade-premium')}
                  className="flex-1 py-2.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-extrabold text-xs rounded-xl"
                >
                  Change Plan
                </button>
                {premium.subscriptionStatus === 'active' && (
                  <button
                    onClick={handleCancelSubscription}
                    disabled={cancelling}
                    className="flex-1 py-2.5 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-300 font-extrabold text-xs rounded-xl disabled:opacity-60"
                  >
                    {cancelling ? 'Cancelling...' : 'Cancel Subscription'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── 4. BILLING HISTORY (real: GET /premium/history) ── */}
        {activeModal === 'billing-history' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🧾</span> Billing History
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {historyLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : billingHistory.length === 0 ? (
              <div className="text-center py-12 space-y-2">
                <div className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-400 flex items-center justify-center text-xl mx-auto">
                  📜
                </div>
                <p className="text-xs font-extrabold text-zinc-500">No purchases yet.</p>
                <p className="text-[11px] text-zinc-400">Your billing transactions and invoices will appear here.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {billingHistory.map(item => {
                  const isGift = item.source === 'launch_offer';
                  const isRejected = item.action === 'payment_rejected';
                  const actionLabel = BILLING_ACTION_LABELS[item.action] || item.action.replace(/_/g, ' ');
                  const showPrevPlan = (item.action === 'upgraded' || item.action === 'downgraded') && item.previous_plan;
                  return (
                    <div
                      key={item.id}
                      className={`p-3.5 rounded-2xl border flex items-center justify-between gap-3 ${
                        isRejected
                          ? 'bg-rose-50/60 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40'
                          : 'bg-zinc-50 dark:bg-zinc-800/40 border-zinc-100 dark:border-zinc-800'
                      }`}
                    >
                      <div>
                        <p className="text-xs font-extrabold text-on-surface">
                          {PLAN_EMOJI[item.plan] || ''} {PLAN_LABELS[item.plan] || item.plan} - {actionLabel}
                          {showPrevPlan && (
                            <span className="text-zinc-400 font-medium"> (from {PLAN_LABELS[item.previous_plan] || item.previous_plan})</span>
                          )}
                        </p>
                        {isRejected && item.rejection_reason && (
                          <p className="text-[10px] text-rose-600 dark:text-rose-300 font-bold mt-0.5">{item.rejection_reason}</p>
                        )}
                        <p className="text-[10px] text-zinc-400 mt-0.5">
                          {new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </p>
                      </div>
                      {/* Gifted (launch-offer) rows must never show a price -- only
                          the label. Non-payment events (cancelled/expired/rejected)
                          show "-"/"Rejected" since nothing was charged or refunded. */}
                      <span className={`text-xs font-extrabold text-right whitespace-nowrap ${isGift ? 'text-amber-600' : isRejected ? 'text-rose-600 dark:text-rose-300' : 'text-on-surface'}`}>
                        {isGift
                          ? '🎁 Gifted by Sniffr'
                          : isRejected
                            ? 'Rejected'
                            : BILLING_PAYMENT_ACTIONS.includes(item.action)
                              ? `₹${Number(item.amount_paid).toFixed(2)}`
                              : '-'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 5. PREMIUM BENEFITS ── */}
        {activeModal === 'premium-benefits' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>⭐</span> Premium Benefits
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {[
                { title: 'Spotlight Boosts', desc: 'Up to 6 boost credits per cycle to get featured at the top of your locality & city rankings.', icon: 'rocket_launch' },
                { title: 'Undo Like', desc: 'Change your mind within 5 seconds of swiping right, no questions asked.', icon: 'replay' },
                { title: 'Super Sniff', desc: 'Browse other pets\' profiles without sending a "someone viewed your profile" notification.', icon: 'visibility_off' },
                { title: 'Unlimited Pets & PawCircles', desc: 'Free accounts are capped at 2 pets, 3 joined PawCircles, and 5 created PawCircles. Premium removes all three limits.', icon: 'all_inclusive' },
                { title: 'Early Feature Access', desc: 'Gold & Platinum only: try out new Sniffr features before everyone else.', icon: 'auto_awesome' },
                { title: 'Fewer Ads', desc: 'Ad frequency drops the higher your tier - Platinum sees them only rarely.', icon: 'block' },
                { title: 'Premium Badge', desc: 'A badge next to your pet\'s name everywhere it appears - Meet, Feed, Spotlight, Chat, and PawCircle.', icon: 'workspace_premium' },
              ].map(item => (
                <div key={item.title} className="p-3.5 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-amber-500/10 text-amber-500 flex items-center justify-center flex-shrink-0">
                    <span className="material-symbols-outlined text-lg">{item.icon}</span>
                  </div>
                  <div>
                    <h4 className="text-xs font-extrabold text-on-surface">{item.title}</h4>
                    <p className="text-[11px] text-zinc-400 mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 6. FAQ ── */}
        {activeModal === 'faq' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>❓</span> Frequently Asked Questions
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-2">
              {[
                { q: 'How do I change my pet profile?', a: 'Go to your Me page and tap Switch Pet Profile to change active pet, or Edit Profile to update details.' },
                { q: 'How do matches work?', a: 'When both pet owners swipe right on each other, a mutual match is formed, unlocking 1-on-1 chat and call capabilities.' },
                { q: 'How do Spotlight rankings work?', a: 'Spotlight ranks pets based on pawsitive interactions, community activity, and profile completeness in your local area.' },
                { q: 'How do I report users?', a: 'Tap the three-dots menu on any post or profile to report suspicious or harmful behavior directly to our safety team.' },
                { q: 'Can I own multiple pets?', a: 'Yes! You can manage up to 5 pet profiles under a single Sniffr account.' },
                { q: 'How do I delete my account?', a: 'Go to Settings → Danger Zone → Delete Account. This permanently removes your account and pet profiles.' },
                { q: 'How do Premium plans work?', a: 'Premium unlocks unlimited swipes, Spotlight boosts, custom PawCircles, and an ad-free experience.' },
              ].map((item, idx) => (
                <div key={idx} className="bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 overflow-hidden">
                  <button
                    onClick={() => setExpandedFaq(expandedFaq === idx ? null : idx)}
                    className="w-full p-3.5 text-left flex justify-between items-center font-bold text-xs text-on-surface"
                  >
                    <span>{item.q}</span>
                    <span className={`material-symbols-outlined text-sm text-zinc-400 transition-transform ${expandedFaq === idx ? 'rotate-180' : ''}`}>
                      expand_more
                    </span>
                  </button>
                  {expandedFaq === idx && (
                    <div className="px-3.5 pb-3.5 text-[11px] text-zinc-500 dark:text-zinc-400 font-medium border-t border-zinc-100 dark:border-zinc-800/50 pt-2">
                      {item.a}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 7. CONTACT SUPPORT ── */}
        {activeModal === 'contact-support' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🎧</span> Contact Support
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {contactSubmitted ? (
              <div className="text-center py-8 space-y-3">
                <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-2xl mx-auto">
                  ✅
                </div>
                <h3 className="text-base font-extrabold text-on-surface">Thanks!</h3>
                <p className="text-xs text-zinc-500">Our team has received your request and will get back to you shortly.</p>
                <button
                  onClick={() => setContactSubmitted(false)}
                  className="mt-2 text-xs font-extrabold text-primary hover:underline"
                >
                  Send Another Message 🐾
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendEmailPayload('Support', contactForm.subject, contactForm.description);
                  setContactSubmitted(true);
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Subject</label>
                  <input
                    type="text"
                    required
                    value={contactForm.subject}
                    onChange={e => setContactForm({ ...contactForm, subject: e.target.value })}
                    placeholder="Brief summary of your issue"
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Description</label>
                  <textarea
                    rows={4}
                    required
                    value={contactForm.description}
                    onChange={e => setContactForm({ ...contactForm, description: e.target.value })}
                    placeholder="Describe what you need help with..."
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Attachment (Optional)</label>
                  <input
                    type="file"
                    onChange={e => setContactForm({ ...contactForm, attachment: e.target.files[0] })}
                    className="w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-zinc-100 file:text-zinc-700 hover:file:bg-zinc-200"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-primary text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
                >
                  Submit Request
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── 8. USER GUIDE ── */}
        {activeModal === 'user-guide' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>📖</span> Sniffr User Guide
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-3">
              {[
                { title: 'Creating your pet', text: 'Set up your pet profile with photos, bio, breed info, and location to connect with nearby playmates.', icon: 'pets' },
                { title: 'Posting', text: 'Share adorable moments, photos, and short videos to the public home feed and earn pawsitive score reactions.', icon: 'add_photo_alternate' },
                { title: 'Finding playmates', text: 'Use the Meet tab to browse nearby pets within your preferred distance radius.', icon: 'explore' },
                { title: 'Communities', text: 'Join breed-specific or local PawCircles to participate in pack discussions and local meetups.', icon: 'groups' },
                { title: 'Messages', text: 'Chat 1-on-1 and make audio/video calls with matched playmates in a safe environment.', icon: 'chat' },
                { title: 'Spotlight', text: 'Compete on locality and city leaderboards to highlight your pet at the top of rankings.', icon: 'stars' },
                { title: 'Premium', text: 'Unlock unlimited swipes, spotlight boosts, custom PawCircle creation, and VIP badges.', icon: 'workspace_premium' },
              ].map(item => (
                <div key={item.title} className="p-3.5 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 flex gap-3 items-start">
                  <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="material-symbols-outlined text-base">{item.icon}</span>
                  </div>
                  <div>
                    <h4 className="text-xs font-extrabold text-on-surface">{item.title}</h4>
                    <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 9. COMMUNITY GUIDELINES ── */}
        {activeModal === 'community-guidelines' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>📜</span> Community Guidelines
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {[
                { title: 'Respect others', desc: 'Treat all pet owners and community members with kindness, empathy, and respect.' },
                { title: 'No harassment', desc: 'Hate speech, bullying, aggressive behavior, or harassment will result in an immediate account ban.' },
                { title: 'No fake pet profiles', desc: 'Profiles must represent real pets owned by you. Misrepresentation is strictly prohibited.' },
                { title: 'No inappropriate content', desc: 'Explicit, violent, or non-pet-related spam content is prohibited.' },
                { title: 'No spam', desc: 'Do not post promotional spam, unauthorized advertising, or phishing links.' },
                { title: 'Follow local meetup laws', desc: 'Ensure pets are vaccinated and leashed according to local public safety regulations.' },
              ].map(item => (
                <div key={item.title} className="p-3 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                  <h4 className="text-xs font-extrabold text-on-surface flex items-center gap-1.5">
                    <span className="text-emerald-500">✓</span> {item.title}
                  </h4>
                  <p className="text-[11px] text-zinc-500 mt-0.5">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 10. REPORT A BUG ── */}
        {activeModal === 'report-bug' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🐛</span> Report a Bug
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {bugSubmitted ? (
              <div className="text-center py-8 space-y-3">
                <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center text-2xl mx-auto">
                  🐛
                </div>
                <h3 className="text-base font-extrabold text-on-surface">Thank you!</h3>
                <p className="text-xs text-zinc-500">Thank you for helping improve Sniffr. Your bug report has been logged in Safety Center → Report History.</p>
                <button
                  onClick={() => setBugSubmitted(false)}
                  className="mt-2 text-xs font-extrabold text-primary hover:underline block mx-auto"
                >
                  Report Another Bug 🐾
                </button>
              </div>
            ) : (
              <form onSubmit={handleBugSubmit} className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Category</label>
                  <select
                    value={bugForm.category}
                    onChange={e => setBugForm({ ...bugForm, category: e.target.value })}
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                 >
                    <option value="UI Layout">UI & Layout</option>
                    <option value="Chat & Messaging">Chat & Messaging</option>
                    <option value="Audio/Video Calls">Audio/Video Calls</option>
                    <option value="Account & Login">Account & Login</option>
                    <option value="Other">Other</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Description</label>
                  <textarea
                    rows={4}
                    required
                    value={bugForm.description}
                    onChange={e => setBugForm({ ...bugForm, description: e.target.value })}
                    placeholder="Describe what happened and how to reproduce it..."
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  />
                </div>

                {/* Reporter Information (Read-Only) */}
                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1.5">Reporter</label>
                  <div className="p-3.5 bg-zinc-50 dark:bg-zinc-800/60 rounded-xl border border-zinc-200 dark:border-zinc-700/60 space-y-2 select-none">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Pet Name:</span>
                      <span className="text-xs font-extrabold text-on-surface">{activePet?.name || 'Pet'}</span>
                    </div>
                    <div className="flex items-center justify-between border-t border-zinc-200/50 dark:border-zinc-700/40 pt-2">
                      <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Username:</span>
                      <span className="text-xs font-extrabold text-primary">
                        {activePet?.pet_username ? (activePet.pet_username.startsWith('@') ? activePet.pet_username : `@${activePet.pet_username}`) : (activePet?.name ? `@${activePet.name.toLowerCase().replace(/\s+/g, '')}` : '@user')}
                      </span>
                    </div>
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-primary text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
                >
                  Submit Bug Report
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── 11. SUGGEST A FEATURE ── */}
        {activeModal === 'suggest-feature' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>💡</span> Suggest a Feature
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            {featureSubmitted ? (
              <div className="text-center py-8 space-y-3">
                <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-2xl mx-auto">
                  💡
                </div>
                <h3 className="text-base font-extrabold text-on-surface">Thanks for your suggestion!</h3>
                <p className="text-xs text-zinc-500">We love hearing ideas from our community!</p>
                <button
                  onClick={() => setFeatureSubmitted(false)}
                  className="mt-2 text-xs font-extrabold text-primary hover:underline block mx-auto"
                >
                  Suggest Another Feature 🐾
                </button>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  sendEmailPayload('Feature Idea', featureForm.title, featureForm.description);
                  setFeatureSubmitted(true);
                }}
                className="space-y-3"
              >
                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Feature Title</label>
                  <input
                    type="text"
                    required
                    value={featureForm.title}
                    onChange={e => setFeatureForm({ ...featureForm, title: e.target.value })}
                    placeholder="e.g. Pet Playdate Scheduler"
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-zinc-500 mb-1">Description</label>
                  <textarea
                    rows={4}
                    required
                    value={featureForm.description}
                    onChange={e => setFeatureForm({ ...featureForm, description: e.target.value })}
                    placeholder="Explain your idea and how it helps pet owners..."
                    className="w-full px-4 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-xs font-medium focus:ring-2 focus:ring-primary outline-hidden"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full py-3 bg-primary text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
                >
                  Submit Suggestion
                </button>
              </form>
            )}
          </div>
        )}

        {/* ── 12. RATE SNIFFR ── */}
        {activeModal === 'rate-sniffr' && (
          <div className="p-6 space-y-4 text-center overflow-y-auto">
            <div className="flex justify-between items-center pb-2">
              <h2 className="text-lg font-extrabold text-on-surface">Enjoying Sniffr? 🐾</h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {/* Live overall rating -- updates for every user the instant anyone rates */}
            {ratingAggregate && ratingAggregate.count > 0 && (
              <div className="flex items-center justify-center gap-1.5 text-amber-500">
                <span className="text-lg font-extrabold">{ratingAggregate.average.toFixed(1)}</span>
                <span className="text-base">⭐</span>
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                  ({ratingAggregate.count.toLocaleString()} {ratingAggregate.count === 1 ? 'rating' : 'ratings'})
                </span>
              </div>
            )}

            {ratingSubmitted ? (
              <div className="py-6 space-y-2">
                <div className="text-4xl">❤️</div>
                <h3 className="text-base font-extrabold text-on-surface">Thank You!</h3>
                <p className="text-xs text-zinc-500">Your review helps more pet lovers find Sniffr.</p>
                <button
                  onClick={() => setRatingSubmitted(false)}
                  className="mt-2 text-xs font-extrabold text-amber-600 hover:underline block mx-auto"
                >
                  Update Rating ⭐
                </button>
              </div>
            ) : (
              <>
                <p className="text-xs text-zinc-500">Rate your experience on Google Play & App Store!</p>

                <div className="flex justify-center gap-2 py-3">
                  {[1, 2, 3, 4, 5].map(star => (
                    <button
                      key={star}
                      onClick={() => setRating(star)}
                      className="text-3xl transition-transform hover:scale-125 active:scale-90"
                    >
                      {star <= rating ? '⭐' : '☆'}
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleSubmitRating}
                  disabled={ratingLoading}
                  className="w-full py-3 bg-amber-500 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {ratingLoading ? <span className="material-symbols-outlined text-base animate-spin">sync</span> : <span>Submit Rating</span>}
                </button>
              </>
            )}
          </div>
        )}

        {/* ── 13. SUPPORT SNIFFR (UNLIMITED DONATIONS) ── */}
        {(activeModal === 'feed-strays' || activeModal === 'donate-creators') && (() => {
          const isFeedPack = activeModal === 'feed-strays';
          const title = isFeedPack ? 'Feed the Strays' : 'For the Creators';
          const subtitle = isFeedPack
            ? 'Donate today and help us feed, care, and protect animals who have no one else!'
            : 'Support the pack behind Sniffr and help us turn bigger ideas into better experiences!';
          const note = isFeedPack ? 'Sniffr Feed Pack' : 'Sniffr Donation';
          return (
            <div className="p-6 space-y-4 overflow-y-auto">
              <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
                <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                  <span>💕</span> {title}
                </h2>
                <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>

              {donationQrView ? (
                <div className="text-center space-y-4">
                  <p className="text-xs text-zinc-500 font-medium">
                    {donationQrView === 'custom'
                      ? "Scan or tap to open your UPI app, then enter any amount you'd like to give."
                      : `Scan or tap to pay ₹${donationTier?.amount} via UPI.`}
                  </p>
                  <a
                    href={buildDonationUpiUrl({ amount: donationQrView === 'custom' ? null : donationTier?.amount, note })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex flex-col items-center gap-2 p-5 rounded-2xl border-2 border-dashed border-rose-200 dark:border-rose-900/40 hover:border-rose-400 transition-colors"
                  >
                    <div className="p-2 bg-white rounded-xl">
                      <QRCodeSVG value={buildDonationUpiUrl({ amount: donationQrView === 'custom' ? null : donationTier?.amount, note })} size={160} />
                    </div>
                    <span className="text-[11px] font-bold text-rose-600 dark:text-rose-300">Tap to pay, or scan with any UPI app</span>
                  </a>
                  <button
                    onClick={() => { setDonationQrView(null); setDonationTier(null); }}
                    className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-2xl active:scale-95 transition-transform"
                  >
                    Back
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-xs text-zinc-500 font-medium leading-relaxed">{subtitle}</p>

                  <div className="grid grid-cols-3 gap-2">
                    {DONATION_PRESETS.map(({ amount, emoji }) => (
                      <button
                        key={amount}
                        onClick={() => setDonationTier({ amount, emoji })}
                        className={`p-3 rounded-2xl border-2 text-center transition-all ${donationTier?.amount === amount ? 'border-rose-500 bg-rose-50/50 text-rose-600 dark:bg-rose-950/20 font-extrabold' : 'border-zinc-200 dark:border-zinc-800 text-on-surface font-bold'}`}
                      >
                        <div className="text-xs">₹{amount} {emoji}</div>
                      </button>
                    ))}
                  </div>

                  <button
                    onClick={() => setDonationQrView('custom')}
                    className="w-full py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs font-bold text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors"
                  >
                    Custom Amount
                  </button>

                  <button
                    onClick={() => donationTier && setDonationQrView('preset')}
                    disabled={!donationTier}
                    className="w-full py-3.5 bg-gradient-to-r from-rose-500 to-pink-500 text-white font-extrabold text-xs rounded-2xl shadow-lg active:scale-95 transition-transform flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {donationTier ? (
                      <>
                        <span>{donationTier.emoji}</span> Contribute ₹{donationTier.amount}
                      </>
                    ) : (
                      'Select an amount'
                    )}
                  </button>
                </>
              )}
            </div>
          );
        })()}

        {/* ── 14. REPORT HISTORY (PERSISTED & INTEGRATED WITH BUGS) ── */}
        {activeModal === 'report-history' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🛡️</span> Report History
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {reportsList.length === 0 ? (
              <div className="text-center py-12 space-y-2">
                <div className="w-12 h-12 rounded-full bg-zinc-100 text-zinc-400 flex items-center justify-center text-xl mx-auto">
                  📋
                </div>
                <p className="text-xs font-extrabold text-zinc-500">You haven't submitted any reports yet.</p>
                <p className="text-[11px] text-zinc-400">Reports and bug logs submitted by you will appear here in chronological order.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {reportsList.map(report => (
                  <div key={report.id} className="p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 space-y-2 text-left">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-extrabold text-on-surface flex items-center gap-1">
                        <span>🚩</span> {report.reason || report.category || 'Report'}
                      </span>
                      <span className={`text-[10px] font-extrabold px-2.5 py-0.5 rounded-full ${
                        report.status === 'Resolved'
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                          : report.status === 'Reviewed'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
                      }`}>
                        {report.status || 'Pending'}
                      </span>
                    </div>
                    {report.post_reference && (
                      <p className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300 bg-white dark:bg-zinc-800 p-2.5 rounded-xl border border-zinc-100 dark:border-zinc-700/50 line-clamp-2">
                        {report.post_reference}
                      </p>
                    )}
                    <div className="flex justify-between items-center pt-1 text-[10px] text-zinc-400">
                      <span>Date & Time</span>
                      <span className="font-semibold">{report.date}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── 15. SAFETY TIPS ── */}
        {activeModal === 'safety-tips' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>🛡️</span> Safety Tips
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-2.5">
              {[
                { title: 'Meet in public places', desc: 'Always schedule initial pet playdates in well-lit public parks or licensed dog parks.' },
                { title: 'Never share sensitive information', desc: 'Keep financial details and home addresses private until trust is established.' },
                { title: 'Verify pet profiles', desc: 'Look for verified pet badges and authentic community posts.' },
                { title: 'Report suspicious activity', desc: 'If a user behaves aggressively or posts fake profiles, use the report button immediately.' },
                { title: 'Respect community guidelines', desc: 'Help us maintain a safe, welcoming environment for pets and owners alike.' },
              ].map((tip, i) => (
                <div key={i} className="p-3.5 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800">
                  <h4 className="text-xs font-extrabold text-on-surface flex items-center gap-2">
                    <span className="text-primary">💡</span> {tip.title}
                  </h4>
                  <p className="text-[11px] text-zinc-500 mt-1">{tip.desc}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 16. WHAT'S NEW (CHANGELOG) ── */}
        {activeModal === 'whats-new' && (
          <div className="p-6 space-y-4 overflow-y-auto">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h2 className="text-lg font-extrabold text-on-surface flex items-center gap-2">
                <span>✨</span> What's New
              </h2>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center">
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-4">
              <div className="p-4 bg-primary/5 rounded-2xl border border-primary/20 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-extrabold text-primary">v1.0.0 - Official Launch 🚀</span>
                  <span className="text-[10px] text-zinc-400 font-semibold">August 2026</span>
                </div>
                <ul className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1 list-disc pl-4">
                  <li>🐾 Create up to 5 Pet Profiles and switch between them anytime.</li>
                  <li>💘 Meet Nearby Pets based on your preferred distance and location.</li>
                  <li>📸 Share Photos & Videos with the Sniffr community.</li>
                  <li>❤️ Lick & React to posts using unique pet-themed reactions.</li>
                  <li>👥 Join PawCircles to connect with pet lovers and communities.</li>
                  <li>📞 Audio & Video Calls for seamless conversations.</li>
                  <li>🏆 Discover the Most-Loved Pets Near You with Spotlight.</li>
                </ul>
              </div>

              <div className="p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-extrabold text-on-surface">v0.9.0 - Beta Preview</span>
                  <span className="text-[10px] text-zinc-400 font-semibold">July 2026</span>
                </div>
                <ul className="text-xs text-zinc-500 space-y-1 list-disc pl-4">
                  <li>🧪 Initial pet matching, feed, and profile experience.</li>
                  <li>💬 Core messaging and community features.</li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* ── 17. LOCATION PERMISSIONS ── */}
        {activeModal === 'location-permissions' && (
          <div className="p-6 space-y-5 overflow-y-auto text-left">
            <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="font-extrabold text-base text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-xl">location_on</span>
                Location Permissions
              </h3>
              <button onClick={onClose} className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-600">
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            <div className="p-4 bg-zinc-50 dark:bg-zinc-800/40 rounded-2xl border border-zinc-100 dark:border-zinc-800 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-zinc-500">GPS Permission Status</span>
                <span className={`text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full ${
                  permissionStatus === 'granted' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' :
                  permissionStatus === 'denied' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300' :
                  'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                }`}>
                  {permissionStatus ? permissionStatus.toUpperCase() : 'UNKNOWN'}
                </span>
              </div>
              <p className="text-[11px] text-zinc-500 font-medium leading-relaxed">
                Sniffr uses precise location to recommend nearby playmates, PawCircle events, and local pet rankings.
              </p>
            </div>

            {locationData ? (
              <div className="p-4 bg-primary/5 rounded-2xl border border-primary/20 space-y-2 text-xs font-medium">
                <p className="font-bold text-primary flex items-center gap-1.5 text-xs">
                  <span className="material-symbols-outlined text-sm">pin_drop</span>
                  Last Stored Location
                </p>
                <p className="text-on-surface font-extrabold">
                  {[locationData.area, locationData.city, locationData.state, locationData.country].filter(Boolean).join(', ') || 'GPS Coordinates Stored'}
                </p>
                <p className="text-[10px] text-zinc-400 font-bold">
                  Lat: {locationData.latitude?.toFixed(4)}, Lng: {locationData.longitude?.toFixed(4)}
                </p>
              </div>
            ) : (
              <div className="p-4 bg-zinc-50 dark:bg-zinc-800/30 rounded-2xl border border-dashed border-zinc-200 text-center text-xs text-zinc-400 font-medium">
                No stored GPS location found. Tap below to fetch your current location.
              </div>
            )}

         <button
              onClick={async () => {
                setLocationLoading(true);
                try {
                  const loc = await getCurrentGPSLocation();
                  setLocationData(loc);
                  setPermissionStatus('granted');
                  showToast('GPS location updated successfully! 📍');
                } catch (e) {
                  setPermissionStatus('denied');
                  showToast('Location permission denied. Enable location access in your browser settings.');
                } finally {
                  setLocationLoading(false);
                }
              }}
              disabled={locationLoading}
              className="w-full py-3.5 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-xs uppercase tracking-wider rounded-2xl shadow-md active:scale-95 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">my_location</span>
              <span>{locationLoading ? 'Updating Location...' : 'Update GPS Location'}</span>
            </button>

            {permissionStatus === 'denied' && (
              <div className="p-4 bg-amber-50 dark:bg-amber-950/40 rounded-2xl border border-amber-200/50 text-[11px] text-amber-800 dark:text-amber-300 space-y-1">
                <p className="font-extrabold flex items-center gap-1">
                  <span className="material-symbols-outlined text-sm">info</span>
                  How to grant location permission:
                </p>
                <ol className="list-decimal pl-4 space-y-1">
                  <li>Click the lock icon 🔒 next to the web URL in your browser.</li>
                  <li>Toggle "Location" permission to Allow.</li>
                  <li>Refresh the page and tap Update GPS Location.</li>
                </ol>
              </div>
            )}
          </div>
        )}

      </div>

      {/* In-app Toast */}
      {toast && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[400] bg-zinc-900 text-white px-5 py-3 rounded-2xl text-xs font-extrabold shadow-2xl animate-bounce">
          {toast}
        </div>
      )}
    </div>
  );
}
