import pg from 'pg';
const { Pool } = pg;

let pool;

export async function initDb() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase requires SSL; DATABASE_SSL=false opts out for a plain local
    // Postgres (e.g. local dev) that has no SSL configured.
    //
    // rejectUnauthorized is false here deliberately, on a wrong assumption
    // corrected the hard way: Supabase's connection *pooler* (Supavisor,
    // the :6543 "pooler.supabase.com" endpoint most apps actually use, as
    // this one does) presents a certificate chain Node's default trusted
    // CA store does not recognize -- turning this on crashed the server on
    // every boot in production with SELF_SIGNED_CERT_IN_CHAIN. The traffic
    // is still encrypted (TLS is on), this only skips validating the
    // chain against a CA bundle, which is the standard/accepted tradeoff
    // for Supabase's pooler specifically -- their own client libraries and
    // docs use the same setting for this exact endpoint.
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: false },
  });

  // quick connectivity check on boot, fails loudly if DATABASE_URL is wrong
  await pool.query('SELECT 1');
  console.log('✅ Connected to Postgres');

  return pool;
}

export function getDb() {
  if (!pool) throw new Error('Database not initialized. Call initDb() first.');
  return pool;
}

// Converts '?' placeholders (SQLite style) to '$1, $2, ...' (Postgres style)
// so the rest of the app's SQL strings don't need to change.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Runs `fn` inside a real BEGIN/COMMIT transaction on a single dedicated
// client (unlike dbAdapter.run/get/all, which each grab whatever
// connection is free in the pool -- fine for single statements, but
// multiple statements that must succeed or fail together need to stay on
// the same connection). `fn` receives a query interface scoped to that
// one client; on any thrown error the transaction is rolled back and the
// error re-thrown, otherwise it's committed. The client is always
// released back to the pool.
export async function withTransaction(fn) {
  const client = await pool.connect();
  const tx = {
    run: async (sql, params = []) => {
      const result = await client.query(toPgPlaceholders(sql), params);
      return { rowCount: result.rowCount, rows: result.rows };
    },
    get: async (sql, params = []) => {
      const result = await client.query(toPgPlaceholders(sql), params);
      return result.rows[0] || null;
    },
    all: async (sql, params = []) => {
      const result = await client.query(toPgPlaceholders(sql), params);
      return result.rows;
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// DB-agnostic query interface — same method names as the old sql.js adapter
export const dbAdapter = {
  async run(sql, params = []) {
    const pgSql = toPgPlaceholders(sql);
    const result = await getDb().query(pgSql, params);
    // Postgres doesn't have lastInsertRowid — callers that need the new row's id
    // should use `... RETURNING id` in their SQL and read result.rows[0].id instead.
    return { rowCount: result.rowCount, rows: result.rows };
  },
  async get(sql, params = []) {
    const pgSql = toPgPlaceholders(sql);
    const result = await getDb().query(pgSql, params);
    return result.rows[0] || null;
  },
  async all(sql, params = []) {
    const pgSql = toPgPlaceholders(sql);
    const result = await getDb().query(pgSql, params);
    return result.rows;
  },
  async exec(sql) {
    return getDb().query(sql);
  }
};

export default dbAdapter;