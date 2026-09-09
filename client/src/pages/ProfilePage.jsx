import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import api from '../services/api';
import { getCurrentGPSLocation, getStoredLocation, watchLiveLocation } from '../services/locationService';
import { getCapabilityStatus, requestSystemPermission } from '../services/permissionService';
import CreatePostModal from '../components/CreatePostModal';
import PawsitiveModal, { getPawsitiveLabel } from '../components/PawsitiveModal';
import SwitchPetModal from '../components/SwitchPetModal';
import SettingsPanel from '../components/SettingsPanel';
import GalleryViewerModal from '../components/GalleryViewerModal';
import PremiumBadge from '../components/PremiumBadge';
import usePullToRefresh from '../hooks/usePullToRefresh';
import Portal from '../components/Portal';
import PostVideo from '../components/PostVideo';
import { thumbnailUrl } from '../utils/media';

export function ChampionCrown({ className = "w-8 h-8" }) {
  return (
    <div className={`relative flex items-center justify-center champion-crown ${className}`}>
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full text-yellow-400">
        <path d="M2 17.5L4 7.5L9.5 12L12 4.5L14.5 12L20 7.5L22 17.5H2Z" fill="url(#goldGradient2)" stroke="#EAB308" strokeWidth="0.8" strokeLinejoin="round"/>
        <path d="M2 18.5H22V20H2V18.5Z" fill="url(#goldGradient2)" stroke="#CA8A04" strokeWidth="0.8"/>
        <circle cx="12" cy="14.2" r="1.4" fill="#CA8A04" />
        <circle cx="9.6" cy="12.2" r="0.7" fill="#CA8A04" />
        <circle cx="12" cy="11.4" r="0.7" fill="#CA8A04" />
        <circle cx="14.4" cy="12.2" r="0.7" fill="#CA8A04" />
        <defs>
          <linearGradient id="goldGradient2" x1="12" y1="4.5" x2="12" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFF280" />
            <stop offset="50%" stopColor="#F5C400" />
            <stop offset="100%" stopColor="#B38600" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
        <div className="champion-crown-shimmer-bar" />
      </div>
    </div>
  );
}

