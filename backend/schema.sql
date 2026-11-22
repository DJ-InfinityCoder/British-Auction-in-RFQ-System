PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS rfqs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    route TEXT NOT NULL DEFAULT '',
    start_at INTEGER NOT NULL,
    original_close_at INTEGER NOT NULL,
    close_at INTEGER NOT NULL,
    forced_close_at INTEGER NOT NULL,
    service_date TEXT NOT NULL,
    trigger_window INTEGER NOT NULL CHECK (trigger_window > 0),
    extension_duration INTEGER NOT NULL CHECK (extension_duration > 0),
    trigger_rule TEXT NOT NULL CHECK (trigger_rule IN ('any_bid', 'rank_change', 'leader_change')),
    CHECK (start_at < original_close_at AND original_close_at < forced_close_at),
    CHECK (close_at BETWEEN original_close_at AND forced_close_at)
);

CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY,
    rfq_id TEXT NOT NULL REFERENCES rfqs(id),
    carrier TEXT NOT NULL,
    supplier_key TEXT NOT NULL,
    freight INTEGER NOT NULL CHECK (freight >= 0),
    origin INTEGER NOT NULL CHECK (origin >= 0),
    destination INTEGER NOT NULL CHECK (destination >= 0),
    total INTEGER GENERATED ALWAYS AS (freight + origin + destination) STORED,
    transit_days INTEGER NOT NULL CHECK (transit_days > 0),
    valid_until TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    CHECK (freight + origin + destination > 0)
);

CREATE INDEX IF NOT EXISTS bids_rfq_price ON bids(rfq_id, total, id);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY,
    rfq_id TEXT NOT NULL REFERENCES rfqs(id),
    bid_id INTEGER NOT NULL REFERENCES bids(id),
    kind TEXT NOT NULL CHECK (kind IN ('bid', 'extension')),
    occurred_at INTEGER NOT NULL,
    reason TEXT,
    previous_close_at INTEGER,
    new_close_at INTEGER
);

CREATE INDEX IF NOT EXISTS activity_rfq ON activity(rfq_id, id DESC);
