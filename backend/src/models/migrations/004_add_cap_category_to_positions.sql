-- Migration 004: Add cap_category to positions
-- Stores cap category (Large/Mid/Small/Micro) at position creation time
-- so historical analytics always reflect the cap at time of entry.
-- Run: psql -U biuser -d breakoutintel -f 004_add_cap_category_to_positions.sql

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS cap_category VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_positions_user_cap
  ON positions(user_id, cap_category);
