/**
 * migrate.js — Idempotent schema + migration runner
 *
 * Execution order:
 *   1.  schema.sql                          — base tables (correct final schema)
 *   2.  001_add_exchange_to_positions.sql
 *   3.  002_add_metadata_to_positions.sql
 *   4.  003_transactions_engine.sql
 *   5.  004_add_cap_category_to_positions.sql
 *   6.  005_rename_buy_price_and_backfill_target.sql
 *   7.  006_news_intelligence.sql           — idempotent safety net
 *   8.  007_news_scoring_columns.sql        — idempotent safety net
 *   9.  008_consensus_engine.sql
 *   10. 009_weight_config.sql
 *   11. 010_scanner_alerts.sql
 *   12. 011_repair_news_schema.sql          — fixes UUID→BIGSERIAL + missing cols
 *
 * All statements use IF NOT EXISTS guards — safe to re-run every startup.
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
//
// IMPORTANT: schema.sql runs first and creates all tables in their correct
// final form. Numbered migrations evolve the schema or act as idempotent
// safety nets. Migration 011 repairs any DB that had the old news_items
// schema (UUID id, missing columns) — it runs DROP+RECREATE which is safe
// because news_items is a pure cache refilled every 90s automatically.
const SQL_FILES = [
  path.join(MODELS_DIR, 'schema.sql'),
  path.join(MIGRATIONS_DIR, '001_add_exchange_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '002_add_metadata_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '003_transactions_engine.sql'),
  path.join(MIGRATIONS_DIR, '004_add_cap_category_to_positions.sql'),
  path.join(MIGRATIONS_DIR, '005_rename_buy_price_and_backfill_target.sql'),
  path.join(MIGRATIONS_DIR, '006_news_intelligence.sql'),
  path.join(MIGRATIONS_DIR, '007_news_scoring_columns.sql'),
  path.join(MIGRATIONS_DIR, '008_consensus_engine.sql'),
  path.join(MIGRATIONS_DIR, '009_weight_config.sql'),
  path.join(MIGRATIONS_DIR, '010_scanner_alerts.sql'),
  path.join(MIGRATIONS_DIR, '011_repair_news_schema.sql'),
  path.join(MIGRATIONS_DIR, '012_holdings_auth.sql'),
  path.join(MIGRATIONS_DIR, '013_broker_holdings.sql'),
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
