import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '../services/api';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});

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
    setLoading(true);
    setError('');
    setSuccess('');
    setFieldErrors({});

    const newFieldErrors = {};

    // 1. Password validation
    if (!password || !validatePasswordStrength(password)) {
      newFieldErrors.password = '🐾 Your password needs at least:\n• 8 characters\n• One uppercase letter\n• One lowercase letter\n• One number\n• One special character';
    }

    // 2. Confirm password validation
    if (password !== confirmPassword) {
      newFieldErrors.confirmPassword = "🐾 Those passwords don't match. Give it another sniff.";
    }

    if (Object.keys(newFieldErrors).length > 0) {
      setFieldErrors(newFieldErrors);
      setError('Please fix the errors below.');
      setLoading(false);
      return;
    }

    try {
      const res = await api.post('/auth/reset-password', {
        token,
        password,
        confirmPassword
      });
      setSuccess(res.message || '🐾 Password reset successfully!');
      setTimeout(() => {
        navigate('/');
      }, 3000);
    } catch (err) {
      setError(err.message || '🐾 Reset link is invalid or expired.');
    } finally {
      setLoading(false);
    }
  };

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
            <div className="absolute w-44 h-44 bg-gradient-to-tr from-[#FCEAEF] to-[#FCEAEF]/40 rounded-full filter blur-sm"></div>
            <div className="relative w-36 h-36 bg-white rounded-[2.75rem] shadow-[0_20px_40px_-5px_rgba(231,126,149,0.25)] flex items-center justify-center border border-[#FCEAEF]/30">
              <img alt="Sniffr" className="w-22 h-22 object-contain" src="/logo.png" />
            </div>
          </div>
          <h1 className="text-4xl font-extrabold tracking-tight text-[#8E2E43] text-center">Sniffr</h1>
          <p className="text-on-surface-variant font-medium mt-1 text-center opacity-85 text-sm">Recover your account password</p>
        </header>

        <div className="bg-white rounded-[2.5rem] p-8 shadow-sm space-y-6">
          <div className="text-center mb-2">
            <h2 className="text-2xl font-black text-on-surface">Reset Password</h2>
            <p className="text-xs text-on-surface-variant/70 mt-1">Enter your new secure password below.</p>
          </div>

          {error && (
            <div className="bg-error-container/20 border border-error/20 text-error text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-shake whitespace-pre-line">
              <span className="material-symbols-outlined text-lg">error</span>
              {error}
            </div>
          )}

          {success && (
            <div className="bg-success-container/20 border border-success/20 text-success text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-pulse">
              <span className="material-symbols-outlined text-lg">check_circle</span>
              {success}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* New Password */}
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold uppercase tracking-widest text-on-surface-variant px-1">New Password</label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">lock</span>
                <input className={`w-full pl-12 pr-12 py-4 bg-surface-container-low/70 rounded-full focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 border-none transition-all ${fieldErrors.password?'ring-2 ring-error':''}`}
                  type={showPass?'text':'password'} placeholder="••••••••" value={password} onChange={e=>setPassword(e.target.value)}/>
                <button type="button" onClick={()=>setShowPass(!showPass)} className="absolute right-4 top-1/2 -translate-y-1/2 text-on-surface-variant/40">
                  <span className="material-symbols-outlined">{showPass?'visibility_off':'visibility'}</span>
                </button>
              </div>
              {fieldErrors.password && <p className="text-xs text-error font-bold px-1 whitespace-pre-line leading-relaxed">{fieldErrors.password}</p>}
            </div>

            {/* Confirm Password */}
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

            <button type="submit" disabled={loading}
              className="w-full py-4 rounded-full bg-gradient-to-r from-[#AE526D] to-[#E293A6] text-white font-bold text-lg active:scale-[0.98] transition-all disabled:opacity-60 flex items-center justify-center gap-2 shadow-md">
              {loading ? (
                <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"/>
              ) : (
                'Sniff Out New Password'
              )}
            </button>
          </form>
        </div>

        <footer className="mt-auto py-8 text-center space-y-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/40">© 2026 SNIFFRWEB.COM</p>
          <div className="flex justify-center gap-4 text-zinc-300/80">
            <span className="material-symbols-outlined text-[18px]">star</span>
            <span className="material-symbols-outlined text-[18px]">verified</span>
            <span className="material-symbols-outlined text-[18px]">shield</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
