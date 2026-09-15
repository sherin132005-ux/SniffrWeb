import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import api from '../services/api';
import CreatePostModal from '../components/CreatePostModal';
import CommentModal from '../components/CommentModal';
import ShareSheetModal from '../components/ShareSheetModal';
import ReportPostModal from '../components/ReportPostModal';
import NotificationsPanel from '../components/NotificationsPanel';
import PremiumBadge from '../components/PremiumBadge';
import PostVideo from '../components/PostVideo';
import { avatarUrl, feedMediaUrl } from '../utils/media';

// ── Custom SVG Icon Components (sized by viewBox for visual-weight matching) ──
// A color-filter-only "liked" state reads as barely-there against some
// backgrounds (a colored glow around an otherwise-identical icon shape) --
// the padded, colored pill background makes "you already liked this"
// unmistakable at a glance, independent of how strong the filter itself
// renders.
const PawLikeIcon = ({ active, className = '' }) => (
  <span className={`inline-flex items-center justify-center rounded-full transition-all duration-200 ${active ? 'bg-primary/15 dark:bg-primary/25 p-1.5 scale-110' : 'p-1.5'}`}>
    <img
      src="/paw-like-icon.png"
      alt="Like"
      className={`object-contain transition-all duration-200 ${className} ${active ? '' : 'opacity-60 dark:invert'}`}
      style={{
        filter: active
          ? 'invert(79%) sepia(29%) saturate(836%) hue-rotate(311deg) brightness(102%) contrast(94%) drop-shadow(0 2px 6px rgba(244,167,185,0.4))'
          : 'none'
      }}
      draggable={false}
    />
  </span>
);

const BoneIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.2 3.5c-1.1-.4-2.3.2-2.7 1.3-.2.5-.1 1 0 1.5L9.2 11.5c-.5-.2-1-.3-1.5-.1-1.1.4-1.7 1.6-1.3 2.7.2.5.5.9.9 1.2-.4.3-.7.8-.9 1.3-.4 1.1.2 2.3 1.3 2.7 1.1.4 2.3-.2 2.7-1.3.2-.5.1-1 0-1.5l5.3-5.2c.5.2 1 .3 1.5.1 1.1-.4 1.7-1.6 1.3-2.7-.2-.5-.5-.9-.9-1.2.4-.3.7-.8.9-1.3.4-1.1-.2-2.3-1.3-2.7z" />
  </svg>
);

const ShareIcon = ({ className = '' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2L11 13" />
    <path d="M22 2L15 22L11 13L2 9L22 2Z" />
  </svg>
);

// ── Reaction Emoji Map ──────────────────────────────────────────
const REACTION_EMOJIS = {
  paw: '🐾',
  bone: '🍖',
  fish: '🐟',
  sleep: '💤',
  love: '💖'
};

const REACTION_LABELS = {
  paw: 'Paw',
  bone: 'Bone',
  fish: 'Fish',
  sleep: 'Snooze',
  love: 'Love'
};

const REACTION_FEEDBACK_TEXTS = {
  paw: "Paw'd!",
  bone: "Bone'd!",
  fish: "Fish'd!",
  sleep: "Snoozed!",
  love: "Loved!"
};

// ── Decorative transparent assets for double-tap Like animation ──
const DECORATIVE_ASSETS = [
  // Rainbows
  { src: '/paw-rainbow-top.png', x: -72, y: -55, className: 'animate-rainbow-top w-12 h-10' },
  { src: '/paw-rainbow-bottom.png', x: -80, y: 42, className: 'animate-rainbow-bottom w-11 h-10' },
  // Stars
  { src: '/paw-star-pink.png', x: 73, y: -54, className: 'animate-star-pop w-8 h-8' },
  { src: '/paw-star-purple.png', x: 60, y: -72, className: 'animate-star-pop w-6 h-6' },
  // Leaves
  { src: '/paw-leaf-left.png', x: -87, y: 20, className: 'animate-leaf-left w-7 h-8' },
  { src: '/paw-leaf-right.png', x: 77, y: 40, className: 'animate-leaf-right w-8 h-9' },
  // Sparkles
  { src: '/paw-sparkle-1.png', x: 85, y: 48, className: 'animate-sparkle-twinkle w-7 h-5' },
  { src: '/paw-sparkle-2.png', x: 88, y: -36, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-3.png', x: -55, y: -76, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-4.png', x: 88, y: 21, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-5.png', x: -68, y: 57, className: 'animate-sparkle-twinkle w-5 h-5' },
  // Dots (with custom CSS variables for drift translation direction)
  { src: '/paw-dot-1.png', x: -90, y: -35, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '-3px' } },
  { src: '/paw-dot-2.png', x: -96, y: 30, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '3px' } },
  { src: '/paw-dot-3.png', x: 79, y: -71, className: 'animate-dot-float w-4 h-4', style: { '--dx': '6px', '--dy': '-5px' } },
  { src: '/paw-dot-4.png', x: 93, y: 35, className: 'animate-dot-float w-4 h-4', style: { '--dx': '7px', '--dy': '3px' } },
  { src: '/paw-dot-5.png', x: 90, y: -51, className: 'animate-dot-float w-4 h-4', style: { '--dx': '6px', '--dy': '-4px' } },
  { src: '/paw-dot-6.png', x: -89, y: -24, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '-2px' } },
  { src: '/paw-dot-7.png', x: -57, y: -65, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-4px', '--dy': '-5px' } }
];

// Helper for dynamic relative timestamps
function formatRelativeTimestamp(createdAt) {
  if (!createdAt) return 'Just now';
  const date = new Date(createdAt);
  if (isNaN(date.getTime())) return 'Just now';
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  if (diffInSeconds < 30) return 'Just now';
  if (diffInSeconds < 60) return '1 min ago';

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes} mins ago`;

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours} ${diffInHours === 1 ? 'hour' : 'hours'} ago`;

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays === 1) return 'Yesterday';
  if (diffInDays < 7) return `${diffInDays} days ago`;

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

