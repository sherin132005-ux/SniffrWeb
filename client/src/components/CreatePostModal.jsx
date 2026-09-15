import { useState, useRef, useEffect } from 'react';
import api from '../services/api';
import Portal from './Portal';
import UpsellModal from './UpsellModal';
import { isQuotaExceededError, quotaUpsellCopy } from '../utils/premiumErrors';

export default function CreatePostModal({ onClose, onPostCreated }) {
  const [upsell, setUpsell] = useState(null);
  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [taggedUsersInput, setTaggedUsersInput] = useState('');
  const [selectedTaggedUsers, setSelectedTaggedUsers] = useState([]); // array of usernames with '@'
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Dropdown search for Sniffr users/pets
  const [tagSearchResults, setTagSearchResults] = useState([]);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [isSearchingTags, setIsSearchingTags] = useState(false);

  // Media permission flow states: 'prompt', 'requesting', 'denied', 'granted'
  const [permissionStatus, setPermissionStatus] = useState('prompt');

  const fileRef = useRef();

  useEffect(() => {
    const saved = localStorage.getItem('sniffr_media_permission');
    if (saved === 'granted') {
      setPermissionStatus('granted');
    }
  }, []);

  // Search Sniffr users/pets when typing in Tag Friends
  useEffect(() => {
    const q = taggedUsersInput.trim().replace(/^@+/, '');
    if (!q) {
      setTagSearchResults([]);
      setShowTagDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      setIsSearchingTags(true);
      try {
        const res = await api.get(`/chat/search?q=${encodeURIComponent(q)}`);
        const pets = res?.results || res?.pets || [];
        setTagSearchResults(pets);
        setShowTagDropdown(true);
      } catch (err) {
        console.error('Failed to search companions:', err);
        setTagSearchResults([]);
      } finally {
        setIsSearchingTags(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [taggedUsersInput]);

  const handleSelectTaggedUser = (pet) => {
    const rawUsername = pet.pet_username ? pet.pet_username.replace(/^@+/, '') : pet.name.toLowerCase().replace(/\s+/g, '');
    const formattedUsername = `@${rawUsername}`;

    if (!selectedTaggedUsers.includes(formattedUsername)) {
      setSelectedTaggedUsers(prev => [...prev, formattedUsername]);
    }

    setTaggedUsersInput('');
    setShowTagDropdown(false);
    setErrorMessage('');
  };

  const handleRemoveTaggedUser = (tagToRemove) => {
    setSelectedTaggedUsers(prev => prev.filter(t => t !== tagToRemove));
  };

  // Automatically format hashtags input with '#'
  const handleHashtagsChange = (e) => {
    let val = e.target.value;
    setHashtags(val);
    setErrorMessage('');
  };

  const handleAddMediaClick = () => {
    if (permissionStatus === 'granted') {
      fileRef.current?.click();
    } else {
      setPermissionStatus('requesting');
    }
  };

  const grantPermission = () => {
    localStorage.setItem('sniffr_media_permission', 'granted');
    setPermissionStatus('granted');
    setErrorMessage('');
    setTimeout(() => {
      fileRef.current?.click();
    }, 100);
  };

  const denyPermission = () => {
    setPermissionStatus('denied');
    setErrorMessage('🐾 Gallery access denied. Sniffr needs permission to let you select pet memories.');
  };

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;

    const isVideo = f.type.startsWith('video/');
    const isImage = f.type.startsWith('image/');
    setErrorMessage('');

    if (isImage) {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
        setErrorMessage('🐾 Oh no! That doesn\'t look like a JPG, JPEG, PNG, or WEBP image. Check the format and try again!');
        return;
      }
      if (f.size > 10 * 1024 * 1024) {
        setErrorMessage('🐾 Wow, that\'s one heavy photo! Images must be under 10 MB. Try compressing it.');
        return;
      }
    } else if (isVideo) {
      if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(f.type)) {
        setErrorMessage('🐾 Oops! Videos must be in MP4, MOV, or WEBM format. Give it another sniff!');
        return;
      }
      if (f.size > 50 * 1024 * 1024) {
        setErrorMessage('🐾 That video is too large! Maximum video size is 50 MB.');
        return;
      }
    } else {
      setErrorMessage('🐾 Unsupported file type. Only photos and videos are allowed!');
      return;
    }

    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const parseHashtags = (str) => {
    if (!str) return [];
    return str
      .split(/[\s,]+/)
      .map(h => h.trim())
      .filter(Boolean)
      .map(h => h.startsWith('#') ? h : `#${h.replace(/^#+/, '')}`);
  };

  const parseManualTags = (str) => {
    if (!str) return [];
    return str
      .split(/[\s,]+/)
      .map(t => t.trim())
      .filter(Boolean)
      .map(t => t.startsWith('@') ? t : `@${t.replace(/^@+/, '')}`);
  };

  const handleSubmit = async () => {
    setErrorMessage('');

    // 1. MANDATORY PHOTO/VIDEO VALIDATION
    if (!file) {
      setErrorMessage('Please add at least one photo before sharing your Memory.');
      return;
    }

    // 2. OPTIONAL HASHTAGS VALIDATION (Auto-format with '#' if entered)
    let validHashtags = [];
    if (hashtags.trim()) {
      const rawHashtags = hashtags.trim().split(/[\s,]+/).filter(Boolean);
      validHashtags = rawHashtags.map(h => h.startsWith('#') ? h : `#${h.replace(/^#+/, '')}`);
    }

    // 3. OPTIONAL TAG FRIENDS VALIDATION (Auto-format with '@' if entered)
    const typedTags = parseManualTags(taggedUsersInput);
    const allTags = Array.from(new Set([...selectedTaggedUsers, ...typedTags]));

    setLoading(true);
    try {
      const form = new FormData();
      let finalCaption = caption.trim();

      const hashStr = validHashtags.join(' ');
      const tagStr = allTags.join(', ');

      if (hashStr) finalCaption += `\n\n${hashStr}`;
      if (tagStr) finalCaption += `\n\nWith: ${tagStr}`;

      form.append('caption', finalCaption);
      if (file) form.append('media', file);

      await api.post('/posts', form);
      if (onPostCreated) onPostCreated();
      onClose();
    } catch (err) {
      if (isQuotaExceededError(err)) {
        setUpsell(quotaUpsellCopy(err));
      } else {
        console.error('Post failed:', err);
        setErrorMessage(err.message || '🐾 Sniff... something went wrong while posting.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Portal>
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100] flex items-center justify-center p-4 selection:bg-primary-container selection:text-on-primary-container" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-surface-container-lowest p-6 sm:p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl relative overflow-hidden transition-all duration-300 transform scale-100 opacity-100 border border-outline-variant/10">
        
        {/* Decorative blobs */}
        <div className="absolute -top-10 -right-10 w-32 h-32 bg-primary-container/30 blur-2xl rounded-full -z-10 pointer-events-none"></div>
        <div className="absolute -bottom-10 -left-10 w-32 h-32 bg-secondary-container/30 blur-2xl rounded-full -z-10 pointer-events-none"></div>

        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2 text-primary">
            <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>add_photo_alternate</span>
            <h2 className="text-xl font-extrabold tracking-tight text-on-surface">New Memory</h2>
          </div>
          <button className="w-8 h-8 flex items-center justify-center rounded-full bg-surface-container-low text-on-surface-variant hover:bg-surface-container-high transition-colors active:scale-90" onClick={onClose}>
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {errorMessage && (
          <div className="bg-error-container/20 border border-error/20 text-error text-[11px] font-bold p-4 rounded-2xl flex items-start gap-3 animate-shake mb-4 leading-relaxed">
            <span className="material-symbols-outlined text-lg mt-0.5 flex-shrink-0">error</span>
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Permission Request Box */}
        {permissionStatus === 'requesting' && (
          <div className="bg-primary-container/20 border border-primary/20 p-5 rounded-2xl mb-4 space-y-4 text-center animate-scale-up">
            <span className="material-symbols-outlined text-4xl text-primary animate-pulse">photo_library</span>
            <h3 className="font-bold text-sm text-on-surface">🐾 Gallery Permission</h3>
            <p className="text-xs text-on-surface-variant/80 leading-relaxed">Sniffr needs permission to access your gallery so you can share sweet moments with other pets.</p>
            <div className="flex gap-3">
              <button onClick={denyPermission} className="flex-1 py-2.5 rounded-xl bg-surface-container-high text-on-surface font-bold text-xs uppercase tracking-wider">Deny</button>
              <button onClick={grantPermission} className="flex-1 py-2.5 rounded-xl bg-primary text-white font-bold text-xs uppercase tracking-wider shadow-sm">Allow</button>
            </div>
          </div>
        )}

        {/* Permission Denied Box */}
        {permissionStatus === 'denied' && (
          <div className="bg-secondary-container/20 border border-secondary/20 p-5 rounded-2xl mb-4 space-y-4 text-center animate-scale-up">
            <span className="material-symbols-outlined text-4xl text-secondary">no_photography</span>
            <h3 className="font-bold text-sm text-on-surface">🐾 Gallery Access Needed</h3>
            <p className="text-xs text-on-surface-variant/80 leading-relaxed">You previously denied gallery permissions. We need access to upload your pet's photo or video.</p>
            <button onClick={grantPermission} className="w-full py-2.5 rounded-xl bg-gradient-to-br from-primary to-primary-fixed-dim text-white font-bold text-xs uppercase tracking-wider shadow-sm">Request Again</button>
          </div>
        )}

        {preview && (
          <div className="rounded-2xl overflow-hidden mb-4 shadow-sm border border-outline-variant/20 relative group bg-black/5 flex items-center justify-center max-h-64">
            {file?.type?.startsWith('video/') ? (
              <video src={preview} controls className="w-full max-h-64 object-contain" />
            ) : (
              <img src={preview} alt="Preview" className="w-full max-h-64 object-contain" />
            )}
            <button 
              onClick={() => { setFile(null); setPreview(null); }}
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity active:scale-90"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}

        <div className="space-y-3">
          <div className="bg-surface-container-low rounded-2xl p-4 focus-within:ring-2 ring-primary/20 transition-all border border-outline-variant/10">
            <textarea
              placeholder="What's on your pet's mind? 🐾"
              value={caption}
              onChange={e => setCaption(e.target.value)}
              rows={3}
              className="w-full bg-transparent resize-none text-sm text-on-surface placeholder:text-on-surface-variant/40 border-none focus:ring-0 p-0 font-medium"
            />
          </div>

          {/* Hashtags and Tag Friends */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-container-low rounded-2xl px-4 py-2.5 focus-within:ring-2 ring-primary/20 transition-all border border-outline-variant/10">
              <label className="block text-[8px] font-bold uppercase tracking-widest text-on-surface-variant mb-0.5">Hashtags</label>
              <input 
                type="text" 
                placeholder="#playdate #dog" 
                value={hashtags}
                onChange={handleHashtagsChange}
                onBlur={() => {
                  if (hashtags.trim()) {
                    setHashtags(parseHashtags(hashtags).join(' '));
                  }
                }}
                className="w-full bg-transparent text-xs text-on-surface placeholder:text-on-surface-variant/30 border-none p-0 focus:ring-0 font-semibold"
              />
            </div>

            <div className="bg-surface-container-low rounded-2xl px-4 py-2.5 focus-within:ring-2 ring-primary/20 transition-all border border-outline-variant/10 relative">
              <label className="block text-[8px] font-bold uppercase tracking-widest text-on-surface-variant mb-0.5">Tag Friends</label>
              
              {/* Selected Tag Badges */}
              {selectedTaggedUsers.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-1 max-h-16 overflow-y-auto">
                  {selectedTaggedUsers.map((tag, idx) => (
                    <span key={idx} className="bg-primary/10 text-primary text-[9px] font-extrabold px-1.5 py-0.5 rounded-md flex items-center gap-1">
                      <span>{tag}</span>
                      <button type="button" onClick={() => handleRemoveTaggedUser(tag)} className="hover:text-primary-fixed-dim">
                        <span className="material-symbols-outlined text-[10px]">close</span>
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <input 
                type="text" 
                placeholder="Search @username..." 
                value={taggedUsersInput}
                onChange={e => setTaggedUsersInput(e.target.value)}
                onFocus={() => { if (tagSearchResults.length > 0) setShowTagDropdown(true); }}
                className="w-full bg-transparent text-xs text-on-surface placeholder:text-on-surface-variant/30 border-none p-0 focus:ring-0 font-semibold"
              />

              {/* Tag Dropdown Search Results */}
              {showTagDropdown && (
                <div className="absolute left-0 right-0 top-full mt-2 z-50 bg-white dark:bg-zinc-900 rounded-2xl shadow-xl border border-outline-variant/20 max-h-48 overflow-y-auto p-1.5 space-y-1 animate-scale-up">
                  {isSearchingTags ? (
                    <div className="p-3 text-[11px] text-center text-zinc-400 font-bold flex items-center justify-center gap-1.5">
                      <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                      <span>Searching Sniffr companions...</span>
                    </div>
                  ) : tagSearchResults.length === 0 ? (
                    <div className="p-3 text-[11px] text-center text-zinc-400 font-bold">
                      No matching Sniffr companions found
                    </div>
                  ) : (
                    tagSearchResults.map(pet => (
                      <button
                        key={pet.id}
                        type="button"
                        onClick={() => handleSelectTaggedUser(pet)}
                        className="w-full p-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 rounded-xl flex items-center gap-2.5 transition-colors text-left cursor-pointer"
                      >
                        <img className="w-7 h-7 rounded-full object-cover shadow-xs flex-shrink-0" src={pet.avatar_url || '/logo.png'} alt={pet.name} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-bold text-on-surface truncate">{pet.name}</p>
                          <p className="text-[9px] font-bold text-primary truncate">
                            {pet.pet_username ? (pet.pet_username.startsWith('@') ? pet.pet_username : `@${pet.pet_username}`) : `@${pet.name.toLowerCase().replace(/\s+/g, '')}`}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <input type="file" ref={fileRef} onChange={handleFile} accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" hidden />
          <button 
            type="button"
            className="flex-1 py-3 bg-secondary-container text-on-secondary-container rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-secondary-container/80 transition-colors flex items-center justify-center gap-2 active:scale-[0.98] cursor-pointer" 
            onClick={handleAddMediaClick}
          >
            <span className="material-symbols-outlined text-[18px]">image</span> Add
          </button>
          
          <button 
            type="button"
            className="flex-1 py-3 bg-gradient-to-br from-primary to-primary-fixed-dim text-on-primary rounded-xl font-bold text-xs uppercase tracking-widest shadow-[0_4px_15px_-3px_rgba(244,167,185,0.4)] flex items-center justify-center gap-2 active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:active:scale-100" 
            onClick={handleSubmit} 
            disabled={loading || permissionStatus === 'requesting'}
          >
            {loading ? (
              <span className="material-symbols-outlined text-[18px] animate-spin">progress_activity</span>
            ) : (
              <span className="material-symbols-outlined text-[18px]">send</span>
            )}
            {loading ? 'Posting...' : 'Share'}
          </button>
        </div>
      </div>
    </div>
    {upsell && (
      <UpsellModal title={upsell.title} message={upsell.message} onClose={() => setUpsell(null)} />
    )}
    </Portal>
  );
}
