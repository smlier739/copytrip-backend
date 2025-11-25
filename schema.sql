-- schema.sql – Grenseløs Reise / copytrip-backend

-- 1) UUID-generator (Render og moderne Postgres har pgcrypto)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2) USERS-tabell
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  full_name       TEXT,

  birth_year      INTEGER,
  home_city       TEXT,
  home_country    TEXT,
  travel_style    TEXT,
  budget_per_day  INTEGER,
  experience_level TEXT,

  is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  is_premium      BOOLEAN NOT NULL DEFAULT FALSE,
  free_trip_limit INTEGER NOT NULL DEFAULT 5,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3) TRIPS-tabell
CREATE TABLE IF NOT EXISTS trips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  title             TEXT NOT NULL,
  description       TEXT,

  -- Evt. gammel "source"-kolonne du bruker for templates mm.
  source            TEXT,

  -- Hva slags reise:
  -- NULL                   = vanlige brukerreiser (KI / manuelle)
  -- 'template'             = maler
  -- 'user_episode_trip'    = reiser laget fra en episode
  -- 'grenselos_episode'    = system-trips som eier galleri + pakkeliste for en episode
  source_type       TEXT,

  -- Spotify episode-id (tekst)
  source_episode_id TEXT,
  -- Valgfri lenke til episoden
  episode_url       TEXT,

  -- Hvis du noen gang lagrer en hel template-struktur
  template_json     JSONB,

  -- Selve reiseinnholdet
  stops             JSONB NOT NULL DEFAULT '[]',
  packing_list      JSONB NOT NULL DEFAULT '[]',
  hotels            JSONB NOT NULL DEFAULT '[]',
  gallery           JSONB NOT NULL DEFAULT '[]',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indeks for kjappe oppslag på user_id
CREATE INDEX IF NOT EXISTS idx_trips_user_id
  ON trips(user_id);

-- Indeks for lookup på episodereiser
CREATE INDEX IF NOT EXISTS idx_trips_source_episode
  ON trips(source_episode_id, source_type);
