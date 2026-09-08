import { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import Portal from '../components/Portal';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

// Same 5 rules as server/routes/auth.js's validatePassword, so the live
// checklist below never shows "all satisfied" for a password the server
// would actually reject.
const PASSWORD_REQUIREMENTS = [
  { key: 'length', label: '8–20 characters', test: (p) => p.length >= 8 && p.length <= 20 },
  { key: 'uppercase', label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { key: 'lowercase', label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
  { key: 'number', label: 'One number', test: (p) => /[0-9]/.test(p) },
  { key: 'special', label: 'One special character', test: (p) => /[^a-zA-Z0-9]/.test(p) },
];

function getPasswordRequirements(password) {
  const pass = password || '';
  return PASSWORD_REQUIREMENTS.map(r => ({ key: r.key, label: r.label, met: r.test(pass) }));
}

export default function AuthPage() {
  const [mode, setMode]         = useState('signin');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [username, setUsername] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

  // 2FA login pending states
  const [twoFactorPending, setTwoFactorPending] = useState(null); // { tempToken, email }
  const [twoFactorCode, setTwoFactorCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(true);
  const [twoFactorLoading, setTwoFactorLoading] = useState(false);
  const [twoFactorError, setTwoFactorError] = useState('');
  const [twoFactorResendTimer, setTwoFactorResendTimer] = useState(0);

  // Pending Account Deletion after sign-in
  const [showDeleteSuccessModal, setShowDeleteSuccessModal] = useState(false);

  // Forgot Password modal states
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [forgotIdentifier, setForgotIdentifier] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState('');
  const [forgotSuccess, setForgotSuccess] = useState('');

  // Social signup flow — shown after Google/Apple returns a new user
  const [socialPrefill, setSocialPrefill] = useState(null); // { email, full_name, provider }
  const [socialUsername, setSocialUsername] = useState('');

  const { login, signup, socialComplete, verify2FALogin, logout, completeExternalLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // Resend code countdown timer
  useEffect(() => {
    let interval = null;
    if (twoFactorResendTimer > 0) {
      interval = setInterval(() => setTwoFactorResendTimer(prev => prev - 1), 1000);
    }
    return () => { if (interval) clearInterval(interval); };
  }, [twoFactorResendTimer]);

  useEffect(() => {
    if (location.state?.showAccountDeletedNotice) {
      setShowDeleteSuccessModal(true);
    }
  }, [location.state]);

  const handlePendingDelete = async () => {
    try {
      await api.post('/privacy/delete');
      logout();
      setShowDeleteSuccessModal(true);
    } catch (err) {
      console.error('Pending delete error:', err);
    }
  };

  // ── Establish session helper ───────────────────────────────
  const applySession = (data) => {
    if (location.state?.pendingDeleteAccount) {
      handlePendingDelete();
      return;
    }
    setTimeout(() => {
      if (location.state?.redirectTo2FA) {
        navigate('/profile', { state: { openSettings: true, openPawPrint2FA: true } });
      } else if (data.pet) {
        navigate('/home');
      } else {
        navigate('/pet-selection');
      }
    }, 50);
  };

  const handleEmailClick = (e) => {
    if (e) e.preventDefault();
    setMode('signin');
    if (email.trim() && password) {
      const formEl = document.querySelector('form');
      if (formEl) {
        if (formEl.requestSubmit) formEl.requestSubmit();
        else handleSubmit(e);
      }
      return;
    }
    setTimeout(() => {
      const el = document.getElementById('email');
      if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 50);
  };

  // ── Google: initialize One-Tap when SDK + Client ID are ready ─
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    const tryInit = () => {
      if (!window.google?.accounts?.id) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        auto_select: false,          // never silent login
        callback: onGoogleCredential,
        cancel_on_tap_outside: true,
        ux_mode: 'popup',
        context: 'signin',
      });
    };
    const id = setInterval(() => { if (window.google?.accounts?.id) { tryInit(); clearInterval(id); } }, 200);
    setTimeout(() => clearInterval(id), 8000);
    return () => clearInterval(id);
  }, []);

  const onGoogleCredential = async (response) => {
    if (!response?.credential) { setError('Google sign-in was cancelled.'); return; }
    setLoading(true); setError('');
    try {
      const data = await api.post('/auth/google', { credential: response.credential });
      if (data.needsSignup) { setSocialPrefill(data.prefill); setLoading(false); return; }
      completeExternalLogin(data);
      applySession(data);
    } catch (err) {
      setError(err.message || 'Google sign-in failed.');
    } finally { setLoading(false); }
  };

  const handleGoogleClick = () => {
    if (!GOOGLE_CLIENT_ID) {
      setError('Google Sign-In is not configured.');
      return;
    }
    if (!window.google?.accounts?.id) {
      setError('Google SDK is still loading. Please wait a moment and try again.');
      return;
    }
    setError('');
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'openid email profile',
      prompt: 'select_account',
      callback: async (tokenResponse) => {
        if (tokenResponse.error) { setError('Google sign-in was cancelled.'); return; }
        setLoading(true);
        try {
          const info = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${tokenResponse.access_token}` }
          }).then(r => r.json());
          
          const data = await api.post('/auth/google', { 
            manual: true,
            email: info.email,
            name: info.name,
            google_id: info.sub,
            picture: info.picture
          });
          
          if (data.needsSignup) { setSocialPrefill(data.prefill); setLoading(false); return; }
          completeExternalLogin(data);
          applySession(data);
        } catch (err) {
          setError(err.message || 'Google sign-in failed.');
        } finally { setLoading(false); }
      },
    });
    client.requestAccessToken();
  };

  // Helper: validate password complexity
  const validatePasswordStrength = (pass) => {
    if (!pass || pass.length < 8 || pass.length > 20) return false;
    if (!/[A-Z]/.test(pass)) return false;
    if (!/[a-z]/.test(pass)) return false;
    if (!/[0-9]/.test(pass)) return false;
    if (!/[^a-zA-Z0-9]/.test(pass)) return false;
    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError(''); setFieldErrors({});

    // Client-side validations
    if (mode === 'signin') {
      if (!email.trim() || !password) {
        setError("🐾 Looks like something's missing.");
        setLoading(false);
        return;
      }
    } else {
      const errors = {};
      
      // 1. Full Name check
      if (!fullName.trim()) {
        errors.fullName = 'Full Name is required.';
      } else if (!/[a-zA-Z]/.test(fullName)) {
        errors.fullName = 'Full name cannot contain numbers or special characters only.';
      }

      // 2. Username check
      if (!username.trim()) {
        errors.username = 'Username is required.';
      } else if (!/^[a-zA-Z0-9_]{4,20}$/.test(username)) {
        errors.username = 'Username must be 4–20 characters and contain only letters, numbers, and underscores.';
      }

      // 3. Email check
      if (!email.trim()) {
        errors.email = 'Email is required.';
      } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.email = "🐾 That doesn't look like a valid email. Check the address and try again.";
      }

      // 4. Password check
      if (!password) {
        errors.password = 'Password is required.';
      } else if (!validatePasswordStrength(password)) {
        errors.password = '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character';
      }

      // 5. Confirm Password check
      if (password !== confirmPassword) {
        errors.confirmPassword = "🐾 Those passwords don't match. Give it another sniff.";
      }

      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setError('Please fix the errors below.');
        setLoading(false);
        return;
      }
    }

    try {
      if (mode === 'signin') {
        const data = await login(email, password);
        if (data && data.requires2FA) {
          setTwoFactorPending({ tempToken: data.tempToken, email: data.email });
          setTwoFactorResendTimer(60);
          setLoading(false);
          return;
        }
        applySession(data);
      } else {
        const data = await signup({ 
          email, 
          password, 
          confirmPassword, 
          username, 
          full_name: fullName 
        });
        applySession(data);
      }
    } catch (err) {
      if (err.errors) {
        // Handle server-side validation errors
        const newFieldErrors = {};
        err.errors.forEach(e => {
          const fieldName = e.field === 'full_name' ? 'fullName' : e.field;
          newFieldErrors[fieldName] = e.message;
        });
        setFieldErrors(newFieldErrors);
        setError('Please fix the errors below.');
      } else if (err.code === 'NOT_FOUND' || err.code === 'BAD_PASSWORD') {
        // Wrong email/username or wrong password -- show one unified,
        // non-leaky message rather than the server's distinct wording for
        // each case (which would reveal whether the email or the password
        // was the wrong part).
        setError("🐾 We couldn't recognize that email or password. Give it another sniff!");
      } else {
        setError(err.message || 'Authentication failed.');
      }
    } finally { setLoading(false); }
  };

  const handleVerify2FASubmit = async (e) => {
    e.preventDefault();
    if (!twoFactorCode || twoFactorCode.trim().length < 6) return;
    setTwoFactorLoading(true);
    setTwoFactorError('');
    try {
      const data = await verify2FALogin({
        tempToken: twoFactorPending.tempToken,
        code: twoFactorCode.trim(),
        trustDevice,
      });
      applySession(data);
    } catch (err) {
      setTwoFactorError(err.message || 'The Paw Code is incorrect or has expired. Please try again.');
    } finally {
      setTwoFactorLoading(false);
    }
  };

  const handleResend2FACode = async () => {
    if (twoFactorResendTimer > 0 || twoFactorLoading) return;
    setTwoFactorLoading(true);
    setTwoFactorError('');
    try {
      await api.post('/auth/2fa/resend-code', { tempToken: twoFactorPending.tempToken });
      setTwoFactorResendTimer(60);
    } catch (err) {
      setTwoFactorError(err.message || 'Failed to resend Paw Code.');
    } finally {
      setTwoFactorLoading(false);
    }
  };

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

  const handleSocialSignup = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const data = await socialComplete({
        email: socialPrefill.email,
        username: socialUsername,
        full_name: socialPrefill.full_name,
        provider: socialPrefill.provider,
      });
      applySession(data);
    } catch (err) {
      setError(err.message || 'Profile completion failed.');
    } finally { setLoading(false); }
  };

  if (socialPrefill) {
    return (
      <div className="min-h-screen bg-background p-6 flex flex-col items-center justify-center animate-fade-in">
        <div className="w-full max-w-sm space-y-8 text-center">
          <div className="space-y-2">
            <h1 className="text-3xl font-black text-on-surface">Almost there! 🐾</h1>
            <p className="text-on-surface-variant/70">Pick a unique username to finish your Sniffr profile.</p>
          </div>
          <form onSubmit={handleSocialSignup} className="space-y-6 text-left">
            <FField id="s-user" label="Username" icon="person" type="text" value={socialUsername} onChange={setSocialUsername} placeholder="pawsome_buddy"/>
            <button type="submit" disabled={loading || !socialUsername}
              className="w-full py-4 rounded-xl bg-primary text-white font-bold text-lg shadow-lg active:scale-95 transition-all disabled:opacity-50">
              {loading ? 'Finalizing...' : 'Start Sniffing!'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isSignIn = mode === 'signin';

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Background Decor Watermark Pawprints */}
      <span className="material-symbols-outlined absolute text-[20rem] text-[#F393AB]/3 -top-24 -left-20 rotate-12 pointer-events-none select-none">pets</span>
      <span className="material-symbols-outlined absolute text-[24rem] text-[#8E2E43]/3 -bottom-28 -right-20 -rotate-12 pointer-events-none select-none">pets</span>

      {/* Background Decor Blur Blobs */}
      <div className="absolute top-[-10%] left-[-10%] w-64 h-64 bg-primary/10 rounded-full blur-3xl animate-pulse"/>
      <div className="absolute bottom-[-10%] right-[-10%] w-64 h-64 bg-secondary/10 rounded-full blur-3xl animate-pulse" style={{animationDelay:'1s'}}/>

      <main className="w-full max-w-sm flex flex-col relative z-10 animate-slide-up">
        <header className="text-center mb-8 space-y-2">
          <div className="relative w-48 h-48 mb-6 mx-auto flex items-center justify-center">
            {/* Soft pink background circle offset behind */}
            <div className="absolute w-44 h-44 bg-gradient-to-tr from-[#FCEAEF] to-[#FCEAEF]/40 rounded-full filter blur-sm"></div>
            {/* White squircle container with logo */}
            <div className="relative w-36 h-36 bg-white rounded-[2.75rem] shadow-[0_20px_40px_-5px_rgba(231,126,149,0.25)] flex items-center justify-center border border-[#FCEAEF]/30">
              <img alt="Sniffr" className="w-22 h-22 object-contain" src="/logo.png" />
            </div>
          </div>
          <h1 className={`text-4xl font-extrabold tracking-tight text-center transition-colors duration-300 ${isSignIn ? 'text-[#F393AB]' : 'text-[#8E2E43]'}`}>
            Sniffr
          </h1>
          <p className="text-on-surface-variant font-medium mt-1 text-center opacity-85 text-sm">Find your pet's soulmate</p>
        </header>

        <div className="bg-white rounded-[2.5rem] p-8 shadow-sm space-y-8">
          {mode === 'signup' ? (
            <div className="text-center mb-4">
              <h2 className="text-2xl font-black text-on-surface">Create your account</h2>
              <p className="text-xs text-on-surface-variant/70 mt-1">Start your journey to find the perfect playmate.</p>
            </div>
          ) : (
            <div className="bg-surface-container-low p-1.5 rounded-full flex mx-auto mb-2 w-full max-w-[280px] border border-outline-variant/20">
              <button onClick={()=>setMode('signin')} className={`flex-1 py-3 rounded-full text-sm font-bold tracking-wide transition-all ${mode==='signin'?'bg-white text-[#8E2E43] shadow-sm':'text-on-surface-variant/60'}`}>Sign In</button>
              <button onClick={()=>setMode('signup')} className={`flex-1 py-3 rounded-full text-sm font-bold tracking-wide transition-all ${mode==='signup'?'bg-white text-[#8E2E43] shadow-sm':'text-on-surface-variant/60'}`}>Sign Up</button>
            </div>
          )}

          {error && (
            <div className="bg-error-container/20 border border-error/20 text-error text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-shake whitespace-pre-line">
              <span className="material-symbols-outlined text-lg">error</span>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {mode === 'signup' && (
              <>
                <FField id="fname" label="Full Name" icon="person" type="text" value={fullName} onChange={setFullName} error={fieldErrors.fullName} placeholder="John Doe"/>
                <FField id="username" label="Username" icon="alternate_email" type="text" value={username} onChange={setUsername} error={fieldErrors.username} placeholder="pawsome_buddy"/>
              </>
            )}
            <FField id="email" label="Email Address" icon="mail" type="text" value={email} onChange={setEmail} error={fieldErrors.email} placeholder={mode === 'signin' ? 'hello@furryfriends.com' : 'hello@sniffr.com'}/>
            <div className="space-y-1.5">
              <div className="flex justify-between items-center px-1">
                <label className="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">Password</label>
                {mode === 'signin' && <button type="button" onClick={() => { setShowForgotModal(true); setForgotError(''); setForgotSuccess(''); setForgotIdentifier(''); }} className="text-[10px] font-bold text-[#8E2E43] hover:opacity-75">Forgot Password?</button>}
              </div>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">lock</span>
                <input className={`w-full pl-12 pr-12 py-4 bg-surface-container-low/70 rounded-full focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 border-none transition-all ${fieldErrors.password?'ring-2 ring-error':''}`}
                  type={showPass?'text':'password'} placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)}/>
                <button type="button" onClick={()=>setShowPass(!showPass)} className="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                  <span className="material-symbols-outlined">{showPass?'visibility_off':'visibility'}</span>
                </button>
              </div>
              {mode === 'signup'
                ? <PasswordChecklist password={password} />
                : (fieldErrors.password && <p className="text-xs text-error font-bold px-1 whitespace-pre-line leading-relaxed">{fieldErrors.password}</p>)
              }
            </div>

            {mode === 'signup' && (
              <div className="space-y-1.5">
                <label className="block text-[11px] font-bold uppercase tracking-widest text-on-surface-variant px-1">Confirm Password</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">lock</span>
                  <input className={`w-full pl-12 pr-12 py-4 bg-surface-container-low/70 rounded-full focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 border-none transition-all ${fieldErrors.confirmPassword?'ring-2 ring-error':''}`}
                    type={showConfirmPass?'text':'password'} placeholder="••••••••" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/>
                  <button type="button" onClick={()=>setShowConfirmPass(!showConfirmPass)} className="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                    <span className="material-symbols-outlined">{showConfirmPass?'visibility_off':'visibility'}</span>
                  </button>
                </div>
                {fieldErrors.confirmPassword && <p className="text-xs text-error font-bold px-1">{fieldErrors.confirmPassword}</p>}
              </div>
            )}
            
            <button type="submit" disabled={loading}
              className={`w-full py-4 rounded-full text-white font-bold text-lg active:scale-[0.98] transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-md ${
                isSignIn
                  ? 'bg-gradient-to-r from-[#EB96AA] via-[#EFA6B7] to-[#ADC6D5]'
                  : 'bg-gradient-to-r from-[#AE526D] to-[#E293A6]'
              }`}>
              {loading ? (
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"/>
              ) : (
                mode === 'signup' ? 'Get Wagging →' : 'Get Wagging'
              )}
            </button>
          </form>

          {mode === 'signin' && (
            <>
              {/* Divider */}
              <div className="flex items-center gap-4">
                <div className="h-px flex-1 bg-surface-container-high"/>
                <span className="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">Or continue with</span>
                <div className="h-px flex-1 bg-surface-container-high"/>
              </div>

              {/* Social buttons */}
              <div className="grid grid-cols-2 gap-4">
                <button onClick={handleGoogleClick} disabled={loading}
                  className="flex items-center justify-center gap-2 py-3 rounded-full bg-white border border-zinc-100 shadow-sm active:scale-[0.98] transition-all font-bold text-zinc-700 text-xs disabled:opacity-60">
                  <GoogleIcon/> GOOGLE
                </button>

                <button onClick={handleEmailClick} disabled={loading}
                  className="flex items-center justify-center gap-2 py-3 rounded-full bg-white border border-zinc-100 shadow-sm active:scale-[0.98] transition-all font-bold text-zinc-700 text-xs disabled:opacity-60 cursor-pointer">
                  <EmailCutoutIcon /> EMAIL
                </button>
              </div>
            </>
          )}

          {mode === 'signup' && (
            <div className="text-center pt-2">
              <span className="text-xs text-on-surface-variant">Already have an account? </span>
              <button onClick={() => setMode('signin')} className="text-xs font-bold text-[#8E2E43] hover:underline">Sign In</button>
            </div>
          )}
        </div>

        {mode === 'signin' && (
          <div className="mt-8 p-6 bg-[#EAF3F8] border border-[#EAF3F8]/50 rounded-[2.5rem] relative overflow-hidden flex gap-4 items-center shadow-sm">
            <div className="bg-[#D3E5F0] p-3 rounded-full flex-shrink-0 flex items-center justify-center">
              <span className="material-symbols-outlined text-[#1C3E57] text-2xl">auto_awesome</span>
            </div>
            <div className="z-10 relative">
              <h3 className="text-[#1C3E57] font-extrabold text-sm">Every tail tells a story.</h3>
              <p className="text-[#3B6682] text-xs mt-1 leading-relaxed">We built Sniffr for unforgettable moments with your furry best friend❤️‍🔥</p>
            </div>
          </div>
        )}

        <footer className="mt-auto py-8 text-center space-y-4">
          {mode === 'signin' ? (
            <p className="text-[10px] text-on-surface-variant/70 px-6 leading-relaxed">
              By tapping Sign In, you agree to our{' '}
              <button onClick={()=>navigate('/terms')} className="underline font-bold text-[#8E2E43] hover:opacity-85">Terms of Service</button>
              {' '}and{' '}
              <button onClick={()=>navigate('/privacy')} className="underline font-bold text-[#8E4D5D] hover:opacity-85">Privacy Policy</button>.
            </p>
          ) : (
            <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">© 2026 SNIFFR.CO.IN</p>
          )}
          <div className="flex justify-center gap-4 text-zinc-300/80">
            <span className="material-symbols-outlined text-[18px]">star</span>
            <span className="material-symbols-outlined text-[18px]">verified</span>
            <span className="material-symbols-outlined text-[18px]">shield</span>
          </div>
        </footer>
      </main>
      <div className="fixed bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none z-20"/>

      <Portal>
      {/* Forgot Password Modal */}
      {showForgotModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md transition-all p-4">
          <div className="w-full max-w-sm bg-white rounded-[2.5rem] p-8 relative flex flex-col space-y-6 animate-scale-up shadow-2xl border border-primary/10">
            <button 
              type="button"
              onClick={() => { setShowForgotModal(false); setForgotError(''); setForgotSuccess(''); setForgotIdentifier(''); }} 
              className="absolute right-6 top-6 text-on-surface-variant/40 hover:text-on-surface transition-colors"
              disabled={forgotLoading}
            >
              <span className="material-symbols-outlined">close</span>
            </button>

            <div className="text-center space-y-2">
              <h3 className="text-2xl font-black text-[#8E2E43]">Recover Password</h3>
              <p className="text-xs text-on-surface-variant/70">We will help you sniff it out! Enter your username or email address below.</p>
            </div>

            {forgotError && (
              <div className="bg-error-container/20 border border-error/20 text-error text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-shake">
                <span className="material-symbols-outlined text-lg">error</span>
                {forgotError}
              </div>
            )}

            {forgotSuccess && (
              <div className="bg-success-container/20 border border-success/20 text-success text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-pulse">
                <span className="material-symbols-outlined text-lg">check_circle</span>
                {forgotSuccess}
              </div>
            )}

            <form onSubmit={handleForgotSubmit} className="space-y-5">
              <div className="space-y-1.5 text-left">
                <label className="block text-[11px] font-bold uppercase tracking-widest text-on-surface-variant px-1">Type In</label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">person</span>
                  <input 
                    className="w-full pl-12 pr-4 py-4 bg-surface-container-low/70 rounded-full focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 border-none transition-all"
                    type="text" 
                    placeholder="Enter your email or username" 
                    value={forgotIdentifier} 
                    onChange={e => setForgotIdentifier(e.target.value)}
                    disabled={forgotLoading}
                    required
                  />
                </div>
              </div>

              <button 
                type="submit" 
                disabled={forgotLoading || !forgotIdentifier.trim()}
                className="w-full py-4 rounded-full bg-gradient-to-r from-[#AE526D] to-[#E293A6] text-white font-bold text-lg active:scale-[0.98] transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-md"
              >
                {forgotLoading ? (
                  <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"/>
                ) : (
                  '🐾 Sniff'
                )}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* PawPrint 2FA Login Modal */}
      {twoFactorPending && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 select-none bg-black/60 backdrop-blur-md animate-fade-in">
          <div className="relative w-full max-w-sm bg-white dark:bg-zinc-900 rounded-3xl p-6 shadow-2xl z-[210] border border-outline-variant/10 animate-scale-up space-y-4">
            <div className="flex justify-between items-center pb-2 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="text-base font-extrabold text-on-surface flex items-center gap-2">
                <span>🐾</span> PawPrint Verification
              </h3>
              <button
                onClick={() => {
                  setTwoFactorPending(null);
                  setTwoFactorCode('');
                  setTwoFactorError('');
                }}
                className="w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-on-surface flex items-center justify-center text-xs"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed text-left">
              A 6-digit Paw Code was sent to <strong className="text-on-surface">{twoFactorPending.email}</strong>. Enter the code below to complete sign in.
            </p>

            {twoFactorError && (
              <div className="p-3 bg-rose-50 border border-rose-200 text-rose-600 dark:bg-rose-950/40 dark:border-rose-900/40 dark:text-rose-300 rounded-xl text-xs font-bold animate-fade-in flex items-center gap-1.5 text-left">
                <span className="material-symbols-outlined text-sm">error</span>
                <span>{twoFactorError}</span>
              </div>
            )}

            <form onSubmit={handleVerify2FASubmit} className="space-y-4 pt-1">
              <div>
                <input
                  type="text"
                  maxLength="6"
                  autoFocus
                  required
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="Enter the Paw Code"
                  className="w-full px-4 py-3 bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl text-base font-extrabold text-center tracking-[0.3em] text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>

              <label className="flex items-center gap-2.5 cursor-pointer text-left select-none px-1">
                <input
                  type="checkbox"
                  checked={trustDevice}
                  onChange={(e) => setTrustDevice(e.target.checked)}
                  className="w-4 h-4 rounded text-primary focus:ring-primary accent-primary"
                />
                <span className="text-xs font-bold text-zinc-600 dark:text-zinc-300">
                  Trust this device for 30 days
                </span>
              </label>

              <button
                type="submit"
                disabled={twoFactorLoading || twoFactorCode.length < 6}
                className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {twoFactorLoading ? (
                  <span className="material-symbols-outlined text-base animate-spin">sync</span>
                ) : (
                  <span>Verify & Sign In</span>
                )}
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={handleResend2FACode}
                  disabled={twoFactorResendTimer > 0 || twoFactorLoading}
                  className={`text-xs font-bold transition-colors ${
                    twoFactorResendTimer > 0 ? 'text-zinc-400 cursor-not-allowed' : 'text-primary hover:underline'
                  }`}
                >
                  {twoFactorResendTimer > 0 ? `Resend Code (${twoFactorResendTimer}s)` : '🐾 Resend Code'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Account Deletion Success Modal on AuthPage */}
      {showDeleteSuccessModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-md z-[250] flex items-center justify-center p-4 select-none animate-fade-in">
          <div className="bg-white dark:bg-zinc-900 p-6 rounded-3xl max-w-sm w-full shadow-2xl relative overflow-hidden text-center space-y-4 border border-outline-variant/10 animate-scale-up">
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
                setShowDeleteSuccessModal(false);
                window.history.replaceState({}, document.title);
              }}
              className="w-full py-3.5 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 transition-transform"
            >
              OK, Back to Sign In
            </button>
          </div>
        </div>
      )}
      </Portal>
    </div>
  );
}

// Live, per-keystroke password requirement checklist for Sign Up. Only
// unmet requirements stay visible -- each one disappears the moment the
// current input satisfies it, no need to wait for submit.
function PasswordChecklist({ password }) {
  if (!password) return null;

  const unmet = getPasswordRequirements(password).filter(r => !r.met);

  if (unmet.length === 0) {
    return (
      <p className="text-xs text-emerald-600 font-bold px-1 flex items-center gap-1.5 animate-fade-in">
        <span>✅</span> Password looks great!
      </p>
    );
  }

  return (
    <div className="px-1 space-y-1 animate-fade-in">
      <p className="text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">🐾 Your password needs:</p>
      <ul className="space-y-0.5">
        {unmet.map(r => (
          <li key={r.key} className="text-xs text-error font-bold flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[13px]">close</span>
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FField({ id, label, icon, type, value, onChange, error, placeholder }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] font-bold uppercase tracking-widest text-on-surface-variant px-1" htmlFor={id}>{label}</label>
      <div className="relative">
        <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">{icon}</span>
        <input id={id} className={`w-full pl-12 pr-4 py-4 bg-surface-container-low/70 rounded-full focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 border-none transition-all ${error?'ring-2 ring-error':''}`}
          type={type} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/>
      </div>
      {error && <p className="text-[10px] text-error font-bold px-1 animate-fade-in">{error}</p>}
    </div>
  );
}

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const EmailCutoutIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-800">
    <path d="M4 6h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-6" />
    <path d="M4 6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h6" />
    <path d="M2.5 7.5L12 14l9.5-6.5" />
    <path d="M14 17h7.5" />
    <path d="M18.5 14l3 3-3 3" />
  </svg>
);
