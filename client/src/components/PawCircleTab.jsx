import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { PawClipDefs, PAW_CLIP_STYLE } from './PawShape';
import { thumbnailUrl } from '../utils/media';

export default function PawCircleTab({ embedMode = true, searchQuery = '' }) {
  const { user, pet } = useAuth();

  const navigate = useNavigate();

  const [myCommunities, setMyCommunities] = useState([]);
  const [recommended, setRecommended] = useState([]);
  const [myCreatedCommunities, setMyCreatedCommunities] = useState([]);
  const [loading, setLoading] = useState(true);

  // Toggle state to see all recommended communities
  const [showAllRecommended, setShowAllRecommended] = useState(false);

  const [deleteTargetCommunity, setDeleteTargetCommunity] = useState(null);

  // IMPORTANT: this effect now depends on user?.id as well as searchQuery.
  // Previously it only depended on searchQuery, so if this component mounted
  // and fetched at the exact moment `user` was still null (a real timing gap
  // that exists right after a client-side login, unlike a full page reload
  // which has a loading gate), the fetch would silently fail via the catch
  // block below and NEVER retry — leaving PawCircles empty until a manual
  // browser refresh reset the timing. Depending on user?.id makes this effect
  // re-run automatically the moment the authenticated user becomes available.
  useEffect(() => {
    if (!user?.id) return; // wait until auth is actually ready
    fetchCommunities();
  }, [searchQuery, user?.id]);

  const fetchCommunities = async () => {
    if (!user?.id) return; // extra guard, belt-and-suspenders
    setLoading(true);
    try {
      const [resAll, resRec] = await Promise.all([
        api.get(`/communities?q=${encodeURIComponent(searchQuery)}`),
        api.get('/communities?recommended=true')
      ]);

      const allList = resAll.communities || [];

      // Filter My Joined Communities: joinStatus === 'Joined' AND NOT hidden AND NOT created by user
      const joined = allList.filter(c => c.joinStatus === 'Joined' && !c.isHiddenFromList && c.created_by !== user?.id);
      setMyCommunities(joined);

      // Filter My Created Communities: created_by === user.id AND NOT hidden
      const created = allList.filter(c => c.created_by === user?.id && !c.isHiddenFromList);
      setMyCreatedCommunities(created);

      setRecommended(resRec.communities || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteGroupConfirmed = async () => {
    if (!deleteTargetCommunity) return;
    try {
      await api.post(`/communities/${deleteTargetCommunity.id}/delete-group`);
      setMyCommunities(prev => prev.filter(c => c.id !== deleteTargetCommunity.id));
      setMyCreatedCommunities(prev => prev.filter(c => c.id !== deleteTargetCommunity.id));
    } catch (err) {
      console.error(err);
    } finally {
      setDeleteTargetCommunity(null);
    }
  };

  const getRecommendedBadge = (comm) => {
    // Dynamic badges: Trending (high growth), New (recent age), Popular (large counts)
    const ageDays = (Date.now() - new Date(comm.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 10) {
      return (
        <span className="absolute -top-1 -right-1 bg-gradient-to-r from-emerald-400 to-teal-400 text-white text-[7px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">
          ✨ New
        </span>
      );
    }
    if ((comm.recent_growth || 0) >= 3) {
      return (
        <span className="absolute -top-1 -right-1 bg-gradient-to-r from-orange-400 to-rose-400 text-white text-[7px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">
          🔥 Trending
        </span>
      );
    }
    if ((comm.member_count || 0) >= 10) {
      return (
        <span className="absolute -top-1 -right-1 bg-gradient-to-r from-amber-400 to-yellow-500 text-white text-[7px] font-black uppercase px-2 py-0.5 rounded-full shadow-sm">
          🏅 Popular
        </span>
      );
    }
    return null;
  };

  const renderCommunityBadges = (comm) => {
    const list = [];
    if (comm.verified) {
      list.push(
        <span key="v" className="material-symbols-outlined text-[13px] text-sky-500" title="Verified Community">
          verified
        </span>
      );
    }
    if ((comm.member_count || 0) >= 100) {
      list.push(
        <span key="t" className="material-symbols-outlined text-[13px] text-yellow-500" title="Top PawCircle">
          military_tech
        </span>
      );
    }
    const nameLower = (comm.name || '').toLowerCase();
    if (nameLower.includes('golden') || nameLower.includes('retriever')) {
      list.push(<span key="b" className="text-[11px]" title="Golden Retriever Club">🐶</span>);
    } else if (nameLower.includes('cat') || nameLower.includes('persian') || nameLower.includes('rescue')) {
      list.push(<span key="c" className="text-[11px]" title="Cat Rescue">🐱</span>);
    }
    if (list.length === 0) return null;
    return <div className="flex items-center gap-0.5 ml-1">{list}</div>;
  };

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse px-0">
        {[1, 2, 3].map(i => <div key={i} className="h-28 bg-zinc-100 dark:bg-zinc-800 rounded-[2.5rem]" />)}
      </div>
    );
  }

  /* ────────── SEE ALL RECOMMENDED COMMUNITIES VIEW ────────── */
  if (showAllRecommended) {
    return (
      <div className="space-y-6 animate-fade-in text-left">
        <PawClipDefs />
        <header className="flex items-center justify-between py-4 border-b">
          <button
            onClick={() => setShowAllRecommended(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 hover:text-primary transition-colors text-xs font-bold uppercase tracking-widest active:scale-95"
          >
            <span className="material-symbols-outlined text-sm">arrow_back</span>
            Back
          </button>
          <h2 className="text-sm font-extrabold tracking-widest uppercase text-on-surface">All Recommended Packs</h2>
          <div className="w-16" />
        </header>

        <div className="space-y-3">
          {recommended.map(comm => (
            <button
              key={comm.id}
              onClick={() => navigate(`/community/${comm.id}`)}
              className="w-full bg-white dark:bg-zinc-900 hover:bg-zinc-50 p-4 rounded-2xl flex items-center gap-4 border border-outline-variant/10 shadow-sm transition-all hover-lift text-left"
            >
              <img className="w-14 h-14 object-cover" style={{ clipPath: PAW_CLIP_STYLE }} src={thumbnailUrl(comm.cover_image) || '/logo.png'} alt={comm.name} loading="lazy" decoding="async" />
              <div className="flex-1 min-w-0">
                <h4 className="font-extrabold text-sm text-on-surface truncate flex items-center">
                  {comm.name}
                  {renderCommunityBadges(comm)}
                </h4>
                <p className="text-[10px] text-zinc-400 font-bold uppercase mt-1">{comm.member_count} Members • {comm.city}</p>
              </div>
              <span className="material-symbols-outlined text-zinc-300">chevron_right</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const hasCreatedAny = myCreatedCommunities.length > 0;

  return (
    <div className="w-full space-y-4 animate-fade-in text-left pb-8">
      <PawClipDefs />

      {/* SECTION 1: Recommended Packs */}
      {recommended.length > 0 && (
        <section className="animate-slide-up bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-outline-variant/10 shadow-sm relative">
          <div className="flex justify-between items-center mb-3">
            <div>
              <h2 className="font-extrabold text-base tracking-tight text-on-surface">Recommended Packs</h2>
              <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-0.5">Explore platform recommended circles</p>
            </div>
            <button
              onClick={() => setShowAllRecommended(true)}
              className="text-[10px] font-black text-primary uppercase tracking-widest hover:underline flex items-center gap-0.5"
            >
              See All <span className="material-symbols-outlined text-xs">arrow_forward</span>
            </button>
          </div>

          {/* Horizontally scrollable list showing 3-4 circles */}
          <div className="flex gap-4 overflow-x-auto pb-1.5 no-scrollbar pr-1">
            {recommended.slice(0, 5).map(comm => (
              <button
                key={comm.id}
                onClick={() => navigate(`/community/${comm.id}`)}
                className="flex-shrink-0 flex flex-col items-center gap-1.5 group cursor-pointer relative"
              >
                <div className="relative">
                  <div className="w-[64px] h-[64px] rounded-[1.6rem] bg-gradient-to-tr from-rose-200 to-amber-200 p-[2.5px] shadow-sm group-active:scale-95 transition-transform hover-lift">
                    <div className="w-full h-full bg-white rounded-[1.4rem] p-0.5 overflow-hidden">
                      <img className="w-full h-full object-cover animate-pulse-glow" style={{ clipPath: PAW_CLIP_STYLE }} src={comm.cover_image || '/logo.png'} alt={comm.name} loading="lazy" />
                    </div>
                  </div>
                  {getRecommendedBadge(comm)}
                </div>
                <div className="text-center max-w-[76px]">
                  <span className="text-[9px] font-black uppercase tracking-widest text-on-surface-variant line-clamp-1">
                    {comm.name}
                  </span>
                  <p className="text-[8px] font-bold text-zinc-400 uppercase tracking-wider">{comm.member_count} Members</p>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* SECTION 2: My PawCircle (Joined but not owned) */}
      <section className="space-y-3 bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-outline-variant/10 shadow-sm">
        <div>
          <h2 className="font-extrabold text-base tracking-tight text-on-surface">My PawCircle</h2>
          <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-0.5">Circles you have joined</p>
        </div>

        {myCommunities.length === 0 ? (
          /* Polished Empty State */
          <div className="text-center py-8 bg-zinc-50/50 dark:bg-zinc-800/30 rounded-2xl border border-dashed border-zinc-200/60 text-zinc-400 space-y-1">
            <span className="text-2xl animate-bounce block">🐾</span>
            <p className="font-extrabold text-xs text-zinc-500">You haven't joined any PawCircles yet.</p>
            <p className="text-[10px] text-zinc-400">Explore Recommended Packs to find your community.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {myCommunities.map((comm, idx) => (
              <button
                key={comm.id}
                onClick={() => navigate(`/community/${comm.id}`)}
                className="w-full bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100/50 p-3.5 rounded-2xl flex items-center gap-3.5 border border-transparent hover:border-primary/10 hover-lift transition-all shadow-sm active:scale-[0.98] text-left"
              >
                <img className="w-12 h-12 object-cover shadow-sm flex-shrink-0" style={{ clipPath: PAW_CLIP_STYLE }} src={thumbnailUrl(comm.cover_image) || '/logo.png'} alt={comm.name} loading="lazy" decoding="async" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <h4 className="font-extrabold text-xs text-on-surface truncate flex items-center">
                      {comm.name}
                      {renderCommunityBadges(comm)}
                    </h4>
                  </div>
                  <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                    {comm.member_count} Members
                  </p>
                  <p className="text-[10px] text-zinc-500 truncate mt-0.5">Last Activity: {comm.last_message || 'No messages yet'}</p>
                </div>
                <span className="material-symbols-outlined text-zinc-300 ml-1 text-sm flex-shrink-0">chevron_right</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* SECTION 3: Start Your Circle (Featured CTA Card) */}
      <section className="bg-gradient-to-tr from-pink-50 to-rose-100/50 dark:from-zinc-900 dark:to-zinc-800 rounded-3xl p-5 border border-pink-100/30 dark:border-zinc-800 shadow-sm flex flex-col items-center text-center relative overflow-hidden space-y-2.5">
        {/* Decorative background paw */}
        <div className="absolute right-0 bottom-0 opacity-[0.03] text-[180px] pointer-events-none select-none">🐾</div>

        <div className="space-y-2 z-10 flex flex-col items-center">
          <h3 className="text-base font-black text-zinc-800 dark:text-zinc-100 leading-tight">Create Your Own Circle 🐾</h3>
          <p className="text-[11px] text-zinc-500 font-bold leading-relaxed max-w-sm mx-auto">
            Start your own circle now and build a community for pet lovers. Meet playmates, share tips, and organize pack walks!
          </p>
          <button
            onClick={() => navigate('/community/create')}
            className="px-5 py-2.5 bg-gradient-to-r from-primary to-primary-fixed-dim text-white rounded-full font-black text-[9px] uppercase tracking-widest shadow-md hover-lift transition-transform active:scale-95 flex items-center justify-center gap-1 mx-auto"
          >
            <span className="material-symbols-outlined text-xs font-bold">add</span>
            Start Your Circle
          </button>
        </div>
      </section>

      {/* SECTION 4: Communities Created by Me */}
      <section className="space-y-3 bg-white dark:bg-zinc-900 rounded-3xl p-4 border border-outline-variant/10 shadow-sm">
        <div>
          <h2 className="font-extrabold text-base tracking-tight text-on-surface">Communities I Created</h2>
          <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest mt-0.5">Circles owned and managed by you</p>
        </div>

        {!hasCreatedAny ? (
          /* Polished Empty State */
          <div className="text-center py-8 bg-zinc-50/50 dark:bg-zinc-800/30 rounded-2xl border border-dashed border-zinc-200/60 text-zinc-400 space-y-1">
            <span className="text-2xl animate-bounce block">✨</span>
            <p className="font-extrabold text-xs text-zinc-500">You haven't created a PawCircle yet.</p>
            <p className="text-[10px] text-zinc-400">Start your first community today.</p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {myCreatedCommunities.map((comm, idx) => (
              <button
                key={comm.id}
                onClick={() => navigate(`/community/${comm.id}`)}
                className="w-full bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100/50 p-3.5 rounded-2xl flex items-center gap-3.5 border border-transparent hover:border-primary/10 hover-lift transition-all shadow-sm active:scale-[0.98] text-left"
              >
                <img className="w-12 h-12 object-cover shadow-sm flex-shrink-0" style={{ clipPath: PAW_CLIP_STYLE }} src={thumbnailUrl(comm.cover_image) || '/logo.png'} alt={comm.name} loading="lazy" decoding="async" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-0.5">
                    <h4 className="font-extrabold text-xs text-on-surface truncate flex items-center">
                      {comm.name}
                      {renderCommunityBadges(comm)}
                    </h4>
                    {/* Standardized Gold Owner Capsule Badge */}
                    <span className="text-[7px] font-black px-2 py-0.5 rounded-full uppercase tracking-widest owner-badge-gradient flex items-center gap-0.5">
                      <span>👑</span> Owner
                    </span>
                  </div>
                  <p className="text-[9px] font-bold text-zinc-400 uppercase tracking-widest">
                    {comm.member_count} Members
                  </p>
                  <p className="text-[9px] text-zinc-400 mt-1 font-medium">Created: {new Date(comm.created_at).toLocaleDateString()}</p>
                </div>
                <span className="material-symbols-outlined text-zinc-300 ml-1 text-sm flex-shrink-0">chevron_right</span>
              </button>
            ))}
          </div>
        )}
      </section>

    </div>
  );
}
