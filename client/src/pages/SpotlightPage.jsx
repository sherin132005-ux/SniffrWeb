import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import { getSocket } from '../services/socket';
import usePullToRefresh from '../hooks/usePullToRefresh';

import { useAuth } from '../context/AuthContext';
import PremiumBadge from '../components/PremiumBadge';
import Portal from '../components/Portal';
import { avatarUrl, thumbnailUrl } from '../utils/media';

const areas = ['locality', 'city', 'country', 'region'];
const areaLabels = { locality: 'Locality', city: 'City', country: 'Country', region: 'Region' };
const areaIcons  = { locality: 'near_me', city: 'location_city', country: 'public', region: 'explore' };

const areaDescriptions = {
  locality: 'Top pets within 50 km',
  city: 'Top pets in your city',
  country: 'Top pets in your country',
  region: 'Top pets in your region'
};

const areaContextTitles = {
  locality: '📍 Local Spotlight',
  city: '🏙 City Spotlight',
  country: '🇮🇳 Country Spotlight',
  region: '🗺 Regional Spotlight'
};

// Premium Animated Golden Paw Crown Component
export function ChampionCrown({ className = "w-8 h-8" }) {
  return (
    <div className={`relative flex items-center justify-center champion-crown ${className}`}>
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full text-yellow-400">
        {/* Crown peaks */}
        <path d="M2 17.5L4 7.5L9.5 12L12 4.5L14.5 12L20 7.5L22 17.5H2Z" fill="url(#goldGradient)" stroke="#EAB308" strokeWidth="0.8" strokeLinejoin="round"/>
        {/* Base border */}
        <path d="M2 18.5H22V20H2V18.5Z" fill="url(#goldGradient)" stroke="#CA8A04" strokeWidth="0.8"/>
        {/* Paw print details */}
        <circle cx="12" cy="14.2" r="1.4" fill="#CA8A04" />
        <circle cx="9.6" cy="12.2" r="0.7" fill="#CA8A04" />
        <circle cx="12" cy="11.4" r="0.7" fill="#CA8A04" />
        <circle cx="14.4" cy="12.2" r="0.7" fill="#CA8A04" />
        
        <defs>
          <linearGradient id="goldGradient" x1="12" y1="4.5" x2="12" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFF280" />
            <stop offset="50%" stopColor="#F5C400" />
            <stop offset="100%" stopColor="#B38600" />
          </linearGradient>
        </defs>
      </svg>
      {/* Dynamic shimmer sheens */}
      <div className="absolute inset-0 overflow-hidden rounded-full pointer-events-none">
        <div className="champion-crown-shimmer-bar" />
      </div>
    </div>
  );
}

