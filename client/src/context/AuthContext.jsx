import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api, { setAccessToken, setOnAuthFailure, ensureFreshSession, getAccessToken } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser]             = useState(null);
  const [pet, setPet]               = useState(null);
  const [allPets, setAllPets]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [switchingPetName, setSwitchingPetName] = useState(null);
  const accessTokenRef              = useRef(null);

  const logout = useCallback(() => {
    const refreshToken = localStorage.getItem('sniffr_refresh_token');
    if (refreshToken) api.post('/auth/logout', { refreshToken }).catch(() => {});
    localStorage.removeItem('sniffr_refresh_token');
    localStorage.removeItem('sniffr_device_token');
    localStorage.removeItem('sniffr_cached_user');
    localStorage.removeItem('sniffr_cached_pet');
    localStorage.removeItem('sniffr_cached_allPets');
    setAccessToken(null);
    accessTokenRef.current = null;
    setUser(null);
    setPet(null);
    setAllPets([]);
  }, []);

  // ── Shared session-establishing helper ──────────────────────────
  // IMPORTANT: this is now the ONE place that fully applies a successful
  // auth response (tokens + user + pet + allPets + localStorage cache)
  // to React state. Every login path -- email/password, 2FA, Google,
  // social-complete -- MUST call this after getting a response
  // back from the server, instead of manually poking localStorage/
  // api.setAccessToken and skipping the setUser/setPet/setAllPets calls.
  //
  // The real bug this fixes: AuthPage.jsx's Google Sign-In handlers were
  // calling /auth/google directly and only storing tokens, WITHOUT ever
  // calling setUser/setPet/setAllPets. That meant `user` stayed null in
  // AuthContext after a client-side Google login, even though the tokens
  // themselves were valid -- until a full page reload re-ran this
  // provider's startup effect and populated state from scratch. Routing
  // every login path through this one helper closes that gap for good.
  const applySessionData = useCallback((data) => {
    if (!data) return;
    setAccessToken(data.accessToken);
    accessTokenRef.current = data.accessToken;
    if (data.refreshToken) {
      localStorage.setItem('sniffr_refresh_token', data.refreshToken);
    }
    setUser(data.user || null);
    setPet(data.pet || null);
    setAllPets(data.allPets || []);
    localStorage.setItem('sniffr_cached_user', JSON.stringify(data.user || null));
    localStorage.setItem('sniffr_cached_pet', JSON.stringify(data.pet || null));
    localStorage.setItem('sniffr_cached_allPets', JSON.stringify(data.allPets || []));
  }, []);

  useEffect(() => {
    // ── Cancellation guard ──────────────────────────────────────
    // Guards against a stale async result from an earlier mount (e.g.
    // React StrictMode's intentional double-mount in dev) overwriting
    // fresh state after a later logout/login cycle.
    let cancelled = false;

    setOnAuthFailure(logout);
    const refreshToken = localStorage.getItem('sniffr_refresh_token');
    if (refreshToken) {
      (async () => {
        try {
          // Goes through the SAME shared, deduplicated refresh mechanism
          // used by api.js's automatic 401-retry logic (ensureFreshSession),
          // instead of making an independent, uncoordinated /auth/refresh
          // call -- which previously could race with other in-flight
          // requests' own refresh attempts and get rejected (refresh
          // tokens are single-use/rotating server-side), silently logging
          // the user back out right after a fresh login.
          await ensureFreshSession();
          if (cancelled) return;
          accessTokenRef.current = getAccessToken();
          const me = await api.get('/auth/me');
          if (cancelled) return;
          setUser(me.user);
          setPet(me.pet);
          setAllPets(me.allPets || []);
          localStorage.setItem('sniffr_cached_user', JSON.stringify(me.user));
          localStorage.setItem('sniffr_cached_pet', JSON.stringify(me.pet));
          localStorage.setItem('sniffr_cached_allPets', JSON.stringify(me.allPets || []));
        } catch (err) {
          if (cancelled) return;
          if (err.isAuthError || err.status === 401 || err.status === 403 || err.message?.includes('Unauthorized') || err.message?.includes('Invalid') || err.message?.includes('expired')) {
            logout();
          } else {
            // Restore from cached session info on network failure so user stays logged in offline/restarts!
            try {
              const cachedUser = JSON.parse(localStorage.getItem('sniffr_cached_user'));
              const cachedPet = JSON.parse(localStorage.getItem('sniffr_cached_pet'));
              const cachedAllPets = JSON.parse(localStorage.getItem('sniffr_cached_allPets') || '[]');
              if (cachedUser) {
                setUser(cachedUser);
                setPet(cachedPet);
                setAllPets(cachedAllPets);
              }
            } catch (e) {
              console.error(e);
            }
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    } else {
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [logout]);

  // ─── Standard email/password login ───────────────────────────
  const login = async (email, password) => {
    const data = await api.post('/auth/login', { email, password });
    if (data && data.requires2FA) {
      return data;
    }
    applySessionData(data);
    return data;
  };

  // ─── Complete 2FA login ─────────────────────────────────────
  const verify2FALogin = async ({ tempToken, code, trustDevice }) => {
    const data = await api.post('/auth/2fa/verify-login', { tempToken, code, trustDevice });
    if (data && data.deviceToken) {
      localStorage.setItem('sniffr_device_token', data.deviceToken);
    }
    applySessionData(data);
    return data;
  };

  // ─── Standard email/password signup ──────────────────────────
  const signup = async ({ email, password, confirmPassword, username, full_name }) => {
  const data = await api.post('/auth/signup', { email, password, confirmPassword, username, full_name });
  applySessionData(data);
  if (data.verificationCooldownUntil) {
    sessionStorage.setItem(`sniffr_verify_cooldown_${data.user.id}`, String(data.verificationCooldownUntil));
  }
  return data;
};

  // ─── Social login (Google) via the internal /auth/social route ──
  const socialLogin = async ({ provider, credential, id_token, email, full_name }) => {
    const data = await api.post('/auth/social', { provider, credential, id_token, email, full_name });

    if (data.needsSignup) {
      return { needsSignup: true, prefill: data.prefill };
    }

    applySessionData(data);
    return { loggedIn: true, pet: data.pet };
  };

  // ─── Social complete ─────────────────────────────────────────
  const socialComplete = async ({ email, username, full_name, provider }) => {
    const data = await api.post('/auth/social-complete', { email, username, full_name, provider });
    applySessionData(data);
    return data;
  };

  // ─── Apply an already-fetched auth response (e.g. from Google's own
  //     /auth/google endpoint, called directly from AuthPage) ─────────
  const completeExternalLogin = useCallback((data) => {
    applySessionData(data);
  }, [applySessionData]);

  // ─── Refresh profile from server ─────────────────────────────
  const refreshProfile = useCallback(async () => {
    try {
      const me = await api.get('/auth/me');
      setUser(me.user);
      setPet(me.pet);
      setAllPets(me.allPets || []);
      return me;
    } catch { /* silent */ }
  }, []);

  // ─── Switch active pet profile ──────────────────────────────
  const switchPet = async (petId) => {
    const targetPet = allPets.find(p => p.id === parseInt(petId, 10)) || pet;
    const targetName = targetPet?.name || 'Playmate';
    setSwitchingPetName(targetName);

    try {
      const data = await api.post('/profile/switch-pet', { petId: parseInt(petId, 10) });
      if (data && data.pet) {
        setPet(data.pet);
        setAllPets(data.allPets || []);
      }
    } catch (err) {
      console.error('Error switching pet:', err);
    } finally {
      setTimeout(() => {
        setSwitchingPetName(null);
      }, 450);
    }
  };

  // ─── Update user locally (optimistic) ────────────────────────
  const updateUser = (partial) => {
    setUser(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem('sniffr_cached_user', JSON.stringify(updated));
      return updated;
    });
  };

  // ─── Update pet locally (optimistic) ─────────────────────────
  const updatePet = (petData) => {
    setPet(prev => ({ ...prev, ...petData }));
    setAllPets(prev => {
      const exists = prev.some(p => p.id === petData.id);
      if (exists) {
        return prev.map(p => p.id === petData.id ? { ...p, ...petData } : p);
      }
      return [...prev, petData];
    });
  };

  return (
    <AuthContext.Provider value={{
      user, pet, allPets, loading, switchingPetName,
      login, signup, logout, verify2FALogin,
      socialLogin, socialComplete, completeExternalLogin,
      updatePet, updateUser, refreshProfile, switchPet,
      isAuthenticated: !!user,
    }}>
      {children}

      {/* 400ms Paw-Print Switching Overlay Animation */}
      {switchingPetName && (
        <div className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center text-white animate-fade-in select-none">
          <div className="bg-white dark:bg-zinc-900 border border-outline-variant/10 rounded-[2.5rem] p-8 max-w-xs w-full shadow-2xl text-center space-y-4 animate-scale-up">
            <div className="w-16 h-16 rounded-full bg-primary/10 text-primary flex items-center justify-center mx-auto text-3xl animate-bounce">
              <span>🐾</span>
            </div>
            <div>
              <p className="font-extrabold text-sm text-on-surface">Switching to {switchingPetName}...</p>
              <p className="text-xs text-zinc-400 font-medium mt-1">Preparing profile and memories...</p>
            </div>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
