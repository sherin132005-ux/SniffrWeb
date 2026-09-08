import pg from 'pg';
const { Pool } = pg;

let pool;

export async function initDb() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase requires SSL; DATABASE_SSL=false opts out for a plain local
    // Postgres (e.g. local dev) that has no SSL configured. Certificate
    // validation is only relaxed outside production -- Supabase's
    // connection cert is signed by a real, publicly-trusted CA, so there's
    // no reason to skip validation once actually deployed; the old
    // unconditional rejectUnauthorized:false weakened the DB connection
    // against MITM in every environment, including production.
    ssl: process.env.DATABASE_SSL === 'false'
      ? false
      : { rejectUnauthorized: process.env.NODE_ENV === 'production' },
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