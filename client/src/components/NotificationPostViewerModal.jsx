import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { useSocket } from '../context/SocketContext';
import CommentModal from './CommentModal';
import ShareSheetModal from './ShareSheetModal';
import ReportPostModal from './ReportPostModal';
import PostVideo from './PostVideo';

// ── Custom SVG Icon Components matching Home Feed ──
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

const DECORATIVE_ASSETS = [
  { src: '/paw-rainbow-top.png', x: -72, y: -55, className: 'animate-rainbow-top w-12 h-10' },
  { src: '/paw-rainbow-bottom.png', x: -80, y: 42, className: 'animate-rainbow-bottom w-11 h-10' },
  { src: '/paw-star-pink.png', x: 73, y: -54, className: 'animate-star-pop w-8 h-8' },
  { src: '/paw-star-purple.png', x: 60, y: -72, className: 'animate-star-pop w-6 h-6' },
  { src: '/paw-leaf-left.png', x: -87, y: 20, className: 'animate-leaf-left w-7 h-8' },
  { src: '/paw-leaf-right.png', x: 77, y: 40, className: 'animate-leaf-right w-8 h-9' },
  { src: '/paw-sparkle-1.png', x: 85, y: 48, className: 'animate-sparkle-twinkle w-7 h-5' },
  { src: '/paw-sparkle-2.png', x: 88, y: -36, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-3.png', x: -55, y: -76, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-4.png', x: 88, y: 21, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-sparkle-5.png', x: -68, y: 57, className: 'animate-sparkle-twinkle w-5 h-5' },
  { src: '/paw-dot-1.png', x: -90, y: -35, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '-3px' } },
  { src: '/paw-dot-2.png', x: -96, y: 30, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '3px' } },
  { src: '/paw-dot-3.png', x: 79, y: -71, className: 'animate-dot-float w-4 h-4', style: { '--dx': '6px', '--dy': '-5px' } },
  { src: '/paw-dot-4.png', x: 93, y: 35, className: 'animate-dot-float w-4 h-4', style: { '--dx': '7px', '--dy': '3px' } },
  { src: '/paw-dot-5.png', x: 90, y: -51, className: 'animate-dot-float w-4 h-4', style: { '--dx': '6px', '--dy': '-4px' } },
  { src: '/paw-dot-6.png', x: -89, y: -24, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-6px', '--dy': '-2px' } },
  { src: '/paw-dot-7.png', x: -57, y: -65, className: 'animate-dot-float w-4 h-4', style: { '--dx': '-4px', '--dy': '-5px' } }
];

