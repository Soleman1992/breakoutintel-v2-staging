-- Migration 002: Add company metadata columns to positions table
-- Run: psql -U biuser -d breakoutintel -f 002_add_metadata_to_positions.sql

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS company_name VARCHAR(150),
  ADD COLUMN IF NOT EXISTS sector       VARCHAR(100),
  ADD COLUMN IF NOT EXISTS industry     VARCHAR(100);
