-- ============================================================================
-- Sniffr — Local-only PostgreSQL schema (reverse-engineered)
-- ============================================================================
-- This file is NOT generated from any tracked migration -- there isn't one.
-- server/db/migrations.js is dead code (its own header says so: SQLite-
-- flavored CREATE TABLE statements, never run against Postgres) and is
-- stale/incomplete relative to the live Supabase DB, which was built by hand
-- via untracked ad-hoc scripts.
--
-- This file was built by reading every server/**/*.js file that touches the
-- DB directly (models/*Repository.js, routes/*.js, socket/*.js,
-- services/*.js, middleware/auth.js + admin.js) and inferring the real
-- Postgres schema from the actual SQL strings in use -- column names, types
-- implied by comparisons/arithmetic, ON CONFLICT targets, FK relationships,
-- and JS-side boolean conventions (INTEGER 0/1 vs real BOOLEAN). Where
-- migrations.js *does* cover a table, it was used as a rough starting point
-- and cross-checked (and corrected) against real usage elsewhere.
--
-- Safe to re-run: enum creation is guarded, every table uses
-- CREATE TABLE IF NOT EXISTS, and indexes use CREATE INDEX IF NOT EXISTS.
--
-- Usage:
--   psql "$DATABASE_URL" -f server/db/local-schema.sql
-- or:
--   const sql = fs.readFileSync('server/db/local-schema.sql', 'utf8');
--   await pool.query(sql);
-- ============================================================================


-- ============================================================================
-- ENUM TYPES
-- ============================================================================
-- These three are commented out in migrations.js with a note that they ARE
-- real Postgres enum types already in use on the live Supabase DB (see
-- users.current_plan / plan_source / subscription_status and
-- payment_sessions.plan / plan_history.plan / plan_history.source /
-- plan_history.previous_plan below). Values match server/config/plans.js
-- (PLAN_KEYS) and the state machines documented in
-- server/services/subscriptionService.js.

DO $$ BEGIN
  CREATE TYPE plan_tier_enum AS ENUM ('free', 'plus', 'gold', 'platinum');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE plan_source_enum AS ENUM ('none', 'paid', 'launch_offer');
EXCEPTION WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE subscription_status_enum AS ENUM ('inactive', 'active', 'cancelled', 'expired');
EXCEPTION WHEN duplicate_object THEN null;
END $$;


-- ============================================================================
-- USERS
-- ============================================================================
-- active_pet_id's FK to pets is added further below (after the pets table
-- exists) to break the users<->pets circular dependency.
--
-- Boolean-flavored columns are INTEGER (0/1) throughout, matching how the
-- app writes them (`enabled ? 1 : 0`) and reads them (`!!user.field`) --
-- EXCEPT is_admin, which is a real BOOLEAN: middleware/admin.js and
-- subscriptionService.js's admin-notify query use `is_admin = TRUE`
-- directly in raw SQL, and migrations.js's own ALTER declares it
-- `BOOLEAN NOT NULL DEFAULT FALSE`.
CREATE TABLE IF NOT EXISTS users (
  id                          SERIAL PRIMARY KEY,
  email                       TEXT UNIQUE NOT NULL,
  username                    TEXT UNIQUE NOT NULL,
  password_hash               TEXT NOT NULL,
  full_name                   TEXT,
  active_pet_id               INTEGER,
  last_active_at              TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  reset_token                 TEXT,
  reset_token_expires_at      TIMESTAMPTZ,
  -- Links to a Supabase Auth identity (email/password login path only --
  -- Google Sign-In keeps using the existing custom JWT, no auth_user_id).
  -- No FK here (unlike the real Supabase project) since this local
  -- throwaway Postgres has no `auth` schema -- the email/password ->
  -- Supabase Auth path can't be exercised against local dev; test it
  -- against the real Supabase project instead.
  auth_user_id                 UUID UNIQUE,
  super_sniff_enabled         INTEGER DEFAULT 0,
  current_plan                plan_tier_enum DEFAULT 'free',
  plan_source                 plan_source_enum DEFAULT 'none',
  subscription_status         subscription_status_enum DEFAULT 'inactive',
  plan_start_date              TIMESTAMPTZ,
  plan_expiry_date             TIMESTAMPTZ,
  auto_renew                  INTEGER DEFAULT 0,
  premium_badge_enabled       INTEGER DEFAULT 1,
  is_founding_member          INTEGER DEFAULT 0,
  welcome_slider_seen         INTEGER DEFAULT 0,
  boost_credits_remaining     INTEGER DEFAULT 0,
  boost_credits_refreshed_at  TIMESTAMPTZ,
  -- Email verification (routes/auth.js "EMAIL VERIFICATION ROUTES")
  email_verified              INTEGER DEFAULT 0,
  email_verify_token          TEXT,
  email_verify_expires_at     TIMESTAMPTZ,
  -- PawPrint 2FA (routes/auth.js "PAWPRINT VERIFICATION (2FA) ENDPOINTS")
  pawprint_2fa_enabled        INTEGER DEFAULT 0,
  paw_code                    TEXT,
  paw_code_expires_at         TIMESTAMPTZ,
  -- PawPrint verification enable-by-email-link (referenced in auth.js
  -- comments; no route currently writes these two, kept for completeness)
  pawprint_verify_token_hash  TEXT,
  pawprint_verify_expires_at  TIMESTAMPTZ,
  -- Platform-admin flag (middleware/admin.js requireAdmin) -- real BOOLEAN,
  -- not the INTEGER 0/1 convention used elsewhere in this table.
  is_admin                    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Cloudinary storage usage tracking (services/mediaService.js) --
  -- override is nullable; NULL means "use the plan default in config.js".
  storage_used_bytes           BIGINT NOT NULL DEFAULT 0,
  storage_quota_override_bytes BIGINT,
  created_at                  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================================
-- PETS
-- ============================================================================
CREATE TABLE IF NOT EXISTS pets (
  id                                  SERIAL PRIMARY KEY,
  user_id                             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name                                TEXT NOT NULL,
  pet_username                        TEXT UNIQUE,
  type                                TEXT,
  gender                              TEXT,
  age                                 INTEGER,
  breed_type                         TEXT,
  breed_name                         TEXT,
  avatar_url                         TEXT,
  vaccinated                         INTEGER DEFAULT 0,
  pet_kyc                            INTEGER DEFAULT 0,
  latitude                           DOUBLE PRECISION,
  longitude                          DOUBLE PRECISION,
  location_text                      TEXT,
  bio                                TEXT,
  pawsitive_score                    INTEGER DEFAULT 50,
  is_flagged                         INTEGER DEFAULT 0,
  reported_count                     INTEGER DEFAULT 0,
  -- Kept TEXT (ISO string), matching migrations.js's own ALTER for this
  -- column (unlike most *_at columns, this one was never DATETIME).
  last_updated_location_timestamp    TEXT,
  country                            TEXT,
  state                              TEXT,
  city                               TEXT,
  area                               TEXT,
  created_at                         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pets_user ON pets(user_id);
CREATE INDEX IF NOT EXISTS idx_pets_lat ON pets(latitude);
CREATE INDEX IF NOT EXISTS idx_pets_lng ON pets(longitude);
CREATE INDEX IF NOT EXISTS idx_pets_geo ON pets(latitude, longitude);

-- Close the users<->pets circular dependency now that pets exists.
-- SET NULL (not CASCADE): deleting a pet shouldn't be blocked by, or
-- cascade into deleting, the owning user -- profile.js's switch-pet route
-- just needs active_pet_id to fall back to NULL if the referenced pet ever
-- disappears.
DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT fk_users_active_pet
    FOREIGN KEY (active_pet_id) REFERENCES pets(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_active_pet ON users(active_pet_id);


-- ============================================================================
-- POSTS
-- ============================================================================
CREATE TABLE IF NOT EXISTS posts (
  id                  SERIAL PRIMARY KEY,
  pet_id              INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  caption             TEXT,
  media_url           TEXT,
  media_type          TEXT DEFAULT 'image',
  is_flagged          INTEGER DEFAULT 0,
  moderation_status   TEXT DEFAULT 'approved',
  reported_count      INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_posts_pet ON posts(pet_id);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);


-- ============================================================================
-- LIKES / COMMENTS / REACTIONS / SHARES / REPORTS  (post engagement)
-- ============================================================================
CREATE TABLE IF NOT EXISTS likes (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
CREATE INDEX IF NOT EXISTS idx_likes_created ON likes(created_at);

-- parent_comment_id deliberately has NO foreign key constraint -- this
-- matches documented production behavior. PostRepository.deleteComment's
-- comment says explicitly: "No FK cascade exists on parent_comment_id (see
-- migrations.js) -- a deleted top-level comment must take its own replies
-- with it, or they'd linger ... permanently orphaned in the DB", and the
-- app manually runs `DELETE FROM comments WHERE parent_comment_id = ?`
-- before deleting the parent row itself specifically because the DB does
-- not enforce this relationship. Adding a real FK here (even ON DELETE
-- CASCADE) would technically still work, but a plain column is what's
-- actually live in production, so that's what's reproduced here.
CREATE TABLE IF NOT EXISTS comments (
  id                  SERIAL PRIMARY KEY,
  post_id             INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content             TEXT NOT NULL,
  parent_comment_id   INTEGER,
  created_at          TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_comment_id);

-- reaction is free TEXT (app-level valid set: 'paw'|'bone'|'fish'|'sleep'|
-- 'love', enforced in routes/posts.js, not a DB CHECK/enum).
CREATE TABLE IF NOT EXISTS reactions (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reaction    TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_post ON reactions(post_id);

CREATE TABLE IF NOT EXISTS shares (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shares_post ON shares(post_id);

-- post_id is NULLABLE: routes/communities.js's report endpoint inserts
-- into this same table with only (user_id, reason, created_at) -- a
-- community report, not a post report -- so post_id is left unset (NULL)
-- for those rows. `status` is never written anywhere in the current code
-- (only ever read via `COALESCE(pr.status, 'Pending')` in routes/posts.js),
-- so its real default in production is unknown -- see NOTES at the bottom.
CREATE TABLE IF NOT EXISTS post_reports (
  id          SERIAL PRIMARY KEY,
  post_id     INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reason      TEXT,
  status      TEXT,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id);
CREATE INDEX IF NOT EXISTS idx_post_reports_user ON post_reports(user_id);


-- ============================================================================
-- NOTIFICATIONS
-- ============================================================================
-- Created before `swipes` because swipes.notification_id references it.
CREATE TABLE IF NOT EXISTS notifications (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  avatar_url      TEXT,
  target_id       TEXT,
  sender_pet_id   INTEGER REFERENCES pets(id) ON DELETE SET NULL,
  is_read         INTEGER DEFAULT 0,
  action_status   TEXT DEFAULT 'pending',
  metadata_json   TEXT,
  created_at      TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_user_type_target ON notifications(user_id, type, target_id);


-- ============================================================================
-- SWIPES / MATCHES / CONVERSATIONS / MESSAGES  (Meet + Chat)
-- ============================================================================
-- Explicit sniff-request state machine (see MatchRepository.js):
--   request_status: 'awaiting' (pending) | 'accepted' (permanent match) |
--                   'rejected' (30-day cooldown)
--   status:         'pending' (within 5s undo window) | 'committed'
--   expires_at:     set for 'awaiting' and 'rejected', NULL for 'accepted'
-- action is free TEXT: 'like' | 'decline' | 'superlike' (SpotlightRepository
-- reads action IN ('like','superlike') for the profile-lick count).
CREATE TABLE IF NOT EXISTS swipes (
  id                 SERIAL PRIMARY KEY,
  from_pet_id        INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  to_pet_id          INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  action             TEXT,
  request_status     TEXT DEFAULT 'awaiting',
  status             TEXT DEFAULT 'committed',
  expires_at         TIMESTAMPTZ,
  notification_id    INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_pet_id, to_pet_id)
);
CREATE INDEX IF NOT EXISTS idx_swipes_from ON swipes(from_pet_id);
CREATE INDEX IF NOT EXISTS idx_swipes_to ON swipes(to_pet_id);
CREATE INDEX IF NOT EXISTS idx_swipes_request_status ON swipes(request_status);

-- source distinguishes a real Meet match ('meet', created only via
-- MatchRepository.acceptMeetRequest) from an incidental conversation-linkage
-- row created by directly messaging a pet you never Meet-matched with
-- ('chat', created via MessageRepository.findOrCreateConversation). Plain
-- TEXT, not an enum -- always set explicitly by every INSERT in the app.
CREATE TABLE IF NOT EXISTS matches (
  id          SERIAL PRIMARY KEY,
  pet1_id     INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  pet2_id     INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'meet',
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_matches_pet1 ON matches(pet1_id);
CREATE INDEX IF NOT EXISTS idx_matches_pet2 ON matches(pet2_id);

-- UNIQUE(match_id) is an added-for-safety constraint beyond migrations.js:
-- MessageRepository.findOrCreateConversation already only ever creates one
-- conversation per match (check-then-insert, no ON CONFLICT), so this just
-- makes that invariant DB-enforced too.
CREATE TABLE IF NOT EXISTS conversations (
  id          SERIAL PRIMARY KEY,
  match_id    INTEGER REFERENCES matches(id) ON DELETE CASCADE UNIQUE,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS messages (
  id                SERIAL PRIMARY KEY,
  conversation_id   INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT,
  media_url         TEXT,
  message_type      TEXT DEFAULT 'text',
  status            TEXT DEFAULT 'sent',
  delivered_at      TIMESTAMPTZ,
  seen_at           TIMESTAMPTZ,
  reply_to_id       INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

CREATE TABLE IF NOT EXISTS message_reactions (
  id          SERIAL PRIMARY KEY,
  message_id  INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reaction    TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);


-- ============================================================================
-- CALLS
-- ============================================================================
-- start_time/end_time kept TEXT (ISO strings), matching migrations.js's own
-- ALTERs for these two columns specifically (every other timestamp column
-- in that file uses DATETIME, these two deliberately don't).
CREATE TABLE IF NOT EXISTS calls (
  id                 SERIAL PRIMARY KEY,
  caller_pet_id      INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  receiver_pet_id    INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  type               TEXT CHECK (type IN ('audio', 'video')),
  status             TEXT CHECK (status IN ('completed', 'missed', 'declined', 'failed')),
  declined_by        TEXT,
  duration           INTEGER DEFAULT 0,
  start_time         TEXT,
  end_time           TEXT,
  created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_pet_id);
CREATE INDEX IF NOT EXISTS idx_calls_receiver ON calls(receiver_pet_id);


-- ============================================================================
-- COMMUNITIES (PawCircle)
-- ============================================================================
CREATE TABLE IF NOT EXISTS communities (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  breed          TEXT,
  pet_type       TEXT,
  city           TEXT,
  cover_image    TEXT,
  icon_image     TEXT,
  is_private     INTEGER DEFAULT 0,
  rules          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  member_count   INTEGER DEFAULT 1,
  invite_code    TEXT UNIQUE,
  tags           TEXT,
  verified       INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_communities_created_by ON communities(created_by);

CREATE TABLE IF NOT EXISTS community_members (
  id                SERIAL PRIMARY KEY,
  community_id      INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT DEFAULT 'Member',
  verified_badge    TEXT,
  last_active_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  joined_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  cleared_at        TIMESTAMPTZ,
  is_hidden         INTEGER DEFAULT 0,
  UNIQUE(community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_members_community ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_community_members_user ON community_members(user_id);

CREATE TABLE IF NOT EXISTS community_messages (
  id                SERIAL PRIMARY KEY,
  community_id      INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  sender_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content           TEXT,
  media_url         TEXT,
  message_type      TEXT DEFAULT 'text',
  is_announcement   INTEGER DEFAULT 0,
  is_pinned         INTEGER DEFAULT 0,
  reply_to_id       INTEGER REFERENCES community_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_messages_community ON community_messages(community_id);

-- Not present in migrations.js at all -- discovered from
-- CommunityRepository.getMessages' json_object_agg subquery and
-- socket/communities.js's react_to_community_message handler (same
-- toggle-reaction pattern as message_reactions, just scoped to
-- community_messages instead of messages).
CREATE TABLE IF NOT EXISTS community_message_reactions (
  id                        SERIAL PRIMARY KEY,
  community_message_id      INTEGER REFERENCES community_messages(id) ON DELETE CASCADE,
  user_id                   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  reaction                  TEXT NOT NULL,
  created_at                TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(community_message_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_message_reactions_msg ON community_message_reactions(community_message_id);

-- latitude/longitude/is_event are NOT in migrations.js -- discovered from
-- CommunityRepository.addAnnouncement and routes/communities.js's
-- POST /:id/announcements (an announcement can optionally double as a
-- nearby-event broadcast).
CREATE TABLE IF NOT EXISTS community_announcements (
  id             SERIAL PRIMARY KEY,
  community_id   INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  sender_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  latitude       DOUBLE PRECISION,
  longitude      DOUBLE PRECISION,
  is_event       INTEGER DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_announcements_community ON community_announcements(community_id);

CREATE TABLE IF NOT EXISTS community_photos (
  id             SERIAL PRIMARY KEY,
  community_id   INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  media_url      TEXT NOT NULL,
  caption        TEXT,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_photos_community ON community_photos(community_id);

-- event_date kept TEXT (ISO string), matching migrations.js.
CREATE TABLE IF NOT EXISTS community_events (
  id             SERIAL PRIMARY KEY,
  community_id   INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  event_date     TEXT,
  location       TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_events_community ON community_events(community_id);

-- options_json/votes_json are TEXT, not JSON/JSONB: CommunityRepository
-- does JSON.stringify() on write and JSON.parse() on read itself in JS --
-- see NOTES at the bottom.
CREATE TABLE IF NOT EXISTS community_polls (
  id             SERIAL PRIMARY KEY,
  community_id   INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  options_json   TEXT NOT NULL,
  votes_json     TEXT DEFAULT '{}',
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_community_polls_community ON community_polls(community_id);

-- Present in migrations.js and read/deleted elsewhere (CommunityRepository.
-- getDetailsWithStatus, routes/privacy.js account deletion), but no current
-- route ever INSERTs into it -- there's no "request to join a private
-- community" flow implemented yet. Included for completeness / forward
-- compatibility.
CREATE TABLE IF NOT EXISTS community_join_requests (
  id             SERIAL PRIMARY KEY,
  community_id   INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT DEFAULT 'pending',
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(community_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_community_join_requests_community ON community_join_requests(community_id);


-- ============================================================================
-- BLOCKED USERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS blocked_users (
  id          SERIAL PRIMARY KEY,
  blocker_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocker ON blocked_users(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked ON blocked_users(blocked_id);


-- ============================================================================
-- PROFILE VIEWS / SPOTLIGHT
-- ============================================================================
CREATE TABLE IF NOT EXISTS profile_views (
  id                SERIAL PRIMARY KEY,
  viewer_pet_id     INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  viewed_pet_id     INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  last_notified_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(viewer_pet_id, viewed_pet_id)
);
CREATE INDEX IF NOT EXISTS idx_profile_views_viewer ON profile_views(viewer_pet_id);
CREATE INDEX IF NOT EXISTS idx_profile_views_viewed ON profile_views(viewed_pet_id);

-- cycle_date kept TEXT ('YYYY-MM-DD' strings), matching migrations.js and
-- SpotlightRepository's own string-based date handling.
CREATE TABLE IF NOT EXISTS spotlight_history (
  id          SERIAL PRIMARY KEY,
  pet_id      INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  area        TEXT NOT NULL,
  score       INTEGER DEFAULT 0,
  cycle_date  TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(area, cycle_date)
);
CREATE INDEX IF NOT EXISTS idx_spotlight_history_pet ON spotlight_history(pet_id);
CREATE INDEX IF NOT EXISTS idx_spotlight_history_date ON spotlight_history(cycle_date);

CREATE TABLE IF NOT EXISTS spotlight_rank_tracking (
  id                   SERIAL PRIMARY KEY,
  pet_id               INTEGER REFERENCES pets(id) ON DELETE CASCADE,
  area                 TEXT NOT NULL,
  last_notified_rank   INTEGER,
  updated_at           TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pet_id, area)
);
CREATE INDEX IF NOT EXISTS idx_spotlight_rank_tracking_pet ON spotlight_rank_tracking(pet_id);


-- ============================================================================
-- BILLING: PAYMENT SESSIONS / PLAN HISTORY
-- ============================================================================
-- status is plain TEXT by design (see subscriptionService.js comments) --
-- values in current use: 'pending' | 'pending_review' | 'succeeded' |
-- 'failed' | 'rejected' | 'approval_in_progress' | 'rejection_in_progress'.
-- amount is DOUBLE PRECISION (INR, can be fractional in principle).
CREATE TABLE IF NOT EXISTS payment_sessions (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
  plan                  plan_tier_enum NOT NULL,
  amount                DOUBLE PRECISION NOT NULL,
  provider              TEXT NOT NULL DEFAULT 'mock',
  status                TEXT NOT NULL DEFAULT 'pending',
  provider_reference    TEXT,
  payment_method        TEXT,
  upi_transaction_id    TEXT,
  proof_url             TEXT,
  submitted_at          TIMESTAMPTZ,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rejection_reason      TEXT,
  created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  completed_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_user ON payment_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_sessions_status ON payment_sessions(status);
-- Race-proof backstop against the same UPI transaction ID being attached
-- to more than one active/succeeded session (see subscriptionService.js).
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_sessions_utr_active
  ON payment_sessions (upi_transaction_id)
  WHERE status IN ('pending_review', 'approval_in_progress', 'succeeded');

-- action is free TEXT by design (see subscriptionService.js comments) --
-- values in current use: 'subscribed' | 'renewed' | 'upgraded' |
-- 'downgraded' | 'cancelled' | 'expired' | 'launch_offer_granted' |
-- 'payment_rejected'.
CREATE TABLE IF NOT EXISTS plan_history (
  id                    SERIAL PRIMARY KEY,
  user_id               INTEGER REFERENCES users(id) ON DELETE CASCADE,
  plan                  plan_tier_enum NOT NULL,
  source                plan_source_enum NOT NULL,
  action                TEXT NOT NULL,
  amount_paid           DOUBLE PRECISION DEFAULT 0,
  previous_plan         plan_tier_enum,
  payment_session_id    INTEGER REFERENCES payment_sessions(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_plan_history_user ON plan_history(user_id);


-- ============================================================================
-- RATINGS / NOTIFICATION PREFERENCES / AUTH SUPPORT TABLES
-- ============================================================================
CREATE TABLE IF NOT EXISTS app_ratings (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  matches     INTEGER DEFAULT 1,
  activity    INTEGER DEFAULT 1,
  pawcircle   INTEGER DEFAULT 1,
  nearby      INTEGER DEFAULT 1,
  offers      INTEGER DEFAULT 1,
  email       INTEGER DEFAULT 1,
  created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_token   TEXT UNIQUE NOT NULL,
  device_info    TEXT,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  device_info   TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked       INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);


-- ============================================================================
-- MEDIA_FILES — per-upload record backing users.storage_used_bytes
-- (services/mediaService.js). Postgres never holds the media bytes
-- themselves, only this ledger + the running total on users.
-- ============================================================================
CREATE TABLE IF NOT EXISTS media_files (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url            TEXT NOT NULL,
  bytes          BIGINT NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'cloudinary',
  resource_type  TEXT,
  subdir         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_media_files_user_id ON media_files(user_id);


-- ============================================================================
-- NOTES — spots to double-check by hand
-- ============================================================================
-- 1. comments.parent_comment_id has NO foreign key constraint (intentional --
--    see the comment above its CREATE TABLE). PostRepository.deleteComment
--    manually cascades the delete in application code because the DB does
--    not. If you'd rather have real referential integrity for local testing,
--    it's safe to add `REFERENCES comments(id) ON DELETE CASCADE` yourself --
--    just know that diverges from what's actually live in production.
--
-- 2. post_reports.status is never written by any route/repository in the
--    current codebase (only ever read via `COALESCE(pr.status, 'Pending')`
--    in routes/posts.js GET /reports). It's included as a nullable TEXT
--    column with no default; production's actual default (if any) is
--    unconfirmed since nothing here sets it.
--
-- 3. community_join_requests is defined and read/deleted, but no route
--    currently INSERTs into it -- there is no implemented "request to join
--    a private community" flow. Schema included for completeness; verify
--    against production whether this table is actually populated at all.
--
-- 4. JSON-ish columns are all plain TEXT, not JSON/JSONB, because the app
--    does its own JSON.stringify()/JSON.parse() in JS:
--      - notifications.metadata_json
--      - community_polls.options_json / community_polls.votes_json
--    Do NOT change these to JSONB -- node-pg would then hand back already-
--    parsed objects instead of strings, and the app's `JSON.parse(x)` calls
--    would throw on a non-string input.
--
-- 5. Lat/lng columns (pets.latitude/longitude, community_announcements.
--    latitude/longitude) are plain DOUBLE PRECISION, not PostGIS geography/
--    geometry types. PetRepository.js's own comment says its bounding-box +
--    haversine approach is "ready for PostGIS migration" but that migration
--    has NOT happened -- production is plain lat/lng columns today.
--
-- 6. Several *_at-looking columns are intentionally TEXT, not TIMESTAMPTZ,
--    because migrations.js itself declared them TEXT (ISO strings written/
--    read as strings by the app, never used in NOW()/INTERVAL arithmetic):
--      - calls.start_time, calls.end_time
--      - pets.last_updated_location_timestamp
--      - community_events.event_date
--      - spotlight_history.cycle_date ('YYYY-MM-DD')
--
-- 7. swipes.action, matches.source, payment_sessions.status, and
--    plan_history.action are all plain TEXT with app-level valid-value
--    sets rather than DB CHECK constraints or enums -- this mirrors explicit
--    comments in the source (e.g. subscriptionService.js: "action is free
--    TEXT (not an enum) by design, so new billing events ... never need a
--    migration"). Deliberately not tightened here.
--
-- 8. users.pawprint_verify_token_hash / pawprint_verify_expires_at are
--    referenced only in a routes/auth.js section header comment
--    ("PAWPRINT VERIFICATION — ENABLE-BY-EMAIL-LINK") with a note that they
--    "must be added to the live Supabase DB by hand" -- no route in the
--    current codebase actually reads or writes them yet. Included for
--    forward compatibility; may not reflect a real, populated production
--    column.
--
-- 9. reactions/likes/message_reactions/community_message_reactions all got
--    UNIQUE(post_or_message, user_id) constraints added here even where the
--    app enforces "one per pair" via a manual SELECT-then-branch instead of
--    ON CONFLICT (e.g. PostRepository.toggleReaction). This is a safety net
--    against races, not something the app's normal code path depends on.
-- ============================================================================
