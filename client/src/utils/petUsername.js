// Mirrors server/utils/petUsername.js -- kept in sync manually since client
// and server are separate deployable packages. This is UX-only (instant
// feedback without a round trip); the server's copy is the real
// enforcement boundary.
export const RESERVED_USERNAMES = new Set([
  'home', 'meet', 'chat', 'profile', 'spotlight', 'faq', 'privacy', 'terms',
  'admin', 'community', 'pet-selection', 'create-profile', 'verify-email',
  'reset-password', 'settings', 'help', 'about', 'api', 'login', 'signup',
  'logout', 'app', 'www', 'support', 'contact', 'sniffr',
]);

const USERNAME_FORMAT = /^[a-z0-9_]{3,20}$/;

// Returns an error message string if invalid, or null if the (raw,
// possibly "@"-prefixed) username is fine to submit.
export function validatePetUsername(raw) {
  const stripped = String(raw || '').trim().replace(/^@+/, '').toLowerCase();
  if (!stripped) return 'Username is required.';
  if (!USERNAME_FORMAT.test(stripped)) {
    return 'Username must be 3-20 characters: letters, numbers, and underscores only.';
  }
  if (RESERVED_USERNAMES.has(stripped)) {
    return 'That username is reserved. Please choose another.';
  }
  return null;
}
