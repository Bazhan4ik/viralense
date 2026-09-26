CREATE EXTENSION IF NOT EXISTS postgis;

-- Hypertable via Tiger Data (TimescaleDB) declarative syntax.
-- For older TimescaleDB, swap the WITH clause for:
--   SELECT create_hypertable('risk_events', by_range('time'), if_not_exists => true);
CREATE TABLE IF NOT EXISTS risk_events (
  time           TIMESTAMPTZ            NOT NULL DEFAULT now(),
  user_hash      TEXT                   NOT NULL,
  location       GEOGRAPHY(POINT, 4326) NOT NULL,
  score          SMALLINT               NOT NULL,
  pulse_rate     REAL,
  breathing_rate REAL,
  hrv_ms         REAL
) WITH (tsdb.hypertable);

CREATE INDEX IF NOT EXISTS risk_events_location_gist
  ON risk_events USING GIST (location);

CREATE INDEX IF NOT EXISTS risk_events_user_time
  ON risk_events (user_hash, time DESC);

SELECT add_retention_policy('risk_events', INTERVAL '14 days', if_not_exists => true);
