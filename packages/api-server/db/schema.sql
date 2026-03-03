-- Arena Protocol v2 (Phase 1) PostgreSQL baseline schema
-- This schema is additive and can be applied before switching persistence from JSON to Postgres.

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS siwe_nonces (
  id BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  nonce VARCHAR(128) NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_siwe_nonces_wallet_nonce
  ON siwe_nonces (wallet_address, nonce);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  session_token VARCHAR(128) NOT NULL UNIQUE,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id BIGSERIAL PRIMARY KEY,
  agent_id VARCHAR(64) NOT NULL UNIQUE,
  owner_wallet_address VARCHAR(42) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  connection_type VARCHAR(16) NOT NULL CHECK (connection_type IN ('webhook', 'sdk', 'stdio')),
  endpoint TEXT NOT NULL,
  secret_ref TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seasons (
  id BIGSERIAL PRIMARY KEY,
  season_id VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  settlement_algorithm VARCHAR(64) NOT NULL,
  leaderboard_hash VARCHAR(66),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cycles (
  id BIGSERIAL PRIMARY KEY,
  season_id VARCHAR(64) NOT NULL,
  cycle_id VARCHAR(64) NOT NULL,
  cycle_root VARCHAR(66) NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (season_id, cycle_id)
);

CREATE TABLE IF NOT EXISTS decision_replay (
  id BIGSERIAL PRIMARY KEY,
  season_id VARCHAR(64) NOT NULL,
  cycle_id VARCHAR(64) NOT NULL,
  agent_id VARCHAR(64) NOT NULL,
  snapshot_hash VARCHAR(64) NOT NULL,
  portfolio_before_hash VARCHAR(64) NOT NULL,
  portfolio_after_hash VARCHAR(64) NOT NULL,
  signals_hash VARCHAR(64) NOT NULL,
  signal_count INTEGER NOT NULL DEFAULT 0,
  trade_count INTEGER NOT NULL DEFAULT 0,
  trace_id VARCHAR(64),
  idempotency_key VARCHAR(128),
  request_hash VARCHAR(64),
  response_hash VARCHAR(64),
  latency_ms INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

