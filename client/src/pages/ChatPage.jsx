import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import { useCall } from '../context/CallContext';
import api from '../services/api';
import CallHistory from '../components/CallHistory';
import PawCircleTab from '../components/PawCircleTab';
import SharedPostViewerModal from '../components/SharedPostViewerModal';
import Portal from '../components/Portal';
import usePullToRefresh from '../hooks/usePullToRefresh';
import PremiumBadge from '../components/PremiumBadge';
import useTypingSignal from '../hooks/useTypingSignal';
import useMessageInteractions from '../hooks/useMessageInteractions';
import TypingDots from '../components/chat/TypingDots';
import { REACTION_EMOJIS, REACTION_LABELS } from '../constants/reactions';
import PostVideo from '../components/PostVideo';
import { avatarUrl, thumbnailUrl } from '../utils/media';
import UpsellModal from '../components/UpsellModal';
import { isQuotaExceededError, quotaUpsellCopy } from '../utils/premiumErrors';

// emoji-picker-react's emoji dataset adds ~330KB to whatever chunk imports
// it eagerly -- ChatPage is already the app's largest route chunk, and most
// chat sessions never open the picker at all. Split into its own chunk,
// fetched only the first time someone actually taps the emoji button.
const EmojiPicker = lazy(() => import('emoji-picker-react'));

function formatPresence(isOnline, lastActiveAt) {
  if (isOnline) return 'Active now';
  if (!lastActiveAt) return 'Offline';
  
  const date = new Date(lastActiveAt);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  
  if (diffMins < 60) {
    const m = Math.max(1, diffMins);
    return `Last active ${m} minute${m > 1 ? 's' : ''} ago`;
  }
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (yesterday.toDateString() === date.toDateString()) {
      return 'Last active yesterday';
    }
    return `Last active ${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  }
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return 'Last active yesterday';
  }
  return `Last active ${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

// ─── Shared Post Card ──────────────────────────────────────────
function SharedPostCard({ postId, onOpenViewer }) {
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!postId) return;
    const fetchPost = async () => {
      try {
        const res = await api.get(`/posts/${postId}`);
        if (res && res.post) {
          setPost(res.post);
        }
      } catch (err) {
        console.error("Error fetching shared post:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchPost();
  }, [postId]);

  const handleTap = (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (onOpenViewer && postId) {
      onOpenViewer(postId);
    }
  };

  if (loading) {
    return (
      <div
        onClick={handleTap}
        className="w-52 p-4 bg-zinc-50 dark:bg-zinc-800 rounded-[2rem] animate-pulse flex items-center justify-center cursor-pointer select-none"
      >
        <span className="paw-trail-dot text-sm text-primary">🐾</span>
      </div>
    );
  }

  if (!post) {
    return (
      <div
        onClick={handleTap}
        className="w-52 p-4 bg-zinc-100 dark:bg-zinc-800 rounded-[2rem] text-zinc-400 text-xs font-bold text-center cursor-pointer select-none"
      >
        🐾 Post unavailable
      </div>
    );
  }

  return (
    <div
      onClick={handleTap}
      className="w-56 bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-[2rem] overflow-hidden shadow-md cursor-pointer hover:shadow-lg transition-all active:scale-[0.98] select-none text-left"
    >
      {post.media_url && (
        <div className="w-full h-32 relative bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
          {post.media_type === 'video' ? (
            <PostVideo src={post.media_url} controls={false} fill />
          ) : (
            <img src={thumbnailUrl(post.media_url)} alt="Thumbnail" loading="lazy" decoding="async" className="w-full h-full object-cover" />
          )}
          <div className="absolute top-2 left-2 bg-black/40 backdrop-blur-sm text-[8px] text-white font-extrabold uppercase tracking-widest px-2.5 py-1 rounded-full flex items-center gap-1">
            <span className="material-symbols-outlined text-[9px] font-bold text-pink-400">pets</span>
            <span>Memory</span>
          </div>
        </div>
      )}

      <div className="p-3.5 space-y-2">
        <div className="flex items-center gap-2">
          <img src={avatarUrl(post.pet_avatar) || '/logo.png'} alt={post.pet_name} loading="lazy" decoding="async" className="w-6 h-6 rounded-full object-cover border" />
          <span className="font-black text-[11px] text-on-surface-variant tracking-tight">{post.pet_name}</span>
        </div>
        {post.caption && (
          <p className="text-[10px] text-zinc-500 font-bold leading-normal line-clamp-2">{post.caption}</p>
        )}
        <button
          type="button"
          onClick={handleTap}
          className="w-full py-1.5 bg-primary/10 hover:bg-primary/15 text-primary font-black text-[9px] uppercase tracking-widest rounded-full transition-all flex items-center justify-center gap-1"
        >
          <span className="material-symbols-outlined text-[11px] font-bold">visibility</span>
          View Post
        </button>
      </div>
    </div>
  );
}

// ─── Custom Voice Playback Component with Paw timeline ──────────
function VoicePlayer({ audioUrl }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const audioRef = useRef(null);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onTimeUpdate = () => {
      if (audio.duration) {
        setProgress((audio.currentTime / audio.duration) * 100);
      }
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
    };
  }, [audioUrl]);

  return (
    <div className="flex items-center gap-3 bg-zinc-50 dark:bg-zinc-800 rounded-full px-4 py-2 border border-zinc-100 dark:border-zinc-800 max-w-[240px]">
      <audio ref={audioRef} src={audioUrl} className="hidden" />
      <button
        type="button"
        onClick={togglePlay}
        className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md active:scale-90 transition-transform flex-shrink-0"
      >
        <span className="material-symbols-outlined text-sm">{playing ? 'pause' : 'play_arrow'}</span>
      </button>
      
      <div className="flex-1 pr-2 min-w-[120px]">
        <div className="paw-playback-timeline w-full">
          <div className="paw-playback-progress animate-pulse" style={{ width: `${progress}%` }} />
          <div className="paw-playback-head text-primary drop-shadow-sm" style={{ left: `${progress}%` }}>🐾</div>
        </div>
      </div>
    </div>
  );
}

// ─── Shared Pet Profile Card ──────────────────────────────────────
function SharedPetCard({ petId, onStartChat }) {
  const [pet, setPet] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchPet = async () => {
      try {
        const idToFetch = parseInt(petId, 10);
        if (isNaN(idToFetch)) {
          const searchRes = await api.get(`/chat/search?q=${encodeURIComponent(petId)}`);
          if (searchRes?.results?.length > 0) {
            const found = searchRes.results.find(p => 
              (p.pet_username && p.pet_username.toLowerCase() === petId.toLowerCase()) ||
              p.name.toLowerCase() === petId.toLowerCase()
            ) || searchRes.results[0];
            const fullPetRes = await api.get(`/profile/${found.id}`);
            setPet(fullPetRes?.pet || found);
          }
        } else {
          const res = await api.get(`/profile/${idToFetch}`);
          if (res && res.pet) setPet(res.pet);
        }
      } catch (err) {
        console.error('Failed to load shared pet profile card:', err);
      } finally {
        setLoading(false);
      }
    };
    if (petId) fetchPet();
  }, [petId]);

  if (loading) {
    return (
      <div className="w-64 p-5 bg-gradient-to-br from-pink-50/50 via-rose-50/50 to-amber-50/50 dark:from-zinc-900 dark:to-zinc-800 rounded-[2.2rem] border border-pink-100/60 dark:border-zinc-800 shadow-sm animate-pulse flex flex-col items-center justify-center min-h-[210px]">
        <div className="w-20 h-20 rounded-full bg-zinc-200 dark:bg-zinc-700 mb-3" />
        <div className="h-4 w-28 bg-zinc-200 dark:bg-zinc-700 rounded mb-1.5" />
        <div className="h-3 w-20 bg-zinc-200 dark:bg-zinc-700 rounded" />
      </div>
    );
  }

  if (!pet) return null;

  const cleanUsername = (pet.pet_username || pet.owner_username || pet.name || '').replace(/^@+/, '');
  const displayUsername = `@${cleanUsername}`;
  const displayName = pet.name;

  const handleView = (e) => {
    e.stopPropagation();
    navigate(`/profile/${pet.id}`);
  };

  const handleChat = (e) => {
    e.stopPropagation();
    if (onStartChat) {
      onStartChat(pet.id);
    }
  };

  return (
    <div className="w-64 max-w-full bg-gradient-to-br from-pink-50/90 via-rose-50/70 to-amber-50/90 dark:from-zinc-900 dark:via-zinc-900 dark:to-zinc-800 border border-pink-100/90 dark:border-zinc-800 rounded-[2.2rem] p-5 shadow-md hover:shadow-lg transition-all text-center flex flex-col items-center select-none">
      <img
        src={thumbnailUrl(pet.avatar_url || pet.pet_avatar) || '/logo.png'}
        alt={displayName}
        loading="lazy"
        decoding="async"
        className="w-20 h-20 rounded-full object-cover border-4 border-white dark:border-zinc-800 shadow-md mb-3"
      />

      <h4 className="font-extrabold text-sm text-on-surface tracking-tight leading-tight truncate max-w-full">
        {displayUsername}
      </h4>

      <p className="text-xs text-zinc-500 dark:text-zinc-400 font-medium mt-0.5 truncate max-w-full">
        {displayName}
      </p>

      <div className="w-full border-t border-zinc-200/60 dark:border-zinc-800 my-3.5" />

      <div className="flex gap-2.5 w-full">
        <button
          type="button"
          onClick={handleView}
          className="flex-1 py-2.5 px-3 bg-white dark:bg-zinc-800 hover:bg-zinc-50 text-zinc-700 dark:text-zinc-200 border border-zinc-200/80 dark:border-zinc-700 rounded-full text-[11px] font-black uppercase tracking-wider shadow-sm transition-transform active:scale-95 flex items-center justify-center gap-1.5"
        >
          <span>👀</span>
          <span>View</span>
        </button>

        <button
          type="button"
          onClick={handleChat}
          className="flex-1 py-2.5 px-3 bg-primary hover:bg-primary-fixed-dim text-white rounded-full text-[11px] font-black uppercase tracking-wider shadow-sm transition-transform active:scale-95 flex items-center justify-center gap-1.5"
        >
          <span>💬</span>
          <span>Chat</span>
        </button>
      </div>
    </div>
  );
}

