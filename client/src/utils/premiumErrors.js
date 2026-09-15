// Every premium-gated backend route (see server/services/premiumGate.js)
// fails with one of these error codes. Centralized here so every page
// handles "this needs Premium" the same way -- catch, check, show
// UpsellModal -- instead of re-deriving the list of codes per call site.
const PREMIUM_GATE_ERROR_CODES = new Set([
  'PET_LIMIT_REACHED',
  'COMMUNITY_JOIN_LIMIT_REACHED',
  'COMMUNITY_CREATE_LIMIT_REACHED',
  'UNDO_LIKE_PREMIUM_ONLY',
  'SUPER_SNIFF_PREMIUM_ONLY',
]);

export function isPremiumGateError(err) {
  return !!err && PREMIUM_GATE_ERROR_CODES.has(err.code);
}

// QUOTA_EXCEEDED (server/services/mediaService.js's QuotaExceededError) is
// handled separately from the codes above -- it's not "this feature needs
// Premium", it's "you're out of room", so it gets its own upsell copy
// rather than being lumped into isPremiumGateError.
export function isQuotaExceededError(err) {
  return !!err && err.code === 'QUOTA_EXCEEDED';
}

function formatBytes(bytes) {
  if (bytes == null) return '';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)}MB`;
  return `${(mb / 1024).toFixed(1)}GB`;
}

// The moment a user is most likely to actually convert: they just tried to
// send a photo/video/voice note and got blocked by their own storage cap.
// Reused everywhere uploadWithQuota can throw QuotaExceededError.
export function quotaUpsellCopy(err) {
  const used = formatBytes(err?.usedBytes);
  const quota = formatBytes(err?.quotaBytes);
  return {
    title: "You've Hit Your Storage Limit 🐾",
    message: used && quota
      ? `You've used all ${used} of your ${quota} of space on photos, videos, and voice notes, so this one couldn't send. Upgrade for a lot more breathing room, and keep every memory (and every message) flowing.`
      : "You're out of room for photos, videos, and voice notes. Upgrade for a lot more breathing room, and keep every memory (and every message) flowing.",
  };
}
