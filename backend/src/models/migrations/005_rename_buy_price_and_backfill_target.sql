-- Migration 005: Align positions schema with average_buy_price/target
--
-- Root cause: portfolioService.js, transactionService.js, analyticsService.js,
-- and intelligenceService.js were all written against `average_buy_price`
-- and `target` columns that schema.sql never defined and no prior migration
-- (001-004) ever added. schema.sql still only has `buy_price`, `target1`,
-- `target2`. This was a missing migration, not a code bug in those services.
--
-- Idempotent: safe to re-run on every server start (migrate.js re-runs all
-- SQL files unconditionally, relying on each file guarding itself).

-- ── buy_price -> average_buy_price ────────────────────────────────────────
-- Plain ALTER ... RENAME COLUMN is not safely re-runnable (the source
-- column won't exist on the 2nd run), so guard it explicitly.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'positions' AND column_name = 'buy_price'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'positions' AND column_name = 'average_buy_price'
  ) THEN
    ALTER TABLE positions RENAME COLUMN buy_price TO average_buy_price;
  END IF;
END $$;

-- ── target1/target2 -> target ─────────────────────────────────────────────
-- No application code reads target1/target2 (verified by repo-wide search);
-- every service already expects a single `target`. Add it and backfill from
-- target1 once. target1/target2 are left in place untouched (no DROP) --
-- smallest safe change, fully reversible, no data loss.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS target DECIMAL(12, 2);

UPDATE positions
   SET target = target1
 WHERE target IS NULL
   AND target1 IS NOT NULL;
