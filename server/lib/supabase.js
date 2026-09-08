// Two separate Supabase clients, matching the two roles a server-side app
// legitimately needs:
//   - anonClient: same privileges a browser client would have (used for
//     signInWithPassword and verifying an already-issued access token).
//   - adminClient: service_role key, bypasses RLS and can create/update/
//     delete any auth user. Only ever used for account-management
//     operations we deliberately gate ourselves (signup, password
//     reset/change, revoking sessions, the one-time user-migration
//     script) -- never used to satisfy a normal per-request read.
//
// Lazily constructed (not at module load) so that local dev -- which has
// no SUPABASE_* env vars set and never exercises the email/password path
// against a real Supabase project -- can still boot and use the untouched
// Google Sign-In / custom-JWT path without these being configured.
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import config from '../config.js';

// The full supabase-js client eagerly constructs a Realtime client (even
// though we never use Realtime here -- only Auth), which requires a
// WebSocket implementation. Node's native `WebSocket` global only exists
// from Node 22+; Render (and this project's Node 20 dev environment)
// predate that, so without this the client throws at construction time.
const clientOptions = { realtime: { transport: ws } };

function required(name, value) {
  if (!value) {
    throw new Error(`[supabase] ${name} is not set -- required for Supabase Auth (email/password login).`);
  }
  return value;
}

let _anonClient = null;
export function getAnonClient() {
  if (!_anonClient) {
    _anonClient = createClient(
      required('SUPABASE_URL', config.SUPABASE_URL),
      required('SUPABASE_ANON_KEY', config.SUPABASE_ANON_KEY),
      { auth: { autoRefreshToken: false, persistSession: false }, ...clientOptions }
    );
  }
  return _anonClient;
}

let _adminClient = null;
export function getAdminClient() {
  if (!_adminClient) {
    _adminClient = createClient(
      required('SUPABASE_URL', config.SUPABASE_URL),
      required('SUPABASE_SERVICE_ROLE_KEY', config.SUPABASE_SERVICE_ROLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false }, ...clientOptions }
    );
  }
  return _adminClient;
}