export default function SpotlightPage() {
  const navigate = useNavigate();

  const { pet } = useAuth();

const [area, setArea] = useState('city');
const [data, setData] = useState({ top3: [], risingStars: [], nextResetTime: '' });
const [loading, setLoading] = useState(true);

// Honest fallback chain: prefer live GPS (set by the geolocation effect
// below); until that resolves, seed from the pet's own saved profile
// location if one exists (real data, not a guess); if neither is
// available, loc stays null and the UI shows an explicit "set your
// location" state instead of silently substituting a fake coordinate.
const [loc, setLoc] = useState(() => {
  if (pet?.latitude && pet?.longitude) {
    return {
      lat: pet.latitude,
      lng: pet.longitude
    };
  }
  return null;
});
const locRef = useRef(loc);
useEffect(() => { locRef.current = loc; }, [loc]);

const [myPetId, setMyPetId] = useState(null);

  // States for Countdown, Hall of Fame, and History Overlay
  const [countdownText, setCountdownText] = useState('');
  const [hallOfFamePet, setHallOfFamePet] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [historyList, setHistoryList] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  

  const [showAll, setShowAll] = useState(false);
  const prevRanksRef = useRef({});

  // Query user's own pet ID when active pet changes
  useEffect(() => {
    const fetchMyProfile = async () => {
      try {
        const res = await api.get('/profile');
        if (res && res.pet) {
          setMyPetId(res.pet.id);
        }
      } catch (err) {
        console.error('Failed to query user pet ID:', err);
      }
    };
    fetchMyProfile();
  }, [pet?.id]);

  // Pet data loads asynchronously via AuthContext -- if it wasn't ready yet
  // when this page first mounted (so the lazy useState initializer above had
  // nothing to seed from) and GPS hasn't resolved either, adopt the pet's
  // saved location (still real data) as soon as it becomes available.
  useEffect(() => {
    if (loc) return;
    if (pet?.latitude && pet?.longitude) {
      setLoc({ lat: pet.latitude, lng: pet.longitude });
    }
  }, [pet?.latitude, pet?.longitude, loc]);

  const loadTop = async () => {
    // No GPS, no saved pet location -- nothing honest to query with. Leave
    // the previous/empty data alone rather than silently falling back to a
    // hardcoded coordinate; the render logic below shows an explicit "set
    // your location" state whenever loc is null.
    if (!loc) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const localMidnight = new Date();
      localMidnight.setHours(0, 0, 0, 0);
      const cycleStartStr = localMidnight.toISOString();

      const result = await api.get(`/spotlight?area=${area}&lat=${loc.lat}&lng=${loc.lng}&cycleStart=${cycleStartStr}`);
      setData(result);

    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const { pullDistance, refreshing, handlers, PawTrailIndicator } = usePullToRefresh(loadTop);

  useEffect(() => {
    if (!navigator.geolocation) {
      if (!locRef.current) setLoading(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      p => setLoc({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => {
        // GPS denied/unavailable -- if we still have no location at all
        // (no saved pet location either) by the time this fires, stop the
        // skeleton and let the explicit "set your location" state render
        // instead of spinning forever. locRef (not loc) so this stays
        // correct even if the pet-profile fallback above resolved after
        // this effect's closure was created.
        if (!locRef.current) setLoading(false);
      },
      { timeout: 5000 }
    );
  }, []);

  useEffect(() => {
    loadTop();
  }, [area, loc?.lat, loc?.lng]);

  // Realtime Countdown Timer to Local Midnight (00:00 AM)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const nextLocalMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1, // tomorrow
        0, 0, 0, 0 // 00:00:00 AM
      );
      const remainingMs = nextLocalMidnight.getTime() - now.getTime();
      if (remainingMs <= 0) {
        setCountdownText('00h 00m');
        loadTop();
      } else {
        const hours = Math.floor(remainingMs / (1000 * 60 * 60));
        const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
        const hoursStr = String(hours).padStart(2, '0');
        const minutesStr = String(minutes).padStart(2, '0');
        setCountdownText(`${hoursStr}h ${minutesStr}m`);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Listen for socket updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = () => {
      loadTop();
    };

    // The leaderboard (top3/ranks4To10/ranks11To20/risingStars) is cached
    // in `data` between loadTop() calls, not always fetched fresh -- so a
    // pet already showing here that edits their name/avatar elsewhere
    // stays stale until the next area change/midnight refresh/pull unless
    // patched directly.
    const onProfileUpdated = ({ pet_id, pet: updatedPet }) => {
      if (!updatedPet) return;
      const patchEntry = (p) => (p.id === pet_id ? {
        ...p,
        name: updatedPet.name,
        avatar_url: updatedPet.avatar_url,
        pet_username: updatedPet.pet_username,
        breed_name: updatedPet.breed_name,
        is_premium: updatedPet.is_premium,
      } : p);
      setData(prev => ({
        ...prev,
        top3: (prev.top3 || []).map(patchEntry),
        ranks4To10: (prev.ranks4To10 || []).map(patchEntry),
        ranks11To20: (prev.ranks11To20 || []).map(patchEntry),
        risingStars: (prev.risingStars || []).map(patchEntry),
      }));
    };

    socket.on('spotlight_updated', handler);
    socket.on('profile_updated', onProfileUpdated);
    return () => {
      socket.off('spotlight_updated', handler);
      socket.off('profile_updated', onProfileUpdated);
    };
  }, [area, loc?.lat, loc?.lng]);

  // Retrieve Spotlight History records
  const loadHistory = async () => {
    setLoadingHistory(true);
    setShowHistory(true);
    try {
      const res = await api.get(`/spotlight/history?area=${area}`);
      setHistoryList(res.history || []);
    } catch (err) {
      console.error('Failed to load spotlight history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  // Cinematic Entrance Animation handler
  const handleChampionClick = (pet) => {
    setHallOfFamePet(pet);
    // Wait 2.2 seconds before navigating
    setTimeout(() => {
      setHallOfFamePet(null);
      navigate(`/profile/${pet.id}`);
    }, 2200);
  };

  return (
    <div className="bg-surface text-on-surface min-h-screen pb-32 lg:pb-8" {...handlers}>
      <PawTrailIndicator />

    
      {/* Mobile header */}
      <header className="lg:hidden bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] fixed top-0 left-0 right-0 md:left-20 z-50">
        <div className="flex justify-between items-center px-6 py-4">
          <button
            onClick={loadHistory}
            className="p-1 text-zinc-400 hover:text-zinc-600 flex items-center justify-center"
          >
            <span className="material-symbols-outlined text-lg">history</span>
          </button>
          <span className="font-extrabold tracking-widest text-xl uppercase text-pink-500 dark:text-pink-300">Spotlight</span>
          <div className="w-7 h-7" /> {/* spacer */}
        </div>
      </header>

      <main className="pt-24 lg:pt-8 px-4 lg:px-8">
        {/* Title area */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="text-left">
            <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Spotlight <span className="gradient-text">⭐</span></h1>
            {/* Dynamic Spotlight Context */}
            <p className="text-xs font-black text-primary mt-1 flex items-center gap-1.5">
              <span>{areaContextTitles[area]}</span>
              <span className="text-zinc-300">•</span>
              <span className="text-zinc-400 font-medium">{areaDescriptions[area]}</span>
            </p>
            {/* Countdown Timer */}
            {countdownText && (
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mt-1.5 flex items-center gap-1">
                <span className="material-symbols-outlined text-xs">schedule</span>
                <span>Refreshes in {countdownText}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={loadHistory}
              className="hidden lg:flex items-center gap-1.5 px-4 py-2 bg-zinc-50 hover:bg-zinc-100 border border-zinc-200/50 rounded-full font-bold text-[10px] uppercase tracking-widest transition-colors text-zinc-500"
            >
              <span className="material-symbols-outlined text-[13px]">history</span>
              <span>History</span>
            </button>
            <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 animate-pulse flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-ping" />
              <span>Live Rankings</span>
            </span>
          </div>
        </div>

        {/* Area filter */}
        <div className="mb-10">
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {areas.map((a, i) => (
              <button
                key={a}
                onClick={() => setArea(a)}
                className={`flex items-center gap-2 px-6 py-3 rounded-full font-bold text-[10px] uppercase tracking-widest transition-all whitespace-nowrap ripple-container animate-slide-up
                  ${area === a
                    ? 'bg-primary text-white shadow-lg shadow-primary/30 scale-105 animate-pulse-glow'
                    : 'bg-surface-container-low text-zinc-400 hover:bg-surface-container-high hover:text-zinc-600'
                  }`}
                style={{ animationDelay: `${i * 80}ms` }}
              >
                <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: area === a ? "'FILL' 1" : "'FILL' 0" }}>
                  {areaIcons[a]}
                </span>
                {areaLabels[a]}
              </button>
            ))}
          </div>
        </div>

        {(!loc || data?.error === 'NO_LOCATION') ? (
          /* Explicit "no location" state -- never silently substitute a fake
             coordinate. Shown when GPS hasn't resolved (or was denied) AND
             the pet's own profile has no saved location either. */
          <div className="text-center py-20 animate-scale-pop max-w-sm mx-auto">
            <span className="material-symbols-outlined text-6xl text-zinc-200 mb-4" style={{ fontVariationSettings: "'FILL' 1" }}>location_off</span>
            <h3 className="font-extrabold text-lg text-zinc-500 mb-1">📍 Set your location to see Spotlight</h3>
            <p className="text-xs text-zinc-400 leading-normal mb-5">We couldn't detect your location and your pet profile doesn't have one saved either.</p>
            <button
              onClick={() => navigate('/profile', { state: { edit: true, focusField: 'city' } })}
              className="px-6 py-2.5 bg-primary text-white rounded-full text-xs font-bold shadow-md active:scale-95 transition-transform hover-lift"
            >
              Set Your Location
            </button>
          </div>
        ) : loading ? (
          <div className="space-y-6 animate-pulse">
            <div className="h-64 bg-surface-container-low rounded-[2.5rem]" />
            <div className="space-y-4">
              {[1, 2, 3].map(i => <div key={i} className="h-24 bg-surface-container-low rounded-[2rem]" />)}
            </div>
          </div>
        ) : data.top3?.length === 0 && data.risingStars?.length === 0 ? (
          /* Empty State */
          <div className="text-center py-20 animate-scale-pop max-w-sm mx-auto">
            <span className="material-symbols-outlined text-6xl text-zinc-200 mb-4 animate-float">star</span>
            <h3 className="font-extrabold text-lg text-zinc-500 mb-1">✨ No stars yet.</h3>
            <p className="text-xs text-zinc-400 leading-normal">Your pet could become today's first Spotlight winner.</p>
          </div>
        ) : (
          <div className="lg:grid lg:grid-cols-[1fr_400px] lg:gap-10">
            {/* Podium */}
            <div>
              <section className="relative mb-16 pt-12 animate-scale-pop">
                <div className="flex items-end justify-center gap-2" style={{ transition: 'all 0.6s cubic-bezier(0.25,1,0.5,1)' }}>
                  
                  {/* #2 */}
                  <div className="flex-1 flex flex-col items-center" style={{ transition: 'transform 0.5s ease, opacity 0.5s ease' }}>
                    {data.top3?.[1] && (
                      <>
                        <div className="relative mb-4 cursor-pointer" onClick={() => navigate(`/profile/${data.top3[1].id}`)}>
                          <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-zinc-100 rounded-full p-1.5 shadow-md z-20">
                            <span className="material-symbols-outlined text-zinc-400 text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>workspace_premium</span>
                          </div>
                          <div className="w-24 h-32 rounded-[2rem] overflow-hidden bg-white shadow-xl rotate-[-3deg] border-4 border-zinc-50 relative z-10 hover-lift">
                            <img className="w-full h-full object-cover" src={thumbnailUrl(data.top3[1].avatar_url) || '/logo.png'} alt={data.top3[1].name} loading="eager" decoding="async" />
                          </div>
                          {data.top3[1].id === myPetId && (
                            <span className="absolute bottom-2 right-2 z-30 bg-primary text-white text-[8px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">YOU</span>
                          )}
                        </div>
                        <div className="text-center">
                          <p className="font-extrabold text-sm text-on-surface leading-tight tracking-tight flex items-center justify-center gap-1">
                            <span>{data.top3[1].name}</span>
                            <PremiumBadge pet={data.top3[1]} size="text-sm" />
                          </p>
                          <p className="text-[10px] font-extrabold tracking-wider text-zinc-500 mt-0.5">👅 {data.top3[1].total_licks || 0} Licks</p>
                        </div>
                      </>
                    )}
                  </div>

                  {/* #1 Daily Winner Highlight with Crown */}
                  <div className="flex-1 flex flex-col items-center z-10 scale-110 -translate-y-4" style={{ transition: 'transform 0.5s ease, opacity 0.5s ease' }}>
                    {data.top3?.[0] && (
                      <>
                        <div className="relative mb-6 cursor-pointer" onClick={() => handleChampionClick(data.top3[0])}>
                          {/* Animated Golden Paw Crown replacement */}
                          <div className="absolute -top-9 left-1/2 -translate-x-1/2 z-20">
                            <ChampionCrown className="w-9 h-9" />
                          </div>
                          <div className="w-32 h-44 rounded-[3rem] overflow-hidden bg-white shadow-[0_20px_50px_-10px_rgba(244,167,185,0.4)] border-4 border-primary relative z-10 hover-lift-lg animate-pulse-glow">
                            <img className="w-full h-full object-cover" src={thumbnailUrl(data.top3[0].avatar_url) || '/logo.png'} alt={data.top3[0].name} loading="eager" decoding="async" />
                          </div>
                          {data.top3[0].id === myPetId && (
                            <span className="absolute bottom-2 right-2 z-30 bg-primary text-white text-[8px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">YOU</span>
                          )}
                        </div>
                        <div className="text-center">
                          <span className="text-[8px] font-extrabold uppercase tracking-widest bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full shadow-sm border border-yellow-200">👑 Top Pet Today</span>
                          <p className="font-extrabold text-lg text-on-surface leading-tight tracking-tighter mt-2 flex items-center justify-center gap-1">
                            <span>{data.top3[0].name}</span>
                            <PremiumBadge pet={data.top3[0]} size="text-base" />
                          </p>
                          <div className="flex items-center justify-center gap-1 mt-1">
                            <span className="material-symbols-outlined text-primary text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                            <p className="text-[11px] font-black tracking-wider text-primary">{data.top3[0].total_licks || 0} Total Licks</p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* #3 */}
                  <div className="flex-1 flex flex-col items-center" style={{ transition: 'transform 0.5s ease, opacity 0.5s ease' }}>
                    {data.top3?.[2] && (
                      <>
                        <div className="relative mb-4 cursor-pointer" onClick={() => navigate(`/profile/${data.top3[2].id}`)}>
                          <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-amber-50 rounded-full p-1.5 shadow-md z-20">
                            <span className="material-symbols-outlined text-amber-600/60 text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>workspace_premium</span>
                          </div>
                          <div className="w-24 h-32 rounded-[2rem] overflow-hidden bg-white shadow-xl rotate-[3deg] border-4 border-zinc-50 relative z-10 hover-lift">
                            <img className="w-full h-full object-cover" src={thumbnailUrl(data.top3[2].avatar_url) || '/logo.png'} alt={data.top3[2].name} loading="eager" decoding="async" />
                          </div>
                          {data.top3[2].id === myPetId && (
                            <span className="absolute bottom-2 right-2 z-30 bg-primary text-white text-[8px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">YOU</span>
                          )}
                        </div>
                        <div className="text-center">
                          <p className="font-extrabold text-sm text-on-surface leading-tight tracking-tight flex items-center justify-center gap-1">
                            <span>{data.top3[2].name}</span>
                            <PremiumBadge pet={data.top3[2]} size="text-sm" />
                          </p>
                          <p className="text-[10px] font-extrabold tracking-wider text-zinc-500 mt-0.5">👅 {data.top3[2].total_licks || 0} Licks</p>
                        </div>
                      </>
                    )}
                  </div>

                </div>
              </section>
            </div>

            {/* Leaderboard List (Top 10 default, expandable to Top 20 via View All) */}
            {((data.ranks4To10?.length > 0) || (data.risingStars?.length > 0)) && (
              <section className="mt-4 lg:mt-0 space-y-4 text-left">
                <div className="flex justify-between items-end px-2 mb-2">
                  <div>
                    <h2 className="font-extrabold text-2xl tracking-tighter text-on-surface">Leaderboard</h2>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-400 mt-1">
                      {showAll ? 'Top 20 Leaderboard' : 'Top 10 Leaderboard'}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  {(showAll 
                    ? [...(data.ranks4To10 || data.risingStars?.slice(0, 7) || []), ...(data.ranks11To20 || data.risingStars?.slice(7, 17) || [])]
                    : (data.ranks4To10 || data.risingStars?.slice(0, 7) || [])
                  ).map((pet) => {
                    const isSelf = pet.id === myPetId;
                    return (
                      <div
                        key={pet.id}
                        onClick={() => navigate(`/profile/${pet.id}`)}
                        className={`group flex items-center gap-4 p-4 rounded-[2rem] bg-white dark:bg-zinc-900 shadow-sm border transition-all active:scale-[0.98] hover-lift cursor-pointer
                          ${isSelf ? 'border-primary bg-pink-50/10' : 'border-outline-variant/10 hover:border-primary/20'}`}
                      >
                        {/* Rank & Movement Badge */}
                        <div className="flex flex-col items-center justify-center w-8">
                          <span className="font-extrabold text-sm text-zinc-400">{pet.rank}</span>
                          {pet.movement && (
                            <span className={`text-[8px] font-black mt-0.5 px-1 rounded flex items-center justify-center
                              ${pet.movement.type === 'up' ? 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/40' : 
                                pet.movement.type === 'down' ? 'text-red-500 bg-red-50 dark:bg-red-950/40' : 
                                'text-orange-500 bg-orange-50 dark:bg-orange-950/40'}`}
                            >
                              {pet.movement.type === 'up' ? `↑${pet.movement.value}` : 
                               pet.movement.type === 'down' ? `↓${pet.movement.value}` : 
                               'NEW'}
                            </span>
                          )}
                        </div>

                        {/* Profile Pic */}
                        <div className="relative">
                          <img className="w-12 h-12 rounded-[1.3rem] object-cover shadow-sm" src={avatarUrl(pet.avatar_url) || '/logo.png'} alt={pet.name} loading="lazy" decoding="async" />
                          {isSelf && (
                            <span className="absolute -top-1 -right-1 bg-primary text-white text-[7px] font-black uppercase px-1 rounded-full border border-white">YOU</span>
                          )}
                        </div>

                        {/* Name & Username */}
                        <div className="flex-1">
                          <h4 className="font-bold text-sm text-on-surface tracking-tight flex items-center gap-1.5">
                            <span>{pet.name}</span>
                            <PremiumBadge pet={pet} size="text-sm" />
                          </h4>
                          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-400 mt-0.5">{pet.pet_username || pet.breed_name}</p>
                        </div>

                        {/* Total Licks display */}
                        <div className="flex items-center gap-1 bg-primary/10 dark:bg-primary/20 px-3 py-1.5 rounded-full">
                          <span className="material-symbols-outlined text-primary text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                          <span className="font-black text-xs text-primary">{pet.total_licks || 0} Licks</span>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* "View All" Button below Top 10 to expand Ranks #11 to #20 */}
                {!showAll && (data.ranks11To20?.length > 0 || data.risingStars?.length > 7) && (
                  <button
                    onClick={() => setShowAll(true)}
                    className="w-full py-3.5 mt-4 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-on-surface font-extrabold text-xs rounded-2xl transition-all shadow-xs flex items-center justify-center gap-2 active:scale-[0.98]"
                  >
                    <span>View All (Ranks #11 – #20)</span>
                    <span className="material-symbols-outlined text-sm">expand_more</span>
                  </button>
                )}
              </section>
            )}
          </div>
        )}

        {/* Background decorations */}
        <div className="fixed top-0 left-0 w-full h-full pointer-events-none -z-20 overflow-hidden">
          <span className="material-symbols-outlined absolute top-[20%] left-[10%] text-zinc-100 text-9xl opacity-40 -rotate-12 animate-float-slow">pets</span>
          <span className="material-symbols-outlined absolute bottom-[10%] left-[5%] text-zinc-100 text-8xl opacity-20 animate-float" style={{ animationDelay: '3s' }}>favorite</span>
        </div>
      </main>

      <Portal>
      {/* Cinematic Champion Entrance Overlay */}
      {hallOfFamePet && (
        <div className="fixed inset-0 z-[200] bg-zinc-950/75 flex items-center justify-center p-6 animate-cinematic-bg">
          <div className="text-center max-w-sm w-full animate-cinematic-card space-y-8 flex flex-col items-center">
            {/* Floating golden crown above zoom card */}
            <div className="relative z-30">
              <ChampionCrown className="w-16 h-16 drop-shadow-[0_4px_15px_rgba(250,204,21,0.8)]" />
            </div>
            
            {/* Enlarged Champion Card */}
            <div className="w-56 h-72 rounded-[3.5rem] overflow-hidden bg-white shadow-[0_25px_60px_-10px_rgba(234,179,8,0.5)] border-4 border-yellow-400 transform scale-105 transition-transform duration-700">
              <img className="w-full h-full object-cover" src={thumbnailUrl(hallOfFamePet.avatar_url) || '/logo.png'} alt={hallOfFamePet.name} loading="lazy" decoding="async" />
            </div>

            {/* Fading details titles */}
            <div className="text-white space-y-2 text-center">
              <h2 className="text-3xl font-black tracking-tighter text-yellow-300">👑 Today's Spotlight Champion</h2>
              <p className="text-sm font-medium text-zinc-300 opacity-90">Most loved pet in the current Spotlight</p>
              <h3 className="text-2xl font-black text-white mt-4">{hallOfFamePet.name}</h3>
            </div>
          </div>
        </div>
      )}

      {/* Spotlight History Panel Overlay */}
      {showHistory && (
        <div
          className="fixed inset-0 z-[160] bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center pt-4 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4 animate-fade-in"
          onClick={() => setShowHistory(false)}
        >
          <div
            className="bg-white rounded-t-[2.5rem] sm:rounded-[2.5rem] w-full max-w-md p-6 pb-8 space-y-6 animate-scale-up shadow-2xl relative border border-outline-variant/10 text-left max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-2 border-b border-zinc-100">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">workspace_premium</span>
                <h3 className="font-extrabold text-on-surface text-base">👑 Spotlight History</h3>
              </div>
              <button
                onClick={() => setShowHistory(false)}
                className="w-8 h-8 rounded-full bg-zinc-50 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-colors"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            {loadingHistory ? (
              <div className="py-12 flex flex-col items-center justify-center text-center">
                <span className="material-symbols-outlined text-3xl text-primary animate-pulse">pets</span>
                <p className="text-xs text-zinc-400 font-bold mt-2 animate-pulse">Retrieving Hall of Fame...</p>
              </div>
            ) : historyList.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center text-center">
                <span className="material-symbols-outlined text-5xl text-zinc-200 mb-3">auto_awesome</span>
                <h3 className="font-bold text-sm text-zinc-400 mb-1">No history records yet</h3>
                <p className="text-xs text-zinc-300">Winners are recorded at the end of every Spotlight cycle.</p>
              </div>
            ) : (
              <div className="divide-y divide-zinc-100 max-h-[360px] overflow-y-auto pr-1 no-scrollbar space-y-1">
                {historyList.map((item) => {
                  const dateObj = new Date(item.cycle_date);
                  const displayDate = dateObj.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

                  return (
                    <div
                      key={item.id}
                      onClick={() => {
                        setShowHistory(false);
                        navigate(`/profile/${item.pet_id}`);
                      }}
                      className="flex items-center justify-between py-3 hover:bg-zinc-50 rounded-xl px-2 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <img className="w-10 h-10 rounded-full object-cover border border-zinc-100" src={avatarUrl(item.avatar_url) || '/logo.png'} alt={item.name} loading="lazy" decoding="async" />
                        <div>
                          <h5 className="font-bold text-xs text-on-surface">{item.name}</h5>
                          <p className="text-[10px] text-zinc-400 font-medium mt-0.5">{item.pet_username || `@${item.name.toLowerCase()}`}</p>
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[9px] font-black text-primary bg-primary/5 px-2 py-0.5 rounded border border-primary/10">{displayDate}</span>
                        <p className="text-[8px] font-bold text-zinc-300 uppercase tracking-widest mt-1">Score: {item.score}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      </Portal>
    </div>
  );
}
