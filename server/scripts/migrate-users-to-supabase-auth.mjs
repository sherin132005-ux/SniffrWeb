// One-time migration: creates a Supabase Auth user for every existing
// public.users row that doesn't have one yet (auth_user_id IS NULL),
// importing their EXISTING bcrypt password hash directly -- Supabase Auth
// supports this natively (documented for exactly this kind of migration),
// so existing users keep logging in with their current password. No
// forced password reset.
//
// Safe to re-run: only processes rows where auth_user_id IS NULL, and
// checks by email first in case a user was already created in a prior
// partial run.
//
// Usage:  node scripts/migrate-users-to-supabase-auth.mjs [--dry-run]
import '../config.js'; // loads server/.env into process.env as a side effect
import { getAdminClient } from '../lib/supabase.js';
import db from '../db/connection.js';
import { initDb } from '../db/connection.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  await initDb();
  const admin = getAdminClient();

  const users = await db.all(
    'SELECT id, email, password_hash, full_name FROM users WHERE auth_user_id IS NULL ORDER BY id'
  );

  console.log(`[migrate] ${users.length} user(s) to migrate${DRY_RUN ? ' (dry run -- no writes)' : ''}.`);

  let migrated = 0, skipped = 0, failed = 0;

  for (const user of users) {
    if (DRY_RUN) {
      console.log(`[migrate] would create Supabase Auth user for ${user.email} (id=${user.id})`);
      continue;
    }

    try {
      // Bcrypt hashes from bcryptjs are standard $2a$/$2b$ format --
      // Supabase Auth's admin.createUser accepts these directly via
      // password_hash (see Auth0-migration guide in Supabase's docs,
      // same documented mechanism this migration relies on).
      const { data, error } = await admin.auth.admin.createUser({
        email: user.email,
        password_hash: user.password_hash,
        email_confirm: true,
        user_metadata: { full_name: user.full_name || undefined },
      });

      if (error) {
        // Most likely cause: this email already exists in auth.users from
        // a prior partial run that failed after creation but before the
        // link-back UPDATE below. Look it up instead of failing.
        if (/already.*registered|already exists/i.test(error.message)) {
          const { data: list } = await admin.auth.admin.listUsers();
          const existing = list?.users?.find(u => u.email === user.email);
          if (existing) {
            await db.run('UPDATE users SET auth_user_id = ? WHERE id = ?', [existing.id, user.id]);
            console.log(`[migrate] linked existing Supabase user for ${user.email}`);
            migrated++;
            continue;
          }
        }
        console.error(`[migrate] FAILED for ${user.email}: ${error.message}`);
        failed++;
        continue;
      }

      await db.run('UPDATE users SET auth_user_id = ? WHERE id = ?', [data.user.id, user.id]);
      console.log(`[migrate] OK: ${user.email} -> ${data.user.id}`);
      migrated++;
    } catch (err) {
      console.error(`[migrate] FAILED for ${user.email}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[migrate] Done. migrated=${migrated} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
