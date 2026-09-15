import { useState, useEffect } from 'react';
import api from '../services/api';

// ─── Status config ───────────────────────────────────────────
const STATUS_CONFIG = {
  completed: {
    icon: null, // uses call type icon
    color: 'text-emerald-500',
    bg: 'bg-emerald-50 dark:bg-emerald-950/20',
    label: 'Completed',
  },
  missed: {
    icon: 'call_missed',
    color: 'text-red-500',
    bg: 'bg-red-50 dark:bg-red-950/20',
    label: 'Missed',
  },
  declined: {
    icon: 'do_not_disturb_on',
    color: 'text-orange-500',
    bg: 'bg-orange-50 dark:bg-orange-950/20',
    label: 'Declined',
  },
  failed: {
    icon: 'signal_disconnected',
    color: 'text-zinc-400',
    bg: 'bg-zinc-50 dark:bg-zinc-800/40',
    label: 'Failed',
  },
};

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatCallTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Yesterday ${time}`;
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function CallItem({ call }) {
  const [expanded, setExpanded] = useState(false);
  const statusConf = STATUS_CONFIG[call.status] || STATUS_CONFIG.failed;
  const isMissed = call.status === 'missed';
  const isDeclined = call.status === 'declined';
  const isFailed = call.status === 'failed';
  const isCompleted = call.status === 'completed';

  // Direction icon
  const directionIcon = call.direction === 'outgoing' ? 'call_made' : 'call_received';
  const directionColor = isCompleted
    ? call.direction === 'outgoing' ? 'text-sky-500' : 'text-emerald-500'
    : statusConf.color;

  // Call type badge
  const typeIcon = call.type === 'video' ? 'videocam' : 'call';
  const typeBg = call.type === 'video' ? 'bg-sky-500' : 'bg-emerald-500';
  const typeLabel = call.type === 'video' ? 'Video Call' : 'Voice Call';

  const duration = formatDuration(call.duration);

  return (
    <div
      className={`bg-white dark:bg-zinc-900 rounded-[2rem] shadow-sm border border-outline-variant/10 overflow-hidden transition-all duration-300 cursor-pointer hover:shadow-md hover-lift
        ${isMissed ? 'border-l-4 border-l-red-400' :
          isDeclined ? 'border-l-4 border-l-orange-400' :
          isFailed ? 'border-l-4 border-l-zinc-300' :
          'border-l-4 border-l-emerald-400'
        }`}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Main row */}
      <div className="p-5 flex items-center gap-4">
        {/* Avatar + call type badge */}
        <div className="relative flex-shrink-0">
          <img
            className="w-14 h-14 rounded-[1.5rem] object-cover"
            src={call.partner_avatar || '/logo.png'}
            alt={call.partner_name}
          />
          <div className={`absolute -bottom-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center border-2 border-white dark:border-zinc-900 shadow-sm ${typeBg}`}>
            <span className="material-symbols-outlined text-white text-[12px]">{typeIcon}</span>
          </div>
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <h4 className={`font-bold text-base tracking-tight truncate ${isMissed || isDeclined ? 'text-red-500' : 'text-on-surface'}`}>
            {call.partner_name}
          </h4>
          <div className="flex items-center gap-1.5 mt-0.5">
            {/* Direction icon */}
            <span className={`material-symbols-outlined text-[16px] ${directionColor}`}>
              {isMissed ? 'call_missed' : isDeclined ? 'do_not_disturb_on' : isFailed ? 'signal_disconnected' : directionIcon}
            </span>
            <span className={`text-[10px] font-bold uppercase tracking-widest ${statusConf.color}`}>
              {isCompleted ? (call.direction === 'outgoing' ? 'Outgoing' : 'Incoming') : statusConf.label}
            </span>
            <span className="text-zinc-300 text-[10px]">•</span>
            <span className="text-[10px] text-zinc-400 font-medium">{formatCallTime(call.created_at)}</span>
          </div>
        </div>

        {/* Right side: duration + chevron */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          {duration && (
            <span className="text-[11px] font-bold text-zinc-400 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-full">
              {duration}
            </span>
          )}
          <span className={`material-symbols-outlined text-[18px] text-zinc-300 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}>
            expand_more
          </span>
        </div>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="px-5 pb-5 pt-1 border-t border-zinc-100 dark:border-zinc-800 animate-fade-in text-left">
          <div className="grid grid-cols-2 gap-3">
            <div className={`${statusConf.bg} rounded-2xl p-4 text-center`}>
              <span className={`material-symbols-outlined text-2xl ${statusConf.color} mb-1 block`} style={{ fontVariationSettings: "'FILL' 1" }}>
                {call.type === 'video' ? 'videocam' : 'call'}
              </span>
              <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{typeLabel}</p>
            </div>
            <div className="bg-surface-container-low rounded-2xl p-4 text-center">
              <p className="text-xl font-extrabold text-on-surface">{duration || '-'}</p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Duration</p>
            </div>
            <div className="bg-surface-container-low rounded-2xl p-4 text-center col-span-2">
              <p className="text-xs font-bold text-on-surface-variant/70">
                {formatCallTime(call.created_at)}
              </p>
              <p className={`text-xs font-extrabold mt-0.5 ${statusConf.color}`}>
                {call.direction === 'outgoing' ? '📤 Outgoing' : '📥 Incoming'} - {statusConf.label}
              </p>
              {call.start_time && (
                <p className="text-[9px] text-zinc-400 font-medium mt-1">
                  Time: {new Date(call.start_time).toLocaleTimeString()} {call.end_time && `to ${new Date(call.end_time).toLocaleTimeString()}`}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CallHistory({ searchQuery = '' }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.get('/chat/calls/history');
        setHistory(data.history || []);
      } catch (err) { console.error(err); }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) return (
    <div className="space-y-4 animate-pulse px-0">
      {[1, 2, 3].map(i => <div key={i} className="h-24 bg-zinc-100 dark:bg-zinc-800 rounded-[2rem]" />)}
    </div>
  );

  const filteredHistory = history.filter(c => 
    c.partner_name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (filteredHistory.length === 0) return (
    <div className="text-center py-20 bg-zinc-50/50 dark:bg-zinc-900/50 rounded-[2.5rem] border border-dashed border-zinc-200 dark:border-zinc-800 animate-fade-in">
      <span className="material-symbols-outlined text-6xl text-zinc-200 mb-4 block animate-float">call</span>
      <p className="font-bold text-zinc-400">No calls matching query</p>
      <p className="text-xs text-zinc-300 mt-1">Try a different name 🐾</p>
    </div>
  );

  // Group chronologically
  const groups = { Today: [], Yesterday: [], Older: [] };
  filteredHistory.forEach(call => {
    const date = new Date(call.created_at);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0 && date.getDate() === now.getDate()) {
      groups.Today.push(call);
    } else if (diffDays <= 1 || (now.getDate() - date.getDate() === 1 && now.getMonth() === date.getMonth())) {
      groups.Yesterday.push(call);
    } else {
      groups.Older.push(call);
    }
  });

  const missedCount = filteredHistory.filter(c => c.status === 'missed').length;

  return (
    <div className="w-full space-y-4 text-left">
      {/* Summary banner */}
      {missedCount > 0 && (
        <div className="flex items-center gap-3 bg-red-50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30 rounded-2xl px-4 py-3 animate-fade-in">
          <span className="material-symbols-outlined text-red-500 text-xl animate-bounce">call_missed</span>
          <p className="text-sm font-bold text-red-500">
            {missedCount} missed call{missedCount > 1 ? 's' : ''}
          </p>
        </div>
      )}

      {/* Grouped calls list */}
      {Object.entries(groups).map(([groupName, items]) => {
        if (items.length === 0) return null;
        return (
          <div key={groupName} className="space-y-3">
            <h3 className="text-xs font-black text-primary uppercase tracking-widest pl-2 mb-1">{groupName}</h3>
            <div className="space-y-3">
              {items.map(call => (
                <CallItem key={call.id} call={call} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