function formatRelativeTimestamp(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'Just now';
  if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? 'min' : 'mins'} ago`;
  if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function NotificationPostViewerModal({ postId, autoOpenComments = false, onClose }) {
  const { pet: activePet } = useAuth();
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [commentPostId, setCommentPostId] = useState(autoOpenComments ? postId : null);
  const [sharePost, setSharePost] = useState(null);
  const [reportPost, setReportPost] = useState(null);
  const [deleteConfirmPost, setDeleteConfirmPost] = useState(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [copyToast, setCopyToast] = useState(null);
  // Sequence guard for the like race described where toggleLike is defined.
  const likeSeqRef = useRef(0);

  const handleDeletePost = async (pId) => {
    try {
      await api.delete(`/posts/${pId}`);
      onClose();
    } catch (e) {
      console.error(e);
    }
  };

  // Double-tap paw animation & Swipe-to-profile state
  const [doubleTapActive, setDoubleTapActive] = useState(false);
  const [swipeDistance, setSwipeDistance] = useState(0);
  const [isSwipingResetting, setIsSwipingResetting] = useState(false);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const postSwipeActive = useRef(false);
  const lastTapRef = useRef(0);

  const navigate = useNavigate();
  const { socket } = useSocket() || {};

  useEffect(() => {
    if (!postId) return;
    const fetchPost = async () => {
      setLoading(true);
      try {
        const res = await api.get(`/posts/${postId}`);
        if (res && res.post) {
          setPost(res.post);
          if (autoOpenComments) {
            setCommentPostId(res.post.id);
          }
        }
      } catch (err) {
        console.error('Error fetching post:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchPost();
  }, [postId, autoOpenComments]);

  // Real-time socket listeners
  useEffect(() => {
    if (!socket || !postId) return;

    const handlePostLiked = (data) => {
      // Server payload is { post_id, liked, like_count } -- and while a
      // local /like request for this post is in flight, that request's own
      // response is authoritative; applying this broadcast (an echo of
      // every like/unlike, including this client's own) in between is what
      // caused a quick re-tap to visibly flicker/revert.
      if (data.post_id === parseInt(postId, 10) && !likeSeqRef.current) {
        setPost(prev => prev ? { ...prev, is_liked: data.liked ? 1 : 0, like_count: data.like_count } : prev);
      }
    };

    const handlePostCommented = (data) => {
      if (data.post_id === parseInt(postId, 10)) {
        setPost(prev => prev ? { ...prev, comment_count: (prev.comment_count || 0) + 1 } : prev);
      }
    };

    const handleCommentDeleted = (data) => {
      if (data.post_id === parseInt(postId, 10)) {
        setPost(prev => prev ? { ...prev, comment_count: Math.max(0, (prev.comment_count || 0) - 1) } : prev);
      }
    };

    // Same "post deleted elsewhere" staleness risk as the feed/gallery --
    // this modal fetches its post once on mount and otherwise never
    // refreshes, so without this it would keep a deleted post fully
    // visible and interactive. Mirrors handleDeletePost's own onClose()
    // call above for a self-initiated delete.
    const handlePostDeleted = ({ post_id }) => {
      if (post_id === parseInt(postId, 10)) {
        onClose();
      }
    };

    socket.on('post_liked', handlePostLiked);
    socket.on('post_commented', handlePostCommented);
    socket.on('comment_deleted', handleCommentDeleted);
    socket.on('post_deleted', handlePostDeleted);

    return () => {
      socket.off('post_liked', handlePostLiked);
      socket.off('post_commented', handlePostCommented);
      socket.off('comment_deleted', handleCommentDeleted);
      socket.off('post_deleted', handlePostDeleted);
    };
  }, [socket, postId]);

  // Guards against a rapid re-tap's earlier /like response landing after a
  // later one and stomping the state it already set (see HomePage.jsx's
  // toggleLike for the full explanation of this race).
  const toggleLike = async () => {
    if (!post) return;
    const postId = post.id;
    // Computed inside the functional updater (from `prev`, not the outer
    // `post` closure) so a second toggleLike() call fired moments later
    // (e.g. a stray double-tap-gesture invocation racing this button's own
    // click) correctly flips the state IT sees, instead of both calls
    // reading the same stale pre-tap values and both computing "like".
    setPost(prev => {
      if (!prev) return prev;
      const isLiked = prev.is_liked ? 0 : 1;
      const count = prev.is_liked ? Math.max(0, prev.like_count - 1) : prev.like_count + 1;
      return { ...prev, is_liked: isLiked, like_count: count };
    });

    const seq = likeSeqRef.current + 1;
    likeSeqRef.current = seq;

    try {
      const d = await api.post(`/posts/${postId}/like`);
      if (likeSeqRef.current !== seq) return; // superseded by a newer tap
      likeSeqRef.current = 0; // settled -- live broadcasts can apply again
      setPost(prev => prev ? { ...prev, is_liked: d.liked ? 1 : 0, like_count: d.likeCount } : prev);
    } catch (e) {
      if (likeSeqRef.current === seq) likeSeqRef.current = 0;
      console.error(e);
    }
  };

  const likePostOnly = async () => {
    if (post && post.is_liked) return;
    toggleLike();
  };

  const handleDoubleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 350) {
      setDoubleTapActive(true);
      likePostOnly();
      setTimeout(() => setDoubleTapActive(false), 850);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  };

  // Swipe-to-profile touch handlers
  const handleTouchStart = (e) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    postSwipeActive.current = false;
  };

  const handleTouchMove = (e) => {
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = Math.abs(e.touches[0].clientY - touchStartY.current);

    if (dx > 15 && dx > dy) {
      postSwipeActive.current = true;
      setSwipeDistance(Math.min(180, dx));
    }
  };

  const handleTouchEnd = () => {
    const distance = swipeDistance;
    if (postSwipeActive.current && distance > 90) {
      setSwipeDistance(220);
      setTimeout(() => {
        const targetPetId = post?.pet_id || post?.user_id;
        if (targetPetId) {
          onClose();
          navigate(`/profile/${targetPetId}`);
        }
        setSwipeDistance(0);
      }, 350);
    } else if (postSwipeActive.current) {
      setIsSwipingResetting(true);
      setSwipeDistance(0);
      setTimeout(() => setIsSwipingResetting(false), 400);
    }

    const wasSwipe = postSwipeActive.current;
    postSwipeActive.current = false;

    if (!wasSwipe && distance < 10) {
      handleDoubleTap();
    }
  };

  const copyPostLink = () => {
    if (!post) return;
    const url = `${window.location.origin}/post/${post.id}`;
    navigator.clipboard.writeText(url);
    setCopyToast('✅ Link copied to clipboard');
    setTimeout(() => setCopyToast(null), 2000);
    setOptionsOpen(false);
  };

  const handleProfileClick = () => {
    const targetPetId = post?.pet_id || post?.user_id;
    if (targetPetId) {
      onClose();
      navigate(`/profile/${targetPetId}`);
    }
  };

  if (!postId) return null;

  const swipeProgress = swipeDistance / 180;

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 99995,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Viewer Header */}
      <div className="flex justify-between items-center px-6 py-4 border-b border-zinc-200/60 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-md flex-shrink-0 z-10">
        <div>
          <h3 className="font-extrabold text-on-surface text-lg tracking-tight">Notification Post 🐾</h3>
          <p className="text-xs text-zinc-400 font-bold">Single post view</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-500 hover:text-on-surface flex items-center justify-center transition-transform active:scale-90"
        >
          <span className="material-symbols-outlined text-xl">close</span>
        </button>
      </div>

      {/* Copy Toast */}
      {copyToast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[300] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-4 py-2 rounded-full text-xs font-extrabold shadow-lg animate-bounce pointer-events-none">
          {copyToast}
        </div>
      )}

      {/* Main Content Area -- this outer element is the ONLY scroll owner
          (plain overflow-y-auto, no flex/justify-content on it). Centering
          for short content lives on the INNER wrapper below instead, which
          is never itself the overflow container -- so when the post is
          taller than the viewport, the inner wrapper simply grows to fit it
          and the outer element scrolls it with plain, unambiguous block-level
          overflow. Combining overflow:auto with justify-content:center on
          the SAME element (the previous layout) is a well-known flexbox
          defect where content taller than the container can't be fully
          scrolled into view -- keep these two concerns on separate elements. */}
      <div className="flex-1 overflow-y-auto no-scrollbar">
      <div className="min-h-full flex flex-col justify-center p-4 sm:p-6 max-w-xl mx-auto w-full">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 space-y-3">
            <div className="w-10 h-10 border-3 border-primary border-t-transparent rounded-full animate-spin" />
            <p className="text-xs font-bold text-zinc-400">Loading referenced post...</p>
          </div>
        ) : !post ? (
          <div className="text-center py-20 space-y-3 bg-white dark:bg-zinc-900 rounded-[2.5rem] p-8 shadow-xl border border-zinc-100 dark:border-zinc-800">
            <div className="w-14 h-14 rounded-full bg-rose-50 text-rose-500 flex items-center justify-center text-2xl mx-auto">
              🐾
            </div>
            <h3 className="text-base font-extrabold text-on-surface">Post Unavailable</h3>
            <p className="text-xs text-zinc-400">This memory may have been removed by its owner.</p>
          </div>
        ) : (
          <article className="relative bg-white dark:bg-zinc-900 rounded-[2.5rem] overflow-hidden shadow-2xl border border-zinc-100 dark:border-zinc-800 text-left">
            {/* Peek Pet Animation Behind Sliding Card */}
            {swipeDistance > 0 && (
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

            {/* Swipeable Card Content */}
            <div
              className="relative z-10 bg-white dark:bg-zinc-900 overflow-hidden"
              style={{
                transform: swipeDistance > 0 ? `translateX(${swipeDistance}px) scale(${1 - swipeProgress * 0.02})` : 'translateX(0px)',
                transition: isSwipingResetting ? 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
                touchAction: 'pan-y'
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              {/* Post Header */}
              <div className="flex items-center justify-between p-5 select-none">
                <div
                  onClick={handleProfileClick}
                  className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
                >
                  <img
                    src={post.pet_avatar || '/logo.png'}
                    alt={post.pet_name || 'Pet'}
                    className="w-11 h-11 rounded-full object-cover border-2 border-primary/20 shadow-xs"
                  />
                  <div>
                    <h4 className="font-bold text-on-surface text-sm hover:text-primary transition-colors">{post.pet_name || 'Pet'}</h4>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
                      {post.distance ? `${post.distance.toFixed(1)} km away` : post.location_text || 'Nearby'}
                    </p>
                  </div>
                </div>

                {/* Options Menu */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setOptionsOpen(!optionsOpen)}
                    className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
                  >
                    <span className="material-symbols-outlined text-zinc-400 text-xl">more_horiz</span>
                  </button>

                  {optionsOpen && (() => {
                    const isPostOwner = activePet && (post.pet_id === activePet.id || post.author_pet_id === activePet.id);
                    return (
                      <>
                        <div className="fixed inset-0 z-20" onClick={() => setOptionsOpen(false)} />
                        <div className="absolute right-0 top-10 w-40 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-outline-variant/10 py-1 z-30 animate-scale-up">
                          <button
                            type="button"
                            onClick={handleProfileClick}
                            className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-on-surface flex items-center gap-2 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-sm text-zinc-400">person</span>
                            <span>View Profile</span>
                          </button>
                          <button
                            type="button"
                            onClick={copyPostLink}
                            className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-on-surface flex items-center gap-2 border-t border-zinc-100/50 cursor-pointer"
                          >
                            <span className="material-symbols-outlined text-sm text-zinc-400">link</span>
                            <span>Copy Link</span>
                          </button>
                          {isPostOwner ? (
                            <button
                              type="button"
                              onClick={() => { setDeleteConfirmPost(post); setOptionsOpen(false); }}
                              className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-rose-600 flex items-center gap-2 border-t border-zinc-100/50 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-sm text-rose-600">delete</span>
                              <span>Delete</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => { setReportPost(post); setOptionsOpen(false); }}
                              className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-rose-600 flex items-center gap-2 border-t border-zinc-100/50 cursor-pointer"
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
                  className="relative bg-zinc-50 dark:bg-zinc-800 flex items-center justify-center select-none"
                  style={{ maxHeight: 'min(480px, 70vh)' }}
                  onDoubleClick={() => {
                    // Touch devices get this via onTouchStart/Move/End above;
                    // mouse/trackpad never triggers those, so double-click
                    // was silently doing nothing outside a touchscreen.
                    setDoubleTapActive(true);
                    likePostOnly();
                    setTimeout(() => setDoubleTapActive(false), 850);
                  }}
                >
                  {post.media_type === 'video' ? (
                    <PostVideo src={post.media_url} />
                  ) : (
                    <img src={post.media_url} alt={post.caption || 'Memory'} className="w-full max-h-full object-contain" style={{ maxHeight: 'min(480px, 70vh)' }} draggable={false} />
                  )}

                  {/* Double-tap Paw Animation Overlay */}
                  {doubleTapActive && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
                      <div className="relative w-40 h-40">
                        <img
                          src="/paw-center.png"
                          alt="Paw center"
                          className="absolute inset-0 w-full h-full object-contain animate-double-tap-paw-center drop-shadow-[0_8px_24px_rgba(244,167,185,0.35)]"
                        />
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

              {/* Caption & Action Bar */}
              <div className="p-5 space-y-3">
                {post.caption && (
                  <p className="text-sm font-medium text-on-surface leading-relaxed">{post.caption}</p>
                )}

                {/* Action Buttons */}
                <div className="flex items-center gap-7 pt-3 border-t border-outline-variant/10">
                  {/* Lick */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); toggleLike(); }}
                    onTouchStart={(e) => e.stopPropagation()}
                    onTouchEnd={(e) => e.stopPropagation()}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-all group/btn h-9"
                  >
                    <PawLikeIcon active={post.is_liked} className="w-[22px] h-[22px] group-hover/btn:scale-110" />
                    {post.like_count > 0 && <span className="font-bold text-xs text-on-surface-variant/80">{post.like_count}</span>}
                  </button>

                  {/* Comment */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setCommentPostId(post.id); }}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-secondary transition-all group/btn h-9"
                  >
                    <BoneIcon className="w-[22px] h-[22px] group-hover/btn:scale-110 transition-transform text-on-surface-variant/60" />
                    {post.comment_count > 0 && <span className="font-bold text-xs text-on-surface-variant/80">{post.comment_count}</span>}
                  </button>

                  {/* Share */}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSharePost(post); }}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-tertiary transition-all group/btn h-9"
                  >
                    <ShareIcon className="w-[21px] h-[21px] group-hover/btn:rotate-12 transition-transform text-on-surface-variant/60" />
                  </button>
                </div>

                {/* Timestamp */}
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-400 pt-1">
                  {formatRelativeTimestamp(post.created_at)}
                </p>
              </div>
            </div>
          </article>
        )}
      </div>
      </div>

      {/* Sub-modals */}
      {commentPostId && (
        <CommentModal
          postId={commentPostId}
          onClose={() => setCommentPostId(null)}
          onCommentAdded={() => {
            // Intentionally left empty: the 'post_commented' socket broadcast
            // (already listened for above) increments comment_count for
            // every viewer, including whoever just commented -- doing it
            // here TOO would double-increment it for that person specifically.
          }}
          onCommentDeleted={() => {
            // Same reasoning -- 'comment_deleted' is handled by the socket
            // listener for every viewer, including the deleter.
          }}
        />
      )}

      {sharePost && (
        <ShareSheetModal
          post={sharePost}
          onClose={() => setSharePost(null)}
        />
      )}

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
    </div>,
    document.body
  );
}