export default function HomePage() {
  const { user, pet, refreshProfile } = useAuth();
  const { socket, onlineUsers = [] } = useSocket();
  const navigate = useNavigate();

  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [commentPostId, setCommentPostId] = useState(null);

  // Pagination & Infinite Scroll states
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Pull-to-refresh gesture states
  const [pullDistance, setPullDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchStartY = useRef(0);
  const touchStartX = useRef(0);
  const gestureType = useRef(null);

  // Post Options Menu states
  const [optionsPost, setOptionsPost] = useState(null);
  const [reportPost, setReportPost] = useState(null);
  const [reportReason, setReportReason] = useState('Spam');
  const [reportNotes, setReportNotes] = useState('');
  const [showReportConfirm, setShowReportConfirm] = useState(false);
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);

  // Double-tap like animation
  const [doubleTapPost, setDoubleTapPost] = useState(null);
  const lastTapRef = useRef({});

  // Swipe-to-profile states
  const [swipePostId, setSwipePostId] = useState(null);
  const [swipeDistance, setSwipeDistance] = useState(0);
  const [isSwipingResetting, setIsSwipingResetting] = useState(false);

  // Long-press reaction picker & Feedback Overlay
  const [reactionPost, setReactionPost] = useState(null);
  const [highlightedReaction, setHighlightedReaction] = useState(null);
  const [feedbackPostId, setFeedbackPostId] = useState(null);
  const [feedbackReaction, setFeedbackReaction] = useState(null);
  const [feedbackUsers, setFeedbackUsers] = useState([]);
  const feedbackTimerRef = useRef(null);
  const [showFullReactionsPost, setShowFullReactionsPost] = useState(null);
  const [reactionUsersList, setReactionUsersList] = useState([]);
  const [activeReactionTab, setActiveReactionTab] = useState('paw');
  const [loadingReactionsList, setLoadingReactionsList] = useState(false);
  // Tapping the reaction row (below "Licked by...") opens this read-only
  // count breakdown -- separate from showFullReactionsPost above, which
  // lists individual users per type and is unrelated to this feature.
  const [reactionSummaryPost, setReactionSummaryPost] = useState(null);
  const longPressTimer = useRef(null);
  const longPressTriggered = useRef(false);

  // Notifications Center states
  const [showNotifications, setShowNotifications] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // Share Sheet states
  const [sharePost, setSharePost] = useState(null);
  const [shareSearchQuery, setShareSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedRecipients, setSelectedRecipients] = useState([]);
  const [isBoopping, setIsBoopping] = useState(false);
  const [conversations, setConversations] = useState([]);
  const [deleteConfirmPost, setDeleteConfirmPost] = useState(null);
  const [matches, setMatches] = useState([]);
  const [nearbyPets, setNearbyPets] = useState([]);
  const [spotlightPets, setSpotlightPets] = useState([]);

  const handleDeletePost = async (postId) => {
    try {
      await api.delete(`/posts/${postId}`);
      setPosts(prev => prev.filter(p => p.id !== postId));
      showToast('🐾 Memory deleted successfully.');
      if (refreshProfile) refreshProfile();
    } catch (e) {
      console.error(e);
      showToast('Failed to delete memory.');
    }
  };

  // ── Hashtag / Mention Caption Renderer ─────────────────────
  // Hashtags are visually styled but honestly show a "coming soon" toast
  // instead of pretending to search, since there's no real Search feature
  // built yet. Mentions ARE fully functional: clicking @username looks up
  // that pet and navigates to their profile.
  const renderCaption = (caption) => {
    if (!caption) return null;
    const parts = caption.split(/(#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)/g);
    return parts.map((part, i) => {
      if (/^#[a-zA-Z0-9_]+$/.test(part)) {
        return (
          <span
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              showToast('🐾 Hashtag search is coming soon!');
            }}
            className="text-primary font-bold cursor-pointer hover:underline"
          >
            {part}
          </span>
        );
      }
      if (/^@[a-zA-Z0-9_]+$/.test(part)) {
        const username = part.slice(1);
        return (
          <span
            key={i}
            onClick={async (e) => {
              e.stopPropagation();
              try {
                const res = await api.get(`/chat/search?q=${encodeURIComponent(username)}`);
                const found = (res.results || []).find(p =>
                  (p.pet_username && p.pet_username.replace(/^@/, '').toLowerCase() === username.toLowerCase()) ||
                  p.name.toLowerCase() === username.toLowerCase()
                );
                if (found) {
                  navigate(`/profile/${found.id}`);
                } else {
                  showToast("🐾 Couldn't find that pet.");
                }
              } catch (err) {
                console.error('Mention lookup failed:', err);
              }
            }}
            className="text-sky-600 font-bold cursor-pointer hover:underline"
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  useEffect(() => {
    api.get('/notifications/unread-count')
      .then(res => res && setUnreadCount(res.unreadCount || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handleNotificationReceived = (data) => {
      if (data && data.unreadCount !== undefined) {
        setUnreadCount(data.unreadCount);
      }
    };
    socket.on('notification_received', handleNotificationReceived);
    return () => socket.off('notification_received', handleNotificationReceived);
  }, [socket]);

  // ── Load Posts (Paginated & Deduplicated) ────────────────────
  const fetchPostsPage = async (pageNum = 1) => {
    try {
      if (pageNum === 1) setLoading(true);
      else setLoadingMore(true);

      const d = await api.get(`/posts?page=${pageNum}&limit=10`);
      let fetchedPosts = d.posts || [];

      // Check if deep post is specified in URL query on initial load
      if (pageNum === 1) {
        const query = new URLSearchParams(window.location.search);
        const highlightedPostId = query.get('post');
        if (highlightedPostId) {
          try {
            const singleRes = await api.get(`/posts/${highlightedPostId}`);
            if (singleRes && singleRes.post) {
              fetchedPosts = fetchedPosts.filter(p => p.id !== singleRes.post.id);
              fetchedPosts = [singleRes.post, ...fetchedPosts];
            }
          } catch (err) {
            console.error("Error loading highlighted post:", err);
          }
        }
      }

      setHasMore(d.hasMore !== undefined ? d.hasMore : fetchedPosts.length === 10);

      setPosts(prev => {
        if (pageNum === 1) {
          const existingIds = new Set();
          const unique = [];
          for (const p of fetchedPosts) {
            if (!existingIds.has(p.id)) {
              existingIds.add(p.id);
              unique.push(p);
            }
          }
          return unique;
        } else {
          const existingIds = new Set(prev.map(p => p.id));
          const uniqueNew = fetchedPosts.filter(p => !existingIds.has(p.id));
          return [...prev, ...uniqueNew];
        }
      });
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
      setPullDistance(0);
    }
  };

  const loadMorePosts = async () => {
    if (loadingMore || !hasMore || loading || refreshing) return;
    const nextPage = page + 1;
    setPage(nextPage);
    await fetchPostsPage(nextPage);
  };

  // Continuous infinite scroll listener
  useEffect(() => {
    const handleScroll = () => {
      if (window.innerHeight + window.scrollY >= document.documentElement.offsetHeight - 600) {
        if (hasMore && !loadingMore && !loading && !refreshing) {
          loadMorePosts();
        }
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [hasMore, loadingMore, loading, refreshing, page]);

  // Pull-to-refresh: fetch newest posts and prepend without duplicates
  const refreshFeed = async () => {
    if (posts.length === 0) {
      return fetchPostsPage(1);
    }
    try {
      const newestDate = posts[0]?.created_at;
      if (newestDate) {
        const d = await api.get(`/posts/incremental?after=${encodeURIComponent(newestDate)}`);
        const newPosts = d.posts || [];
        if (newPosts.length > 0) {
          setPosts(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const fresh = newPosts.filter(p => !existingIds.has(p.id));
            return [...fresh, ...prev];
          });
        }
      } else {
        await fetchPostsPage(1);
      }
    } catch (e) {
      await fetchPostsPage(1);
    } finally {
      setRefreshing(false);
      setPullDistance(0);
    }
  };

  const location = useLocation();

  useEffect(() => {
    setPage(1);
    fetchPostsPage(1);
  }, [pet?.id]);

  // Auto-open target post's comment modal from notification deep links
  useEffect(() => {
    if (location.state?.openPostId) {
      const targetPostId = parseInt(location.state.openPostId, 10);
      setCommentPostId(targetPostId);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  // ── Realtime Socket.IO Listeners ───────────────────────────
  useEffect(() => {
    if (!socket) return;

    const handleNewPost = (post) => {
      setPosts(prev => {
        if (prev.some(p => p.id === post.id)) return prev;
        return [post, ...prev];
      });
    };

    const handlePostLiked = ({ post_id, like_count }) => {
      // Skip while this client has its own /like request in flight for this
      // post -- that request's own response is the source of truth and will
      // land right after; applying this broadcast first (it's an echo of
      // every like/unlike, including this client's) is what caused the
      // count to visibly flicker/revert on a quick re-tap.
      if (likeSeqRef.current[post_id]) return;
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, like_count } : p));
    };

    const handlePostCommented = ({ post_id }) => {
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, comment_count: Number(p.comment_count || 0) + 1 } : p));
    };

    const handleCommentDeleted = ({ post_id }) => {
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, comment_count: Math.max(0, Number(p.comment_count || 0) - 1) } : p));
    };

    const handlePostShared = ({ post_id, share_count }) => {
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, share_count } : p));
    };

    const handlePostReacted = ({ post_id, reactions }) => {
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, reactions } : p));
    };

    const handlePostUpdated = ({ post_id, caption }) => {
      setPosts(prev => prev.map(p => p.id === post_id ? { ...p, caption } : p));
    };

    const handlePostDeleted = ({ post_id }) => {
      setPosts(prev => prev.filter(p => p.id !== post_id));
    };

    const handleProfileUpdated = ({ pet_id, pet: updatedPet }) => {
      if (pet && pet.id === pet_id) refreshProfile();

      // Post cards store the author's name/avatar/etc. denormalized onto
      // the post itself (pet_name, pet_avatar, ...) rather than a live
      // reference to the pet -- so an edit to someone else's profile never
      // reaches a post already sitting in this feed unless we patch it
      // here too, matching on pet_id/author_pet_id.
      if (updatedPet) {
        setPosts(prev => prev.map(p => (
          (p.pet_id === pet_id || p.author_pet_id === pet_id)
            ? {
                ...p,
                pet_name: updatedPet.name,
                pet_avatar: updatedPet.avatar_url,
                pet_username: updatedPet.pet_username,
                breed_name: updatedPet.breed_name,
                location_text: updatedPet.location_text,
                is_premium: updatedPet.is_premium,
              }
            : p
        )));
      }
    };

    socket.on('new_post', handleNewPost);
    socket.on('post_liked', handlePostLiked);
    socket.on('post_commented', handlePostCommented);
    socket.on('comment_deleted', handleCommentDeleted);
    socket.on('post_shared', handlePostShared);
    socket.on('post_reacted', handlePostReacted);
    socket.on('post_updated', handlePostUpdated);
    socket.on('post_deleted', handlePostDeleted);
    socket.on('profile_updated', handleProfileUpdated);

    return () => {
      socket.off('new_post', handleNewPost);
      socket.off('post_liked', handlePostLiked);
      socket.off('post_commented', handlePostCommented);
      socket.off('comment_deleted', handleCommentDeleted);
      socket.off('post_shared', handlePostShared);
      socket.off('post_reacted', handlePostReacted);
      socket.off('post_updated', handlePostUpdated);
      socket.off('post_deleted', handlePostDeleted);
      socket.off('profile_updated', handleProfileUpdated);
    };
  }, [socket, pet, refreshProfile]);

  // ── Pull to Refresh (with swipe gesture disambiguation) ────
  const handleTouchStart = (e) => {
    touchStartY.current = e.touches[0].pageY;
    touchStartX.current = e.touches[0].pageX;
    gestureType.current = null;
  };

  const handleTouchMove = (e) => {
    if (!gestureType.current) {
      const dx = Math.abs(e.touches[0].pageX - touchStartX.current);
      const dy = Math.abs(e.touches[0].pageY - touchStartY.current);
      if (dy > 10 || dx > 10) {
        gestureType.current = dy > dx ? 'scroll' : 'swipe';
      }
    }

    if (gestureType.current === 'scroll' && window.scrollY === 0 && !refreshing) {
      const diff = e.touches[0].pageY - touchStartY.current;
      if (diff > 0) {
        const dist = Math.min(80, Math.pow(diff, 0.75) * 1.8);
        setPullDistance(dist);
      }
    }
  };

  const handleTouchEnd = () => {
    if (gestureType.current === 'scroll' && window.scrollY === 0 && !refreshing && pullDistance > 45) {
      setRefreshing(true);
      setPullDistance(50);
      refreshFeed();
    } else {
      setPullDistance(0);
    }
    touchStartY.current = 0;
    touchStartX.current = 0;
    gestureType.current = null;
  };

  // ── Post Actions ───────────────────────────────────────────
  // Rapid re-tapping (or a slow like-notification round trip racing a quick
  // unlike right after) can land two /like responses out of order -- without
  // a guard, the OLDER response can arrive last and stomp the state a newer
  // tap already set, which is exactly the "glitchy / reverts itself" feel.
  // likeSeqRef tracks the latest request per post so a stale response (and
  // the live 'post_liked' broadcast echoing this client's own action) is
  // dropped instead of applied.
  const likeSeqRef = useRef({});

  const toggleLike = async (postId) => {
    setPosts(prev => prev.map(p => {
      if (p.id === postId) {
        const isLiked = p.is_liked ? 0 : 1;
        const count = p.is_liked ? Math.max(0, p.like_count - 1) : p.like_count + 1;
        return { ...p, is_liked: isLiked, like_count: count };
      }
      return p;
    }));

    const seq = (likeSeqRef.current[postId] || 0) + 1;
    likeSeqRef.current[postId] = seq;

    try {
      const d = await api.post(`/posts/${postId}/like`);
      if (likeSeqRef.current[postId] !== seq) return; // superseded by a newer tap
      likeSeqRef.current[postId] = 0; // settled -- live broadcasts for this post can apply again
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, is_liked: d.liked ? 1 : 0, like_count: d.likeCount } : p));
    } catch (e) {
      if (likeSeqRef.current[postId] === seq) likeSeqRef.current[postId] = 0;
      console.error(e);
    }
  };

  // Like-only action (for double tap — only likes, never unlikes)
  const likePost = async (postId) => {
    const post = posts.find(p => p.id === postId);
    if (post && post.is_liked) return;
    toggleLike(postId);
  };

  const showToast = (message) => {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = 'position:fixed;bottom:120px;left:50%;transform:translateX(-50%);background:#F4A7B9;color:#fff;font-weight:700;font-size:13px;padding:10px 24px;border-radius:999px;z-index:9999;box-shadow:0 8px 24px rgba(244,167,185,0.4);animation:slide-up 0.3s ease both';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2500);
  };

  const copyPostLink = (postId) => {
    const shareUrl = `${window.location.origin}/home?post=${postId}`;
    navigator.clipboard.writeText(shareUrl);
    showToast('🐾 "Post link copied."');
    setOptionsPost(null);
  };

  const submitReport = async () => {
    if (!reportPost) return;
    setIsSubmittingReport(true);
    try {
      const reasonText = reportReason === 'Other' ? `Other: ${reportNotes}` : reportReason;
      await api.post(`/posts/${reportPost.id}/report`, { reason: reasonText });

      try {
        const existing = JSON.parse(localStorage.getItem('sniffr_user_reports') || '[]');
        const newEntry = {
          id: Date.now(),
          post_id: reportPost.id,
          post_reference: reportPost.caption ? `Post by @${reportPost.pet_username || reportPost.pet_name || 'pet'}: "${reportPost.caption.slice(0, 40)}${reportPost.caption.length > 40 ? '...' : ''}"` : `Post #${reportPost.id}`,
          reason: reasonText,
          date: new Date().toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          status: 'Pending'
        };
        localStorage.setItem('sniffr_user_reports', JSON.stringify([newEntry, ...existing]));
      } catch (e) {
        console.error(e);
      }

      showToast("🐾 Thanks for helping keep Sniffr safe. Report submitted.");
      setReportPost(null);
      setShowReportConfirm(false);
      setReportReason('Spam');
      setReportNotes('');
    } catch (err) {
      console.error(err);
    } finally {
      setIsSubmittingReport(false);
    }
  };

  // Lock body scroll when any modal is open to freeze feed position
  useEffect(() => {
    const isModalOpen = sharePost || reportPost || showCreate || reactionPost;
    if (isModalOpen) {
      const html = document.documentElement;
      const scrollY = window.scrollY;
      html.style.overflow = 'hidden';
      document.body.style.overflow = 'hidden';

      return () => {
        html.style.overflow = '';
        document.body.style.overflow = '';
        window.scrollTo(0, scrollY);
      };
    }
  }, [sharePost, reportPost, showCreate, reactionPost]);

  // ── Share Sheet Setup & Helpers ─────────────────────────────
  const openShareSheet = (post) => {
    setSharePost(post);
    setShareSearchQuery('');
    setSearchResults([]);
    setSelectedRecipients([]);
    setIsBoopping(false);

    Promise.all([
      api.get('/chat/conversations'),
      api.get('/matches'),
      api.get('/spotlight'),
      api.get('/chat/nearby')
    ]).then(([convRes, matchesRes, spotlightRes, nearbyRes]) => {
      setConversations(convRes?.conversations || []);
      setMatches(matchesRes?.matches || []);
      let spot = [];
      if (spotlightRes) {
        if (Array.isArray(spotlightRes)) spot = spotlightRes;
        else if (spotlightRes.pets) spot = spotlightRes.pets;
        else if (spotlightRes.spotlight) spot = spotlightRes.spotlight;
      }
      setSpotlightPets(spot);
      setNearbyPets(nearbyRes?.pets || []);
    }).catch(e => console.error(e));
  };

  const toggleRecipient = (pet) => {
    setSelectedRecipients(prev => {
      const exists = prev.find(r => r.id === pet.id);
      if (exists) return prev.filter(r => r.id !== pet.id);
      if (prev.length >= 10) {
        showToast('🐾 Max 10 recipients per share!');
        return prev;
      }
      return [...prev, { id: pet.id, name: pet.name || pet.partner_name, avatar: pet.avatar_url || pet.partner_avatar, username: pet.pet_username || pet.partner_username }];
    });
  };

  const removeRecipient = (id) => {
    setSelectedRecipients(prev => prev.filter(r => r.id !== id));
  };

  const isSelected = (id) => selectedRecipients.some(r => r.id === id);

  const handleBoop = async () => {
    if (selectedRecipients.length === 0 || !sharePost) return;
    setIsBoopping(true);
    try {
      await api.post('/chat/share', {
        postId: sharePost.id,
        recipientPetIds: selectedRecipients.map(r => r.id)
      });
      setPosts(prev => prev.map(p => p.id === sharePost.id ? { ...p, share_count: (p.share_count || 0) + 1 } : p));
      showToast('🐾 Post shared via Sniffr Chat!');
      setSharePost(null);
      setSelectedRecipients([]);
    } catch (e) {
      console.error(e);
      showToast('Failed to share post. Try again!');
    } finally {
      setIsBoopping(false);
    }
  };

  const runSearch = async (query) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await api.get(`/chat/search?q=${encodeURIComponent(query)}`);
      const results = res.results || [];

      const ranked = [...results].sort((a, b) => {
        const hasConvA = conversations.some(c => c.partner_pet_id === a.id);
        const hasConvB = conversations.some(c => c.partner_pet_id === b.id);
        if (hasConvA && !hasConvB) return -1;
        if (!hasConvA && hasConvB) return 1;
        const isMatchA = matches.some(m => m.id === a.id);
        const isMatchB = matches.some(m => m.id === b.id);
        if (isMatchA && !isMatchB) return -1;
        if (!isMatchA && isMatchB) return 1;
        const isSpotA = spotlightPets.some(s => s.id === a.id);
        const isSpotB = spotlightPets.some(s => s.id === b.id);
        if (isSpotA && !isSpotB) return -1;
        if (!isSpotA && isSpotB) return 1;
        const isNearbyA = nearbyPets.some(n => n.id === a.id);
        const isNearbyB = nearbyPets.some(n => n.id === b.id);
        if (isNearbyA && !isNearbyB) return -1;
        if (!isNearbyA && isNearbyB) return 1;
        return 0;
      });

      setSearchResults(ranked);
    } catch (e) {
      console.error(e);
    }
  };

  const getSuggestedDefault = () => {
    const merged = [];
    const seen = new Set(conversations.map(c => c.partner_pet_id));
    if (pet) seen.add(pet.id);
    matches.forEach(m => { if (!seen.has(m.id)) { merged.push(m); seen.add(m.id); } });
    spotlightPets.forEach(s => { if (!seen.has(s.id)) { merged.push(s); seen.add(s.id); } });
    nearbyPets.forEach(n => { if (!seen.has(n.id)) { merged.push(n); seen.add(n.id); } });
    return merged.slice(0, 5);
  };

  // ── Double-Tap Like Handler (with custom asset animations) ───
  const handleDoubleTap = useCallback((postId) => {
    const now = Date.now();
    const lastTap = lastTapRef.current[postId] || 0;
    if (now - lastTap < 350) {
      setDoubleTapPost(postId);
      likePost(postId);
      setTimeout(() => setDoubleTapPost(null), 850);
      lastTapRef.current[postId] = 0;
    } else {
      lastTapRef.current[postId] = now;
    }
  }, [posts]);

  // ── Long Press Handler (with haptic feedback) ──────────────
  const startLongPress = (post) => {
    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      // Haptic feedback where supported
      if (navigator.vibrate) navigator.vibrate(15);
      setReactionPost(post);
    }, 500);
  };

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const submitReaction = async (postId, reactionType) => {
    try {
      const res = await api.post(`/posts/${postId}/react`, { reaction: reactionType });
      setPosts(prev => prev.map(p => p.id === postId ? { ...p, reactions: res.reactions } : p));
      setReactionPost(null);

      // Trigger feedback overlay
      setFeedbackPostId(postId);
      setFeedbackReaction(reactionType);

      // Pre-fetch names list for social summary
      try {
        const uRes = await api.get(`/posts/${postId}/reactions`);
        setFeedbackUsers(uRes.reactions || []);
      } catch (e) {
        console.error(e);
      }

      // Auto dismiss overlay after 2.5 seconds
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = setTimeout(() => {
        setFeedbackPostId(null);
        setFeedbackReaction(null);
        setFeedbackUsers([]);
      }, 2500);
    } catch (e) {
      console.error(e);
    }
  };

  const handleFeedbackOverlayTap = (post) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedbackPostId(null);
    setFeedbackReaction(null);
    openFullReactionsSheet(post);
  };

  const openFullReactionsSheet = async (post) => {
    setShowFullReactionsPost(post);
    setReactionUsersList([]);
    setLoadingReactionsList(true);
    try {
      const res = await api.get(`/posts/${post.id}/reactions`);
      const list = res.reactions || [];
      setReactionUsersList(list);
      const firstActive = Object.keys(REACTION_EMOJIS).find(type => list.some(u => u.reaction === type));
      setActiveReactionTab(firstActive || 'paw');
    } catch (e) {
      console.error(e);
    } finally {
      setLoadingReactionsList(false);
    }
  };

  const formatSocialSummary = (users, myPetName) => {
    if (!users || users.length === 0) return "You're the first to react!";
    const names = users.map(u => u.pet_name === myPetName ? 'You' : u.pet_name);
    const uniqueNames = [...new Set(names)];
    if (uniqueNames.length === 1) {
      return `${uniqueNames[0]} reacted`;
    }
    if (uniqueNames.length === 2) {
      return `${uniqueNames[0]} and ${uniqueNames[1]} reacted`;
    }
    if (uniqueNames.length === 3) {
      return `${uniqueNames[0]}, ${uniqueNames[1]} and 1 other reacted`;
    }
    return `${uniqueNames[0]}, ${uniqueNames[1]} and ${uniqueNames.length - 2} others reacted`;
  };

  // ── Swipe-to-Profile (smoother easing, slight scale, subtle bounce) ──
  const postTouchStart = useRef({});
  const postSwipeActive = useRef({});

  const handlePostTouchStart = (postId, e) => {
    postTouchStart.current[postId] = { x: e.touches[0].pageX, y: e.touches[0].pageY };
    postSwipeActive.current[postId] = false;
    setIsSwipingResetting(false);
    startLongPress(posts.find(p => p.id === postId));
  };

  const handlePostTouchMove = (postId, e) => {
    if (reactionPost && reactionPost.id === postId) {
      const touch = e.touches[0];
      const elem = document.elementFromPoint(touch.clientX, touch.clientY);
      const reactType = elem?.closest('[data-reaction]')?.getAttribute('data-reaction');
      setHighlightedReaction(reactType || null);
      e.preventDefault();
      return;
    }

    const start = postTouchStart.current[postId];
    if (!start) return;
    const dx = e.touches[0].pageX - start.x;
    const dy = e.touches[0].pageY - start.y;

    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) cancelLongPress();

    if (dx > 10 && Math.abs(dy) < Math.abs(dx)) {
      postSwipeActive.current[postId] = true;
      setSwipePostId(postId);
      setSwipeDistance(Math.min(180, dx));
      e.preventDefault();
    }
  };

  const handlePostTouchEnd = (postId, post) => {
    cancelLongPress();
    
    if (reactionPost && reactionPost.id === postId) {
      if (highlightedReaction) {
        submitReaction(postId, highlightedReaction);
      } else {
        setReactionPost(null);
      }
      setHighlightedReaction(null);
      return;
    }

    const distance = swipeDistance;
    if (postSwipeActive.current[postId] && distance > 90) {
      setSwipeDistance(220);
      setTimeout(() => {
        navigate(`/profile/${post.author_pet_id || post.pet_id}`);
        setSwipePostId(null);
        setSwipeDistance(0);
      }, 350);
    } else if (postSwipeActive.current[postId]) {
      setIsSwipingResetting(true);
      setSwipeDistance(0);
      setTimeout(() => {
        setSwipePostId(null);
        setIsSwipingResetting(false);
      }, 400);
    }

    const wasSwipe = postSwipeActive.current[postId];
    postSwipeActive.current[postId] = false;
    delete postTouchStart.current[postId];

    if (!longPressTriggered.current && !wasSwipe && distance < 10) {
      handleDoubleTap(postId);
    }
  };

  // ── Format like count ──────────────────────────────────────
  const formatLikeCount = (count) => {
    if (!count || count === 0) return null;
    const formatted = count >= 1000 ? count.toLocaleString() : count;
    return `Licked by ${formatted} ${count === 1 ? 'paw' : 'paws'} 🐾`;
  };

  // ── Reaction summary ──────────────────────────────────────
  const renderReactions = (reactions) => {
    if (!reactions || Object.keys(reactions).length === 0) return null;
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {Object.entries(reactions).filter(([, c]) => c > 0).map(([type, count]) => (
          <span key={type} className="bg-surface-container-low px-2 py-0.5 rounded-full text-[11px] font-bold flex items-center gap-0.5 text-on-surface-variant">
            {REACTION_EMOJIS[type]} {count}
          </span>
        ))}
      </div>
    );
  };

  // Sorted (highest count first), emoji-only reaction types for a post --
  // used both by the row under "Licked by..." and the tap-to-open summary
  // popup, so the two are always guaranteed to agree on ordering.
  const sortedReactionEntries = (reactions) =>
    Object.entries(reactions || {})
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);

  // Compact, emoji-only, popularity-ordered reaction row shown on the post
  // card itself -- LinkedIn-style. No counts here (those only appear in the
  // tap-to-open summary popup); hidden entirely when nobody has reacted.
  const renderReactionRow = (post) => {
    const entries = sortedReactionEntries(post.reactions);
    if (entries.length === 0) return null;
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setReactionSummaryPost(post.id); }}
        className="flex items-center gap-1"
      >
        {entries.map(([type]) => (
          <span key={type} className="text-base leading-none">{REACTION_EMOJIS[type]}</span>
        ))}
      </button>
    );
  };

  // ── Profile completion ─────────────────────────────────────
  const CHECKLIST_MAP = {
    avatar_url: { label: '📷 Missing Profile Photo', icon: 'add_a_photo', focus: 'avatar' },
    country: { label: '🌍 Missing Country', icon: 'public', focus: 'country' },
    state: { label: '🗺 Missing State', icon: 'map', focus: 'state' },
    city: { label: '🏙 Missing City', icon: 'location_city', focus: 'city' },
    bio: { label: '📝 Missing Bio', icon: 'edit_note', focus: 'bio' },
    breed_name: { label: '🐶 Missing Breed', icon: 'pets', focus: 'breed_name' },
    age: { label: '🎂 Missing Age', icon: 'cake', focus: 'age' },
    vaccinated: { label: '💉 Missing Vaccination Status', icon: 'vaccines', focus: 'vaccinated' },
    pawsitive_score: { label: '🐾 Missing Pawsitive Score', icon: 'thumb_up', focus: 'pawsitive_score' },
    gallery: { label: '🖼 Missing Gallery Photos', icon: 'photo_library', focus: 'gallery' }
  };

  const handleChipClick = (item) => {
    if (item.focus === 'gallery') navigate('/profile', { state: { openGalleryUpload: true } });
    else if (item.focus === 'pawsitive_score') navigate('/profile', { state: { openPawsitive: true } });
    else navigate('/profile', { state: { edit: true, focusField: item.focus } });
  };

  const missingFields = (pet?.missing_fields || []).map(k => {
    const item = CHECKLIST_MAP[k];
    return item ? { key: k, ...item } : { key: k, label: `Missing ${k}`, icon: 'error', focus: k };
  });

  const completionPercent = pet?.completion_percent || 0;
  const showCompletion = pet && completionPercent < 100;

  // ── Share Sheet: render a selectable profile row ───────────
  const ProfileRow = ({ p }) => {
    const isOnline = onlineUsers.includes(p.user_id || p.partner_user_id);
    const targetId = p.id || p.partner_pet_id;
    return (
      <button
        onClick={() => toggleRecipient({ id: targetId, name: p.name || p.partner_name, avatar_url: p.avatar_url || p.partner_avatar })}
        className={`flex items-center justify-between w-full p-3 rounded-2xl transition-all active:scale-[0.98] ${isSelected(targetId) ? 'bg-primary/5 ring-1 ring-primary/20' : 'bg-zinc-50 hover:bg-zinc-100'}`}
      >
        <div className="flex items-center gap-3">
          <div className="relative">
            <img src={avatarUrl(p.avatar_url || p.partner_avatar) || '/logo.png'} alt={p.name || p.partner_name} loading="lazy" decoding="async" className="w-10 h-10 rounded-full object-cover border border-zinc-100" />
            {isOnline && (
              <div className="absolute -bottom-0.5 -right-0.5 bg-emerald-500 rounded-full w-3 h-3 border-2 border-white" />
            )}
          </div>
          <div className="text-left">
            <h5 className="font-bold text-xs text-on-surface">{p.name || p.partner_name}</h5>
            <p className="text-[10px] text-zinc-400 font-bold">{p.pet_username || p.partner_username || `@${(p.name || p.partner_name || '').toLowerCase()}`}</p>
          </div>
        </div>
        
        {/* Selection Circle */}
        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all ${isSelected(targetId) ? 'bg-primary border-primary text-white' : 'border-zinc-300'}`}>
          {isSelected(targetId) && <span className="material-symbols-outlined text-[10px] font-bold text-white">check</span>}
        </div>
      </button>
    );
  };

  return (
    <div
      className="bg-surface text-on-surface min-h-screen pb-32 lg:pb-8"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Paw-Trail Pull-To-Refresh Indicator */}
      {(pullDistance > 0 || refreshing) && (
        <div
          className="fixed top-20 left-0 right-0 z-40 flex justify-center items-center transition-all duration-200"
          style={{
            height: refreshing ? '50px' : `${pullDistance}px`,
            opacity: Math.min(1, refreshing ? 1 : pullDistance / 45)
          }}
        >
          <div className="bg-white/90 backdrop-blur-sm shadow-md rounded-full px-5 py-2 flex items-center gap-1 border border-[#F4A7B9]/20">
            <span className="paw-trail-dot" style={{ animationPlayState: refreshing ? 'running' : 'paused', transform: !refreshing ? `scale(${Math.min(1, pullDistance / 45)})` : undefined }}>🐾</span>
            <span className="paw-trail-dot" style={{ animationPlayState: refreshing ? 'running' : 'paused', transform: !refreshing ? `scale(${Math.min(1, pullDistance / 55)})` : undefined }}>🐾</span>
            <span className="paw-trail-dot" style={{ animationPlayState: refreshing ? 'running' : 'paused', transform: !refreshing ? `scale(${Math.min(1, pullDistance / 65)})` : undefined }}>🐾</span>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="lg:hidden bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] fixed top-0 left-0 right-0 md:left-20 z-50">
        <div className="flex justify-between items-center w-full px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
            <span className="font-['Plus_Jakarta_Sans'] font-extrabold tracking-tighter text-2xl uppercase text-pink-400">Sniffr</span>
          </div>

          {/* Notification Bell Button */}
          <button
            onClick={() => setShowNotifications(true)}
            className="relative w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-primary transition-transform active:scale-90"
            aria-label="Open Notifications"
          >
            <span className="material-symbols-outlined text-xl">notifications</span>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-500 text-white text-[10px] font-extrabold flex items-center justify-center border-2 border-white dark:border-zinc-900 shadow-2xs animate-pulse">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="pt-24 lg:pt-8 px-4 lg:px-8 max-w-2xl lg:max-w-none mx-auto lg:mx-0 space-y-5 sm:space-y-6 lg:space-y-8">
        {/* Desktop title */}
        <div className="hidden lg:flex items-center justify-between mb-2">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Home Feed <span className="gradient-text">🐾</span></h1>
            <p className="text-on-surface-variant text-sm mt-1">What's happening in your pet community</p>
          </div>
          <div className="flex items-center gap-3">
            {/* Notification Bell Button */}
            <button
              onClick={() => setShowNotifications(true)}
              className="relative w-11 h-11 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-primary transition-all active:scale-95 shadow-2xs"
              aria-label="Open Notifications"
            >
              <span className="material-symbols-outlined text-2xl">notifications</span>
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-500 text-white text-[10px] font-extrabold flex items-center justify-center border-2 border-white dark:border-zinc-900 shadow-2xs animate-pulse">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            <button onClick={() => setShowCreate(true)} className="hidden lg:flex items-center gap-2 bg-gradient-to-br from-primary to-primary-fixed-dim text-white px-6 py-3 rounded-full font-bold shadow-lg hover-lift ripple-container">
              <span className="material-symbols-outlined">add</span> New Post
            </button>
          </div>
        </div>

        {/* Profile Completion Panel */}
        <div className="transition-all duration-500 ease-in-out overflow-hidden" style={{ maxHeight: showCompletion ? '500px' : '0px', opacity: showCompletion ? 1 : 0, marginBottom: showCompletion ? '2rem' : '0px', pointerEvents: showCompletion ? 'auto' : 'none' }}>
          <section className="bg-secondary/10 p-6 rounded-2xl relative overflow-hidden hover-lift">
            <div className="relative z-10">
              <div className="flex justify-between items-end mb-3">
                <h3 className="font-bold text-on-secondary-container text-lg">🐾 {completionPercent}% Completed</h3>
                <button onClick={() => navigate('/profile')} className="font-bold text-[10px] uppercase tracking-widest text-on-secondary-fixed-variant hover:text-primary transition-colors">Finish Setup →</button>
              </div>
              <div className="w-full h-3 bg-white/50 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-secondary to-secondary-fixed-dim rounded-full transition-all duration-700 ease-out" style={{ width: `${completionPercent}%` }} />
              </div>
              {missingFields.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2 animate-fade-in">
                  {missingFields.map(f => (
                    <button key={f.key} onClick={() => handleChipClick(f)} className="bg-white/80 px-3 py-1.5 rounded-full text-[11px] font-bold text-secondary flex items-center gap-1 transition-all hover:bg-white active:scale-95 shadow-sm">
                      <span className="material-symbols-outlined text-[13px]">{f.icon}</span>{f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="material-symbols-outlined absolute -bottom-4 -right-4 text-secondary opacity-10 text-[120px] pointer-events-none">pets</span>
          </section>
        </div>

        {/* Feed */}
        <div className="space-y-5 sm:space-y-6 lg:space-y-8 lg:masonry-grid">
          {loading ? (
            <div className="space-y-6">
              {[1, 2, 3].map(i => (
                <div key={i} className="bg-surface-container-low rounded-2xl overflow-hidden animate-pulse">
                  <div className="h-12 bg-surface-container-high m-4 rounded-xl" />
                  <div className="h-64 bg-surface-container-highest" />
                  <div className="h-16 bg-surface-container-high m-4 rounded-xl" />
                </div>
              ))}
            </div>
          ) : posts.length === 0 ? (
            <div className="text-center py-24 animate-fade-in">
              <span className="material-symbols-outlined text-8xl text-zinc-200 mb-4 animate-float" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
              <h3 className="font-bold text-xl text-zinc-400">No posts yet</h3>
              <p className="text-zinc-300 text-sm mt-2">Be the first to share a memory!</p>
            </div>
          ) : (
            posts.map((post, idx) => {
              const isCurrentSwiped = swipePostId === post.id;
              const swipeProgress = swipeDistance / 180; // 0 → 1

              return (
                <article
                  key={post.id}
                  className="lg:masonry-item bg-[#F9F9FB] dark:bg-zinc-950/80 rounded-2xl overflow-hidden shadow-sm border border-outline-variant/10 hover-lift-lg group premium-card animate-slide-up relative"
                  style={{ animationDelay: `${idx * 80}ms` }}
                >
                  {/* Peek pet behind the sliding card */}
                  {isCurrentSwiped && swipeDistance > 0 && (
                    <div
                      className="absolute left-0 top-0 bottom-0 z-0 flex items-center justify-center pointer-events-none select-none"
                      style={{
                        width: `${swipeDistance}px`,
                        opacity: Math.min(1, swipeDistance / 50),
                        transition: isSwipingResetting ? 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none'
                      }}
                    >
                      <img
                        src={post.pet_type?.toLowerCase() === 'cat' ? '/peek-cat-transparent.png' : '/peek-dog-transparent.png'}
                        alt="Peek"
                        className="object-contain"
                        style={{
                          width: `${60 + swipeProgress * 40}px`,
                          height: `${60 + swipeProgress * 40}px`,
                          transform: `scale(${0.3 + swipeProgress * 0.7}) translateX(${-20 + swipeProgress * 20}px)`,
                          transition: isSwipingResetting ? 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none'
                        }}
                      />
                    </div>
                  )}

                  {/* Swipeable card contents */}
                  <div
                    className="relative z-10 bg-white/95 dark:bg-zinc-900/95 overflow-hidden"
                    style={{
                      transform: isCurrentSwiped
                        ? `translateX(${swipeDistance}px) scale(${1 - swipeProgress * 0.02})`
                        : 'translateX(0px) scale(1)',
                      transition: isSwipingResetting && isCurrentSwiped
                        ? 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)'
                        : 'none',
                      touchAction: 'pan-y'
                    }}
                    onTouchStart={(e) => handlePostTouchStart(post.id, e)}
                    onTouchMove={(e) => handlePostTouchMove(post.id, e)}
                    onTouchEnd={() => handlePostTouchEnd(post.id, post)}
                  >
                    {/* Feedback Overlay */}
                    {feedbackPostId === post.id && (
                      <div
                        onClick={() => handleFeedbackOverlayTap(post)}
                        className="absolute inset-0 z-20 backdrop-blur-md bg-white/75 dark:bg-zinc-900/75 flex flex-col items-center justify-center p-6 text-center cursor-pointer animate-fade-in"
                      >
                        <span className="text-6xl mb-2.5 animate-scale-pop">{REACTION_EMOJIS[feedbackReaction]}</span>
                        <h3 className="text-xl font-black text-primary mb-3.5">{REACTION_FEEDBACK_TEXTS[feedbackReaction]}</h3>
                        
                        {/* Compact Reaction Summary */}
                        <div className="flex items-center gap-2 mb-3 bg-white/60 dark:bg-zinc-800/60 px-3 py-1.5 rounded-full border border-outline-variant/10">
                          {Object.entries(post.reactions || {}).filter(([_, c]) => c > 0).map(([type, count]) => (
                            <span key={type} className="text-xs font-bold flex items-center gap-0.5 text-on-surface-variant">
                              {REACTION_EMOJIS[type]} {count}
                            </span>
                          ))}
                        </div>

                        {/* Social Summary Text */}
                        <p className="text-[11px] font-black text-on-surface-variant/80 tracking-wide uppercase">
                          {feedbackUsers.length === 0
                            ? "You're the first to react!"
                            : formatSocialSummary(feedbackUsers, pet?.name)}
                        </p>
                      </div>
                    )}
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2 p-4 sm:p-5 select-none">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="relative flex-shrink-0">
                          <img src={avatarUrl(post.pet_avatar) || '/logo.png'} alt={post.pet_name} loading="lazy" decoding="async" className="w-12 h-12 rounded-full object-cover border-2 border-primary/20" draggable={false} />
                          <div className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-400 rounded-full border-2 border-white" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h4 className="font-bold text-on-surface truncate max-w-[9rem] sm:max-w-none">{post.pet_name}</h4>
                            <PremiumBadge pet={post} size="text-base" />
                            {post.breed_name && (
                              <span className="bg-tertiary/10 text-on-tertiary-container px-2 py-0.5 rounded-full text-[8px] font-bold uppercase tracking-widest">{post.breed_name}</span>
                            )}
                          </div>
                          <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant truncate">
                            {post.distance ? `${post.distance.toFixed(1)} km away` : post.location_text || 'Nearby'}
                          </p>
                        </div>
                      </div>
                      {/* Three-dot menu — anchored dropdown with custom click-away overlay */}
                      <div className="relative z-30">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setOptionsPost(prev => prev?.id === post.id ? null : post);
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                          className="w-10 h-10 rounded-full hover:bg-surface-container-low flex items-center justify-center transition-colors relative"
                        >
                          <span className="material-symbols-outlined text-zinc-400 text-[22px]">more_horiz</span>
                        </button>

                        {optionsPost?.id === post.id && (() => {
                          const isPostOwner = pet && (post.pet_id === pet.id || post.author_pet_id === pet.id);
                          return (
                            <>
                              {/* Backdrop overlay to dismiss menu on clicking outside */}
                              <div
                                className="fixed inset-0 z-20 cursor-default"
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setOptionsPost(null);
                                }}
                              />
                              {/* Options Popup */}
                              <div
                                className="absolute right-0 top-11 w-36 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md rounded-2xl shadow-xl border border-outline-variant/10 py-1 z-30 animate-scale-up origin-top-right text-left"
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    copyPostLink(post.id);
                                  }}
                                  className="w-full text-left px-4 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-bold text-on-surface-variant flex items-center gap-2 transition-all active:scale-[0.98] cursor-pointer"
                                >
                                  <span className="material-symbols-outlined text-sm text-zinc-400">link</span>
                                  <span>Copy Link</span>
                                </button>
                                {isPostOwner ? (
                                  <>
                                    {/* Edit lives on the "Me" page (ProfilePage's gallery) only --
                                        editing your own post from the Home feed was a bug, not a
                                        feature: this menu still offers Copy Link / Delete here. */}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setDeleteConfirmPost(post);
                                        setOptionsPost(null);
                                      }}
                                      className="w-full text-left px-4 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-bold text-rose-600 flex items-center gap-2 transition-all active:scale-[0.98] border-t border-zinc-100/50 cursor-pointer"
                                    >
                                      <span className="material-symbols-outlined text-sm text-rose-600">delete</span>
                                      <span>Delete</span>
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      setReportPost(post);
                                      setOptionsPost(null);
                                      setShowReportConfirm(false);
                                    }}
                                    className="w-full text-left px-4 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 text-xs font-bold text-error flex items-center gap-2 transition-all active:scale-[0.98] border-t border-zinc-100/50 cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-sm text-rose-500">flag</span>
                                    <span>Report</span>
                                  </button>
                                )}
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Media */}
                    {post.media_url && (
                      <div
                        className="relative overflow-hidden bg-black/5 flex items-center justify-center select-none"
                        style={{ maxHeight: 'min(480px, 70vh)' }}
                        onDoubleClick={() => {
                          // Touch devices already get double-tap via the
                          // onTouchStart/Move/End trio on the card wrapper
                          // above (handlePostTouchEnd -> handleDoubleTap).
                          // Those never fire for mouse/trackpad input, so
                          // double-click was silently doing nothing outside
                          // a touchscreen. likePost() is a no-op if already
                          // liked, so this can't double-toggle even if a
                          // touch device's synthetic dblclick also fires.
                          setDoubleTapPost(post.id);
                          likePost(post.id);
                          setTimeout(() => setDoubleTapPost(null), 850);
                        }}
                      >
                        {post.media_type === 'video' ? (
                          <PostVideo src={post.media_url} />
                        ) : (
                          <img src={feedMediaUrl(post.media_url)} alt={post.caption} loading={idx < 2 ? 'eager' : 'lazy'} decoding="async" className="w-full max-h-full object-contain group-hover:scale-105 transition-transform duration-700" style={{ maxHeight: 'min(480px, 70vh)' }} draggable={false} />
                        )}

                        {/* Double-tap paw animation overlay with sparkles */}
                        {doubleTapPost === post.id && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
                            <div className="relative w-40 h-40">
                              {/* Central Paw */}
                              <img
                                src="/paw-center.png"
                                alt="Paw center"
                                className="absolute inset-0 w-full h-full object-contain animate-double-tap-paw-center drop-shadow-[0_8px_24px_rgba(244,167,185,0.35)]"
                              />
                              {/* Decorative Assets */}
                              {DECORATIVE_ASSETS.map((asset, aIdx) => (
                                <img
                                  key={aIdx}
                                  src={asset.src}
                                  alt=""
                                  className={`absolute object-contain ${asset.className}`}
                                  style={{
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    marginLeft: `${asset.x}px`,
                                    marginTop: `${asset.y}px`,
                                    ...asset.style
                                  }}
                                />
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Caption & Actions */}
                    <div className="p-4 sm:p-5 space-y-3 select-none">
                      {formatLikeCount(post.like_count) && (
                        <p className="font-bold text-xs text-on-surface">{formatLikeCount(post.like_count)}</p>
                      )}
                      {renderReactionRow(post)}
                      {post.caption && (
                        <p className="text-on-surface-variant text-sm leading-relaxed whitespace-pre-line">{renderCaption(post.caption)}</p>
                      )}

                      {/* Action buttons — visually balanced by weight */}
                      <div className="flex items-center gap-5 sm:gap-7 pt-3 border-t border-outline-variant/10">
                        {/* Like */}
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleLike(post.id); }}
                          onTouchStart={(e) => e.stopPropagation()}
                          onTouchEnd={(e) => e.stopPropagation()}
                          className="flex items-center gap-2 text-on-surface-variant hover:text-[#8E2E43] transition-all group/btn h-10"
                          title="Lick Post"
                        >
                          <PawLikeIcon active={post.is_liked} className="w-[22px] h-[22px] group-hover/btn:scale-110" />
                          {post.like_count > 0 && <span className="font-bold text-xs text-on-surface-variant/80">{post.like_count}</span>}
                        </button>

                        {/* Comment */}
                        <button
                          onClick={(e) => { e.stopPropagation(); setCommentPostId(post.id); }}
                          onTouchStart={(e) => e.stopPropagation()}
                          onTouchEnd={(e) => e.stopPropagation()}
                          className="flex items-center gap-2 text-on-surface-variant hover:text-secondary transition-all group/btn h-10"
                          title="Add Comment"
                        >
                          <BoneIcon className="w-[22px] h-[22px] group-hover/btn:scale-110 transition-transform text-on-surface-variant/60" />
                          {post.comment_count > 0 && <span className="font-bold text-xs text-on-surface-variant/80">{post.comment_count}</span>}
                        </button>

                        {/* Share (No Count) */}
                        <button
                          onClick={(e) => { e.stopPropagation(); openShareSheet(post); }}
                          onTouchStart={(e) => e.stopPropagation()}
                          onTouchEnd={(e) => e.stopPropagation()}
                          className="flex items-center gap-2 text-on-surface-variant hover:text-tertiary transition-all group/btn h-10"
                          title="Share Post"
                        >
                          <ShareIcon className="w-[21px] h-[21px] group-hover/btn:rotate-12 transition-transform text-on-surface-variant/60" />
                        </button>
                      </div>

                      {/* Post timestamp placed directly below action icons */}
                      <p className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-400 pt-1">
                        {formatRelativeTimestamp(post.created_at)}
                      </p>
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </main>

      {showCreate && <CreatePostModal onClose={() => setShowCreate(false)} onPostCreated={() => { fetchPostsPage(1); setShowCreate(false); }} />}
      {commentPostId && (
        <CommentModal
          postId={commentPostId}
          onClose={() => setCommentPostId(null)}
          onCommentAdded={() => {
            // Intentionally left empty: the 'post_commented' socket broadcast
            // (already listened for above) increments comment_count for
            // everyone, including the person who just commented. Doing it
            // here TOO caused a double-increment for the commenter specifically.
          }}
          onCommentDeleted={() => {
            // Same reasoning as onCommentAdded above -- 'comment_deleted' is
            // handled by the socket listener for every viewer, including
            // whoever just deleted their own comment.
          }}
        />
      )}

      {/* LinkedIn-style Long-Press Reaction Picker */}
      {reactionPost && (
        <div
          className="fixed inset-0 z-[60] bg-black/35 backdrop-blur-[2px] flex items-center justify-center animate-fade-in"
          onClick={() => { setReactionPost(null); setHighlightedReaction(null); }}
          onTouchEnd={() => {
            if (highlightedReaction) {
              submitReaction(reactionPost.id, highlightedReaction);
            } else {
              setReactionPost(null);
            }
            setHighlightedReaction(null);
          }}
        >
          <div
            className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md rounded-full px-6 py-4 shadow-2xl flex items-end gap-3.5 border border-outline-variant/10 animate-reaction-picker"
            onClick={(e) => e.stopPropagation()}
          >
            {Object.entries(REACTION_EMOJIS).map(([type, emoji]) => {
              const isHighlighted = highlightedReaction === type;
              return (
                <button
                  key={type}
                  data-reaction={type}
                  onMouseEnter={() => setHighlightedReaction(type)}
                  onMouseLeave={() => setHighlightedReaction(null)}
                  onClick={() => submitReaction(reactionPost.id, type)}
                  className={`flex flex-col items-center gap-1 cursor-pointer transition-all duration-200 origin-bottom select-none outline-none ${
                    isHighlighted ? 'scale-135 -translate-y-3.5' : 'hover:scale-110'
                  }`}
                  title={REACTION_LABELS[type]}
                >
                  <span className={`text-3xl transition-all ${
                    isHighlighted ? 'drop-shadow-[0_0_10px_rgba(244,167,185,0.7)]' : ''
                  }`}>
                    {emoji}
                  </span>
                  <span className={`text-[9px] font-black uppercase tracking-wider text-primary transition-all duration-150 h-3 ${
                    isHighlighted ? 'opacity-100 scale-100' : 'opacity-0 scale-75'
                  }`}>
                    {REACTION_LABELS[type]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Reaction Summary Popup -- read-only breakdown, opened by tapping the
          reaction row on a post card. Does not allow reacting or changing
          reactions; sizing/styling intentionally mirrors the reaction picker
          above (same pill/blur/shadow language) rather than introducing a
          new visual pattern. */}
      {reactionSummaryPost && (() => {
        // Looked up fresh from `posts` (rather than a snapshot taken when the
        // row was tapped) so if a reaction changes while this is open, the
        // breakdown stays in sync instead of showing stale counts.
        const summaryPost = posts.find(p => p.id === reactionSummaryPost);
        if (!summaryPost) return null;
        return (
          <div
            className="fixed inset-0 z-[200] bg-black/35 backdrop-blur-[2px] flex items-center justify-center animate-fade-in"
            onClick={() => setReactionSummaryPost(null)}
          >
            <div
              className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md rounded-3xl px-5 py-4 shadow-2xl border border-outline-variant/10 animate-reaction-picker max-w-[280px]"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-[9px] font-black uppercase tracking-widest text-zinc-400 mb-2.5 text-center">Reactions</p>
              <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                {sortedReactionEntries(summaryPost.reactions).map(([type, count]) => (
                  <div key={type} className="flex items-center gap-1.5">
                    <span className="text-xl leading-none">{REACTION_EMOJIS[type]}</span>
                    <span className="text-sm font-extrabold text-on-surface">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Reusable Share Sheet */}
      {sharePost && (
        <ShareSheetModal
          post={sharePost}
          onClose={() => setSharePost(null)}
        />
      )}

      {/* Reusable Report Post Dialog */}
      {reportPost && (
        <ReportPostModal
          post={reportPost}
          onClose={() => setReportPost(null)}
        />
      )}

      {deleteConfirmPost && (
        <div className="fixed inset-0 z-[99999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={(e) => e.target === e.currentTarget && setDeleteConfirmPost(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 sm:p-8 max-w-xs w-full shadow-2xl border border-outline-variant/20 text-center space-y-4 animate-scale-up">
            <div className="w-14 h-14 bg-rose-100 dark:bg-rose-950/50 text-rose-500 rounded-full flex items-center justify-center mx-auto text-2xl shadow-inner">
              <span className="material-symbols-outlined">delete</span>
            </div>
            <div>
              <h3 className="font-extrabold text-base text-on-surface">Delete this Memory?</h3>
              <p className="text-xs text-zinc-500 font-medium leading-relaxed mt-1">
                This action is permanent and cannot be undone.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmPost(null)}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl hover:bg-zinc-200 transition-colors uppercase tracking-wider cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = deleteConfirmPost.id;
                  setDeleteConfirmPost(null);
                  handleDeletePost(id);
                }}
                className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs rounded-xl transition-all shadow-md active:scale-95 uppercase tracking-wider cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}


      {/* Notifications Panel */}
      <NotificationsPanel
        isOpen={showNotifications}
        onClose={() => setShowNotifications(false)}
        onUnreadCountChange={setUnreadCount}
      />

      {/* Background decoration */}
      <div className="fixed top-0 left-0 w-full h-full pointer-events-none -z-20 overflow-hidden">
        <span className="material-symbols-outlined absolute top-[20%] left-[-5%] text-primary opacity-[0.03] text-[15rem] -rotate-12">pets</span>
        <span className="material-symbols-outlined absolute bottom-[10%] right-[-5%] text-primary opacity-[0.03] text-[20rem] rotate-45">pets</span>
      </div>
    </div>
  );
}
