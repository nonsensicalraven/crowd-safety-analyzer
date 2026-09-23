-- migration.sql
--
-- The schema changed shape, not just additively: stream_id and
-- per-zone `location` are new on both tables, zones/clusters are now
-- JSON, and several old single-value columns (avg_density,
-- cluster_count, confidence on detections) don't exist in the new
-- contract at all. Patching this with a long chain of ALTER TABLE
-- statements would be more error-prone than it's worth for a
-- prototype with no real incident data riding on it yet.
--
-- Run this ONCE against your Postgres database (Neon or local) before
-- starting the updated backend. Base.metadata.create_all() (called on
-- app startup) only creates tables that don't already exist -- it
-- will NOT restructure existing ones.

DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS detections;

-- Tables are recreated automatically on next app startup, matching
-- models.py. If you'd rather create them explicitly right now instead
-- of waiting for app startup:

CREATE TABLE IF NOT EXISTS detections (
    id SERIAL PRIMARY KEY,
    stream_id VARCHAR(64) NOT NULL,
    frame_id INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    person_count INTEGER NOT NULL DEFAULT 0,
    directional_surge BOOLEAN NOT NULL DEFAULT FALSE,
    zones JSON NOT NULL,
    clusters JSON NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_detections_stream_id ON detections (stream_id);

CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    stream_id VARCHAR(64) NOT NULL,
    location VARCHAR(32) NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    alert_level INTEGER NOT NULL,
    alert_type VARCHAR(20) NOT NULL,
    duration INTEGER DEFAULT 0,
    user_acknowledged BOOLEAN DEFAULT FALSE,
    false_positive_flag BOOLEAN DEFAULT FALSE,
    response_team_arrived_at TIMESTAMP,
    cleared_at TIMESTAMP,
    source_detection_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_alerts_stream_id ON alerts (stream_id);
CREATE INDEX IF NOT EXISTS ix_alerts_location ON alerts (location);