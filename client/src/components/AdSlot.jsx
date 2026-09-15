// Placeholder ad unit. No ad inventory is integrated yet -- this is purely
// the render hook point the future real ad SDK/component would replace.
// Frequency of when this actually renders is decided by the caller, driven
// by premium.adFrequency (see PremiumContext / server/config/plans.js) --
// this component itself has no tier logic, it's just what shows up.
export default function AdSlot() {
  return (
    <div className="w-full p-4 rounded-2xl border border-dashed border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 text-center space-y-1 animate-fade-in">
      <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Sponsored</span>
      <p className="text-xs font-bold text-zinc-500">🐾 Your ad could be here - Sniffr Ads coming soon!</p>
    </div>
  );
}
