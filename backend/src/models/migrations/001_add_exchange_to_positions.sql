-- Migration 001: Add exchange column to positions table
-- Run: psql -U biuser -d breakoutintel -f 001_add_exchange_to_positions.sql

ALTER TABLE positions
  ADD COLUMN IF NOT EXISTS exchange VARCHAR(10) NOT NULL DEFAULT 'NSE';
