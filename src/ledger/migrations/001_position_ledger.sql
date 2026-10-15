-- ============================================================================
-- File: src/ledger/migrations/001_position_ledger.sql
-- Purpose: Position ledger, webhook audit trail, and observability metadata.
-- PostgreSQL migration. This is a parallel ingestion system and does not
-- change existing routes, entry gates, trading settings, or execution behavior.
-- ============================================================================

BEGIN;

-- Source of truth for positions received through authenticated webhooks.
CREATE TABLE IF NOT EXISTS position_ledger (
    id SERIAL PRIMARY KEY,
    tradetron_order_id VARCHAR(64) NOT NULL UNIQUE,
    webhook_event_id VARCHAR(64) NOT NULL UNIQUE,
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(8) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
    qty DECIMAL(20, 8) NOT NULL CHECK (qty > 0),
    entry_price DECIMAL(20, 8) NOT NULL CHECK (entry_price > 0),
    entry_time TIMESTAMP NOT NULL,
    exit_price DECIMAL(20, 8) CHECK (exit_price IS NULL OR exit_price > 0),
    exit_time TIMESTAMP,
    status VARCHAR(16) NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'PARTIAL')),
    gross_pnl_usd DECIMAL(20, 8),
    net_pnl_usd DECIMAL(20, 8),
    fees_usd DECIMAL(20, 8) DEFAULT 0,
    funding_usd DECIMAL(20, 8) DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_ledger_status
    ON position_ledger (status);

CREATE INDEX IF NOT EXISTS idx_position_ledger_symbol
    ON position_ledger (symbol);

-- Audit every incoming event, including invalid JSON and signature failures.
-- raw_payload must always be valid JSON because PostgreSQL JSONB rejects
-- malformed JSON; malformed request bodies are stored as a JSON wrapper.
CREATE TABLE IF NOT EXISTS webhook_events (
    id SERIAL PRIMARY KEY,
    event_id VARCHAR(64) NOT NULL UNIQUE,
    event_type VARCHAR(32) NOT NULL,
    symbol VARCHAR(32),
    raw_payload JSONB NOT NULL,
    signature_valid BOOLEAN NOT NULL,
    status VARCHAR(32) NOT NULL
        CHECK (status IN ('RECEIVED', 'PROCESSED', 'FAILED', 'SIGNATURE_FAILED')),
    error_message TEXT,
    received_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_status
    ON webhook_events (status);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
    ON webhook_events (received_at DESC);

-- Rebuildable cache for observability only; it is not authoritative.
CREATE TABLE IF NOT EXISTS system_meta (
    key VARCHAR(64) PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMIT;
