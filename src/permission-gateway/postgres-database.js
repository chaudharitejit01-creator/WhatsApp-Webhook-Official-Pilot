const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATION_LOCK_NAME = 'whatsapp-permission-gateway-migrations';

async function runMigrations(pool, migrationsDirectory = path.join(__dirname, 'postgres-migrations')) {
  const client = await pool.connect();
  let locked = false;
  let inTransaction = false;

  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_NAME]);
    locked = true;
    await client.query('BEGIN');
    inTransaction = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);

    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations ORDER BY version')).rows
        .map((row) => row.version),
    );
    const migrations = fs.readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const migration of migrations) {
      if (applied.has(migration)) continue;

      await client.query(fs.readFileSync(path.join(migrationsDirectory, migration), 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)',
        [migration, new Date().toISOString()],
      );
    }

    await client.query('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the migration error.
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_NAME]);
      } catch {
        // The connection is released immediately after migration setup.
      }
    }
    client.release();
  }
}

async function createPostgresDatabase({
  databaseUrl,
  max = 10,
  idleTimeoutMillis = 30000,
  connectionTimeoutMillis = 10000,
  migrationsDirectory,
} = {}) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL');

  const pool = new Pool({
    connectionString: databaseUrl,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis,
  });

  try {
    await runMigrations(pool, migrationsDirectory);
  } catch (error) {
    await pool.end();
    throw error;
  }

  return {
    pool,
    close: () => pool.end(),
  };
}

module.exports = {
  createPostgresDatabase,
  runMigrations,
};
