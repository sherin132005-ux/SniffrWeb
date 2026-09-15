import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import CommentModal from './CommentModal';
import ShareSheetModal from './ShareSheetModal';
import ReportPostModal from './ReportPostModal';
import PostVideo from './PostVideo';

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

export default function GalleryViewerModal({ posts = [], initialIndex = 0, petName = 'Pet', isOwner = false, onClose, onPostLiked, onPostDeleted, onPostUpdated }) {
  const { pet: activePet } = useAuth();
  const [commentPostId, setCommentPostId] = useState(null);
  const [sharePost, setSharePost] = useState(null);
  const [reportPost, setReportPost] = useState(null);
  const [optionsPost, setOptionsPost] = useState(null);
  const [deleteConfirmPost, setDeleteConfirmPost] = useState(null);
  const [editPost, setEditPost] = useState(null);
  const [editCaption, setEditCaption] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [localPosts, setLocalPosts] = useState(posts);
  const postRefs = useRef([]);

  useEffect(() => {
    setLocalPosts(posts);
  }, [posts]);

  // Scroll to the tapped post when opened
  useEffect(() => {
    if (initialIndex >= 0 && postRefs.current[initialIndex]) {
      setTimeout(() => {
        postRefs.current[initialIndex]?.scrollIntoView({ behavior: 'auto', block: 'start' });
      }, 50);
    }
  }, [initialIndex]);

  // Guards against a rapid re-tap's earlier /like response landing after a
  // later one and stomping the state it already set (see HomePage.jsx's
  // toggleLike for the full explanation of this race).
  const likeSeqRef = useRef({});

  const toggleLike = async (postId) => {
    setLocalPosts(prev => prev.map(p => {
      if (p.id === postId) {
        const isLiked = p.is_liked ? 0 : 1;
        const count = p.is_liked ? Math.max(0, p.like_count - 1) : p.like_count + 1;
        if (onPostLiked) onPostLiked(postId, !!isLiked, count);
        return { ...p, is_liked: isLiked, like_count: count };
      }
      return p;
    }));

    const seq = (likeSeqRef.current[postId] || 0) + 1;
    likeSeqRef.current[postId] = seq;

    try {
      const d = await api.post(`/posts/${postId}/like`);
      if (likeSeqRef.current[postId] !== seq) return; // superseded by a newer tap
      likeSeqRef.current[postId] = 0; // settled -- future updates for this post can apply again
      setLocalPosts(prev => prev.map(p => {
        if (p.id === postId) {
          if (onPostLiked) onPostLiked(postId, d.liked, d.likeCount);
          return { ...p, is_liked: d.liked ? 1 : 0, like_count: d.likeCount };
        }
        return p;
      }));
    } catch (e) {
      if (likeSeqRef.current[postId] === seq) likeSeqRef.current[postId] = 0;
      console.error(e);
    }
  };

  const copyPostLink = (postId) => {
    const url = `${window.location.origin}/post/${postId}`;
    navigator.clipboard.writeText(url);
    setOptionsPost(null);
  };

  const handleDeletePost = async (postId) => {
    if (!window.confirm('Delete this post?')) return;
    try {
      await api.delete(`/posts/${postId}`);
      setLocalPosts(prev => prev.filter(p => p.id !== postId));
      if (onPostDeleted) onPostDeleted(postId);
    } catch (e) { console.error(e); }
  };

  // Editing lives here (the owner's own gallery / "Me" page) only -- this is
  // the sole place a post's caption can be edited from.
  const handleSaveEdit = async () => {
    if (!editPost) return;
    setEditSaving(true);
    try {
      const res = await api.put(`/posts/${editPost.id}`, { caption: editCaption });
      setLocalPosts(prev => prev.map(p => p.id === editPost.id ? { ...p, caption: res.post.caption } : p));
      if (onPostUpdated) onPostUpdated(editPost.id, res.post.caption);
      setEditPost(null);
    } catch (e) {
      console.error(e);
    } finally {
      setEditSaving(false);
    }
  };

  return createPortal(
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 99990,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Gallery Viewer Overlay Header */}
      <div className="flex justify-between items-center px-6 py-4 border-b border-zinc-200/60 dark:border-zinc-800 bg-white/70 dark:bg-zinc-900/70 backdrop-blur-md flex-shrink-0 z-10">
        <div>
          <h3 className="font-extrabold text-on-surface text-lg tracking-tight">{petName}'s Gallery 🐾</h3>
          <p className="text-xs text-zinc-400 font-bold">{localPosts.length} memories</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-500 hover:text-on-surface flex items-center justify-center transition-transform active:scale-90"
        >
          <span className="material-symbols-outlined text-xl">close</span>
        </button>
      </div>

      {/* Scrollable Single-Pet Posts List */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 max-w-xl mx-auto w-full no-scrollbar">
        {localPosts.map((post, idx) => (
          <article
            key={post.id}
            ref={el => postRefs.current[idx] = el}
            className="bg-white dark:bg-zinc-900 rounded-[2.5rem] overflow-hidden shadow-2xl border border-zinc-100 dark:border-zinc-800 text-left"
          >
            {/* Post Header */}
            <div className="flex items-center justify-between p-5 select-none">
              <div className="flex items-center gap-3">
                <img
                  src={post.pet_avatar || '/logo.png'}
                  alt={post.pet_name || petName}
                  className="w-11 h-11 rounded-full object-cover border-2 border-primary/20"
                />
                <div>
                  <h4 className="font-bold text-on-surface text-sm">{post.pet_name || petName}</h4>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant/60">
                    {post.distance ? `${post.distance.toFixed(1)} km away` : post.location_text || 'Nearby'}
                  </p>
                </div>
              </div>

              {/* Options */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setOptionsPost(optionsPost?.id === post.id ? null : post)}
                  className="w-9 h-9 rounded-full hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-center transition-colors"
                >
                  <span className="material-symbols-outlined text-zinc-400 text-xl">more_horiz</span>
                </button>

                {optionsPost?.id === post.id && (() => {
                  const isPostOwner = isOwner || (activePet && (post.pet_id === activePet.id || post.author_pet_id === activePet.id));
                  return (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setOptionsPost(null)} />
                      <div className="absolute right-0 top-10 w-36 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-outline-variant/10 py-1 z-30 animate-scale-up">
                        <button
                          type="button"
                          onClick={() => copyPostLink(post.id)}
                          className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-on-surface flex items-center gap-2 cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-sm text-zinc-400">link</span>
                          <span>Copy Link</span>
                        </button>
                        {isPostOwner ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setEditPost(post);
                                setEditCaption(post.caption || '');
                                setOptionsPost(null);
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-on-surface flex items-center gap-2 border-t border-zinc-100/50 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-sm text-zinc-400">edit</span>
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => { setDeleteConfirmPost(post); setOptionsPost(null); }}
                              className="w-full text-left px-4 py-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-bold text-rose-600 flex items-center gap-2 border-t border-zinc-100/50 cursor-pointer"
                            >
                              <span className="material-symbols-outlined text-sm text-rose-600">delete</span>
                              <span>Delete</span>
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setReportPost(post); setOptionsPost(null); }}
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
              <div className="relative bg-black/5 flex items-center justify-center" style={{ maxHeight: 'min(480px, 70vh)' }}>
                {post.media_type === 'video' ? (
                  <PostVideo src={post.media_url} />
                ) : (
                  <img src={post.media_url} alt={post.caption || 'Memory'} className="w-full max-h-full object-contain" style={{ maxHeight: 'min(480px, 70vh)' }} />
                )}
              </div>
            )}

            {/* Caption & Actions */}
            <div className="p-5 space-y-3">
              {post.caption && (
                <p className="text-sm font-medium text-on-surface leading-relaxed">{post.caption}</p>
              )}

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-2 border-t border-outline-variant/10">
                <div className="flex items-center gap-6">
                  {/* Lick */}
                  <button
                    type="button"
                    onClick={() => toggleLike(post.id)}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors h-9"
                  >
                    <PawLikeIcon active={post.is_liked} className="w-5 h-5" />
                    {post.like_count > 0 && <span className="font-bold text-xs">{post.like_count}</span>}
                  </button>

                  {/* Comment */}
                  <button
                    type="button"
                    onClick={() => setCommentPostId(post.id)}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-secondary transition-colors h-9"
                  >
                    <BoneIcon className="w-5 h-5 text-on-surface-variant/60" />
                    {post.comment_count > 0 && <span className="font-bold text-xs">{post.comment_count}</span>}
                  </button>

                  {/* Share */}
                  <button
                    type="button"
                    onClick={() => setSharePost(post)}
                    className="flex items-center gap-2 text-on-surface-variant hover:text-tertiary transition-colors h-9"
                  >
                    <ShareIcon className="w-5 h-5 text-on-surface-variant/60" />
                  </button>
                </div>
              </div>

              {/* Timestamp */}
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-zinc-400 pt-1">
                {formatRelativeTimestamp(post.created_at)}
              </p>
            </div>
          </article>
        ))}
      </div>

      {/* Sub-modals */}
      {commentPostId && (
        <CommentModal
          postId={commentPostId}
          onClose={() => setCommentPostId(null)}
          onCommentAdded={(pid) => {
            setLocalPosts(prev => prev.map(p => p.id === pid ? { ...p, comment_count: (p.comment_count || 0) + 1 } : p));
          }}
          onCommentDeleted={(pid) => {
            setLocalPosts(prev => prev.map(p => p.id === pid ? { ...p, comment_count: Math.max(0, (p.comment_count || 0) - 1) } : p));
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

      {editPost && (
        <div className="fixed inset-0 z-[99999] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={(e) => e.target === e.currentTarget && !editSaving && setEditPost(null)}>
          <div className="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-6 sm:p-8 max-w-sm w-full shadow-2xl border border-outline-variant/20 space-y-4 animate-scale-up">
            <div className="flex items-center justify-between">
              <h3 className="font-extrabold text-base text-on-surface flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">edit</span> Edit Post
              </h3>
              <button
                onClick={() => !editSaving && setEditPost(null)}
                disabled={editSaving}
                className="w-8 h-8 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 flex items-center justify-center disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-base">close</span>
              </button>
            </div>
            <textarea
              rows={4}
              value={editCaption}
              onChange={e => setEditCaption(e.target.value)}
              placeholder="Update your caption..."
              className="w-full px-4 py-3 rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 text-sm font-medium focus:ring-2 focus:ring-primary outline-none resize-none"
            />
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditPost(null)}
                disabled={editSaving}
                className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-extrabold text-xs rounded-xl uppercase tracking-wider disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={editSaving}
                className="flex-1 py-3 bg-primary hover:bg-primary/90 text-white font-extrabold text-xs rounded-xl shadow-md active:scale-95 uppercase tracking-wider disabled:opacity-50"
              >
                {editSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
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