export default function ProfilePage() {
  const { user, pet: authPet, logout, refreshProfile } = useAuth();
  const { socket } = useSocket();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  
  const [pet, setPet] = useState(null);
  const [posts, setPosts] = useState([]);
  const [stats, setStats] = useState({ likes: 0, matches: 0, score: 50 });
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showPawsitive, setShowPawsitive] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showShareCard, setShowShareCard] = useState(false);
  const [showLocationInfoModal, setShowLocationInfoModal] = useState(false);
  const [showSwitchPetModal, setShowSwitchPetModal] = useState(false);
  const [showSettingsPanel, setShowSettingsPanel] = useState(false);
  const [settingsInitialModal, setSettingsInitialModal] = useState(null);
  const [selectedGalleryIndex, setSelectedGalleryIndex] = useState(0);
  const [showGalleryViewer, setShowGalleryViewer] = useState(false);
  const [toast, setToast] = useState(null);
  const [initialFocusField, setInitialFocusField] = useState(null);
  const [hoveredPost, setHoveredPost] = useState(null);
  const fileInputRef = useRef(null);

  // Live, in-session-only location detection (display next to the pin icon
  // only) -- declared this early, ahead of the loading-gated early return
  // below, so the effect that uses it stays a valid hook. Never written to
  // pet.location_text in the database; see the effect further down.
  const [liveLocationText, setLiveLocationText] = useState(null);
  const [detectingLocation, setDetectingLocation] = useState(false);
  const [locationError, setLocationError] = useState('');
  // Holds the "stop tracking" function returned by watchLiveLocation while a
  // watch is active, so it can be torn down on unmount / re-run instead of
  // leaking a geolocation watch every time this effect re-fires.
  const stopWatchRef = useRef(null);

  // Moved up from its old spot near the render return so the live-location
  // effect below (and any other hook) can read it -- hooks can't be
  // declared after the `if (loading) return` further down in this file.
  const isOwner = !id || (pet && authPet && (pet.id === authPet.id || pet.user_id === user?.id));

  useEffect(() => { if (user) loadProfile(); }, [user, authPet?.id, id]);

  // ── Profile View notification ───────────────────────────────
  // Fires once per page visit (not on every re-render/pull-to-refresh), and
  // only when viewing someone else's pet -- never on your own profile, at
  // /profile or /profile/:id. viewTrackedRef only resets when the :id param
  // itself changes, so a pull-to-refresh on the same profile (which re-runs
  // loadProfile and gives `pet` a new object identity) won't re-fire this.
  const viewTrackedRef = useRef(false);
  useEffect(() => {
    viewTrackedRef.current = false;
  }, [id]);

  useEffect(() => {
    if (!pet || !user || viewTrackedRef.current) return;
    if (pet.user_id === user.id) return; // never notify on self-views
    viewTrackedRef.current = true;
    api.post(`/profile/${pet.id}/view`).catch(err => console.error('Failed to record profile view:', err));
  }, [pet, user]);

  // ── Live location tracking (owner's own profile only) ─────────
  // Display-only "where you are right now" -- never written back to
  // pet.location_text (the API is never called from here). Only starts
  // silently on mount when permission was ALREADY granted in a past visit --
  // it never calls requestSystemPermission itself. Several browsers (notably
  // iOS Safari) silently ignore/timeout a geolocation prompt that wasn't
  // triggered by a direct user gesture (a click), which is exactly why this
  // used to fail to ever display: the request fired from this background
  // effect, with no click behind it. Requesting the actual permission now
  // only ever happens from handleDetectLiveLocation, wired to a button tap.
  // Once running, this keeps updating as the user physically moves (via
  // watchLiveLocation's watchPosition) -- no manual refresh needed.
  const startLiveLocationWatch = () => {
    stopWatchRef.current?.(); // never run two watches at once
    stopWatchRef.current = watchLiveLocation(
      (loc) => {
        const liveText = [loc.area, loc.city].filter(Boolean).join(', ');
        if (liveText) setLiveLocationText(liveText);
      },
      (err) => console.warn('Live location tracking unavailable:', err)
    );
  };

  useEffect(() => {
    if (!isOwner || !pet) return;
    let cancelled = false;

    (async () => {
      const status = await getCapabilityStatus('location');
      if (status !== 'granted' || cancelled) return;
      startLiveLocationWatch();
    })();

    return () => {
      cancelled = true;
      stopWatchRef.current?.();
      stopWatchRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, pet?.id]);

  // ── Explicit "set/refresh my location" action ───────────────────
  // Triggered directly by a button click (a real user gesture, required by
  // some browsers for geolocation prompts to fire at all) -- requests
  // permission if needed, reads an immediate GPS fix for instant feedback,
  // then starts continuous tracking so it keeps updating as the user moves
  // without needing another click. This is the ONLY thing "Set your
  // location" needs; it deliberately does not touch Edit Profile, since
  // that form's saved location is a separate, rarely-changed field for
  // matching, not this live "where are you right now" indicator.
  const handleDetectLiveLocation = async () => {
    setDetectingLocation(true);
    setLocationError('');
    try {
      const status = await requestSystemPermission('location');
      if (status !== 'granted') {
        setLocationError('Location permission was not granted. You can allow it in your browser/device settings and try again.');
        return;
      }
      const loc = await getCurrentGPSLocation();
      const liveText = [loc.area, loc.city].filter(Boolean).join(', ');
      if (liveText) {
        setLiveLocationText(liveText);
      } else {
        setLocationError("Couldn't determine your area from that location. Please try again.");
      }
      startLiveLocationWatch();
    } catch (err) {
      console.warn('Live location detection failed:', err);
      setLocationError('Could not access your location. Please try again.');
    } finally {
      setDetectingLocation(false);
    }
  };

  useEffect(() => {
    if (location.state) {
      const state = location.state;
      if (state.openSettings || state.openPawPrint2FA || state.openPremium) {
        setShowSettingsPanel(true);
        if (state.openPremium) {
          setSettingsInitialModal('upgrade-premium');
        } else if (state.openPawPrint2FA) {
          setSettingsInitialModal('pawprint-2fa');
        }
      }
      if (state.openGalleryUpload) {
        setShowCreate(true);
      }
      if (state.openPawsitive) {
        setShowPawsitive(true);
      }
      if (state.edit) {
        if (state.focusField === 'avatar') {
          setTimeout(() => fileInputRef.current?.click(), 100);
        } else {
          setShowEdit(true);
          setInitialFocusField(state.focusField || null);
        }
      }
      window.history.replaceState({}, document.title);
    }
  }, [location.state, pet]);

  const handleProfileSaved = async () => {
    await refreshProfile();
    loadProfile();
  };

  const loadProfile = async () => {
    try {
      const localMidnight = new Date();
      localMidnight.setHours(0, 0, 0, 0);
      const cycleStartStr = localMidnight.toISOString();

      const url = id ? `/profile/${id}` : '/profile';
      const res = await api.get(`${url}?cycleStart=${cycleStartStr}`);
      setPet(res.pet);
      // "Licks" = sum of likes across ALL posts (computed server-side in getProfileWithStats)
      const totalLikes = res.pet?.total_likes || 0;
      const matchCount = res.pet?.match_count || 0;
      const pawsitiveScore = res.pet?.pawsitive_score ?? 50;
      setStats({ likes: totalLikes, matches: matchCount, score: pawsitiveScore });
      setPosts(res.posts || []);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  // Real-time synchronization for Licks, Matches, and Gallery
  useEffect(() => {
    if (!socket || !pet) return;

    const handlePostLiked = (data) => {
      // Server payload is { post_id, liked, like_count }.
      setPosts(prev => {
        const postExists = prev.some(p => p.id === data.post_id);
        if (!postExists) return prev;
        const updated = prev.map(p => p.id === data.post_id ? { ...p, like_count: data.like_count } : p);
        const total = updated.reduce((sum, curr) => sum + (curr.like_count || 0), 0);
        setStats(s => ({ ...s, likes: total }));
        return updated;
      });
    };

    const handleNewPost = (data) => {
      if (data.post && (data.post.pet_id === pet.id || data.post.author_pet_id === pet.id)) {
        setPosts(prev => [data.post, ...prev.filter(p => p.id !== data.post.id)]);
      }
    };

    const handleMatchCreated = (data) => {
      if (data.pet1_id === pet.id || data.pet2_id === pet.id) {
        setStats(s => ({ ...s, matches: (s.matches || 0) + 1 }));
      }
    };

    const handlePostDeleted = ({ post_id }) => {
      setPosts(prev => {
        const postExists = prev.some(p => p.id === post_id);
        if (!postExists) return prev;
        const updated = prev.filter(p => p.id !== post_id);
        const total = updated.reduce((sum, curr) => sum + (curr.like_count || 0), 0);
        setStats(s => ({ ...s, likes: total }));
        return updated;
      });
    };

    // Covers the "viewing someone ELSE's profile while they edit it from
    // another device/tab" staleness case -- pet here IS the full displayed
    // profile object (not a denormalized subset like posts/conversations
    // elsewhere), so merging the updated pet row directly keeps every
    // rendered field (name, avatar, bio, breed, location_text, ...) in
    // sync. Stats fields like total_likes/is_champion aren't part of the
    // pet row PUT /profile returns, so this merge never clobbers them.
    const handleProfileUpdated = ({ pet_id, pet: updatedPet }) => {
      if (updatedPet && pet.id === pet_id) {
        setPet(prev => prev ? { ...prev, ...updatedPet } : prev);
      }
    };

    socket.on('post_liked', handlePostLiked);
    socket.on('post_unliked', handlePostLiked);
    socket.on('new_post', handleNewPost);
    socket.on('match_created', handleMatchCreated);
    socket.on('post_deleted', handlePostDeleted);
    socket.on('profile_updated', handleProfileUpdated);

    return () => {
      socket.off('post_liked', handlePostLiked);
      socket.off('post_unliked', handlePostLiked);
      socket.off('new_post', handleNewPost);
      socket.off('match_created', handleMatchCreated);
      socket.off('post_deleted', handlePostDeleted);
      socket.off('profile_updated', handleProfileUpdated);
    };
  }, [socket, pet]);

  const { pullDistance, refreshing, handlers, PawTrailIndicator } = usePullToRefresh(loadProfile);

  const handleAvatarUpdate = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('avatar', file);
    try {
      await api.put('/profile', fd);
      // Sync AuthContext.pet so HomePage completion bar updates
      await refreshProfile();
      loadProfile();
    } catch (err) {
      console.error(err);
      // Previously silent -- a rejected upload (quota exceeded, oversized
      // file, network error) showed the user literally nothing.
      setToast(err.message || "🐾 Couldn't update your photo. Try again.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      // Without this, re-selecting the SAME file after a failed attempt
      // doesn't fire onChange again (the input's value never changed from
      // the browser's perspective), so a naive retry silently no-ops.
      e.target.value = '';
    }
  };

  const handlePawsitiveSaved = async (newScore) => {
    setStats(s => ({ ...s, score: newScore }));
    setPet(p => p ? { ...p, pawsitive_score: newScore } : p);
    // Sync AuthContext so HomePage completion bar re-evaluates
    await refreshProfile();
  };

  const formatLikes = (n) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return n;
  };

  const pawsitiveInfo = getPawsitiveLabel(stats.score);

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="bg-surface text-on-surface min-h-screen pb-32 lg:pb-8" {...handlers}>
      <PawTrailIndicator />
      {/* Mobile Header */}
      <header className="lg:hidden fixed top-0 left-0 right-0 md:left-20 z-50 flex items-center justify-between px-6 py-4 glass rounded-b-[2.5rem] shadow-[0_10px_30px_-15px_rgba(0,0,0,0.05)]">
        <div className="flex items-center gap-3">
          {id ? (
            <button onClick={() => navigate(-1)} className="w-10 h-10 flex items-center justify-center bg-surface-container-low rounded-full active:scale-90 transition-transform">
              <span className="material-symbols-outlined text-on-surface">arrow_back</span>
            </button>
          ) : (
            <div className="w-10 h-10 bg-primary-container flex items-center justify-center rounded-full">
              <span className="material-symbols-outlined text-primary text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
          )}
          <h1 className="font-extrabold tracking-tighter text-2xl uppercase text-pink-400">
            {isOwner ? 'Sniffr' : pet?.name || 'Profile'}
          </h1>
        </div>

        {isOwner && (
          <button
            onClick={() => setShowSettingsPanel(true)}
            className="w-10 h-10 flex items-center justify-center bg-surface-container-low text-on-surface rounded-full active:scale-90 transition-transform shadow-2xs"
            aria-label="Open Settings"
          >
            <span className="material-symbols-outlined text-xl">settings</span>
          </button>
        )}
      </header>

      <main className="pt-24 lg:pt-8 px-4 lg:px-8">
        {/* Desktop page title */}
        <div className="hidden lg:block mb-8">
          {id && (
            <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-zinc-400 hover:text-primary transition-colors text-xs font-bold uppercase tracking-widest mb-3">
              <span className="material-symbols-outlined text-base">arrow_back</span> Back
            </button>
          )}
          <div className="flex justify-between items-center w-full">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">
                {isOwner ? 'My Profile' : `${pet?.name || 'Pet'}'s Profile`} <span className="gradient-text">🐾</span>
              </h1>
              <p className="text-on-surface-variant text-sm mt-1">
                {isOwner ? "Manage your pet's public presence" : `View details about ${pet?.name || 'this pet'}`}
              </p>
            </div>
            {isOwner && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowEdit(true)}
                  className="flex items-center gap-2 bg-gradient-to-br from-primary to-primary-fixed-dim text-white px-5 py-2.5 rounded-full font-bold shadow-md hover-lift transition-transform active:scale-95 text-xs"
                >
                  <span className="material-symbols-outlined text-sm">edit</span>
                  Edit Profile
                </button>
                <button
                  onClick={() => setShowSettingsPanel(true)}
                  className="w-10 h-10 flex items-center justify-center bg-surface-container-low hover:bg-surface-container-high text-on-surface rounded-full shadow-2xs transition-transform active:scale-90"
                  aria-label="Open Settings"
                  title="Settings"
                >
                  <span className="material-symbols-outlined text-lg">settings</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="lg:grid lg:grid-cols-[340px_1fr] lg:gap-10 max-w-5xl">
          {/* Left column: Profile card */}
          <div className="space-y-6">
            <section className="relative bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm rounded-3xl p-8 shadow-sm border border-outline-variant/10 hover-lift premium-card animate-slide-up">
              {/* Avatar */}
              <div className="flex flex-col items-center">
                <div className="relative mb-6">
                  <div className="absolute -inset-3 bg-gradient-to-tr from-primary/20 to-secondary/20 blur-2xl rounded-full animate-border-dance" />
                  <img
                    alt={pet?.name}
                    className="w-36 h-36 object-cover shadow-xl relative z-10 rounded-[40%]"
                    src={thumbnailUrl(pet?.avatar_url) || '/logo.png'}
                    loading="eager"
                    decoding="async"
                  />
                  {pet?.is_champion && (
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 z-20">
                      <ChampionCrown className="w-9 h-9 drop-shadow-[0_2px_8px_rgba(250,204,21,0.6)]" />
                    </div>
                  )}
                  {isOwner && (
                    <>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="absolute bottom-1 right-1 z-20 bg-primary text-white p-2.5 rounded-full shadow-lg active:scale-90 transition-transform hover:scale-110 animate-pulse-glow"
                      >
                        <span className="material-symbols-outlined text-sm">edit</span>
                      </button>
                      <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleAvatarUpdate} />
                    </>
                  )}
                </div>

                <h2 className="text-2xl font-bold tracking-tight text-on-surface text-center mb-1 flex items-center justify-center gap-1.5">
                  {pet?.name}{pet?.age ? `, ${pet.age}` : ''}
                  <PremiumBadge pet={pet} size="text-lg" />
                </h2>
                {pet?.is_champion && (
                  <div className="mb-2 flex items-center justify-center">
                    <span className="text-[8px] font-black uppercase tracking-widest bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full shadow-sm border border-yellow-200">
                      👑 Today's Champion
                    </span>
                  </div>
                )}
                {isOwner && (
                  <button 
                    onClick={() => setShowEdit(true)}
                    className="lg:hidden mb-4 flex items-center gap-1.5 bg-surface-container-high px-4 py-2 rounded-full text-xs font-bold text-on-surface-variant hover:bg-surface-container-highest transition-colors active:scale-95 shadow-sm"
                  >
                    <span className="material-symbols-outlined text-[14px]">edit</span> Edit Details
                  </button>
                )}
                <div className="mb-4">
                  <div className="flex items-center gap-2 text-primary font-medium">
                    <span className="material-symbols-outlined text-lg">location_on</span>
                    {/* Owner's own profile: live GPS-detected location (if
                        permission was granted) wins over the saved profile
                        location -- display-only, never written back to
                        pet.location_text. Falls back to the exact same chain
                        as before once liveLocationText isn't available. */}
                    {(isOwner && liveLocationText) || pet?.location_text ? (
                      <>
                        <span className="text-xs uppercase tracking-wider">{(isOwner && liveLocationText) || pet.location_text}</span>
                        {isOwner && (
                          <button
                            type="button"
                            onClick={() => {
                              // Already tracking live -- just force a fresh
                              // read. Otherwise this is the "declined /
                              // never granted" fallback (showing the saved
                              // location instead): changing their mind here
                              // must go through the exact same explanatory
                              // popup + permission flow as "Set your
                              // location" did the first time, not silently
                              // re-request permission behind their back.
                              if (liveLocationText) {
                                handleDetectLiveLocation();
                              } else {
                                setShowLocationInfoModal(true);
                              }
                            }}
                            disabled={detectingLocation}
                            title={liveLocationText ? 'Refresh my live location' : 'Set your live location'}
                            className="text-zinc-400 hover:text-primary transition-colors disabled:opacity-50"
                          >
                            <span className={`material-symbols-outlined text-sm ${detectingLocation ? 'animate-spin' : ''}`}>
                              {detectingLocation ? 'sync' : liveLocationText ? 'my_location' : 'location_on'}
                            </span>
                          </button>
                        )}
                      </>
                    ) : isOwner ? (
                      <button
                        type="button"
                        onClick={() => setShowLocationInfoModal(true)}
                        disabled={detectingLocation}
                        className="text-xs uppercase tracking-wider underline decoration-dotted hover:opacity-70 transition-opacity disabled:opacity-50"
                      >
                        {detectingLocation ? 'Locating...' : 'Set your location'}
                      </button>
                    ) : (
                      <span className="text-xs uppercase tracking-wider">Location not set</span>
                    )}
                  </div>
                  {isOwner && locationError && (
                    <p className="text-[10px] text-rose-500 font-medium mt-1 max-w-xs">{locationError}</p>
                  )}
                </div>
                {pet?.is_champion && (
                  <button
                    onClick={() => setShowShareCard(true)}
                    className="mb-6 flex items-center gap-2 bg-gradient-to-br from-yellow-400 via-amber-500 to-yellow-500 text-white px-5 py-2.5 rounded-full font-bold shadow-md hover-lift transition-transform active:scale-95 text-[10px] uppercase tracking-widest border-2 border-white/20"
                  >
                    <span className="material-symbols-outlined text-sm">share</span>
                    <span>Share Achievement</span>
                  </button>
                )}

                {/* Stats */}
                <div className="grid grid-cols-3 gap-3 w-full">
                  {/* Licks — total post likes */}
                  <div
                    className="bg-surface-container-low p-4 rounded-xl flex flex-col items-center text-center hover-lift animate-slide-up"
                    style={{ animationDelay: '0ms' }}
                    title={`${stats.likes} total likes across all posts`}
                  >
                    <span className="text-xl font-bold text-primary">{formatLikes(stats.likes)}</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Licks</span>
                  </div>

                  {/* Matches — mutual likes */}
                  <div
                    className="bg-primary-container p-4 rounded-xl flex flex-col items-center text-center hover-lift animate-slide-up"
                    style={{ animationDelay: '100ms' }}
                    title="Mutual matches (both pets liked each other)"
                  >
                    <span className="text-xl font-bold text-on-primary-container">{stats.matches}</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Matches</span>
                  </div>

                  {/* Pawsitive — clickable, opens modal */}
                  {isOwner ? (
                    <button
                      className="bg-tertiary-container p-4 rounded-xl flex flex-col items-center text-center hover-lift animate-slide-up active:scale-95 transition-all group relative overflow-hidden"
                      style={{ animationDelay: '200ms' }}
                      onClick={() => setShowPawsitive(true)}
                      title="Click to update your pet's social vibe"
                    >
                      {/* Subtle hover ring */}
                      <div className="absolute inset-0 bg-tertiary/10 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl" />
                      <span className="text-xl font-bold text-on-tertiary-container">{stats.score}%</span>
                      <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Pawsitive</span>
                      {/* Tiny edit hint */}
                      <span className="material-symbols-outlined text-[10px] text-on-tertiary-container/40 mt-0.5 group-hover:text-on-tertiary-container/70 transition-colors">edit</span>
                    </button>
                  ) : (
                    <div
                      className="bg-tertiary-container p-4 rounded-xl flex flex-col items-center text-center hover-lift animate-slide-up"
                      style={{ animationDelay: '200ms' }}
                    >
                      <span className="text-xl font-bold text-on-tertiary-container">{stats.score}%</span>
                      <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">Pawsitive</span>
                    </div>
                  )}
                </div>

                {/* Pawsitive level label */}
                <div className="mt-4 w-full flex items-center gap-2 bg-surface-container-low rounded-xl px-3 py-2">
                  <span className="text-lg">{pawsitiveInfo.emoji}</span>
                  <div>
                    <p className={`text-[11px] font-bold ${pawsitiveInfo.color}`}>{pawsitiveInfo.label}</p>
                    <p className="text-[9px] text-on-surface-variant/50 font-medium uppercase tracking-widest">Social Vibe</p>
                  </div>
                  {isOwner && (
                    <button
                      onClick={() => setShowPawsitive(true)}
                      className="ml-auto text-[10px] font-bold text-primary hover:opacity-70 transition-opacity uppercase tracking-wider"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Switch Pet Profile */}
            {isOwner && (
              <button
                onClick={() => setShowSwitchPetModal(true)}
                className="w-full py-4 bg-primary/10 text-primary hover:bg-primary/20 font-bold rounded-2xl active:scale-95 transition-all shadow-sm flex items-center justify-center gap-2 ripple-container"
              >
                <span>🐾</span> Switch Pet Profile
              </button>
            )}
          </div>

          {/* Right column: Gallery */}
          <section className="mt-8 lg:mt-0 animate-slide-in-right">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold">Gallery</h3>
              <span className="text-xs font-bold uppercase tracking-widest text-primary">{posts.length} Photos</span>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {posts.map((post, i) => (
                <div
                  key={post.id}
                  onClick={() => {
                    setSelectedGalleryIndex(i);
                    setShowGalleryViewer(true);
                  }}
                  className={`relative overflow-hidden rounded-2xl shadow-sm cursor-pointer hover-lift-lg group
                    ${i === 0 ? 'col-span-2 h-64 lg:h-72' : 'h-40 lg:h-44'}`}
                  onMouseEnter={() => setHoveredPost(post.id)}
                  onMouseLeave={() => setHoveredPost(null)}
                >
                  {post.media_type === 'video' ? (
                    <PostVideo
                      src={post.media_url}
                      controls={false}
                      fill
                      className="transition-transform duration-500 group-hover:scale-110"
                    />
                  ) : (
                    <img
                      className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                      src={thumbnailUrl(post.media_url)}
                      alt={post.caption || 'Gallery image'}
                      loading="lazy"
                      decoding="async"
                    />
                  )}
                  {/* Video badge -- gallery thumbnails never autoplay, this just
                      signals "this tile is a video" before the viewer opens it */}
                  {post.media_type === 'video' && (
                    <div className="absolute top-2 left-2 w-6 h-6 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center pointer-events-none">
                      <span className="material-symbols-outlined text-white text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>play_arrow</span>
                    </div>
                  )}
                  {/* Like count overlay */}
                  <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/40 backdrop-blur-sm rounded-full px-2 py-1">
                    <span className="material-symbols-outlined text-white text-[12px]" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                    <span className="text-[10px] font-bold text-white">{post.like_count || 0}</span>
                  </div>
                  {/* Hover overlay */}
                  <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity duration-300 ${hoveredPost === post.id ? 'opacity-100' : 'opacity-0'}`}>
                    <span className="material-symbols-outlined text-white text-4xl animate-scale-pop" style={{ fontVariationSettings: "'FILL' 1" }}>favorite</span>
                  </div>
                </div>
              ))}

              {/* Add button */}
              {isOwner && (
                <button
                  onClick={() => setShowCreate(true)}
                  className={`${posts.length === 0 ? 'col-span-2 h-40' : 'col-span-2 lg:col-span-1 h-40 lg:h-44'} p-6 border-2 border-dashed border-outline-variant/30 rounded-2xl flex flex-col items-center justify-center gap-2 hover:bg-primary-container/20 transition-all group hover-lift ripple-container`}
                >
                  <div className="w-12 h-12 bg-surface-container-high rounded-full flex items-center justify-center group-hover:scale-110 transition-transform">
                    <span className="material-symbols-outlined text-primary">add</span>
                  </div>
                  <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">Add memories</span>
                </button>
              )}
            </div>
          </section>
        </div>
      </main>

      {showCreate && <CreatePostModal onClose={() => setShowCreate(false)} onPostCreated={loadProfile} />}

      {showPawsitive && (
        <PawsitiveModal
          currentScore={stats.score}
          onClose={() => setShowPawsitive(false)}
          onSaved={handlePawsitiveSaved}
        />
      )}

      {showEdit && (
        <EditProfileModal
          pet={pet}
          initialFocusField={initialFocusField}
          onClose={() => { setShowEdit(false); setInitialFocusField(null); }}
          onSaved={handleProfileSaved}
        />
      )}

      {showShareCard && (
        <Portal>
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowShareCard(false)}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 max-w-sm w-full text-center shadow-2xl relative border border-outline-variant/10 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-2 border-b border-zinc-100 dark:border-zinc-800 mb-4">
              <h3 className="font-extrabold text-on-surface text-sm">👑 Share Achievement</h3>
              <button
                onClick={() => setShowShareCard(false)}
                className="w-8 h-8 rounded-full bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-colors"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {/* 9:16 Share Card Optimized for Instagram Stories */}
            <div className="relative aspect-[9/16] w-full rounded-[2rem] bg-gradient-to-tr from-primary/35 via-rose-100/40 to-secondary/35 border-4 border-yellow-300 p-6 flex flex-col justify-between items-center shadow-inner overflow-hidden text-left select-none">
              <div className="absolute -top-12 -left-12 w-48 h-48 bg-primary/10 rounded-full blur-2xl pointer-events-none" />
              <div className="absolute -bottom-12 -right-12 w-48 h-48 bg-secondary/10 rounded-full blur-2xl pointer-events-none" />

              <div className="w-full flex flex-col items-center pt-8 text-center space-y-4">
                <ChampionCrown className="w-14 h-14 drop-shadow-[0_4px_10px_rgba(250,204,21,0.6)]" />
                <div className="space-y-1">
                  <p className="text-[10px] font-black text-yellow-800 uppercase tracking-[0.2em] leading-none">Today's</p>
                  <p className="text-sm font-black text-rose-800 uppercase tracking-widest leading-tight">
                    {pet?.champion_area ? `${pet.champion_area.toUpperCase()} SPOTLIGHT` : 'LOCAL SPOTLIGHT'}
                  </p>
                  <p className="text-lg font-black text-rose-500 uppercase tracking-[0.1em] leading-none">Champion</p>
                </div>
              </div>

              {/* Centered Pet Info */}
              <div className="flex flex-col items-center space-y-3 z-10">
                <img
                  src={thumbnailUrl(pet?.avatar_url) || '/logo.png'}
                  alt={pet?.name}
                  loading="eager"
                  decoding="async"
                  className="w-28 h-28 object-cover rounded-[2rem] border-4 border-white shadow-xl"
                />
                <h4 className="text-xl font-black text-zinc-800 uppercase tracking-wide">
                  {pet?.type === 'cat' ? '🐱' : '🐶'} {pet?.name}
                </h4>
              </div>

              {/* Bottom Date & Branding */}
              <div className="w-full flex flex-col items-center pb-8 text-center space-y-2">
                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                  {new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}
                </p>
                <div className="h-0.5 w-12 bg-zinc-200" />
                <p className="text-[9px] font-black text-primary uppercase tracking-[0.15em] leading-none">Powered by Sniffr</p>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowShareCard(false)}
                className="flex-1 py-3 bg-zinc-100 hover:bg-zinc-200 text-on-surface text-xs font-bold rounded-full transition-colors text-center"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setShowShareCard(false);
                  setToast("🐾 Share card saved to gallery!");
                  setTimeout(() => setToast(null), 3000);
                }}
                className="flex-1 py-3 bg-gradient-to-r from-primary to-primary-fixed-dim text-white text-xs font-bold rounded-full shadow-lg active:scale-95 transition-transform"
              >
                Download Card
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {showLocationInfoModal && (
        <Portal>
        <div
          className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in"
          onClick={() => setShowLocationInfoModal(false)}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 max-w-sm w-full shadow-2xl relative border border-outline-variant/10 text-center animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/10 flex items-center justify-center animate-pulse-glow">
              <span className="material-symbols-outlined text-primary text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>location_on</span>
            </div>
            <h3 className="font-extrabold text-lg text-on-surface mb-2">🐾 Find Friends Nearby</h3>
            <p className="text-sm text-on-surface-variant leading-relaxed mb-6">
              Setting your location helps Sniffr connect you with furry friends whenever they're nearby — so Meet, Spotlight, and PawCircles can all show you playmates close to home.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLocationInfoModal(false)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-on-surface text-xs font-bold rounded-full transition-colors"
              >
                Not Now
              </button>
              <button
                onClick={() => {
                  setShowLocationInfoModal(false);
                  handleDetectLiveLocation();
                }}
                className="flex-1 py-3 bg-gradient-to-r from-primary to-primary-fixed-dim text-white text-xs font-bold rounded-full shadow-lg active:scale-95 transition-transform"
              >
                Allow Location Access
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {toast && (
        <Portal>
        <div className="fixed top-24 left-1/2 -translate-x-1/2 z-[250] bg-white shadow-2xl rounded-[2rem] px-6 py-4 border border-primary/10 animate-fade-in">
          <p className="text-xs font-bold text-on-surface leading-snug">{toast}</p>
        </div>
        </Portal>
      )}

      <div className="fixed bottom-32 lg:bottom-8 -left-8 opacity-[0.03] text-primary rotate-12 pointer-events-none">
        <span className="material-symbols-outlined text-[12rem]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
      </div>

      <SwitchPetModal
        isOpen={showSwitchPetModal}
        onClose={() => setShowSwitchPetModal(false)}
      />

      {showGalleryViewer && (
        <GalleryViewerModal
          posts={posts}
          initialIndex={selectedGalleryIndex}
          petName={pet?.name || 'Pet'}
          isOwner={isOwner}
          onClose={() => setShowGalleryViewer(false)}
          onPostLiked={(postId, isLiked, likeCount) => {
            setPosts(prev => {
              const updated = prev.map(p => p.id === postId ? { ...p, is_liked: isLiked ? 1 : 0, like_count: likeCount } : p);
              const total = updated.reduce((acc, curr) => acc + (curr.like_count || 0), 0);
              setStats(s => ({ ...s, likes: total }));
              return updated;
            });
          }}
          onPostDeleted={(postId) => {
            setPosts(prev => {
              const updated = prev.filter(p => p.id !== postId);
              const total = updated.reduce((acc, curr) => acc + (curr.like_count || 0), 0);
              setStats(s => ({ ...s, likes: total }));
              return updated;
            });
          }}
          onPostUpdated={(postId, caption) => {
            setPosts(prev => prev.map(p => p.id === postId ? { ...p, caption } : p));
          }}
        />
      )}

      <SettingsPanel
        isOpen={showSettingsPanel}
        initialModal={settingsInitialModal}
        onClose={() => {
          setShowSettingsPanel(false);
          setSettingsInitialModal(null);
        }}
        onOpenSwitchPet={() => setShowSwitchPetModal(true)}
      />
    </div>
  );
}

function EditProfileModal({ pet, initialFocusField, onClose, onSaved }) {
  const storedLoc = getStoredLocation();

  const initialCountry = pet?.country || storedLoc?.country || '';
  const initialState = pet?.state || storedLoc?.state || '';
  const initialCity = pet?.city || storedLoc?.city || '';
  const initialArea = pet?.area || storedLoc?.area || '';
  const initialLat = pet?.latitude || storedLoc?.latitude || '';
  const initialLng = pet?.longitude || storedLoc?.longitude || '';

  const hasLocation = Boolean(initialCountry || initialCity || (initialLat && initialLng));

  const [form, setForm] = useState({
    name: pet?.name || '',
    pet_username: pet?.pet_username?.replace('@', '') || '',
    gender: pet?.gender || 'male',
    age: pet?.age || '',
    breed_type: pet?.breed_type || 'Original',
    breed_name: pet?.breed_name || '',
    vaccinated: pet?.vaccinated === 1 || pet?.vaccinated === true,
    bio: pet?.bio || '',
    country: initialCountry,
    state: initialState,
    city: initialCity,
    area: initialArea,
    latitude: initialLat,
    longitude: initialLng
  });
  const [loading, setLoading] = useState(false);
  const [gpsStatus, setGpsStatus] = useState(hasLocation ? 'success' : '');
  const [errorMessage, setErrorMessage] = useState('');

  // Input refs for checklist autofocus and smooth scrolling
  const nameRef = useRef();
  const usernameRef = useRef();
  const ageRef = useRef();
  const breedNameRef = useRef();
  const bioRef = useRef();
  const countryRef = useRef();
  const stateRef = useRef();
  const cityRef = useRef();
  const areaRef = useRef();
  const gpsRef = useRef();
  const vaccinatedRef = useRef();

  useEffect(() => {
    if (initialFocusField) {
      const refs = {
        name: nameRef,
        pet_username: usernameRef,
        age: ageRef,
        breed_name: breedNameRef,
        bio: bioRef,
        country: countryRef,
        state: stateRef,
        city: cityRef,
        area: areaRef,
        location: gpsRef,
        vaccinated: vaccinatedRef
      };
      const ref = refs[initialFocusField];
      if (ref && ref.current) {
        setTimeout(() => {
          ref.current.focus();
          ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      }
    }
  }, [initialFocusField]);

  const update = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const [gpsMessage, setGpsMessage] = useState('');

  const handleGPS = async () => {
    setGpsStatus('loading');
    setGpsMessage('');
    setErrorMessage('');
    try {
      const loc = await getCurrentGPSLocation();
      setForm(prev => ({
        ...prev,
        latitude: loc.latitude,
        longitude: loc.longitude,
        country: loc.country || prev.country,
        state: loc.state || prev.state,
        city: loc.city || prev.city,
        area: loc.area || prev.area
      }));
      setGpsStatus('success');
      setGpsMessage('Location retrieved and filled successfully! 📍');
    } catch (err) {
      console.error(err);
      setGpsStatus('denied');
      setGpsMessage('Location permission is required for nearby features. You can grant permission in your browser or device settings.');
    }
  };

  const isLocationValid = (form.latitude && form.longitude) || (form.country.trim() && form.state.trim() && form.city.trim() && form.area.trim());

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isLocationValid) {
      setErrorMessage("Please provide your location (GPS or Manual) to continue.");
      return;
    }
    setLoading(true);
    setErrorMessage('');
    try {
      const payload = {
        ...form,
        pet_username: form.pet_username ? `@${form.pet_username.replace('@', '')}` : '',
        vaccinated: form.vaccinated ? 'true' : 'false'
      };
      await api.put('/profile', payload);

      // Permanently save location to localStorage for offline/app consistency
      try {
        const savedLoc = {
          latitude: form.latitude ? parseFloat(form.latitude) : null,
          longitude: form.longitude ? parseFloat(form.longitude) : null,
          country: form.country || '',
          state: form.state || '',
          city: form.city || '',
          area: form.area || '',
          timestamp: Date.now()
        };
        localStorage.setItem('sniffr_user_gps_location', JSON.stringify(savedLoc));
      } catch (e) {
        /* ignore storage errors */
      }

      onSaved();
      onClose();
    } catch (err) {
      setErrorMessage(err.message || 'Failed to update profile.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Portal>
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto selection:bg-primary-container selection:text-on-primary-container" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white p-6 sm:p-8 rounded-[2.5rem] max-w-md w-full shadow-2xl relative overflow-y-auto max-h-[90vh] border border-outline-variant/10 animate-scale-up">
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2 text-[#8E2E43]">
            <span className="material-symbols-outlined text-2xl">edit_square</span>
            <h2 className="text-xl font-extrabold tracking-tight text-on-surface">Edit Profile</h2>
          </div>
          <button className="w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high transition-colors active:scale-90" onClick={onClose}>
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {errorMessage && (
          <div className="bg-error-container/20 border border-error/20 text-error text-[11px] font-bold p-4 rounded-2xl flex items-center gap-3 animate-shake mb-6">
            <span className="material-symbols-outlined text-lg">error</span>
            {errorMessage}
          </div>
        )}

        <form className="space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-4">
            <div className="group">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Pet Name</label>
              <input 
                ref={nameRef}
                className="w-full bg-surface-container-low border-none rounded-full px-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 transition-all text-sm"
                placeholder="e.g. Marshmallow" 
                type="text"
                value={form.name}
                onChange={(e) => update('name', e.target.value)}
                required
              />
            </div>
            <div className="group">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Pet Username</label>
              <div className="relative">
                <span className="absolute left-6 top-1/2 -translate-y-1/2 text-primary font-bold">@</span>
                <input 
                  ref={usernameRef}
                  className="w-full bg-surface-container-low border-none rounded-full pl-10 pr-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 transition-all text-sm"
                  placeholder="handle" 
                  type="text"
                  value={form.pet_username}
                  onChange={(e) => update('pet_username', e.target.value)}
                  required
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-3 ml-4">Gender</label>
            <div className="flex gap-4">
              <label className="flex-1 cursor-pointer">
                <input className="hidden peer" name="gender" type="radio" checked={form.gender === 'male'} onChange={() => update('gender', 'male')} />
                <div className="bg-surface-container-low peer-checked:bg-primary/20 peer-checked:text-primary text-stone-500 font-bold py-3 rounded-full text-center transition-all flex items-center justify-center gap-2 text-xs">
                  <span className="material-symbols-outlined text-base">male</span> Male
                </div>
              </label>
              <label className="flex-1 cursor-pointer">
                <input className="hidden peer" name="gender" type="radio" checked={form.gender === 'female'} onChange={() => update('gender', 'female')} />
                <div className="bg-surface-container-low peer-checked:bg-primary/20 peer-checked:text-primary text-stone-500 font-bold py-3 rounded-full text-center transition-all flex items-center justify-center gap-2 text-xs">
                  <span className="material-symbols-outlined text-base">female</span> Female
                </div>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-1">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Age</label>
              <input 
                ref={ageRef}
                className="w-full bg-surface-container-low border-none rounded-full px-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 transition-all text-sm"
                placeholder="Years" 
                type="number"
                value={form.age}
                onChange={(e) => update('age', e.target.value)}
              />
            </div>
            <div className="col-span-1">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Breed Type</label>
              <div className="relative">
                <select 
                  className="w-full appearance-none bg-surface-container-low border-none rounded-full px-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface text-sm"
                  value={form.breed_type}
                  onChange={(e) => update('breed_type', e.target.value)}
                >
                  <option>Original</option>
                  <option>Cross</option>
                </select>
                <span className="material-symbols-outlined absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-stone-400">expand_more</span>
              </div>
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Breed Name</label>
              <input 
                ref={breedNameRef}
                className="w-full bg-surface-container-low border-none rounded-full px-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 transition-all text-sm"
                placeholder="e.g. Golden Retriever" 
                type="text"
                value={form.breed_name}
                onChange={(e) => update('breed_name', e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant mb-2 ml-4">Bio</label>
            <textarea 
              ref={bioRef}
              className="w-full bg-surface-container-low border-none rounded-2xl px-6 py-4 focus:ring-2 focus:ring-primary/20 text-on-surface placeholder:text-on-surface-variant/40 transition-all text-sm resize-none"
              rows={3}
              value={form.bio}
              onChange={(e) => update('bio', e.target.value)}
            />
          </div>

          <div className="space-y-4">
            <label className="block text-[10px] font-bold uppercase tracking-[0.05em] text-on-surface-variant ml-4">Location (Required)</label>
            <button 
              ref={gpsRef}
              type="button"
              onClick={handleGPS}
              className={`w-full py-3.5 rounded-full font-bold text-xs flex items-center justify-center gap-2 transition-all uppercase tracking-wider active:scale-95 ${gpsStatus === 'success' ? 'bg-[#8E2E43] text-white shadow-md' : 'bg-surface-container-low text-on-surface hover:bg-primary/10'}`}
            >
              <span className="material-symbols-outlined text-base">{gpsStatus === 'success' ? 'check_circle' : 'my_location'}</span>
              {gpsStatus === 'loading' ? 'Locating & Reverse Geocoding...' : gpsStatus === 'success' ? 'GPS Location Acquired' : 'Use Current GPS Location'}
            </button>

            {gpsMessage && (
              <div className={`p-3.5 rounded-2xl text-[11px] font-bold flex items-center gap-2.5 ${gpsStatus === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 border border-emerald-200/50' : 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 border border-amber-200/50'}`}>
                <span className="material-symbols-outlined text-base flex-shrink-0">{gpsStatus === 'success' ? 'verified' : 'location_disabled'}</span>
                <span>{gpsMessage}</span>
              </div>
            )}

            <div className="bg-surface-container-low p-5 rounded-3xl space-y-4 border border-outline-variant/10">
              <p className="text-[9px] font-bold text-on-surface-variant/60 text-center uppercase tracking-widest mb-2">Or enter manually</p>
              <div className="grid grid-cols-2 gap-3">
                <input ref={countryRef} className="w-full bg-white border-none rounded-full px-4 py-3 text-xs focus:ring-2 focus:ring-primary/20 font-bold text-on-surface" placeholder="Country" value={form.country} onChange={e => update('country', e.target.value)} />
                <input ref={stateRef} className="w-full bg-white border-none rounded-full px-4 py-3 text-xs focus:ring-2 focus:ring-primary/20 font-bold text-on-surface" placeholder="State" value={form.state} onChange={e => update('state', e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <input ref={cityRef} className="w-full bg-white border-none rounded-full px-4 py-3 text-xs focus:ring-2 focus:ring-primary/20 font-bold text-on-surface" placeholder="City" value={form.city} onChange={e => update('city', e.target.value)} />
                <input ref={areaRef} className="w-full bg-white border-none rounded-full px-4 py-3 text-xs focus:ring-2 focus:ring-primary/20 font-bold text-on-surface" placeholder="Area" value={form.area} onChange={e => update('area', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between bg-surface-container-low p-4 rounded-3xl">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-xl">vaccines</span>
              <div>
                <p className="font-bold text-xs">Vaccinated</p>
                <p className="text-[8px] uppercase font-bold tracking-wider text-on-surface-variant/50">Health Record Verified</p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input ref={vaccinatedRef} className="sr-only peer" type="checkbox" checked={form.vaccinated} onChange={(e) => update('vaccinated', e.target.checked)} />
              <div className="w-11 h-6 bg-surface-container-high peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
            </label>
          </div>

          <button 
            type="submit" 
            disabled={loading}
            className="w-full py-4 rounded-full bg-gradient-to-r from-[#AE526D] to-[#E293A6] text-white font-bold text-sm uppercase tracking-wider transition-all shadow-md active:scale-95 disabled:opacity-60 flex items-center justify-center gap-2"
          >
            {loading ? (
              <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"/>
            ) : (
              'Save Changes 🐾'
            )}
          </button>
        </form>
      </div>
    </div>
    </Portal>
  );
}
