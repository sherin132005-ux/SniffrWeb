import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import usePullToRefresh from '../hooks/usePullToRefresh';
import { useSocket } from '../context/SocketContext';
import UpsellModal from '../components/UpsellModal';
import PremiumBadge from '../components/PremiumBadge';
import AdSlot from '../components/AdSlot';
import { isPremiumGateError } from '../utils/premiumErrors';
import { usePremium } from '../context/PremiumContext';
import Portal from '../components/Portal';
import { avatarUrl, thumbnailUrl } from '../utils/media';

// Haversine formula to compute distance (approximate)
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// Distance display labels
function formatDistanceText(distanceKm) {
  const meters = distanceKm * 1000;
  if (meters <= 250) return 'Nearby Now';
  if (meters <= 500) return 'Very Close';
  if (meters < 1000) return `${Math.round(meters)} m away`;
  return `${distanceKm.toFixed(1)} km away`;
}

import { useAuth } from '../context/AuthContext';

export default function MeetPage() {
  const navigate = useNavigate();
  const { socket } = useSocket();
  const { pet, user, updateUser } = useAuth();
  const { premium } = usePremium();

  const [pets, setPets] = useState([]);
  // Honest fallback chain: prefer live GPS (set by the geolocation watcher
  // below); until that resolves, seed from the pet's own saved profile
  // location if one exists (real data, not a guess); if neither is
  // available, loc stays null and the UI shows an explicit "set your
  // location" state instead of silently substituting a fake coordinate.
  const [loc, setLoc] = useState(() => {
    if (pet?.latitude && pet?.longitude) {
      return {
        lat: pet.latitude,
        lng: pet.longitude,
        text: [pet.city, pet.state, pet.country].filter(Boolean).join(', ') || 'Your Saved Location',
      };
    }
    return null;
  });
  const [radius, setRadius] = useState(15);
  const [loading, setLoading] = useState(true);

  // Fallback states
  const [gpsAvailable, setGpsAvailable] = useState(true);
  const [manualMode, setManualMode] = useState(false);
  const [showGpsPrompt, setShowGpsPrompt] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  // Preferences states
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(() => localStorage.getItem('live_nearby_updates') !== 'false');
  const [showPreferences, setShowPreferences] = useState(false);

  // ── Swipe Card States ──────────────────────────────────────
  const [currentIndex, setCurrentIndex] = useState(0);
  const [swipeX, setSwipeX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState(null); // 'left' | 'right' | null
  const [showPawAnimation, setShowPawAnimation] = useState(false);
  const [showMatchCelebration, setShowMatchCelebration] = useState(false);
  const [matchedPetData, setMatchedPetData] = useState(null);
  const [matchConversationId, setMatchConversationId] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [swipedIds, setSwipedIds] = useState(new Set());
  const [matchToast, setMatchToast] = useState(null);
  const [activity, setActivity] = useState({ requested: [], pending: [], accepted: [] });
  const [activeActivityTab, setActiveActivityTab] = useState('pending'); // 'pending' | 'requested' | 'accepted'
  const cardRef = useRef(null);
  const dragStartRef = useRef({ x: 0, y: 0, startX: 0 });

  // ── First-time swipe hint (teaches the gesture, dismissed for good after the user's first drag) ──
  const [showSwipeHint, setShowSwipeHint] = useState(() => {
    try { return !localStorage.getItem('sniffr_meet_swipe_hint_seen'); } catch { return true; }
  });
  const dismissSwipeHint = () => {
    setShowSwipeHint(false);
    try { localStorage.setItem('sniffr_meet_swipe_hint_seen', '1'); } catch {}
  };

  // ── Ad Manager hook point: frequency comes from premium.adFrequency ──
  const [swipeCount, setSwipeCount] = useState(0);
  const [showAd, setShowAd] = useState(false);
  const adTimerRef = useRef(null);

  // ── Undo Like snackbar (5s window matching the server's undo grace period) ──
  const UNDO_WINDOW_MS = 5000;
  const [undoSnackbar, setUndoSnackbar] = useState(null); // { petId, petName }
  const [undoVisible, setUndoVisible] = useState(false);
  const undoTimerRef = useRef(null);
  const [upsell, setUpsell] = useState(null); // { title, message } -- premium upsell modal
  const undoHideTimerRef = useRef(null);

  const loadActivity = useCallback(async () => {
    try {
      const res = await api.get('/matches/activity');
      if (res) {
        setActivity({
          requested: res.requested || [],
          pending: res.pending || [],
          accepted: res.accepted || []
        });
      }
    } catch (e) { console.error('Failed to load activity lists:', e); }
  }, []);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  const gpsWatcherIdRef = useRef(null);
  const lastUpdatedLocRef = useRef(null);
  const debounceRef = useRef(null);

  const load = useCallback(async (lat = loc?.lat, lng = loc?.lng, r = radius) => {
    // No GPS, no saved pet location -- nothing honest to query with. Leave
    // the results empty rather than silently falling back to a hardcoded
    // coordinate; the render logic below shows an explicit "set your
    // location" state whenever loc is null.
    if (lat == null || lng == null) {
      setPets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const d = await api.get(`/matches/discover?lat=${lat}&lng=${lng}&radius=${r}`);
      const newPets = (d.pets || []).filter(p => !swipedIds.has(p.id));
      setPets(newPets);
      setCurrentIndex(0);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [loc?.lat, loc?.lng, radius, pet?.id, swipedIds]);

  const { pullDistance, refreshing, handlers, PawTrailIndicator } = usePullToRefresh(load);

  const initialFetchDoneRef = useRef(false);

  // Pet data loads asynchronously via AuthContext -- if it wasn't ready yet
  // when this page first mounted (so the lazy useState initializer above had
  // nothing to seed from) and GPS hasn't resolved either, adopt the pet's
  // saved location (still real data) as soon as it becomes available.
  useEffect(() => {
    if (loc) return;
    if (pet?.latitude && pet?.longitude) {
      setLoc({
        lat: pet.latitude,
        lng: pet.longitude,
        text: [pet.city, pet.state, pet.country].filter(Boolean).join(', ') || 'Your Saved Location',
      });
    }
  }, [pet?.latitude, pet?.longitude, loc]);

  // Fetch nearby results the first time ANY location becomes known -- the
  // pet's saved profile (seeded above/at mount) or live GPS resolving
  // later. Only fires once so it never duplicates the explicit load()
  // calls already triggered by GPS success / manual search below.
  useEffect(() => {
    if (loc && !initialFetchDoneRef.current) {
      initialFetchDoneRef.current = true;
      load(loc.lat, loc.lng, radius);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc]);

  // Geolocation position watcher effect
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsAvailable(false);
      if (!loc) setLoading(false);
      return;
    }

    const handleSuccess = async (position) => {
      setGpsAvailable(true);
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      const timestamp = position.timestamp;

      // 1. Adaptive movement threshold
      let thresholdMeters = 25; // default walking
      if (speed !== null && speed > 2) {
        if (speed <= 7) thresholdMeters = 50; // cycling
        else thresholdMeters = 100; // driving
      }

      let shouldUpdate = false;
      if (!lastUpdatedLocRef.current) {
        shouldUpdate = true;
      } else {
        const distKm = haversine(
          latitude,
          longitude,
          lastUpdatedLocRef.current.lat,
          lastUpdatedLocRef.current.lng
        );
        if (distKm * 1000 >= thresholdMeters) {
          shouldUpdate = true;
        }
      }

      if (shouldUpdate) {
        lastUpdatedLocRef.current = { lat: latitude, lng: longitude };

        // Only update backend coordinates if Live Nearby Updates is ON
        if (liveUpdatesEnabled) {
          try {
            await api.post('/profile/location', {
              latitude,
              longitude,
              accuracy,
              speed,
              heading,
              timestamp: new Date(timestamp).toISOString()
            });
          } catch (err) {
            console.error('Failed to update live coordinates:', err);
          }
        }

        // If in GPS mode, update local coordinates and query discover
        if (!manualMode) {
          setLoc({ lat: latitude, lng: longitude, text: 'Current Location' });
          load(latitude, longitude, radius);
        } else {
          // If in manual mode but watchPosition success triggers, show GPS restoration prompt
          setShowGpsPrompt(true);
        }
      }
    };

    const handleError = (error) => {
      console.warn('Geolocation error:', error.message);
      // Only treat permission denied or search errors as unavailable
      if (error.code === error.PERMISSION_DENIED) {
        setGpsAvailable(false);
      }
      // No GPS, and no saved pet-profile location either -- stop the
      // skeleton and let the explicit "set your location" state render
      // instead of spinning forever.
      if (!loc) setLoading(false);
    };

    const watchId = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 0
    });

    gpsWatcherIdRef.current = watchId;

    return () => {
      if (gpsWatcherIdRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatcherIdRef.current);
      }
    };
  }, [manualMode, radius, liveUpdatesEnabled, load]);

  // Socket.IO realtime synchronizer
  useEffect(() => {
    if (!socket) return;

    // Location updates are only broadcast to sockets in the 'meet_live'
    // room (see server/socket/meet.js) -- join while this page is mounted,
    // leave on unmount so we stop receiving other users' live coordinates
    // the moment we navigate away.
    socket.emit('join_meet');

    const handleLocationUpdate = (data) => {
      if (!liveUpdatesEnabled || !loc) return;

      const { pet_id, latitude, longitude, last_updated_location_timestamp, pet } = data;
      const distance = haversine(loc.lat, loc.lng, latitude, longitude);

      setPets(prev => {
        const exists = prev.some(p => p.id === pet_id);

        if (distance <= radius) {
          if (exists) {
            return prev.map(p => {
              if (p.id === pet_id) {
                let liveProximityText = null;
                // Only provide live relative dynamic text within 1 km
                if (distance <= 1.0) {
                  const prevDist = p.distance;
                  if (prevDist > 1.0) {
                    liveProximityText = 'Just arrived nearby';
                  } else if (distance < prevDist - 0.02) {
                    liveProximityText = 'Moved slightly closer';
                  } else {
                    liveProximityText = `Now ${formatDistanceText(distance)}`;
                  }
                }
                return {
                  ...p,
                  latitude,
                  longitude,
                  distance,
                  last_updated_location_timestamp,
                  liveProximityText
                };
              }
              return p;
            }).sort((a, b) => a.distance - b.distance);
          } else {
            // Fade in new pet entering search radius
            return [...prev, {
              ...pet,
              distance,
              latitude,
              longitude,
              last_updated_location_timestamp,
              isNew: true
            }].sort((a, b) => a.distance - b.distance);
          }
        } else {
          // Fade out pet leaving search radius
          if (exists) {
            return prev.filter(p => p.id !== pet_id);
          }
        }
        return prev;
      });
    };

    const handleUserOnline = ({ userId }) => {
      setPets(prev => prev.map(p => p.user_id === userId ? { ...p, online: true } : p));
    };

    const handleUserOffline = ({ userId }) => {
      setPets(prev => prev.map(p => p.user_id === userId ? { ...p, online: false } : p));
    };

    const handleProfileUpdate = ({ pet_id, pet }) => {
      setPets(prev => prev.map(p => p.id === pet_id ? { ...p, ...pet } : p));
    };

    socket.on('location_updated', handleLocationUpdate);
    socket.on('user_online', handleUserOnline);
    socket.on('user_offline', handleUserOffline);
    socket.on('profile_updated', handleProfileUpdate);

    return () => {
      socket.emit('leave_meet');
      socket.off('location_updated', handleLocationUpdate);
      socket.off('user_online', handleUserOnline);
      socket.off('user_offline', handleUserOffline);
      socket.off('profile_updated', handleProfileUpdate);
    };
  }, [socket, loc?.lat, loc?.lng, radius, liveUpdatesEnabled]);

  // Slider change handler
  const handleRadiusChange = (val) => {
    const r = parseInt(val);
    setRadius(r);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load(loc?.lat, loc?.lng, r);
    }, 100);
  };

  // Fallback geocoding search
  const handleGeocodeSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const res = await api.get(`/profile/geocode?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(res.results || []);
    } catch (err) {
      console.error('Geocoding search failed:', err);
    }
  };

  const handleSelectLocation = (item) => {
    setLoc({ lat: item.lat, lng: item.lng, text: item.display_name });
    setManualMode(true);
    setSearchResults([]);
    setSearchQuery('');
    load(item.lat, item.lng, radius);
  };

  const toggleLiveUpdates = (val) => {
    setLiveUpdatesEnabled(val);
    localStorage.setItem('live_nearby_updates', val ? 'true' : 'false');
  };

  // Persisted server-side (not localStorage) so it holds across refresh,
  // logout/login, and devices -- see PATCH /api/profile/super-sniff.
  // Optimistic update, reconciled against the real user object on failure.
  const handleToggleSuperSniff = async (enabled) => {
    // Client-side shortcut for a snappier upsell -- purely a UX nicety.
    // PATCH /api/profile/super-sniff is the real, non-bypassable gate.
    if (enabled && premium && !premium.canUseSuperSniff) {
      setUpsell({
        title: 'Super Sniff is a Premium Feature',
        message: "Browse other pets' profiles without sending a \"someone viewed your profile\" notification. Upgrade to Premium to unlock stealth browsing.",
      });
      return;
    }

    updateUser({ super_sniff_enabled: enabled ? 1 : 0 });
    try {
      await api.patch('/profile/super-sniff', { enabled });
    } catch (err) {
      updateUser({ super_sniff_enabled: enabled ? 0 : 1 });
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'Super Sniff is a Premium Feature', message: err.message });
      } else {
        console.error('Failed to update Super Sniff:', err);
      }
    }
  };

  // Increase Radius logic
  const increaseRadius = () => {
    const nextRadius = Math.min(100, radius + 15);
    setRadius(nextRadius);
    load(loc?.lat, loc?.lng, nextRadius);
  };

  const totalNearby = pets.length;
  const withinOneKm = pets.filter(p => p.distance <= 1.0).length;
  const currentPet = pets[currentIndex] || null;
  const hasMoreCards = currentIndex < pets.length;

  // ── Swipe Gesture Handlers ─────────────────────────────────
  const SWIPE_THRESHOLD = 100;

  const handleDragStart = (clientX, clientY) => {
    if (isProcessing || !currentPet) return;
    if (showSwipeHint) dismissSwipeHint();
    setIsDragging(true);
    dragStartRef.current = { x: clientX, y: clientY, startX: swipeX };
  };

  const handleDragMove = (clientX) => {
    if (!isDragging) return;
    const dx = clientX - dragStartRef.current.x;
    setSwipeX(dx);
  };

  const handleDragEnd = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (Math.abs(swipeX) >= SWIPE_THRESHOLD) {
      if (swipeX > 0) handleSwipeRight();
      else handleSwipeLeft();
    } else {
      setSwipeX(0);
    }
  };

  // Touch handlers
  const onTouchStart = (e) => handleDragStart(e.touches[0].clientX, e.touches[0].clientY);
  const onTouchMove = (e) => handleDragMove(e.touches[0].clientX);
  const onTouchEnd = () => handleDragEnd();

  // Mouse handlers
  const onMouseDown = (e) => { e.preventDefault(); handleDragStart(e.clientX, e.clientY); };
  const onMouseMove = (e) => handleDragMove(e.clientX);
  const onMouseUp = () => handleDragEnd();

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      return () => {
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
    }
  }, [isDragging, swipeX]);

  // ── Swipe Actions ──────────────────────────────────────────
  const advanceCard = () => {
    setSwipeX(0);
    setSwipeDirection(null);
    setCurrentIndex(prev => prev + 1);
  };

  // Only one snackbar at a time: re-swiping before the previous one dismisses
  // just replaces it (and restarts the 5s clock for the new action). Stores
  // the FULL pet object (not just id/name) so a successful undo can splice
  // it straight back into the live deck -- see handleUndoLike.
  const showUndoSnackbar = (pet) => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    setUndoSnackbar({ pet });
    setUndoVisible(true);
    undoTimerRef.current = setTimeout(() => {
      setUndoVisible(false);
      undoHideTimerRef.current = setTimeout(() => setUndoSnackbar(null), 300);
    }, UNDO_WINDOW_MS);
  };

  const dismissUndoSnackbar = () => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
    setUndoVisible(false);
    undoHideTimerRef.current = setTimeout(() => setUndoSnackbar(null), 300);
  };

  // The 5s commit timer lives server-side (matches.js), so this can fail
  // safely (e.g. TOO_LATE) without leaving the UI or backend inconsistent --
  // the swipe just stands as a normal committed action. Free users always
  // see the snackbar/button (unchanged) -- the server is what actually
  // decides whether the undo goes through; a free user's tap surfaces the
  // upsell. On success, Premium Undo restores the pet to the TOP of the
  // live stack immediately (not just the next server fetch) by splicing it
  // back into `pets` at the current position.
  const handleUndoLike = async () => {
    if (!undoSnackbar) return;
    const pet = undoSnackbar.pet;
    dismissUndoSnackbar();
    try {
      await api.post(`/matches/undo/${pet.id}`);
      setSwipedIds(prev => {
        const next = new Set(prev);
        next.delete(pet.id);
        return next;
      });
      setPets(prev => {
        if (prev.some(p => p.id === pet.id)) return prev;
        const next = [...prev];
        next.splice(currentIndex, 0, pet);
        return next;
      });
      loadActivity();
    } catch (err) {
      if (isPremiumGateError(err)) {
        setUpsell({ title: 'Undo Like is a Premium Feature', message: err.message });
      } else {
        console.error('Undo failed (likely already committed):', err);
      }
    }
  };

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (undoHideTimerRef.current) clearTimeout(undoHideTimerRef.current);
      if (adTimerRef.current) clearTimeout(adTimerRef.current);
    };
  }, []);

  // Interval comes straight from the backend (server/config/plans.js), so
  // free vs Plus vs Gold vs Platinum frequency is decided in exactly one
  // place -- this just counts swipes and checks against it.
  const maybeShowAd = () => {
    const interval = premium?.adFrequency?.meetSwipeInterval || 3;
    setSwipeCount(prev => {
      const next = prev + 1;
      if (next % interval === 0) {
        setShowAd(true);
        if (adTimerRef.current) clearTimeout(adTimerRef.current);
        adTimerRef.current = setTimeout(() => setShowAd(false), 4000);
      }
      return next;
    });
  };

  const handleSwipeRight = async () => {
    if (isProcessing || !currentPet) return;
    if (showSwipeHint) dismissSwipeHint();
    setIsProcessing(true);
    setSwipeDirection('right');
    setShowPawAnimation(true);
    maybeShowAd();

    const likedPet = currentPet;

    try {
      // A swipe right sends ONE pending sniff request -- it is never itself
      // an Accept, so no match forms here. If the target already has a live
      // request out to us, the backend silently absorbs this swipe (no new
      // row, nothing to undo) rather than creating a duplicate/contradictory
      // request -- see MatchRepository.createPendingSwipeAction.
      const res = await api.post(`/matches/like/${likedPet.id}`);
      setSwipedIds(prev => new Set(prev).add(likedPet.id));
      if (!res?.absorbed) {
        showUndoSnackbar(likedPet);
      }
      loadActivity();
    } catch (err) {
      console.error('Like failed:', err);
    }

    setTimeout(() => {
      setShowPawAnimation(false);
      advanceCard();
      setIsProcessing(false);
    }, 500);
  };

  const handleSwipeLeft = async () => {
    if (isProcessing || !currentPet) return;
    if (showSwipeHint) dismissSwipeHint();
    setIsProcessing(true);
    setSwipeDirection('left');
    maybeShowAd();

    const declinedPet = currentPet;

    try {
      // Same pending/absorbed treatment as swipe-right, just resulting in a
      // 30-day rejection cooldown instead of a request -- see
      // MatchRepository.createPendingSwipeAction. Undo now applies to left
      // swipes too, matching right swipe.
      const res = await api.post(`/matches/decline/${declinedPet.id}`);
      setSwipedIds(prev => new Set(prev).add(declinedPet.id));
      if (!res?.absorbed) {
        showUndoSnackbar(declinedPet);
      }
      loadActivity();
    } catch (err) {
      console.error('Decline failed:', err);
    }

    setTimeout(() => {
      advanceCard();
      setIsProcessing(false);
    }, 400);
  };

  // ── Pending List Actions ────────────────────────────────────
  // Explicit Accept/Reject of an INCOMING request -- distinct from a fresh
  // swipe, and instant/final (no undo window; see plan D7). Shares its
  // state-machine logic server-side with the notification's own
  // Accept/Reject buttons via MatchRepository.acceptMeetRequest/rejectMeetRequest.
  const handleAcceptPending = async (petId) => {
    try {
      await api.post(`/matches/pending/${petId}/respond`, { action: 'accept' });
      loadActivity();
    } catch (err) {
      console.error('Accept pending failed:', err);
    }
  };

  const handleDeclinePending = async (petId) => {
    try {
      await api.post(`/matches/pending/${petId}/respond`, { action: 'decline' });
      loadActivity(); // Silently removes from list immediately
    } catch (err) {
      console.error('Decline pending failed:', err);
    }
  };

  // ── Match Celebration Actions ───────────────────────────────
  const handleStartChat = () => {
    setShowMatchCelebration(false);
    setMatchedPetData(null);
    advanceCard();
    if (matchConversationId) {
      navigate(`/chat?conv=${matchConversationId}`);
    } else {
      navigate('/chat');
    }
  };

  const handleKeepExploring = () => {
    setShowMatchCelebration(false);
    setMatchedPetData(null);
    advanceCard();
  };

  // ── Real-time match/request updates on Meet page ───────────────────
  // No manual reload is ever required for Pending/Requested/Accepted/Meet
  // card visibility -- the side that performed an action gets its own state
  // synchronously from the API response; this effect covers the OTHER
  // device, which never made that call. See plan D8.
  useEffect(() => {
    if (!socket) return;
    const handleMatchUpdate = async (data) => {
      if (data?.notification?.type === 'match_request') {
        // A new sniff request just arrived for us -- refresh Pending live,
        // and drop the sender from our own local deck if it happened to
        // already be loaded (they're now excluded from discovery both ways).
        loadActivity();
        const senderId = data.notification.sender_pet_id;
        if (senderId) {
          setPets(prev => prev.filter(p => p.id !== senderId));
        }
        return;
      }

      if (data?.notification?.type === 'new_match' || data?.notification?.action_status === 'accepted') {
        setMatchToast(`🐾 ${data.notification.title}`);
        setTimeout(() => setMatchToast(null), 4000);
        loadActivity();

        // A match only ever forms from an explicit Accept (never a fresh
        // swipe), so the celebration modal is always driven from here,
        // regardless of whether Accept was pressed on this device or the
        // other one.
        const matchedPetId = data.notification.sender_pet_id;
        if (matchedPetId) {
          try {
            const matchesRes = await api.get('/matches');
            const match = (matchesRes.matches || []).find(m => m.matched_pet_id === matchedPetId);
            if (match) {
              setMatchedPetData({
                id: match.matched_pet_id,
                name: match.matched_pet_name,
                avatar_url: match.matched_pet_avatar,
                pet_username: match.matched_pet_username,
                breed_name: match.matched_pet_breed,
              });
              setMatchConversationId(match.conversation_id || null);
              setShowMatchCelebration(true);
            }
          } catch (e) { console.error('Failed to load match details for celebration:', e); }
        }
      }
      if (data?.notification?.action_status === 'declined') {
        setMatchToast(`${data.notification.title}`);
        setTimeout(() => setMatchToast(null), 3000);
      }
    };

    // Silent -- a rejected request never sends a visible notification, but
    // the requester's own Requested list still needs to drop the resolved
    // entry live rather than waiting for a manual refresh.
    const handleRequestDeclined = () => {
      loadActivity();
    };

    socket.on('notification_received', handleMatchUpdate);
    socket.on('meet_request_declined', handleRequestDeclined);
    return () => {
      socket.off('notification_received', handleMatchUpdate);
      socket.off('meet_request_declined', handleRequestDeclined);
    };
  }, [socket]);

  // ── Swipe card transform ───────────────────────────────────
  const cardTransform = useMemo(() => {
    if (swipeDirection === 'right') return 'translateX(120%) rotate(20deg)';
    if (swipeDirection === 'left') return 'translateX(-120%) rotate(-20deg)';
    const rotation = swipeX * 0.08;
    return `translateX(${swipeX}px) rotate(${rotation}deg)`;
  }, [swipeX, swipeDirection]);

  const swipeProgress = Math.min(Math.abs(swipeX) / SWIPE_THRESHOLD, 1);
  const isSwipingRight = swipeX > 0;
  const isSwipingLeft = swipeX < 0;
  const superSniffLocked = !!premium && !premium.canUseSuperSniff && !user?.super_sniff_enabled;

  return (
    <div className="bg-surface text-on-surface min-h-screen pb-32 lg:pb-8 overflow-x-hidden" {...handlers}>
      <PawTrailIndicator />

      {/* GPS recovery prompt */}
      {showGpsPrompt && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[145] bg-primary-container border border-primary/20 rounded-2xl px-5 py-3.5 flex items-center gap-3 shadow-xl animate-fade-in max-w-sm">
          <span className="material-symbols-outlined text-primary">gps_fixed</span>
          <div className="text-left flex-1">
            <p className="text-xs font-black text-on-primary-container leading-none">Live GPS Available</p>
            <p className="text-[10px] text-zinc-500 font-bold mt-1 leading-normal">Switch back to live location tracking?</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowGpsPrompt(false)}
              className="px-2.5 py-1.5 bg-zinc-100 hover:bg-zinc-200 text-on-surface font-bold text-[10px] rounded-lg transition-colors"
            >
              No
            </button>
            <button
              onClick={() => {
                setManualMode(false);
                setShowGpsPrompt(false);
                if (lastUpdatedLocRef.current) {
                  setLoc({ lat: lastUpdatedLocRef.current.lat, lng: lastUpdatedLocRef.current.lng, text: 'Current Location' });
                  load(lastUpdatedLocRef.current.lat, lastUpdatedLocRef.current.lng, radius);
                }
              }}
              className="px-2.5 py-1.5 bg-primary text-white font-bold text-[10px] rounded-lg transition-colors active:scale-95"
            >
              Yes
            </button>
          </div>
        </div>
      )}

      {/* Mobile header */}
      <header className="lg:hidden bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] fixed top-0 left-0 right-0 md:left-20 z-50">
        <div className="flex justify-between items-center px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
            <span className="font-extrabold tracking-tighter text-2xl uppercase text-pink-400">Sniffr</span>
          </div>

          {/* Super Sniff -- compact, always-visible toggle (see PATCH /api/profile/super-sniff).
              Visually dimmed + lock badge for free users, per the Premium gating spec. */}
          <button
            onClick={() => handleToggleSuperSniff(!user?.super_sniff_enabled)}
            className={`relative w-10 h-10 rounded-full flex items-center justify-center transition-all active:scale-90 ${
              user?.super_sniff_enabled
                ? 'bg-primary text-white shadow-md'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-primary'
            } ${superSniffLocked ? 'opacity-60' : ''}`}
            title={user?.super_sniff_enabled ? 'Super Sniff is ON - browse without notifying' : superSniffLocked ? 'Super Sniff is a Premium feature' : 'Super Sniff is OFF'}
            aria-label="Toggle Super Sniff"
          >
            <span className="text-lg leading-none">🐽</span>
            {superSniffLocked && (
              <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-zinc-500 text-white flex items-center justify-center text-[9px] border-2 border-white dark:border-zinc-950">
                <span className="material-symbols-outlined text-[9px]" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="pt-24 lg:pt-8 px-4 lg:px-8 max-w-2xl lg:max-w-none mx-auto lg:mx-0">
        {/* Desktop title */}
        <div className="hidden lg:flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Find a Playmate <span className="gradient-text">🐾</span></h1>
            <p className="text-on-surface-variant text-sm mt-1">Discover nearby pets in real time</p>
          </div>

          {/* Super Sniff -- compact, always-visible toggle (see PATCH /api/profile/super-sniff).
              Visually dimmed + lock badge for free users, per the Premium gating spec. */}
          <button
            onClick={() => handleToggleSuperSniff(!user?.super_sniff_enabled)}
            className={`relative w-11 h-11 rounded-2xl flex items-center justify-center transition-all active:scale-95 shadow-2xs ${
              user?.super_sniff_enabled
                ? 'bg-primary text-white'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-primary'
            } ${superSniffLocked ? 'opacity-60' : ''}`}
            title={user?.super_sniff_enabled ? 'Super Sniff is ON - browse without notifying' : superSniffLocked ? 'Super Sniff is a Premium feature' : 'Super Sniff is OFF'}
            aria-label="Toggle Super Sniff"
          >
            <span className="text-xl leading-none">🐽</span>
            {superSniffLocked && (
              <span className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-zinc-500 text-white flex items-center justify-center text-[9px] border-2 border-white dark:border-zinc-950">
                <span className="material-symbols-outlined text-[9px]" style={{ fontVariationSettings: "'FILL' 1" }}>lock</span>
              </span>
            )}
          </button>
        </div>

        <div className="lg:grid lg:grid-cols-2 lg:gap-8 items-start">
          {/* Left: Controls */}
          <div className="space-y-6">
            {/* Radius card */}
            <section className="bg-white/80 dark:bg-zinc-900/80 backdrop-blur-sm p-6 rounded-2xl border border-outline-variant/10 shadow-sm hover-lift relative">
              <div className="flex justify-between items-end mb-6">
                <div>
                  <h2 className="font-extrabold text-2xl tracking-tighter text-on-surface">Search Radius</h2>
                  <div className="flex items-center gap-1 mt-1">
                    <span className="material-symbols-outlined text-[10px] text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>location_on</span>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant max-w-[200px] truncate">{loc?.text || 'Location not set'}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {/* Location Privacy Icon */}
                  <button
                    onClick={() => setShowPreferences(true)}
                    className="p-1.5 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors flex items-center justify-center text-primary"
                    title="Nearby Preferences"
                  >
                    <span className="material-symbols-outlined text-lg">share_location</span>
                  </button>
                  <div className="text-right">
                    <span className="text-3xl font-extrabold text-primary leading-none">{radius}</span>
                    <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant ml-1">KM</span>
                  </div>
                </div>
              </div>

              {/* Radius slider */}
              <div className="relative w-full h-2 bg-surface-variant rounded-full">
                <input
                  type="range" min="1" max="100" value={radius}
                  onChange={e => handleRadiusChange(e.target.value)}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                />
                <div
                  className="absolute top-0 left-0 h-full bg-gradient-to-r from-primary to-secondary rounded-full transition-all"
                  style={{ width: `${(radius / 100) * 100}%` }}
                />
                <div
                  className="absolute top-1/2 -mt-3 w-6 h-6 bg-white border-4 border-primary rounded-full shadow-lg transition-all animate-pulse-glow"
                  style={{ left: `calc(${(radius / 100) * 100}% - 12px)` }}
                />
              </div>

              {/* Distance markers */}
              <div className="flex justify-between text-[9px] font-bold text-zinc-300 uppercase tracking-widest mt-3">
                <span>1km</span><span>25km</span><span>50km</span><span>75km</span><span>100km</span>
              </div>

              {/* Fallback Location Search -- shown whenever GPS failed/was denied
                  OR we genuinely have no location at all yet (no GPS, no saved
                  pet-profile location), not just on the narrower "permission
                  denied" case. */}
              {(!gpsAvailable || !loc) && (
                <div className="mt-4 p-4 bg-zinc-50 dark:bg-zinc-800/50 border border-outline-variant/10 rounded-xl space-y-2 text-left">
                  <div className="flex items-center gap-2 text-zinc-400">
                    <span className="material-symbols-outlined text-sm">location_off</span>
                    <span className="text-[10px] font-bold uppercase tracking-wider">{loc ? 'GPS Unavailable' : 'Location Not Set'}</span>
                  </div>
                  <form onSubmit={handleGeocodeSearch} className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Search city, area, or landmark..."
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      className="flex-1 bg-white dark:bg-zinc-900 border border-zinc-200/50 dark:border-zinc-800 rounded-xl text-xs px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary text-on-surface"
                    />
                    <button type="submit" className="px-3 bg-primary text-white rounded-xl text-xs font-bold transition-all active:scale-95">
                      Search
                    </button>
                  </form>
                  {searchResults.length > 0 && (
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-800/50 bg-white dark:bg-zinc-900 rounded-xl shadow-lg border border-outline-variant/10 max-h-40 overflow-y-auto mt-2">
                      {searchResults.map((item, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSelectLocation(item)}
                          className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-[10px] font-bold text-on-surface truncate"
                        >
                          📍 {item.display_name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>

          {/* Right / Mobile: Discover Card */}
          <div className="relative mt-6 lg:mt-0">
            <div className="bg-white/85 dark:bg-zinc-900/85 backdrop-blur-sm p-6 rounded-2xl border border-outline-variant/10 shadow-sm">
              {/* Header with progress counter */}
              <div className="flex justify-between items-center mb-4 pb-2 border-b border-zinc-100 dark:border-zinc-800">
                <div className="flex flex-col gap-0.5 text-left">
                  <span className="font-extrabold text-sm text-on-surface">
                    {loc ? `🐾 ${totalNearby} furry friend${totalNearby !== 1 ? 's' : ''} nearby` : '📍 Location needed'}
                  </span>
                  <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-widest">
                    {!loc
                      ? 'Set your location below to discover pets'
                      : hasMoreCards
                        ? `Showing ${currentIndex + 1} of ${totalNearby} nearby pets`
                        : `${withinOneKm} within 1 km`
                    }
                  </span>
                </div>
              </div>

              {/* Real-time match toast */}
              {matchToast && (
                <div className="mb-3 px-4 py-2.5 bg-primary-container border border-primary/20 rounded-xl text-xs font-bold text-on-primary-container animate-fade-in text-center">
                  {matchToast}
                </div>
              )}

              {/* Ad slot -- frequency driven by premium.adFrequency.meetSwipeInterval
                  (server/config/plans.js): Free ~every 3 swipes, Plus 6, Gold 15,
                  Platinum 40 (rare, never zero). See maybeShowAd(). */}
              {showAd && (
                <div className="mb-3">
                  <AdSlot />
                </div>
              )}

              {!loc ? (
                /* Explicit "no location" state -- never silently substitute a
                   fake coordinate. Shown when GPS hasn't resolved (or was
                   denied) AND the pet's own profile has no saved location
                   either. The search box to resolve this lives in the Radius
                   card just above. */
                <div className="py-12 flex flex-col items-center justify-center text-center p-6 animate-scale-pop">
                  <span className="material-symbols-outlined text-5xl text-zinc-200 mb-3" style={{ fontVariationSettings: "'FILL' 1" }}>location_off</span>
                  <h3 className="font-bold text-sm text-zinc-500 mb-1">📍 Set your location to see nearby pets</h3>
                  <p className="text-xs text-zinc-400 max-w-[240px]">
                    We couldn't detect your location and your pet profile doesn't have one saved either. Enable location access or search for your area above.
                  </p>
                </div>
              ) : loading ? (
                /* Skeleton Polaroid Card */
                <div className="animate-pulse space-y-4">
                  <div className="bg-zinc-100 dark:bg-zinc-800 rounded-2xl p-5 space-y-4">
                    <div className="flex items-center gap-4">
                      <div className="w-20 h-20 rounded-full bg-zinc-200 dark:bg-zinc-700 flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-zinc-200 dark:bg-zinc-700 rounded-full w-3/4" />
                        <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded-full w-1/2" />
                        <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded-full w-2/3" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded-full w-full" />
                      <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded-full w-5/6" />
                      <div className="h-3 bg-zinc-200 dark:bg-zinc-700 rounded-full w-4/6" />
                    </div>
                    <div className="h-10 bg-zinc-200 dark:bg-zinc-700 rounded-full w-full" />
                  </div>
                  <div className="flex justify-center gap-6">
                    <div className="w-14 h-14 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                    <div className="w-14 h-14 rounded-full bg-zinc-200 dark:bg-zinc-700" />
                  </div>
                </div>
              ) : !hasMoreCards || pets.length === 0 ? (
                /* Empty / All Swiped State */
                <div className="py-12 flex flex-col items-center justify-center text-center p-6 animate-scale-pop">
                  <span className="material-symbols-outlined text-5xl text-zinc-200 mb-3 animate-float" style={{ fontVariationSettings: "'FILL' 1" }}>
                    {pets.length === 0 ? 'pets' : 'celebration'}
                  </span>
                  <h3 className="font-bold text-sm text-zinc-500 mb-1">
                    {pets.length === 0 ? '🐾 Still sniffing around...' : '🎉 All caught up!'}
                  </h3>
                  <p className="text-xs text-zinc-400 mb-5 max-w-[240px]">
                    {pets.length === 0
                      ? 'No furry friends found nearby. Try increasing your search radius.'
                      : "You've discovered all nearby pets within your selected radius. Try increasing your search radius or check back later."
                    }
                  </p>
                  <button onClick={increaseRadius} className="px-6 py-2.5 bg-primary text-white rounded-full text-xs font-bold shadow-md active:scale-95 transition-transform hover-lift">
                    Increase Radius
                  </button>
                </div>
              ) : currentPet ? (
                /* ── Polaroid Swipe Card ─────────────────────── */
                <div className="relative">
                  {/* Swipe direction indicators */}
                  {isDragging && swipeProgress > 0.2 && (
                    <>
                      {isSwipingRight && (
                        <div className="absolute top-4 left-4 z-30 px-4 py-2 bg-emerald-500/90 text-white rounded-xl font-black text-sm rotate-[-12deg] shadow-lg animate-fade-in" style={{ opacity: swipeProgress }}>
                          🐾 Meet!
                        </div>
                      )}
                      {isSwipingLeft && (
                        <div className="absolute top-4 right-4 z-30 px-4 py-2 bg-rose-400/90 text-white rounded-xl font-black text-sm rotate-[12deg] shadow-lg animate-fade-in" style={{ opacity: swipeProgress }}>
                          Skip
                        </div>
                      )}
                    </>
                  )}

                  {/* First-time Swipe Hint — teaches new users the gesture; dismissed
                      for good (localStorage) the moment they drag the card or tap a button */}
                  {showSwipeHint && !isDragging && (
                    <div
                      onClick={dismissSwipeHint}
                      className="absolute inset-0 z-40 rounded-[1.75rem] bg-black/40 backdrop-blur-[2px] flex flex-col items-center justify-center gap-4 animate-fade-in cursor-pointer select-none"
                    >
                      <div className="w-full flex items-center justify-between px-8">
                        <div className="flex flex-col items-center gap-1">
                          <span className="material-symbols-outlined text-rose-300 text-4xl animate-swipe-hint-arrow-left">chevron_left</span>
                          <span className="text-[10px] font-black uppercase tracking-widest text-white/90">Skip</span>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                          <span className="material-symbols-outlined text-emerald-300 text-4xl animate-swipe-hint-arrow-right">chevron_right</span>
                          <span className="text-[10px] font-black uppercase tracking-widest text-white/90">Meet</span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 bg-white/15 border border-white/25 px-4 py-2 rounded-full animate-pulse-glow">
                        <span className="material-symbols-outlined text-white text-xl animate-swipe-hint-hand" style={{ fontVariationSettings: "'FILL' 1" }}>swipe</span>
                        <span className="text-xs font-extrabold text-white tracking-wide">Swipe right to Meet, left to Skip</span>
                      </div>

                      <span className="text-[10px] font-bold text-white/70 uppercase tracking-wider">Tap anywhere to try it</span>
                    </div>
                  )}

                  {/* The Card */}
                  <div
                    ref={cardRef}
                    onTouchStart={onTouchStart}
                    onTouchMove={onTouchMove}
                    onTouchEnd={onTouchEnd}
                    onMouseDown={onMouseDown}
                    className="relative select-none touch-pan-y"
                    style={{
                      transform: cardTransform,
                      transition: isDragging ? 'none' : 'transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                      cursor: isDragging ? 'grabbing' : 'grab',
                    }}
                  >
                    <div
                      className="bg-gradient-to-br from-white to-zinc-50 dark:from-zinc-900 dark:to-zinc-800 rounded-[1.75rem] border border-outline-variant/15 shadow-[0_8px_30px_-8px_rgba(244,167,185,0.25)] overflow-hidden relative"
                      style={{
                        boxShadow: isDragging
                          ? isSwipingRight
                            ? `0 8px 30px -8px rgba(52, 211, 153, ${0.15 + swipeProgress * 0.3})`
                            : isSwipingLeft
                              ? `0 8px 30px -8px rgba(244, 63, 94, ${0.15 + swipeProgress * 0.3})`
                              : undefined
                          : undefined,
                      }}
                    >
                      {/* Paw accent top-right */}
                      <span className="material-symbols-outlined absolute top-3 right-3 text-[2rem] text-primary/8 pointer-events-none select-none rotate-12" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>

                      {/* Card Body */}
                      <div className="p-5 pb-4">
                        {/* Avatar + Core Info Row */}
                        <div className="flex items-start gap-4 mb-4">
                          <div className="relative flex-shrink-0">
                            <img
                              src={thumbnailUrl(currentPet.avatar_url) || '/logo.png'}
                              alt={currentPet.name}
                              loading="eager"
                              decoding="async"
                              className="w-28 h-28 rounded-2xl object-cover border-4 border-white dark:border-zinc-800 shadow-xl transition-transform hover:scale-105"
                              draggable="false"
                            />
                            {currentPet.online && (
                              <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-emerald-500 rounded-full border-[3px] border-white dark:border-zinc-800 flex items-center justify-center shadow-md">
                                <div className="w-2.5 h-2.5 bg-white rounded-full" />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0 pt-1">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <h3 className="font-extrabold text-lg text-on-surface leading-tight truncate">{currentPet.name}</h3>
                              {currentPet.verified && (
                                <span className="material-symbols-outlined text-primary text-base" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
                              )}
                              <PremiumBadge pet={currentPet} size="text-base" />
                            </div>
                            <p className="text-xs font-bold text-zinc-400 truncate">@{currentPet.pet_username || currentPet.name.toLowerCase().replace(/\s+/g, '')}</p>
                            <div className="flex items-center gap-1 mt-1.5">
                              <span className="material-symbols-outlined text-primary text-[13px]" style={{ fontVariationSettings: "'FILL' 1" }}>location_on</span>
                              <span className="text-[11px] font-bold text-primary">
                                {currentPet.liveProximityText && liveUpdatesEnabled
                                  ? currentPet.liveProximityText
                                  : formatDistanceText(currentPet.distance)
                                }
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Info Grid */}
                        <div className="grid grid-cols-2 gap-2 mb-4">
                          {currentPet.breed_name && (
                            <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2.5 rounded-xl">
                              <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                              <div>
                                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Breed</p>
                                <p className="text-[11px] font-bold text-on-surface truncate">{currentPet.breed_name}</p>
                              </div>
                            </div>
                          )}
                          {currentPet.age && (
                            <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2.5 rounded-xl">
                              <span className="material-symbols-outlined text-secondary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>cake</span>
                              <div>
                                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Age</p>
                                <p className="text-[11px] font-bold text-on-surface">{currentPet.age}</p>
                              </div>
                            </div>
                          )}
                          {currentPet.gender && (
                            <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2.5 rounded-xl">
                              <span className="material-symbols-outlined text-tertiary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
                                {currentPet.gender === 'Male' ? 'male' : currentPet.gender === 'Female' ? 'female' : 'transgender'}
                              </span>
                              <div>
                                <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Gender</p>
                                <p className="text-[11px] font-bold text-on-surface">{currentPet.gender}</p>
                              </div>
                            </div>
                          )}
                          <div className="flex items-center gap-2 bg-zinc-50 dark:bg-zinc-800/50 px-3 py-2.5 rounded-xl">
                            <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1", color: currentPet.vaccinated ? '#22c55e' : '#f59e0b' }}>
                              {currentPet.vaccinated ? 'verified_user' : 'health_and_safety'}
                            </span>
                            <div>
                              <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-wider">Vaccinated</p>
                              <p className="text-[11px] font-bold text-on-surface">{currentPet.vaccinated ? 'Yes ✓' : 'Unknown'}</p>
                            </div>
                          </div>
                        </div>

                        {/* Bio snippet */}
                        {currentPet.bio && (
                          <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed mb-4 line-clamp-2 italic">
                            "{currentPet.bio}"
                          </p>
                        )}

                        {/* Location info */}
                        {(currentPet.city || currentPet.state) && (
                          <div className="flex items-center gap-1.5 mb-3">
                            <span className="material-symbols-outlined text-zinc-300 text-[13px]">map</span>
                            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider truncate">
                              {[currentPet.city, currentPet.state, currentPet.country].filter(Boolean).join(', ')}
                            </span>
                          </div>
                        )}

                        {/* View Full Profile Button */}
                        <button
                          onClick={(e) => { e.stopPropagation(); navigate(`/profile/${currentPet.id}`); }}
                          className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-full text-xs font-bold text-on-surface-variant transition-colors flex items-center justify-center gap-1.5 active:scale-[0.98]"
                        >
                          <span className="material-symbols-outlined text-sm">person</span>
                          View Full Profile
                        </button>
                      </div>

                      {/* Paw accent bottom-left */}
                      <span className="material-symbols-outlined absolute bottom-2 left-3 text-[1.5rem] text-secondary/8 pointer-events-none select-none -rotate-12" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                    </div>
                  </div>

                  {/* Paw Burst Animation (on right swipe) */}
                  {showPawAnimation && (
                    <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
                      {[...Array(6)].map((_, i) => (
                        <span
                          key={i}
                          className="material-symbols-outlined absolute text-primary animate-ping"
                          style={{
                            fontVariationSettings: "'FILL' 1",
                            fontSize: `${20 + Math.random() * 16}px`,
                            left: `${25 + Math.random() * 50}%`,
                            top: `${20 + Math.random() * 60}%`,
                            animationDelay: `${i * 80}ms`,
                            animationDuration: '0.6s',
                            opacity: 0.7 + Math.random() * 0.3,
                          }}
                        >pets</span>
                      ))}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex justify-center items-center gap-5 mt-5">
                    <button
                      onClick={handleSwipeLeft}
                      disabled={isProcessing}
                      className="group w-14 h-14 rounded-full bg-white dark:bg-zinc-800 border-2 border-rose-200 dark:border-rose-900/40 shadow-md flex items-center justify-center transition-all active:scale-90 hover:border-rose-400 hover:shadow-lg disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-rose-400 text-2xl group-hover:scale-110 transition-transform">close</span>
                    </button>
                    <button
                      onClick={handleSwipeRight}
                      disabled={isProcessing}
                      className="group w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary-fixed-dim shadow-lg flex items-center justify-center transition-all active:scale-90 hover:shadow-xl hover:scale-105 disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-white text-3xl group-hover:scale-110 transition-transform" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                    </button>
                    <button
                      onClick={handleSwipeLeft}
                      disabled={isProcessing}
                      className="group w-14 h-14 rounded-full bg-white dark:bg-zinc-800 border-2 border-amber-200 dark:border-amber-900/40 shadow-md flex items-center justify-center transition-all active:scale-90 hover:border-amber-400 hover:shadow-lg disabled:opacity-50"
                    >
                      <span className="material-symbols-outlined text-amber-400 text-2xl group-hover:scale-110 transition-transform">skip_next</span>
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            {/* ── Meet Activity Lists Section ───────────────────── */}
            <section className="mt-6 bg-white/85 dark:bg-zinc-900/85 backdrop-blur-sm p-6 rounded-2xl border border-outline-variant/10 shadow-sm text-left space-y-4">
              <div className="flex justify-between items-center pb-3 border-b border-zinc-100 dark:border-zinc-800">
                <div>
                  <h3 className="font-extrabold text-base text-on-surface tracking-tight">Meet Activity 🐾</h3>
                  <p className="text-[11px] font-bold text-zinc-400">Track your pack connections and pending requests</p>
                </div>
              </div>

              {/* Activity Sub-Tabs */}
              <div className="flex gap-1.5 p-1 bg-zinc-100 dark:bg-zinc-800/80 rounded-xl">
                <button
                  onClick={() => setActiveActivityTab('pending')}
                  className={`flex-1 py-2 rounded-lg font-extrabold text-xs transition-all flex items-center justify-center gap-1 ${
                    activeActivityTab === 'pending'
                      ? 'bg-white dark:bg-zinc-900 text-rose-500 shadow-xs'
                      : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                  }`}
                >
                  <span>📩</span> Pending ({activity.pending.length})
                </button>
                <button
                  onClick={() => setActiveActivityTab('requested')}
                  className={`flex-1 py-2 rounded-lg font-extrabold text-xs transition-all flex items-center justify-center gap-1 ${
                    activeActivityTab === 'requested'
                      ? 'bg-white dark:bg-zinc-900 text-amber-500 shadow-xs'
                      : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                  }`}
                >
                  <span>📤</span> Requested ({activity.requested.length})
                </button>
                <button
                  onClick={() => setActiveActivityTab('accepted')}
                  className={`flex-1 py-2 rounded-lg font-extrabold text-xs transition-all flex items-center justify-center gap-1 ${
                    activeActivityTab === 'accepted'
                      ? 'bg-white dark:bg-zinc-900 text-emerald-500 shadow-xs'
                      : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                  }`}
                >
                  <span>🎉</span> Accepted ({activity.accepted.length})
                </button>
              </div>

              {/* Tab Contents */}
              {activeActivityTab === 'pending' && (
                <div className="space-y-2.5 pt-1">
                  {activity.pending.length === 0 ? (
                    <p className="text-xs text-zinc-400 italic text-center py-6">No pending Meet requests awaiting your response.</p>
                  ) : (
                    activity.pending.map(item => (
                      <div key={item.pet_id} className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-100 dark:border-zinc-800 rounded-xl">
                        <img src={avatarUrl(item.avatar_url) || '/logo.png'} alt={item.name} loading="lazy" decoding="async" className="w-11 h-11 rounded-full object-cover border border-zinc-200/50" />
                        <div className="flex-1 min-w-0">
                          <h4 className="font-extrabold text-xs text-on-surface truncate">{item.name}</h4>
                          <p className="text-[10px] font-bold text-zinc-400 truncate">{item.breed_name || 'Furry Friend'} • {item.age || '1y'}</p>
                        </div>
                        <div className="flex gap-1.5 flex-shrink-0">
                          <button
                            onClick={() => handleAcceptPending(item.pet_id)}
                            className="px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[11px] rounded-lg shadow-xs transition-transform active:scale-95 flex items-center gap-1"
                          >
                            <span>✓</span> Accept
                          </button>
                          <button
                            onClick={() => handleDeclinePending(item.pet_id)}
                            className="px-2.5 py-1.5 bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 text-zinc-600 dark:text-zinc-300 font-extrabold text-[11px] rounded-lg transition-transform active:scale-95"
                            title="Decline"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeActivityTab === 'requested' && (
                <div className="space-y-2.5 pt-1">
                  {activity.requested.length === 0 ? (
                    <p className="text-xs text-zinc-400 italic text-center py-6">You haven't sent any pending Meet requests.</p>
                  ) : (
                    activity.requested.map(item => (
                      <div key={item.pet_id} className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-100 dark:border-zinc-800 rounded-xl">
                        <img src={avatarUrl(item.avatar_url) || '/logo.png'} alt={item.name} loading="lazy" decoding="async" className="w-11 h-11 rounded-full object-cover border border-zinc-200/50" />
                        <div className="flex-1 min-w-0">
                          <h4 className="font-extrabold text-xs text-on-surface truncate">{item.name}</h4>
                          <p className="text-[10px] font-bold text-zinc-400 truncate">{item.breed_name || 'Furry Friend'} • @{item.pet_username}</p>
                        </div>
                        <span className="px-2.5 py-1 bg-amber-500/10 text-amber-600 dark:text-amber-400 font-black text-[10px] rounded-full uppercase tracking-wider">
                          Awaiting response
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}

              {activeActivityTab === 'accepted' && (
                <div className="space-y-2.5 pt-1">
                  {activity.accepted.length === 0 ? (
                    <p className="text-xs text-zinc-400 italic text-center py-6">No mutual matches yet. Keep exploring to connect with playmates!</p>
                  ) : (
                    activity.accepted.map(item => {
                      const matchedId = item.matched_pet_id || item.pet_id;
                      const matchedName = item.matched_pet_name || item.name;
                      const matchedAvatar = item.matched_pet_avatar || item.avatar_url;
                      const matchedBreed = item.matched_pet_breed || item.breed_name;

                      return (
                        <div key={item.id || matchedId} className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800/40 border border-emerald-200/40 dark:border-emerald-900/30 rounded-xl">
                          <img src={matchedAvatar || '/logo.png'} alt={matchedName} className="w-11 h-11 rounded-full object-cover border-2 border-emerald-400/50" />
                          <div className="flex-1 min-w-0">
                            <h4 className="font-extrabold text-xs text-on-surface truncate flex items-center gap-1">
                              {matchedName} <span className="text-emerald-500">✓</span>
                            </h4>
                            <p className="text-[10px] font-bold text-zinc-400 truncate">{matchedBreed || 'Matched Playmate'}</p>
                          </div>
                          <button
                            onClick={() => navigate('/chat', { state: { petId: matchedId, autoOpen: true } })}
                            className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold text-[11px] rounded-lg shadow-xs transition-transform active:scale-95 flex items-center gap-1"
                          >
                            <span>💬</span> Chat
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </section>
          </div>

          <Portal>
          {/* ── Match Celebration Modal ───────────────────── */}
          {showMatchCelebration && matchedPetData && (
            <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-md flex items-center justify-center p-6 animate-fade-in">
              <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] w-full max-w-sm p-8 text-center space-y-6 animate-scale-up shadow-2xl border border-primary/20 relative overflow-hidden">
                {/* Floating paw accents */}
                <span className="material-symbols-outlined absolute -top-4 -left-4 text-[4rem] text-primary/10 rotate-12 pointer-events-none" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                <span className="material-symbols-outlined absolute -bottom-4 -right-4 text-[3rem] text-secondary/10 -rotate-12 pointer-events-none" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>

                {/* Avatars */}
                <div className="flex items-center justify-center gap-4 relative">
                  <div className="w-20 h-20 rounded-full overflow-hidden border-[3px] border-primary shadow-lg">
                    <img src={thumbnailUrl(pet?.avatar_url) || '/logo.png'} alt={pet?.name} loading="eager" decoding="async" className="w-full h-full object-cover" />
                  </div>
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary to-secondary flex items-center justify-center shadow-md -mx-3 z-10">
                    <span className="material-symbols-outlined text-white text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                  </div>
                  <div className="w-20 h-20 rounded-full overflow-hidden border-[3px] border-secondary shadow-lg">
                    <img src={thumbnailUrl(matchedPetData.avatar_url) || '/logo.png'} alt={matchedPetData.name} loading="eager" decoding="async" className="w-full h-full object-cover" />
                  </div>
                </div>

                {/* Text */}
                <div className="space-y-2">
                  <h2 className="text-2xl font-extrabold text-on-surface tracking-tight">It's a Match! 🎉</h2>
                  <p className="text-sm text-zinc-500 font-bold">🐾 {matchedPetData.name} accepted your Meet Request!</p>
                  <p className="text-xs text-zinc-400 font-medium">You're now Pack Friends!</p>
                </div>

                {/* Buttons */}
                <div className="space-y-3">
                  <button
                    onClick={handleStartChat}
                    className="w-full py-3.5 bg-gradient-to-r from-primary to-primary-fixed-dim text-white font-bold text-sm rounded-full shadow-lg hover:shadow-xl active:scale-[0.98] transition-all flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>chat_bubble</span>
                    Start Chat
                  </button>
                  <button
                    onClick={handleKeepExploring}
                    className="w-full py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-on-surface font-bold text-sm rounded-full transition-colors flex items-center justify-center gap-2 active:scale-[0.98]"
                  >
                    <span className="material-symbols-outlined text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>explore</span>
                    Keep Exploring
                  </button>
                </div>
              </div>
            </div>
          )}
          </Portal>
        </div>
      </main>

      <Portal>
      {/* Nearby Preferences Bottom Sheet */}
      {showPreferences && (
        <div
          className="fixed inset-0 z-[160] bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center pt-4 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-4 animate-fade-in"
          onClick={() => setShowPreferences(false)}
        >
          <div
            className="bg-white rounded-t-[2.5rem] sm:rounded-[2.5rem] w-full max-w-sm p-6 pb-8 space-y-6 animate-scale-up shadow-2xl relative border border-outline-variant/10 text-left max-h-[90dvh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center pb-2 border-b border-zinc-100">
              <h3 className="font-extrabold text-on-surface text-base">Nearby Preferences</h3>
              <button
                onClick={() => setShowPreferences(false)}
                className="w-8 h-8 rounded-full bg-zinc-50 flex items-center justify-center text-zinc-400 hover:text-zinc-600 transition-colors"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary">share_location</span>
                  <span className="text-xs font-black text-on-surface">🟢 Live Nearby Updates</span>
                </div>

                {/* Switch toggle slider */}
                <label className="relative inline-flex items-center cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={liveUpdatesEnabled}
                    onChange={(e) => toggleLiveUpdates(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary" />
                </label>
              </div>

              <div className="text-[10px] text-zinc-500 font-bold leading-normal space-y-2">
                <p>Receive realtime proximity updates for pets within 1 km while using Meet.</p>
                <p className="text-primary font-black">Only approximate distances are shared. Your exact location is never visible to other users.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Undo Like Snackbar -- 5s window mirrors the server-side undo grace period */}
      {undoSnackbar && (
        <div
          className={`fixed bottom-24 lg:bottom-8 left-1/2 -translate-x-1/2 z-[220] transition-all duration-300 ease-out ${
            undoVisible ? 'opacity-100 translate-y-0 animate-slide-up' : 'opacity-0 translate-y-4 pointer-events-none'
          }`}
        >
          <div className="flex items-center gap-3 bg-primary text-white pl-5 pr-2 py-2.5 rounded-full shadow-2xl border border-white/10">
            <span className="text-xs font-bold whitespace-nowrap">🦴 Treat tossed! Undo?</span>
            <button
              onClick={handleUndoLike}
              className="px-3.5 py-1.5 bg-white text-primary font-extrabold text-[11px] rounded-full shadow-xs hover:bg-white/90 active:scale-95 transition-transform"
            >
              Undo
            </button>
          </div>
        </div>
      )}
      </Portal>

      {upsell && (
        <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
      )}
    </div>
  );
}
