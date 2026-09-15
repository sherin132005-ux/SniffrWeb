// Pet usernames now double as top-level profile URLs (app.sniffrweb.com/kitty,
// see client/src/App.jsx's catch-all route), so a username can never be
// allowed to collide with one of the app's own real page paths -- otherwise
// that specific pet's profile would become unreachable at its pretty URL
// (the static page always wins the route). Keep this in sync with the
// route list in client/src/App.jsx and with RESERVED_USERNAMES in
// client/src/utils/petUsername.js.
export const RESERVED_USERNAMES = new Set([
  'home', 'meet', 'chat', 'profile', 'spotlight', 'faq', 'privacy', 'terms',
  'admin', 'community', 'pet-selection', 'create-profile', 'verify-email',
  'reset-password', 'settings', 'help', 'about', 'api', 'login', 'signup',
  'logout', 'app', 'www', 'support', 'contact', 'sniffr',
]);

const USERNAME_FORMAT = /^[a-z0-9_]{3,20}$/;

// Accepts the raw value straight out of req.body (with or without a leading
// "@", any case), returns either { value: '@cleanname' } ready to store, or
// { error: CODE } for the route to turn into a 400. Centralizing this (POST
// / and PUT / in routes/profile.js both call it) is what fixed a real
// inconsistency: PUT previously stored pet_username verbatim from the
// client with no "@" normalization or reserved-word check at all, while
// POST only normalized the "@" and never checked reserved words either.
export function normalizePetUsername(raw) {
  if (raw === undefined || raw === null) return { error: 'MISSING_USERNAME' };
  const stripped = String(raw).trim().replace(/^@+/, '').toLowerCase();
  if (!stripped) return { error: 'MISSING_USERNAME' };
  if (!USERNAME_FORMAT.test(stripped)) {
    return { error: 'INVALID_USERNAME_FORMAT', message: 'Username must be 3-20 characters: letters, numbers, and underscores only.' };
  }
  if (RESERVED_USERNAMES.has(stripped)) {
    return { error: 'RESERVED_USERNAME', message: 'That username is reserved. Please choose another.' };
  }
  return { value: `@${stripped}` };
}