// ─── Meetup Invitation Card ──────────────────────────────────────
function MeetupCard({ messageId, content, onStatusUpdate }) {
  let details = { location: 'Cubbon Park', date_time: 'Saturday • 5:00 PM', status: 'pending', note: '' };
  try {
    details = JSON.parse(content);
  } catch {}

  const handleAction = async (action) => {
    try {
      const res = await api.post(`/chat/meetup/${messageId}`, { status: action });
      if (res.message) {
        onStatusUpdate(res.message);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="w-60 bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-[2rem] p-4 shadow-md text-left space-y-3 relative">
      <div className="flex items-center gap-2 text-primary">
        <span className="material-symbols-outlined text-lg">location_on</span>
        <h4 className="font-extrabold text-xs uppercase tracking-wider">Meetup Invitation</h4>
      </div>
      <div>
        <p className="text-xs font-black text-on-surface">{details.location}</p>
        <p className="text-[10px] text-zinc-400 font-bold mt-0.5">{details.date_time}</p>
        {details.note && (
          <p className="text-[9px] bg-zinc-50 p-2 rounded-lg border text-zinc-500 italic mt-2">{details.note}</p>
        )}
      </div>

      {details.status === 'pending' ? (
        <div className="flex gap-2">
          <button
            onClick={() => handleAction('declined')}
            className="flex-1 py-2 bg-zinc-100 hover:bg-zinc-200 text-on-surface-variant text-[9px] font-black uppercase tracking-widest rounded-full transition-all"
          >
            Decline
          </button>
          <button
            onClick={() => handleAction('accepted')}
            className="flex-1 py-2 bg-primary text-white text-[9px] font-black uppercase tracking-widest rounded-full shadow-sm hover:opacity-90 transition-all"
          >
            Accept
          </button>
        </div>
      ) : (
        <div className="pt-1 text-center">
          <span className={`inline-block text-[9px] font-black uppercase tracking-widest px-3 py-1 rounded-full border
            ${details.status === 'accepted' ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-red-50 text-red-500 border-red-200'}`}>
            {details.status === 'accepted' ? '✅ Invitation Accepted' : '❌ Invitation Declined'}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── File Attachment Card ──────────────────────────────────────────
function FileCard({ filename, mediaUrl }) {
  return (
    <div className="flex items-center gap-3 p-3 bg-zinc-50 dark:bg-zinc-800 border rounded-2xl text-left max-w-xs shadow-sm">
      <span className="material-symbols-outlined text-primary text-2xl">description</span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold text-on-surface truncate">{filename || 'Document'}</p>
        <p className="text-[9px] text-zinc-400 uppercase">Document file</p>
      </div>
      <a
        href={mediaUrl}
        download
        target="_blank"
        rel="noreferrer"
        className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-zinc-500 hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-sm">download</span>
      </a>
    </div>
  );
}

export default function ChatPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { getSocket } = useSocket();
  const { startCall } = useCall();
  const location = useLocation();

  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState(() => {
    return sessionStorage.getItem('sniffr_pawcircle_search') || '';
  });

  const [activeTab, setActiveTab] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get('tab') || location.state?.activeTab || sessionStorage.getItem('sniffr_chat_tab') || 'messages';
  });

  const [onlineUsers, setOnlineUsers] = useState(new Set());
  const [lastActiveTimes, setLastActiveTimes] = useState({});

  const [searchResults, setSearchResults] = useState([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  const [replyingTo, setReplyingTo] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [recordPreviewUrl, setRecordPreviewUrl] = useState(null);
  const [recordBlob, setRecordBlob] = useState(null);
  const recordIntervalRef = useRef(null);

  const [atSuggestions, setAtSuggestions] = useState([]);
  const [showSecondaryTray, setShowSecondaryTray] = useState(false);

  const [showMeetupBottomSheet, setShowMeetupBottomSheet] = useState(false);
  const [meetupLocation, setMeetupLocation] = useState('');
  const [meetupDate, setMeetupDate] = useState('');
  const [meetupTime, setMeetupTime] = useState('');
  const [meetupNote, setMeetupNote] = useState('');

  const [confirmRemoveModal, setConfirmRemoveModal] = useState(null);
  const [removingConvId, setRemovingConvId] = useState(null);

  const [actionMenuMessage, setActionMenuMessage] = useState(null);
  const [confirmFetchBackModal, setConfirmFetchBackModal] = useState(null);
  const [copyToast, setCopyToast] = useState(null);
  const [highlightMsgId, setHighlightMsgId] = useState(null);
  const messageRefsMap = useRef({});

  const [selectedPetForCard, setSelectedPetForCard] = useState(null);

  const [preSendMedia, setPreSendMedia] = useState([]);
  // Guards every send path (text/media/voice) against a duplicate send from
  // a rapid double-tap/double-Enter while the previous send is still
  // in-flight (upload + socket ack round-trip isn't instant).
  const [sending, setSending] = useState(false);
  const [upsell, setUpsell] = useState(null);

  const [mediaViewer, setMediaViewer] = useState(null);
  const [selectedSharedPostId, setSelectedSharedPostId] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const messagesEnd = useRef(null);
  
  const mediaInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const searchRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const searchRequestIdRef = useRef(0);
  const inputFieldRef = useRef(null);
  const [typingUsers, setTypingUsers] = useState({});
const [failedMessages, setFailedMessages] = useState({});
const [messageReactions, setMessageReactions] = useState({});

  const { pet } = useAuth();
  useEffect(() => { loadConversations(); loadMatches(); }, [pet?.id]);

  const { notifyTyping, stopTyping } = useTypingSignal(
    (isTyping) => {
      const socket = getSocket();
      if (!socket || !activeConv) return;
      socket.emit(isTyping ? 'typing_start' : 'typing_stop', { conversationId: activeConv.id });
    },
    activeConv?.id
  );

  const {
    reactionPickerMsgId,
    setReactionPickerMsgId,
    highlightedMsgReaction,
    setHighlightedMsgReaction,
    handleMessageTap,
    startMessageLongPress,
    cancelMessageLongPress,
    handleBubbleTouchMove,
    handleBubbleTouchEnd,
    submitMessageReaction,
  } = useMessageInteractions({
    currentUserId: user?.id,
    onReply: (msg) => { setReplyingTo(msg); inputFieldRef.current?.focus(); },
    onOpenActionMenu: (msg, { isOwn, top, left }) => setActionMenuMessage({ msg, isOwn, top, left }),
    onReact: (messageId, reaction) => {
      const socket = getSocket();
      if (socket && activeConv) {
        // Backend toggles: tapping the same reaction again removes it.
        socket.emit('react_to_message', { messageId, conversationId: activeConv.id, reaction });
      }
    },
  });

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onOnlineList = ({ onlineUserIds }) => setOnlineUsers(new Set(onlineUserIds));
    const onUserOnline = ({ userId }) => setOnlineUsers(prev => new Set(prev).add(userId));
    const onUserOffline = ({ userId, lastActiveAt }) => {
      setOnlineUsers(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
      if (lastActiveAt) setLastActiveTimes(prev => ({ ...prev, [userId]: lastActiveAt }));
    };

    const onMsg = (msg) => {
      if (activeConv && msg.conversation_id === activeConv.id) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === msg.id);
          if (exists) return prev.map(m => m.id === msg.id ? msg : m);
          return [...prev, msg];
        });
        socket.emit('messages_seen', { conversationId: activeConv.id });
      }
      loadConversations();
    };

    const onMsgUpdated = (updated) => {
      if (activeConv && updated.conversation_id === activeConv.id) {
        setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
      }
      loadConversations();
    };

    // Batched counterpart to onMsgUpdated -- the server sends one of
    // these (instead of N individual 'message_updated' events) when a
    // whole conversation's worth of messages flips to delivered/seen at
    // once (opening a chat, joining after a reconnect). Applying all of
    // them in a single setMessages call, and refetching the conversation
    // list once instead of once per message, is what actually fixes the
    // "N events -> N refetches" cost -- see server/socket/chat.js.
    const onMsgsUpdated = ({ conversationId, messages: updatedMsgs }) => {
      if (!updatedMsgs?.length) return;
      if (activeConv && conversationId === activeConv.id) {
        const byId = new Map(updatedMsgs.map(m => [m.id, m]));
        setMessages(prev => prev.map(m => byId.has(m.id) ? byId.get(m.id) : m));
      }
      loadConversations();
    };

    const onUserTyping = ({ conversationId, userId: typingUserId, isTyping }) => {
      if (typingUserId === user?.id) return;
      if (activeConv && conversationId === activeConv.id) {
        setTypingUsers(prev => ({ ...prev, [conversationId]: isTyping }));
      }
    };

    const onReactionUpdated = ({ messageId, reactions }) => {
      setMessageReactions(prev => ({
        ...prev,
        [messageId]: reactions
      }));
    };

    // Conversation rows and the open conversation header store the chat
    // partner's name/avatar/etc. denormalized (partner_name, partner_avatar,
    // ...) rather than a live reference to their pet -- patch both the list
    // and, if it's the currently-open conversation, the header too.
    const onProfileUpdated = ({ pet_id, pet: updatedPet }) => {
      if (!updatedPet) return;
      const patch = {
        partner_name: updatedPet.name,
        partner_avatar: updatedPet.avatar_url,
        partner_username: updatedPet.pet_username,
        is_premium: updatedPet.is_premium,
      };
      setConversations(prev => prev.map(c => c.partner_pet_id === pet_id ? { ...c, ...patch } : c));
      setActiveConv(prev => (prev && prev.partner_pet_id === pet_id) ? { ...prev, ...patch } : prev);
    };

    // Socket.IO rooms are scoped to the underlying connection -- on any
    // reconnect (dropped wifi, tab backgrounded, server restart) the
    // client gets a new connection and silently falls out of
    // `conv_${id}`, even though `activeConv` never changed. From that
    // point on it stops receiving ANY room broadcast for this
    // conversation (reactions, message updates, seen receipts) until
    // the conversation is closed and reopened. Re-join on every
    // 'connect' (which also fires after a reconnect, not just the
    // first connection) so an already-open conversation keeps working.
    const onConnect = () => {
      if (activeConv) {
        socket.emit('join_conversation', { conversationId: activeConv.id });
      }
    };

    socket.on('online_users_list', onOnlineList);
    socket.on('user_online', onUserOnline);
    socket.on('user_offline', onUserOffline);
    socket.on('message_received', onMsg);
    socket.on('message_updated', onMsgUpdated);
    socket.on('messages_updated', onMsgsUpdated);
    socket.on('user_typing', onUserTyping);
    socket.on('message_reaction_updated', onReactionUpdated);
    socket.on('profile_updated', onProfileUpdated);
    socket.on('connect', onConnect);

    return () => {
      socket.off('online_users_list', onOnlineList);
      socket.off('user_online', onUserOnline);
      socket.off('user_offline', onUserOffline);
      socket.off('message_received', onMsg);
      socket.off('message_updated', onMsgUpdated);
      socket.off('messages_updated', onMsgsUpdated);
      socket.off('user_typing', onUserTyping);
      socket.off('message_reaction_updated', onReactionUpdated);
      socket.off('profile_updated', onProfileUpdated);
      socket.off('connect', onConnect);
    };
  }, [activeConv, user?.id]);

  useEffect(() => {
    if (activeConv) {
      setTimeout(() => {
        messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [activeConv, messages.length]);

  useEffect(() => {
    sessionStorage.setItem('sniffr_chat_tab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    sessionStorage.setItem('sniffr_pawcircle_search', searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const savedScroll = sessionStorage.getItem('sniffr_pawcircle_scroll');
    if (savedScroll) {
      const scrollVal = parseInt(savedScroll, 10);
      const timer = setTimeout(() => {
        window.scrollTo({ top: scrollVal, behavior: 'auto' });
        sessionStorage.removeItem('sniffr_pawcircle_scroll');
      }, 150);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (activeTab === 'pawcircle') {
        sessionStorage.setItem('sniffr_pawcircle_scroll', window.scrollY);
      }
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [activeTab]);

  const loadConversations = async () => {
    try {
      const data = await api.get('/chat/conversations');
      setConversations(data.conversations || []);
      const times = {};
      data.conversations.forEach(c => {
        if (c.partner_last_active_at) times[c.partner_user_id] = c.partner_last_active_at;
      });
      setLastActiveTimes(prev => ({ ...prev, ...times }));
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    if (location.state?.petId) {
      const targetPetId = location.state.petId;
      startNewConversation(targetPetId);
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);

  const { pullDistance, refreshing, handlers, PawTrailIndicator } = usePullToRefresh(loadConversations);

  const loadMatches = async () => {
    try {
      const data = await api.get('/matches');
      setMatches(data.matches || []);
    } catch (err) { console.error(err); }
  };

  const handleSearchChange = (query) => {
    setSearchQuery(query);

    // A plain onChange handler has no cleanup phase, so the previous
    // pending timeout was never actually cancelled here -- typing fast used
    // to fire an overlapping API call per keystroke, and whichever response
    // landed LAST (not necessarily the one for the latest query) won and
    // silently overwrote the results, including with results for a query
    // that no longer matches what's in the box. Clearing the ref-held timer
    // and tagging each request with an incrementing id fixes both: only one
    // request is ever in flight from typing, and a late/out-of-order
    // response for an old query is discarded instead of applied.
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);

    if (activeTab !== 'messages') return;

    if (!query.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    const matchedConvs = conversations.filter(c =>
      c.partner_name.toLowerCase().includes(query.toLowerCase())
    );

    if (matchedConvs.length > 0) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    const requestId = ++searchRequestIdRef.current;
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const data = await api.get(`/chat/search?q=${encodeURIComponent(query)}`);
        if (requestId !== searchRequestIdRef.current) return; // a newer keystroke superseded this
        setSearchResults(data.results || []);
      } catch (err) {
        console.error(err);
      } finally {
        if (requestId === searchRequestIdRef.current) setSearchLoading(false);
      }
    }, 350);
  };

  const startNewConversation = async (recipientPetId) => {
    try {
      const targetId = parseInt(recipientPetId, 10);
      setActiveTab('messages');

      const existing = conversations.find(c => parseInt(c.partner_pet_id, 10) === targetId);
      if (existing) {
        openConversation(existing);
        return;
      }

      const res = await api.post('/chat/conversations', { recipientPetId: targetId });
      if (res && res.conversation) {
        setSearchQuery('');
        setSearchResults([]);
        const petInfo = await api.get(`/profile/${targetId}`);
        const conv = {
          ...res.conversation,
          partner_name: petInfo.pet?.name || 'Playmate',
          partner_avatar: petInfo.pet?.avatar_url || '/logo.png',
          partner_pet_id: targetId,
          partner_user_id: petInfo.pet?.user_id,
          is_premium: petInfo.pet?.is_premium || false
        };

        setConversations(prev => {
          const exists = prev.some(c => c.id === conv.id);
          if (exists) return prev;
          return [conv, ...prev];
        });

        openConversation(conv);
        loadConversations();
      }
    } catch (err) {
      console.error('Failed to create new conversation:', err);
    }
  };

  const draftsRef = useRef({});

  const openConversation = async (conv) => {
    if (activeConv) {
      draftsRef.current[activeConv.id] = newMsg;
    }
    setActiveTab('messages');
    setActiveConv(conv);
    setNewMsg(draftsRef.current[conv.id] || '');
    try {
      const data = await api.get(`/chat/messages/${conv.id}`);
      const fetchedMessages = data.messages || [];
      setMessages(fetchedMessages);

      // Reactions are persisted server-side (message_reactions table) and
      // come back embedded on each message, so they survive reconnects,
      // page reloads, and reopening the conversation later -- not just
      // whatever arrived over the socket while this tab was connected.
      setMessageReactions(prev => {
        const next = { ...prev };
        fetchedMessages.forEach(m => {
          if (m.reactions && Object.keys(m.reactions).length > 0) {
            next[m.id] = m.reactions;
          } else {
            delete next[m.id];
          }
        });
        return next;
      });

      const socket = getSocket();
      socket?.emit('join_conversation', { conversationId: conv.id });
      socket?.emit('messages_seen', { conversationId: conv.id });
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: 0 } : c));
    } catch (err) {
      console.error(err);
    }
  };

  const sendMessage = (type = 'text', mediaUrl = null, inviteContent = null) => {
    const socket = getSocket();
    if (!socket || !activeConv) return;

    stopTyping();

    let payload = {
      conversationId: activeConv.id,
      messageType: type
    };

    if (type === 'meetup' && inviteContent) {
      payload.content = JSON.stringify(inviteContent);
    } else if (type === 'pet_profile') {
      payload.content = `🐶 Profile shared`;
      payload.mediaUrl = String(mediaUrl);
    } else {
      if (!newMsg.trim() && !mediaUrl) return;
      payload.content = newMsg;
      if (mediaUrl) payload.mediaUrl = mediaUrl;
    }

    if (replyingTo) {
      payload.replyToId = replyingTo.id;
      setReplyingTo(null);
    }

    // Acknowledgment-based send: if the socket is disconnected or the
    // server doesn't respond within 6s, this is treated as a failure
    // and the message is marked as failed so the UI can show a retry
    // option -- instead of the message silently vanishing, which was
    // the previous behavior with a bare socket.emit().
    const clientTempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    payload.clientTempId = clientTempId;

    const ackTimeout = setTimeout(() => {
      setFailedMessages(prev => ({ ...prev, [clientTempId]: payload }));
    }, 6000);

    socket.emit('send_message', payload, (ack) => {
      clearTimeout(ackTimeout);
      if (!ack || !ack.success) {
        setFailedMessages(prev => ({ ...prev, [clientTempId]: payload }));
      } else {
        setFailedMessages(prev => {
          const next = { ...prev };
          delete next[clientTempId];
          return next;
        });
      }
    });

    setNewMsg('');
    if (activeConv) draftsRef.current[activeConv.id] = '';
    setAtSuggestions([]);
    setShowSecondaryTray(false);
    setShowEmojiPicker(false);
  };

  const retryFailedMessage = (clientTempId) => {
    const socket = getSocket();
    const payload = failedMessages[clientTempId];
    if (!socket || !payload) return;

    const ackTimeout = setTimeout(() => {
      setFailedMessages(prev => ({ ...prev, [clientTempId]: payload }));
    }, 6000);

    socket.emit('send_message', payload, (ack) => {
      clearTimeout(ackTimeout);
      if (ack && ack.success) {
        setFailedMessages(prev => {
          const next = { ...prev };
          delete next[clientTempId];
          return next;
        });
      }
    });
  };

  const handleSendAllMedia = async () => {
    if (preSendMedia.length === 0) return;
    const mediaList = [...preSendMedia];
    setPreSendMedia([]);
    const caption = newMsg.trim();
    setNewMsg('');

    for (let i = 0; i < mediaList.length; i++) {
      const item = mediaList[i];
      const formData = new FormData();
      formData.append('media', item.file);
      formData.append('conversationId', activeConv.id);
      // Any typed caption rides along with the last item in the batch.
      // POST /chat/messages already creates the message row AND broadcasts
      // it over the socket server-side -- calling sendMessage() again
      // after this (the old code) sent the exact same media a second time
      // as a brand new message. Don't call it.
      if (caption && i === mediaList.length - 1) {
        formData.append('content', caption);
      }
      try {
        await api.post('/chat/messages', formData);
      } catch (err) {
        if (isQuotaExceededError(err)) {
          setUpsell(quotaUpsellCopy(err));
          break; // rest of the batch would fail the same way, don't keep trying
        }
        console.error('Media upload loop failed:', err);
      }
    }
  };

  const handleComposerSend = async () => {
    // A tap/Enter that lands while the previous send is still uploading
    // (or waiting on the socket ack) must be ignored -- otherwise the same
    // media/voice note/text goes out twice, since nothing else in this
    // path was blocking re-entry.
    if (sending) return;
    setSending(true);
    try {
      await handleComposerSendInner();
    } finally {
      setSending(false);
    }
  };

  const handleComposerSendInner = async () => {
    if (preSendMedia.length > 0) {
      await handleSendAllMedia();
      return;
    }

    const trimmed = newMsg.trim();
    const mentionMatch = trimmed.match(/@([a-zA-Z0-9_]+)/);
    if (mentionMatch || selectedPetForCard) {
      const username = mentionMatch ? mentionMatch[1] : (selectedPetForCard?.username);
      
      let matched = (selectedPetForCard && selectedPetForCard.username && username && selectedPetForCard.username.toLowerCase() === username.toLowerCase()) ? selectedPetForCard : null;

      if (!matched && username) {
        matched = atSuggestions.find(s => s.username && s.username.toLowerCase() === username.toLowerCase());
      }

      if (!matched && username) {
        const m = matches.find(m => m.matched_pet_username && m.matched_pet_username.toLowerCase() === username.toLowerCase());
        if (m) {
          matched = { id: m.matched_pet_id, username: m.matched_pet_username, name: m.matched_pet_name };
        }
      }

      if (!matched && username) {
        try {
          const res = await api.get(`/chat/search?q=${encodeURIComponent(username)}`);
          if (res?.results?.length > 0) {
            const found = res.results.find(p => 
              (p.pet_username && p.pet_username.toLowerCase() === username.toLowerCase()) ||
              (p.owner_username && p.owner_username.toLowerCase() === username.toLowerCase()) ||
              p.name.toLowerCase() === username.toLowerCase()
            ) || res.results[0];
            if (found) matched = { id: found.id, username: found.pet_username || found.owner_username || found.name, name: found.name };
          }
        } catch (err) {
          console.error('Error matching mentioned pet username:', err);
        }
      }

      if (matched && matched.id) {
        sendMessage('pet_profile', matched.id);
        setNewMsg('');
        setSelectedPetForCard(null);
        setAtSuggestions([]);
        return;
      }
    }

    sendMessage();
  };

  const handleMediaUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !activeConv) return;
    const formData = new FormData();
    formData.append('media', file);
    formData.append('conversationId', activeConv.id);
    // FileCard renders msg.content as the filename (see its render branch
    // below) -- without this, every document attachment shows up as just
    // "Document" with no name.
    formData.append('content', file.name);
    try {
      // POST /chat/messages already creates the message row and broadcasts
      // it over the socket server-side -- no follow-up sendMessage() call
      // needed (that used to send the same file a second time).
      await api.post('/chat/messages', formData);
    } catch (err) {
      if (isQuotaExceededError(err)) {
        setUpsell(quotaUpsellCopy(err));
      } else {
        console.error('Upload failed', err);
      }
    }
  };

  const handleMediaSelection = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const newPreviews = files.map(file => ({
      file,
      url: URL.createObjectURL(file),
      type: file.type.startsWith('video') ? 'video' : 'image'
    }));

    setPreSendMedia(prev => [...prev, ...newPreviews]);
  };

  const handleRemovePreSendItem = (indexToRemove) => {
    setPreSendMedia(prev => {
      const item = prev[indexToRemove];
      if (item) URL.revokeObjectURL(item.url);
      return prev.filter((_, i) => i !== indexToRemove);
    });
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const name = file.name.toLowerCase();
    const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'];
    const isValid = allowedExtensions.some(ext => name.endsWith(ext));

    if (!isValid) {
      alert("Invalid file format. Please upload PDF, Word, Excel, PowerPoint, or text documents.");
      e.target.value = '';
      return;
    }

    // Mirrors server/config.js's MAX_DOCUMENT_SIZE -- checked here too so a
    // too-large file doesn't waste an upload round-trip before being
    // rejected server-side anyway.
    const MAX_DOCUMENT_SIZE = 5 * 1024 * 1024;
    if (file.size > MAX_DOCUMENT_SIZE) {
      alert("That document is too large. Documents must be under 5MB.");
      e.target.value = '';
      return;
    }

    handleMediaUpload(e);
  };

  const handleConfirmMeetup = () => {
    if (!meetupLocation.trim() || !meetupDate.trim() || !meetupTime.trim()) {
      alert("Please enter location, date, and time.");
      return;
    }
    const invite = {
      location: meetupLocation,
      date_time: `${meetupDate} • ${meetupTime}`,
      note: meetupNote,
      status: 'pending'
    };
    sendMessage('meetup', null, invite);
    
    setMeetupLocation('');
    setMeetupDate('');
    setMeetupTime('');
    setMeetupNote('');
    setShowMeetupBottomSheet(false);
    setShowSecondaryTray(false);
  };

  const handleStartVoiceRecord = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const localUrl = URL.createObjectURL(audioBlob);
        setRecordPreviewUrl(localUrl);
        setRecordBlob(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      setRecordTimer(0);
      setRecordPreviewUrl(null);
      setRecordBlob(null);

      mediaRecorder.start();
      setRecording(true);

      recordIntervalRef.current = setInterval(() => {
        setRecordTimer(t => t + 1);
      }, 1000);

    } catch (err) {
      console.error('Microphone access denied:', err);
    }
  };

  const handleStopVoiceRecord = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      clearInterval(recordIntervalRef.current);
      setRecording(false);
    }
  };

  const handleCancelVoiceRecord = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
    clearInterval(recordIntervalRef.current);
    setRecording(false);
    setRecordPreviewUrl(null);
    setRecordBlob(null);
  };

  const handleSendVoiceNote = async () => {
    if (!recordBlob || !activeConv || sending) return;
    setSending(true);
    // Capture the blob/preview locally and clear the staged-recording state
    // *before* the upload starts, not after it resolves -- otherwise the
    // preview (and its Send button) stays on screen for the whole upload,
    // so a second tap while it's still uploading re-sends the same
    // recording a second time.
    const blob = recordBlob;
    const previewUrl = recordPreviewUrl;
    setRecordPreviewUrl(null);
    setRecordBlob(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    const file = new File([blob], `voice_${Date.now()}.webm`, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('media', file);
    formData.append('conversationId', activeConv.id);
    try {
      // POST /chat/messages already creates the message row and broadcasts
      // it over the socket server-side -- no follow-up sendMessage() call
      // needed (that used to send the same recording a second time).
      await api.post('/chat/messages', formData);
    } catch (err) {
      if (isQuotaExceededError(err)) {
        setUpsell(quotaUpsellCopy(err));
      } else {
        console.error(err);
      }
    } finally {
      setSending(false);
    }
  };

  const formatTimer = (secs) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  const handleInputChange = async (val) => {
    setNewMsg(val);
    const index = val.lastIndexOf('@');
    if (index !== -1) {
      const searchPart = val.substring(index + 1);
      try {
        const data = await api.get(`/chat/search?q=${encodeURIComponent(searchPart || 'a')}`);
        const fetched = (data.results || []).map(p => ({
          id: p.id,
          name: p.name,
          username: p.pet_username || p.owner_username || 'playmate',
          breed: p.breed_name || 'Breed'
        }));
        
        const matchSugs = matches
          .filter(m => m.matched_pet_username.toLowerCase().includes(searchPart.toLowerCase()))
          .map(m => ({ id: m.matched_pet_id, name: m.matched_pet_name, username: m.matched_pet_username, breed: m.matched_breed_name || 'Breed' }));
        
        const combined = [...matchSugs];
        fetched.forEach(f => {
          if (!combined.some(c => c.username.toLowerCase() === f.username.toLowerCase())) {
            combined.push(f);
          }
        });
        setAtSuggestions(combined);
      } catch (e) {
        console.error(e);
      }
    } else {
      setAtSuggestions([]);
    }
  };

  const handleSelectPetCard = (selectedPet) => {
    const index = newMsg.lastIndexOf('@');
    const base = newMsg.substring(0, index);
    setNewMsg(`${base}@${selectedPet.username} `);
    setAtSuggestions([]);
    setSelectedPetForCard(selectedPet);
    inputFieldRef.current?.focus();
  };

  const handleTriggerShareProfile = () => {
    inputFieldRef.current?.focus();
    handleInputChange('@');
    setShowSecondaryTray(false);
  };

  const handleEmojiButtonClick = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    setShowSecondaryTray(false);
    setShowEmojiPicker(v => !v);
  };

  const handleEmojiSelect = (emojiData) => {
    const inputEl = inputFieldRef.current;
    const emojiToAdd = emojiData.emoji;

    const start = inputEl && typeof inputEl.selectionStart === 'number' ? inputEl.selectionStart : newMsg.length;
    const end = inputEl && typeof inputEl.selectionEnd === 'number' ? inputEl.selectionEnd : newMsg.length;

    const updated = newMsg.substring(0, start) + emojiToAdd + newMsg.substring(end);
    setNewMsg(updated);

    const nextPos = start + emojiToAdd.length;
    requestAnimationFrame(() => {
      if (inputFieldRef.current) {
        inputFieldRef.current.focus();
        try {
          inputFieldRef.current.setSelectionRange(nextPos, nextPos);
        } catch (err) {
        }
      }
    });
  };

  const openMediaViewer = (mediaUrl, index, list) => {
    setMediaViewer({ index, urls: list });
  };

  const handleConfirmRemoveConversation = async () => {
    if (!confirmRemoveModal) return;
    const convId = confirmRemoveModal.id;
    setConfirmRemoveModal(null);
    setRemovingConvId(convId);

    try {
      await api.delete(`/chat/conversations/${convId}`);
    } catch (err) {
      console.error('Failed to remove empty conversation:', err);
    }

    setTimeout(() => {
      setConversations(prev => prev.filter(c => c.id !== convId));
      setRemovingConvId(null);
    }, 300);
  };

  const handleConfirmFetchBack = async (messageId) => {
    if (!messageId) return;
    setConfirmFetchBackModal(null);

    setMessages(prev => prev.map(m => m.id === messageId ? {
      ...m,
      content: '🐾 This message was fetched back.',
      message_type: 'system',
      media_url: null
    } : m));

    const socket = getSocket();
    if (socket) {
      socket.emit('fetch_back_message', { messageId });
    }

    try {
      await api.post(`/chat/messages/${messageId}/fetch-back`);
    } catch (err) {
      console.error('Error fetching back message:', err);
    }
    loadConversations();
  };

  const scrollToMessage = (msgId) => {
    const el = messageRefsMap.current[msgId];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightMsgId(msgId);
      setTimeout(() => setHighlightMsgId(null), 1500);
    }
  };

  const filteredConversations = conversations.filter(c =>
    c.partner_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (activeConv) {
    const mediaMessages = messages.filter(m => m.media_url && (m.message_type === 'image' || m.message_type === 'video'));
    const mediaUrlsList = mediaMessages.map(m => m.media_url);

    return createPortal(
      <div className="fixed inset-0 bg-surface text-on-surface z-[100] flex flex-col text-left message-enter-animate w-full max-w-full overflow-x-hidden">
        <header className="flex items-center justify-between px-4 lg:px-8 py-4 glass border-b border-outline-variant/10 z-50 flex-shrink-0 w-full max-w-full overflow-x-hidden">
          <div className="flex items-center gap-4">
            <button
              onClick={() => {
                setSelectedSharedPostId(null);
                setActiveConv(null);
                getSocket()?.emit('leave_conversation', { conversationId: activeConv.id });
              }}
              className="w-10 h-10 rounded-full hover:bg-surface-container-low flex items-center justify-center transition-colors text-primary active:scale-90"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            
            <div className="relative cursor-pointer" onClick={() => navigate(`/profile/${activeConv.partner_pet_id}`)}>
              <img className="w-12 h-12 rounded-full object-cover border-2 border-primary/20 hover:scale-105 transition-transform" src={avatarUrl(activeConv.partner_avatar) || '/logo.png'} alt={activeConv.partner_name} loading="eager" decoding="async" />
              {onlineUsers.has(activeConv.partner_user_id) && (
                <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-400 border-2 border-white rounded-full status-online" />
              )}
            </div>
            
            <div>
              <h3 className="font-extrabold text-on-surface cursor-pointer hover:text-primary transition-colors flex items-center gap-1.5" onClick={() => navigate(`/profile/${activeConv.partner_pet_id}`)}>
                <span>{activeConv.partner_name}</span>
                <PremiumBadge pet={activeConv} size="text-base" />
              </h3>
              <span
  className={`text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 ${
    typingUsers[activeConv.id]
      ? 'text-primary'
      : onlineUsers.has(activeConv.partner_user_id)
      ? 'text-emerald-500'
      : 'text-zinc-400'
  }`}
>
  {typingUsers[activeConv.id]
    ? (<>Typing <TypingDots /></>)
    : formatPresence(
        onlineUsers.has(activeConv.partner_user_id),
        lastActiveTimes[activeConv.partner_user_id]
      )}
</span>
            </div>
          </div>

          <div className="flex gap-2">
            <button
  onClick={() => {
    startCall({
      type: 'audio',
      name: activeConv.partner_name,
      username:
        activeConv.partner_pet_username ||
        activeConv.partner_username ||
        (activeConv.partner_name
          ? activeConv.partner_name.toLowerCase().replace(/\s+/g, '')
          : ''),
      avatar: activeConv.partner_avatar,
      petId: activeConv.partner_pet_id,
      toUserId: activeConv.partner_user_id
    });
  }}
className="w-10 h-10 rounded-full bg-surface-container-low hover:bg-emerald-100 text-zinc-500 hover:text-emerald-500 flex items-center justify-center transition-all active:scale-90"
>
  <span className="material-symbols-outlined text-[20px]">call</span>
</button>
            <button
              onClick={() => startCall({
                type: 'video',
                name: activeConv.partner_name,
                username: activeConv.partner_pet_username || activeConv.partner_username || (activeConv.partner_name ? activeConv.partner_name.toLowerCase().replace(/\s+/g, '') : ''),
                avatar: activeConv.partner_avatar,
                petId: activeConv.partner_pet_id,
                toUserId: activeConv.partner_user_id
              })}
              className="w-10 h-10 rounded-full bg-surface-container-low hover:bg-sky-100 text-zinc-500 hover:text-sky-500 flex items-center justify-center transition-all active:scale-90"
            >
              <span className="material-symbols-outlined text-[20px]">videocam</span>
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 lg:px-8 overflow-y-auto space-y-4 py-6 no-scrollbar bg-surface-container-lowest flex flex-col">
          <div className="flex-1" />
          {messages.map((msg, i) => {
            const isOwn = msg.sender_id === user?.id;
            const time = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const isHighlighted = highlightMsgId === msg.id;

            if (msg.message_type === 'system') {
              return (
                <div key={msg.id || i} ref={el => { if (el) messageRefsMap.current[msg.id] = el; }} className="flex justify-center my-2 w-full animate-fade-in">
                  <div className="bg-zinc-100 dark:bg-zinc-800/80 text-zinc-400 dark:text-zinc-400 text-[10px] font-bold px-3.5 py-1.5 rounded-full flex items-center gap-1.5 border border-zinc-200/50 dark:border-zinc-700/50 select-none shadow-2xs">
                    <span>{msg.content || '🐾 This message was fetched back.'}</span>
                  </div>
                </div>
              );
            }

            const replyPreview = msg.reply_to_id ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); scrollToMessage(msg.reply_to_id); }}
                className={`flex items-start gap-2 px-3 py-2 rounded-xl text-[10px] mb-1 max-w-full cursor-pointer transition-all hover:opacity-80 active:scale-[0.98] border ${
                  isOwn
                    ? 'bg-white/15 border-white/20 text-white/80'
                    : 'bg-zinc-200/60 dark:bg-zinc-700/50 border-zinc-300/40 dark:border-zinc-600/40 text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <div className={`w-0.5 h-full min-h-[20px] rounded-full flex-shrink-0 ${isOwn ? 'bg-white/40' : 'bg-primary/40'}`} />
                <div className="flex flex-col items-start text-left overflow-hidden">
                  <span className="font-extrabold text-[9px] uppercase tracking-wider">
                    {msg.reply_sender_id === user?.id ? 'You' : (msg.reply_sender_username || activeConv.partner_name)}
                  </span>
                  <span className="truncate max-w-[180px] font-medium">
                    {msg.reply_message_type === 'voice' ? '🎤 Voice note' :
                     msg.reply_message_type === 'file' ? '📄 File' :
                     msg.reply_message_type === 'image' ? '🖼 Photo' :
                     msg.reply_message_type === 'video' ? '🎬 Video' :
                     (msg.reply_content || '...')}
                  </span>
                </div>
              </button>
            ) : null;

            return (
              <div
                key={msg.id || i}
                ref={el => { if (el) messageRefsMap.current[msg.id] = el; }}
                className={`flex flex-col gap-1 animate-fade-in transition-all duration-500 ${isOwn ? 'items-end ml-auto max-w-[80%]' : 'items-start max-w-[80%]'} ${isHighlighted ? 'ring-2 ring-primary/30 rounded-2xl bg-primary/5' : ''}`}
              >
              <div className="relative">
                {msg.message_type === 'shared_post' ? (
                  <SharedPostCard postId={msg.media_url} onOpenViewer={(id) => setSelectedSharedPostId(id)} />
                ) : msg.message_type === 'pet_profile' ? (
                  <SharedPetCard petId={msg.media_url} onStartChat={(id) => startNewConversation(id)} />
                ) : msg.message_type === 'meetup' ? (
                  <MeetupCard messageId={msg.id} content={msg.content} onStatusUpdate={(updated) => {
                    setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
                  }} />
                ) : msg.message_type === 'voice' ? (
                  <div
                    onClick={(e) => handleMessageTap(msg, e)}
                    onTouchStart={() => startMessageLongPress(msg)}
                    onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                    onTouchEnd={() => handleBubbleTouchEnd(msg)}
                    onMouseDown={() => startMessageLongPress(msg)}
                    onMouseUp={() => cancelMessageLongPress(msg.id)}
                    onMouseLeave={() => cancelMessageLongPress(msg.id)}
                    className="cursor-pointer select-none"
                  >
                    {replyPreview}
                    <VoicePlayer audioUrl={msg.media_url} />
                  </div>
                ) : msg.message_type === 'file' ? (
                  <div
                    onClick={(e) => handleMessageTap(msg, e)}
                    onTouchStart={() => startMessageLongPress(msg)}
                    onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                    onTouchEnd={() => handleBubbleTouchEnd(msg)}
                    onMouseDown={() => startMessageLongPress(msg)}
                    onMouseUp={() => cancelMessageLongPress(msg.id)}
                    onMouseLeave={() => cancelMessageLongPress(msg.id)}
                    className="cursor-pointer select-none"
                  >
                    {replyPreview}
                    <FileCard filename={msg.content} mediaUrl={msg.media_url} />
                  </div>
                ) : msg.media_url ? (
                  <div
                    onClick={(e) => handleMessageTap(msg, e)}
                    onTouchStart={() => startMessageLongPress(msg)}
                    onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                    onTouchEnd={() => handleBubbleTouchEnd(msg)}
                    onMouseDown={() => startMessageLongPress(msg)}
                    onMouseUp={() => cancelMessageLongPress(msg.id)}
                    onMouseLeave={() => cancelMessageLongPress(msg.id)}
                    className={`rounded-[2rem] overflow-hidden border-4 shadow-sm cursor-pointer hover:opacity-95 transition-opacity select-none ${isOwn ? 'border-primary/20 rounded-br-sm' : 'border-zinc-100 rounded-bl-sm'}`}
                  >
                    {replyPreview && <div className="px-3 pt-2">{replyPreview}</div>}
                    {msg.message_type === 'video' ? (
                      <div className="relative">
                        <video src={msg.media_url} className="max-w-xs rounded-xl pointer-events-none" />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <span className="material-symbols-outlined text-white text-4xl">play_circle</span>
                        </div>
                      </div>
                    ) : (
                      <img src={thumbnailUrl(msg.media_url)} alt="Shared media" className="w-full max-w-xs object-cover rounded-xl" loading="lazy" decoding="async" />
                    )}
                    {msg.content && (
                      <div className={`px-6 py-4 text-xs leading-relaxed ${isOwn ? 'bg-primary/10 text-on-surface' : 'bg-zinc-100 text-on-surface'}`}>
                        {msg.content}
                      </div>
                    )}
                  </div>
                ) : (
                  <div
                    onClick={(e) => handleMessageTap(msg, e)}
                    onTouchStart={() => startMessageLongPress(msg)}
                    onTouchMove={(e) => handleBubbleTouchMove(msg, e)}
                    onTouchEnd={() => handleBubbleTouchEnd(msg)}
                    onMouseDown={() => startMessageLongPress(msg)}
                    onMouseUp={() => cancelMessageLongPress(msg.id)}
                    onMouseLeave={() => cancelMessageLongPress(msg.id)}
                    className={`px-5 py-3 text-xs leading-relaxed shadow-sm cursor-pointer select-none group relative transition-transform active:scale-[0.99]
                      ${isOwn ? 'bg-gradient-to-br from-primary to-primary-fixed-dim text-white rounded-[2rem] rounded-br-sm' : 'bg-zinc-100 dark:bg-zinc-800 text-on-surface rounded-[2rem] rounded-bl-sm'}`}
                  >
                    {replyPreview}
                    {msg.content}
                  </div>
                )}

                {/* Instagram-style reaction badge: a small emoji chip
                    overlapping the bubble's inner-bottom corner, instead
                    of a count pill sitting underneath it. */}
                {messageReactions[msg.id] && Object.values(messageReactions[msg.id]).some(c => c > 0) && (
                  <div className={`absolute -bottom-2.5 ${isOwn ? '-left-2' : '-right-2'} flex items-center`}>
                    {Object.entries(messageReactions[msg.id]).filter(([, c]) => c > 0).map(([type, count], idx) => (
                      <span
                        key={type}
                        style={{ marginLeft: idx > 0 ? '-8px' : 0, zIndex: 10 - idx }}
                        className="w-6 h-6 rounded-full bg-white dark:bg-zinc-900 border border-outline-variant/15 shadow-md flex items-center justify-center text-[12px]"
                        title={`${REACTION_LABELS[type]}${count > 1 ? ` × ${count}` : ''}`}
                      >
                        {REACTION_EMOJIS[type]}
                      </span>
                    ))}
                  </div>
                )}
              </div>

                <div className={`flex items-center gap-1 mt-1 ${isOwn ? 'mr-2' : 'ml-2'}`}>
  <span className="text-[9px] font-bold text-zinc-300 uppercase tracking-widest">
    {time}
  </span>

  {isOwn && (
    <span
  className={`material-symbols-outlined text-[13px] ${
    msg.seen_at
      ? 'text-zinc-700 dark:text-zinc-300'
      : msg.delivered_at
      ? 'text-zinc-300'
      : 'text-zinc-300'
  }`}
>
  {msg.seen_at
    ? 'done_all'
    : msg.delivered_at
    ? 'done_all'
    : 'done'}
</span>
  )}
</div>
              </div>
            );
          })}
          <div ref={messagesEnd} />
        </main>

        <div className="px-4 lg:px-8 py-4 glass border-t border-outline-variant/10 flex-shrink-0 relative">
          
          {replyingTo && (
            <div className="flex items-center gap-3 bg-zinc-50 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700 px-4 py-2.5 mb-2 rounded-2xl animate-slide-up">
              <div className="w-1 h-8 rounded-full bg-primary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-extrabold text-primary uppercase tracking-wider">
                  🐾 Replying to {replyingTo.sender_id === user?.id ? 'your message' : `${activeConv.partner_name}'s message`}
                </p>
                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 font-medium truncate mt-0.5">
                  "{(replyingTo.message_type === 'voice' ? '🎤 Voice note' :
                    replyingTo.message_type === 'file' ? '📄 File' :
                    replyingTo.media_url && !replyingTo.content ? '🖼 Photo' :
                    (replyingTo.content || '').substring(0, 60)) || '...'}{(replyingTo.content || '').length > 60 ? '...' : ''}"
                </p>
              </div>
              <button
                onClick={() => setReplyingTo(null)}
                className="w-6 h-6 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-500 transition-colors flex-shrink-0"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            </div>
          )}

          {Object.keys(failedMessages).length > 0 && (
            <div className="flex items-center gap-3 bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900 px-4 py-2.5 mb-2 rounded-2xl animate-slide-up">
              <span className="material-symbols-outlined text-rose-500 text-lg">error</span>
              <div className="flex-1">
                <p className="text-[10px] font-extrabold text-rose-600 uppercase tracking-wider">Message failed to send</p>
                <p className="text-[10px] text-rose-400 font-medium">Check your connection and try again.</p>
              </div>
              <button
                onClick={() => {
                  const ids = Object.keys(failedMessages);
                  ids.forEach(id => retryFailedMessage(id));
                }}
                className="px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[10px] uppercase tracking-wider rounded-full transition-all active:scale-95"
              >
                Retry
              </button>
            </div>
          )}

          {atSuggestions.length > 0 && (
            <div className="absolute bottom-20 left-6 right-6 bg-white dark:bg-zinc-900 border rounded-2xl shadow-xl p-2 z-50 space-y-1 max-h-32 overflow-y-auto no-scrollbar animate-scale-up">
              <p className="text-[8px] font-black text-zinc-400 uppercase tracking-wider pl-2 mb-1">Mention to share Profile Card</p>
              {atSuggestions.map(p => (
                <button
                  key={p.id}
                  onClick={() => handleSelectPetCard(p)}
                  className="w-full text-left p-2 hover:bg-zinc-50 rounded-xl flex items-center gap-2 text-xs font-bold text-on-surface"
                >
                  <span>🐶 {p.name}</span>
                  <span className="text-[10px] text-zinc-400 font-medium">@{p.username}</span>
                </button>
              ))}
            </div>
          )}

          {preSendMedia.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-3 mb-2 pt-1 border-b border-zinc-100 dark:border-zinc-800 no-scrollbar">
              {preSendMedia.map((item, idx) => (
                <div key={idx} className="media-pre-send-card flex-shrink-0">
                  <button onClick={() => handleRemovePreSendItem(idx)} className="media-pre-send-remove">
                    <span className="material-symbols-outlined text-[10px]">close</span>
                  </button>
                  {item.type === 'video' ? (
                    <video src={item.url} className="w-full h-full object-cover" />
                  ) : (
                    <img src={item.url} className="w-full h-full object-cover" alt="Upload Preview" />
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">

            {showEmojiPicker && (
              <div className="mb-2 animate-scale-up flex justify-center">
                <Suspense fallback={
                  <div className="w-full flex items-center justify-center text-zinc-400 text-xs" style={{ height: 360 }}>
                    Loading emoji…
                  </div>
                }>
                  <EmojiPicker
                    onEmojiClick={handleEmojiSelect}
                    autoFocusSearch={false}
                    lazyLoadEmojis
                    width="100%"
                    height={360}
                  />
                </Suspense>
              </div>
            )}

            {showSecondaryTray && (
              <div className="bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-outline-variant/10 shadow-lg mb-2 animate-scale-up">
                <div className="flex items-center justify-around w-full max-w-sm mx-auto">
                  <button
                    onClick={() => { mediaInputRef.current?.click(); setShowSecondaryTray(false); }}
                    className="flex flex-col items-center gap-2 text-zinc-500 hover:text-primary transition-all"
                  >
                    <div className="w-12 h-12 bg-rose-50 dark:bg-zinc-800 rounded-full flex items-center justify-center text-primary shadow-sm hover:scale-105 transition-transform">
                      <span className="material-symbols-outlined text-lg">image</span>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Media</span>
                  </button>

                  <button
                    onClick={() => { fileInputRef.current?.click(); setShowSecondaryTray(false); }}
                    className="flex flex-col items-center gap-2 text-zinc-500 hover:text-primary transition-all"
                  >
                    <div className="w-12 h-12 bg-pink-50 dark:bg-zinc-800 rounded-full flex items-center justify-center text-pink-500 shadow-sm hover:scale-105 transition-transform">
                      <span className="material-symbols-outlined text-lg">description</span>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">File</span>
                  </button>

                  <button
                    onClick={() => { setShowMeetupBottomSheet(true); setShowSecondaryTray(false); }}
                    className="flex flex-col items-center gap-2 text-zinc-500 hover:text-primary transition-all"
                  >
                    <div className="w-12 h-12 bg-emerald-50 dark:bg-zinc-800 rounded-full flex items-center justify-center text-emerald-500 shadow-sm hover:scale-105 transition-transform">
                      <span className="material-symbols-outlined text-lg">calendar_month</span>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Meetup</span>
                  </button>

                  <button
                    onClick={handleTriggerShareProfile}
                    className="flex flex-col items-center gap-2 text-zinc-500 hover:text-primary transition-all"
                  >
                    <div className="w-12 h-12 bg-sky-50 dark:bg-zinc-800 rounded-full flex items-center justify-center text-sky-500 shadow-sm hover:scale-105 transition-transform">
                      <span className="material-symbols-outlined text-lg">badge</span>
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Profile</span>
                  </button>
                </div>
              </div>
            )}

            {recording ? (
              <div className="flex items-center justify-between bg-zinc-100 dark:bg-zinc-900 rounded-full px-5 py-3 search-glow animate-slide-up">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-ping" />
                  <span className="text-xs font-bold text-red-500">Recording... {formatTimer(recordTimer)}</span>
                </div>
                <div className="flex gap-3">
                  <button onClick={handleCancelVoiceRecord} className="text-zinc-500 hover:text-red-500 font-extrabold text-xs uppercase">Cancel</button>
                  <button onClick={handleStopVoiceRecord} className="text-primary hover:text-primary-fixed-dim font-extrabold text-xs uppercase">Stop</button>
                </div>
              </div>
            ) : recordPreviewUrl ? (
              <div className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-800 rounded-full px-5 py-3 border animate-slide-up">
<div className="flex items-center gap-3">
                  <span className="text-xs font-bold text-zinc-500">Preview:</span>
                  <VoicePlayer audioUrl={recordPreviewUrl} />
                </div>
                <div className="flex gap-3">
                  <button onClick={() => { setRecordPreviewUrl(null); setRecordBlob(null); }} className="text-zinc-400 hover:text-red-500">
                    <span className="material-symbols-outlined text-sm">delete</span>
                  </button>
                  <button onClick={handleSendVoiceNote} disabled={sending} className="w-8 h-8 rounded-full bg-emerald-500 text-white flex items-center justify-center active:scale-95 shadow-md disabled:opacity-40">
                    <span className="material-symbols-outlined text-sm">send</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 bg-zinc-100 dark:bg-zinc-900 rounded-full py-1.5 pl-4 pr-2 search-glow max-w-lg mx-auto w-full">
                
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onTouchStart={(e) => e.preventDefault()}
                  onClick={handleEmojiButtonClick}
                  className="text-zinc-400 hover:text-primary transition-colors active:scale-90 flex-shrink-0 cursor-pointer"
                  title="Insert Emoji / Focus Keyboard"
                >
                  <span className="material-symbols-outlined text-[20px]">sentiment_satisfied</span>
                </button>

                <button onClick={() => mediaInputRef.current?.click()} className="text-zinc-400 hover:text-primary transition-colors active:scale-90" title="Upload Media Files">
                  <span className="material-symbols-outlined text-[20px]">image</span>
                </button>
                <input type="file" accept="image/*,video/*" multiple ref={mediaInputRef} className="hidden" onChange={handleMediaSelection} />

                <button onClick={handleStartVoiceRecord} className="text-zinc-400 hover:text-primary transition-colors active:scale-90" title="Record Voice note">
                  <span className="material-symbols-outlined text-[20px]">mic</span>
                </button>

                <button onClick={() => { setShowEmojiPicker(false); setShowSecondaryTray(!showSecondaryTray); }} className={`text-zinc-400 hover:text-primary transition-all active:scale-90 ${showSecondaryTray ? 'rotate-45 text-primary' : ''}`} title="More options">
                  <span className="material-symbols-outlined text-[20px]">add</span>
                </button>

                <input type="file" ref={fileInputRef} accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" className="hidden" onChange={handleFileSelect} />

                <input
                  ref={inputFieldRef}
                  className="flex-1 bg-transparent border-none focus:ring-0 text-xs placeholder:text-zinc-400 outline-none text-on-surface py-2"
                  placeholder="Send a message..."
                  value={newMsg}
                  onChange={e => {
  handleInputChange(e.target.value);
  notifyTyping();
}}
                  onKeyDown={e => e.key === 'Enter' && !sending && (newMsg.trim() || preSendMedia.length > 0) && handleComposerSend()}
                />

                <button
                  onClick={handleComposerSend}
                  disabled={sending || (!newMsg.trim() && preSendMedia.length === 0)}
                  className="w-9 h-9 rounded-full bg-primary text-white flex items-center justify-center shadow-md active:scale-90 transition-all disabled:opacity-40 hover:scale-105 flex-shrink-0 mr-1"
                >
                  <span className="material-symbols-outlined text-[16px]">pets</span>
                </button>
              </div>
            )}
          </div>
        </div>

        {upsell && (
          <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
        )}

        {showMeetupBottomSheet && (
          <div className="fixed inset-0 z-[150] bg-black/50 flex items-end justify-center pb-[env(safe-area-inset-bottom)]" onClick={() => setShowMeetupBottomSheet(false)}>
            <div className="bg-white dark:bg-zinc-900 w-full max-w-lg rounded-t-[2.5rem] p-6 space-y-4 bottom-sheet-slide-up text-left max-h-[90dvh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <div className="flex justify-between items-center pb-2 border-b">
                <h3 className="font-extrabold text-sm uppercase tracking-widest text-on-surface">📍 Propose a Meetup</h3>
                <button onClick={() => setShowMeetupBottomSheet(false)} className="material-symbols-outlined text-zinc-400 hover:text-red-500">close</button>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest block mb-1">Location</label>
                  <input
                    type="text"
                    value={meetupLocation}
                    onChange={e => setMeetupLocation(e.target.value)}
                    placeholder="e.g. Cubbon Park Dog Park"
                    className="w-full bg-zinc-50 dark:bg-zinc-800 p-3 rounded-2xl border text-xs"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest block mb-1">Date</label>
                    <input
                      type="date"
                      value={meetupDate}
                      onChange={e => setMeetupDate(e.target.value)}
                      className="w-full bg-zinc-50 dark:bg-zinc-800 p-3 rounded-2xl border text-xs"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest block mb-1">Time</label>
                    <input
                      type="time"
                      value={meetupTime}
                      onChange={e => setMeetupTime(e.target.value)}
                      className="w-full bg-zinc-50 dark:bg-zinc-800 p-3 rounded-2xl border text-xs"
                    />
                  </div>
                </div>
                
                <div>
                  <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest block mb-1">Short Note (Optional)</label>
                  <input
                    type="text"
                    value={meetupNote}
                    onChange={e => setMeetupNote(e.target.value)}
                    placeholder="e.g. Bring some treats!"
                    className="w-full bg-zinc-50 dark:bg-zinc-800 p-3 rounded-2xl border text-xs"
                  />
                </div>
                
                <button
                  onClick={handleConfirmMeetup}
                  className="w-full py-4 bg-gradient-to-r from-primary to-primary-fixed-dim text-white rounded-full font-bold text-xs uppercase tracking-widest shadow-md hover-lift active:scale-95 transition-transform"
                >
                  Confirm Meetup Invite
                </button>
              </div>
            </div>
          </div>
        )}

        {mediaViewer && (
          <div className="fixed inset-0 z-[250] bg-black/95 flex flex-col justify-between p-4" onClick={() => setMediaViewer(null)}>
            <div className="flex justify-between items-center text-white p-2">
              <span className="text-xs font-bold">{mediaViewer.index + 1} / {mediaViewer.urls.length}</span>
              <div className="flex gap-4">
                <a href={mediaViewer.urls[mediaViewer.index]} download target="_blank" rel="noreferrer" className="text-white hover:text-primary flex items-center gap-1 text-xs">
                  <span className="material-symbols-outlined">download</span> Download
                </a>
                <button onClick={() => setMediaViewer(null)} className="text-white hover:text-red-500">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>

            <div className="flex-1 flex items-center justify-between" onClick={e => e.stopPropagation()}>
              <button
                disabled={mediaViewer.index === 0}
                onClick={() => setMediaViewer(prev => ({ ...prev, index: prev.index - 1 }))}
                className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30"
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>

              <div className="max-w-[85vw] max-h-[70vh] flex items-center justify-center overflow-hidden">
                {mediaViewer.urls[mediaViewer.index].endsWith('.mp4') || mediaViewer.urls[mediaViewer.index].endsWith('.webm') || mediaViewer.urls[mediaViewer.index].endsWith('.mov') ? (
                  <video src={mediaViewer.urls[mediaViewer.index]} controls autoPlay className="max-w-full max-h-full rounded-lg" />
                ) : (
                  <img src={mediaViewer.urls[mediaViewer.index]} alt="Fullscreen media" className="max-w-full max-h-full rounded-lg object-contain transition-transform" />
                )}
              </div>

              <button
                disabled={mediaViewer.index === mediaViewer.urls.length - 1}
                onClick={() => setMediaViewer(prev => ({ ...prev, index: prev.index + 1 }))}
                className="w-12 h-12 rounded-full bg-white/10 text-white flex items-center justify-center disabled:opacity-30"
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </div>
            <div />
          </div>
        )}

        {actionMenuMessage && (
          <div
            className="fixed inset-0 z-[150] bg-black/10 backdrop-blur-[1px]"
            onClick={() => setActionMenuMessage(null)}
          >
            <div
              className="absolute bg-white dark:bg-zinc-900 border border-outline-variant/15 rounded-2xl shadow-xl p-1.5 min-w-[140px] animate-scale-up text-left select-none space-y-0.5"
              style={{
                top: `${Math.max(65, actionMenuMessage.top)}px`,
                left: `${Math.max(16, Math.min(window.innerWidth - 160, actionMenuMessage.left))}px`
              }}
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  const textToCopy = actionMenuMessage.msg.content || '';
                  navigator.clipboard?.writeText(textToCopy);
                  setActionMenuMessage(null);
                  setCopyToast('✅ Copied to clipboard');
                  setTimeout(() => setCopyToast(null), 2000);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-extrabold text-on-surface hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
              >
                <span className="material-symbols-outlined text-sm">content_copy</span>
                Copy
              </button>

              {actionMenuMessage.isOwn && (
                <button
                  onClick={() => {
                    const msgToFetch = actionMenuMessage.msg;
                    setActionMenuMessage(null);
                    setConfirmFetchBackModal(msgToFetch);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-extrabold text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                >
                  <span className="text-sm">🐾</span>
                  Fetch Back
                </button>
              )}
            </div>
          </div>
        )}

        {/* Long-Press Message Reaction Picker (same visual pattern as the
            Home feed's post reaction picker) */}
        {reactionPickerMsgId && (
          <div
            className="fixed inset-0 z-[300] bg-black/35 backdrop-blur-[2px] flex items-center justify-center animate-fade-in"
            onClick={() => { setReactionPickerMsgId(null); setHighlightedMsgReaction(null); }}
          >
            <div
              className="bg-white/90 dark:bg-zinc-900/90 backdrop-blur-md rounded-full px-6 py-4 shadow-2xl flex items-end gap-3.5 border border-outline-variant/10 animate-reaction-picker"
              onClick={(e) => e.stopPropagation()}
            >
              {Object.entries(REACTION_EMOJIS).map(([type, emoji]) => {
                const isHighlighted = highlightedMsgReaction === type;
                return (
                  <button
                    key={type}
                    data-msg-reaction={type}
                    onMouseEnter={() => setHighlightedMsgReaction(type)}
                    onMouseLeave={() => setHighlightedMsgReaction(null)}
                    onClick={() => submitMessageReaction(reactionPickerMsgId, type)}
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

        {confirmFetchBackModal && (
          <div
            className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-fade-in"
            onClick={() => setConfirmFetchBackModal(null)}
          >
            <div
              className="bg-white dark:bg-zinc-900 border border-outline-variant/10 rounded-[2.2rem] p-6 max-w-xs w-full shadow-2xl text-center space-y-4 animate-scale-up"
              onClick={e => e.stopPropagation()}
            >
              <div className="w-12 h-12 rounded-full bg-rose-50 text-red-500 flex items-center justify-center mx-auto text-xl font-bold">
                <span className="text-2xl">🐾</span>
              </div>
              <div>
                <h3 className="font-extrabold text-sm text-on-surface">Fetch back this message?</h3>
                <p className="text-xs text-zinc-400 font-medium mt-1">This message will be removed for everyone in the conversation.</p>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => setConfirmFetchBackModal(null)}
                  className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 font-extrabold text-xs uppercase tracking-wider rounded-full transition-all active:scale-95"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleConfirmFetchBack(confirmFetchBackModal.id)}
                  className="flex-1 py-3 bg-red-500 hover:bg-red-600 text-white font-extrabold text-xs uppercase tracking-wider rounded-full shadow-md transition-all active:scale-95"
                >
                  Fetch Back
                </button>
              </div>
            </div>
          </div>
        )}

        {copyToast && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[220] bg-zinc-900/90 text-white dark:bg-white/90 dark:text-zinc-900 px-4 py-2 rounded-full text-xs font-extrabold shadow-lg animate-bounce flex items-center gap-1.5 pointer-events-none">
            <span>{copyToast}</span>
          </div>
        )}

        {selectedSharedPostId && (
          <SharedPostViewerModal
            postId={selectedSharedPostId}
            onClose={() => setSelectedSharedPostId(null)}
          />
        )}
      </div>,
      document.body
    );
  }

  const placeholderTexts = {
    messages: 'Sniff pets or owners...',
    pawcircle: 'Join a Pawcircle...',
    calls: 'Search your history...'
  };

  const showFallbackResults = activeTab === 'messages' && searchQuery && filteredConversations.length === 0;

  return (
    <div className="w-full bg-surface text-on-surface min-h-screen pb-32 lg:pb-8 overflow-x-hidden" {...handlers}>
      <PawTrailIndicator />

      <header className="lg:hidden bg-white/80 dark:bg-zinc-950/80 backdrop-blur-md shadow-[0_15px_40px_-15px_rgba(244,167,185,0.2)] fixed top-0 left-0 right-0 md:left-20 z-50">
        <div className="flex justify-between items-center w-full px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
            <span className="font-extrabold tracking-tighter text-2xl uppercase text-pink-400">Sniffr</span>
          </div>
        </div>
      </header>

      <main className="pt-24 lg:pt-8 px-4 lg:px-8 max-w-2xl lg:max-w-none mx-auto lg:mx-0 w-full overflow-x-hidden">
        <div className="hidden lg:block mb-6 text-left">
          <h1 className="text-3xl font-extrabold tracking-tight text-on-surface">Messages <span className="gradient-text">💬</span></h1>
          <p className="text-on-surface-variant text-sm mt-1">Connect with your pet's playmates</p>
        </div>

        <div className="bg-zinc-100 dark:bg-zinc-900 rounded-2xl p-1 mb-3.5 flex shadow-inner">
          {['messages', 'pawcircle', 'calls'].map(tab => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setSearchQuery(''); setSearchResults([]); }}
              className={`flex-1 py-2 rounded-xl transition-all font-bold uppercase tracking-widest text-[10px]
                ${activeTab === tab ? 'bg-white dark:bg-zinc-800 shadow-md text-primary' : 'text-zinc-400 hover:text-zinc-600'}`}
            >
              {tab === 'messages' ? 'Messages' : tab === 'pawcircle' ? 'PawCircle' : 'Calls'}
            </button>
          ))}
        </div>

        <div className="relative mb-3.5 search-glow" ref={searchRef}>
          <span className="material-symbols-outlined absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 text-lg">search</span>
          <input
            type="text"
            placeholder={placeholderTexts[activeTab]}
            value={searchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
            className="w-full bg-zinc-100 dark:bg-zinc-900 border-none rounded-2xl py-2.5 pl-10 pr-5 text-xs font-bold uppercase tracking-wider placeholder:text-zinc-400 focus:ring-2 ring-primary/20 transition-all text-left"
          />
          {searchLoading && (
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          )}
        </div>

        {activeTab === 'messages' && (
          <section className="space-y-2.5 animate-fade-in text-left">
            
            {showFallbackResults && (
              <div className="space-y-3 animate-fade-in mb-4">
                <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Matched Registered Profiles</h3>
                {searchResults.length === 0 && !searchLoading ? (
                  <div className="text-center py-10 bg-zinc-50 rounded-[2rem] border border-dashed border-zinc-200">
                    <span className="material-symbols-outlined text-4xl text-zinc-200 mb-2 block animate-float">search_off</span>
                    <p className="font-bold text-zinc-400 text-sm">No wagging tails detected 🐾</p>
                    <p className="text-xs text-zinc-300 mt-1">Try another name or username</p>
                  </div>
                ) : (
                  searchResults.map(p => (
                    <button
                      key={p.id}
                      onClick={() => startNewConversation(p.id)}
                      className="w-full bg-white dark:bg-zinc-950 p-4 rounded-2xl flex items-center gap-4 hover-lift border border-transparent hover:border-primary/10 transition-all text-left"
                    >
                      <img src={avatarUrl(p.avatar_url) || '/logo.png'} className="w-12 h-12 rounded-2xl object-cover shadow-sm" alt={p.name} loading="lazy" decoding="async" />
                      <div className="flex-1">
                        <p className="font-extrabold text-sm">{p.name}</p>
                        <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider mt-0.5">@{p.pet_username || p.owner_username}</p>
                      </div>
                      <span className="material-symbols-outlined text-primary">chat</span>
                    </button>
                  ))
                )}
              </div>
            )}

            {!showFallbackResults && (
              loading ? (
                <div className="space-y-4">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="animate-skeleton flex gap-4 items-center bg-white dark:bg-zinc-900 p-5 rounded-[2rem] border">
                      <div className="w-16 h-16 bg-zinc-200 dark:bg-zinc-800 rounded-[1.8rem] flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 bg-zinc-200 dark:bg-zinc-800 rounded w-1/3" />
                        <div className="h-3 bg-zinc-200 dark:bg-zinc-800 rounded w-2/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filteredConversations.length === 0 ? (
                <div className="text-center py-20 bg-zinc-50/50 rounded-[2.5rem] border border-dashed border-zinc-200 animate-fade-in">
                  <span className="material-symbols-outlined text-6xl text-zinc-200 mb-4 animate-float">chat_bubble</span>
                  <p className="font-bold text-zinc-400">No conversations yet</p>
                  <p className="text-xs text-zinc-300 mt-1">Match with pets to start chatting!</p>
                </div>
              ) : (
                filteredConversations.map((conv, i) => {
                  const isUnread = conv.unread_count > 0;
                  const isEmptyConversation = !conv.last_message || conv.last_message === 'Start chatting!';
                  const isRemoving = removingConvId === conv.id;

                  return (
                    <div
                      key={conv.id}
                      className={`transition-all duration-300 ${isRemoving ? 'opacity-0 scale-95 max-h-0 overflow-hidden py-0 my-0 border-0' : 'max-h-36'}`}
                    >
                      <button
                        onClick={() => openConversation(conv)}
                        className="w-full bg-white dark:bg-zinc-950 hover:bg-zinc-50 p-3.5 rounded-2xl flex items-center gap-3.5 transition-all active:scale-[0.98] text-left shadow-sm border border-transparent hover:border-primary/10 hover-lift animate-slide-up ripple-container relative"
                        style={{ animationDelay: `${i * 60}ms` }}
                      >
                        {isUnread && (
                          <div className="flex-shrink-0 w-5 h-5 bg-rose-50 border border-rose-200 rounded-full flex items-center justify-center badge-pop">
                            <span className="text-[9px] text-primary">🐾</span>
                          </div>
                        )}
                        
                        <div className="relative flex-shrink-0">
                          <img className="w-12 h-12 rounded-2xl object-cover shadow-sm" src={avatarUrl(conv.partner_avatar) || '/logo.png'} alt={conv.partner_name} loading="lazy" decoding="async" />
                          {onlineUsers.has(conv.partner_user_id) && (
                            <div className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-emerald-400 border-2 border-white rounded-full status-online" />
                          )}
                        </div>

                        <div className="flex-1 overflow-hidden">
                          <div className="flex justify-between items-center mb-0.5">
                            <span className={`text-on-surface text-base tracking-tight flex items-center gap-1.5 ${isUnread ? 'font-black' : 'font-bold'}`}>
                              <span>{conv.partner_name}</span>
                              <PremiumBadge pet={conv} size="text-sm" />
                            </span>
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] font-bold text-zinc-300 uppercase tracking-widest">Active</span>
                              {isEmptyConversation && (
                                <div
                                  role="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setConfirmRemoveModal(conv);
                                  }}
                                  className="w-[22px] h-[22px] rounded-full bg-zinc-100 dark:bg-zinc-800 hover:bg-rose-50 hover:text-rose-500 text-zinc-400 flex items-center justify-center transition-all active:scale-90 flex-shrink-0"
                                  title="Remove empty conversation"
                                >
                                  <span className="material-symbols-outlined text-[10px]">close</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <p className={`text-xs truncate ${isUnread ? 'font-black text-on-surface-variant' : 'font-medium text-zinc-400'}`}>
                            {conv.last_message || 'Start chatting!'}
                          </p>
                        </div>
                      </button>
                    </div>
                  );
                })
              )
            )}

            {confirmRemoveModal && (
              <Portal>
              <div className="fixed inset-0 z-[200] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4 select-none animate-fade-in" onClick={() => setConfirmRemoveModal(null)}>
                <div className="bg-white dark:bg-zinc-900 border border-outline-variant/10 rounded-[2.2rem] p-6 max-w-xs w-full shadow-2xl text-center space-y-4 animate-scale-up" onClick={e => e.stopPropagation()}>
                  <div className="w-12 h-12 rounded-full bg-rose-50 text-red-500 flex items-center justify-center mx-auto text-xl font-bold">
                    <span className="material-symbols-outlined text-2xl">chat_bubble</span>
                  </div>
                  <div>
                    <h3 className="font-extrabold text-sm text-on-surface">Remove this conversation?</h3>
                    <p className="text-xs text-zinc-400 font-medium mt-1">This conversation hasn't started yet.</p>
                  </div>
                  <div className="flex gap-3 pt-2">
                    <button
                      onClick={() => setConfirmRemoveModal(null)}
                      className="flex-1 py-3 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 text-zinc-700 dark:text-zinc-300 font-extrabold text-xs uppercase tracking-wider rounded-full transition-all active:scale-95"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirmRemoveConversation}
                      className="flex-1 py-3 bg-red-500 hover:bg-red-600 text-white font-extrabold text-xs uppercase tracking-wider rounded-full shadow-md transition-all active:scale-95"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
              </Portal>
            )}
          </section>
        )}

        {activeTab === 'pawcircle' && (
          <div className="animate-fade-in">
            <PawCircleTab embedMode={true} searchQuery={searchQuery} />
          </div>
        )}

        {activeTab === 'calls' && (
          <div className="animate-fade-in">
            <CallHistory searchQuery={searchQuery} />
          </div>
        )}
      </main>

      {selectedSharedPostId && (
        <SharedPostViewerModal
          postId={selectedSharedPostId}
          onClose={() => setSelectedSharedPostId(null)}
        />
      )}

      <div className="fixed top-1/4 right-0 opacity-[0.03] pointer-events-none select-none -z-10 rotate-12 overflow-hidden max-w-full">
        <span className="material-symbols-outlined text-[220px] text-primary">pets</span>
      </div>
    </div>
  );
}
