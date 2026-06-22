/**
 * migrate.js — Idempotent schema + migration runner
 *
 * Execution order:
 *   1. schema.sql          — CREATE TABLE IF NOT EXISTS (base tables)
 *   2. 001_add_exchange_to_positions.sql
 *   3. 002_add_metadata_to_positions.sql
 *   4. 003_transactions_engine.sql
 *   5. 004_add_cap_category_to_positions.sql
 *
 * All statements use IF NOT EXISTS / IF NOT EXISTS guards so re-running
 * is always safe (idempotent).
 *
 * Usage (called from index.js after DB pool is created):
 *   const runMigrations = require('./models/migrate');
 *   await runMigrations(db);
 */

const fs   = require('fs');
const path = require('path');

const MODELS_DIR     = __dirname;                          // backend/src/models/
const MIGRATIONS_DIR = path.join(MODELS_DIR, 'migrations');

// Ordered list — schema first, then migrations in numeric order
const SQL_FILES = [
  path.join(MODELS_DIR, 'schema.sql'),
  path.join(MIGRATIONS_DIR, '001_add_exchange_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '002_add_metadata_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '003_transactions_engine.sql'),
  path.join(MIGRATIONS_DIR, '004_add_cap_category_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '005_rename_buy_price_and_backfill_target.sql'),
  path.join(MIGRATIONS_DIR, '006_news_intelligence.sql'),
  path.join(MIGRATIONS_DIR, '007_news_scoring_columns.sql'),
];

async function runMigrations(pool) {
  console.log('[Migrate] Starting schema + migration run...');

  for (const filePath of SQL_FILES) {
    const label = path.relative(MODELS_DIR, filePath);
    try {
      const sql = fs.readFileSync(filePath, 'utf8');
      await pool.query(sql);
      console.log(`[Migrate] ✓ ${label}`);
    } catch (err) {
      // Log the error but do NOT crash — partial schema is better than no start.
      // Most errors here are benign (e.g. trigger already exists without
      // CREATE OR REPLACE support on older PG versions).
      console.error(`[Migrate] ✗ ${label} — ${err.message}`);
    }
  }

  console.log('[Migrate] Done ✓');
}

module.exports = runMigrations;
