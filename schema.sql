CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  birth_year INT,
  gender TEXT,
  home_city TEXT,
  home_country TEXT,
  preferred_language TEXT,

  -- Preferanser
  travel_style TEXT,              -- f.eks. "Luksus", "Backpacker"
  budget_per_day INT,             -- NOK
  experience_level TEXT,          -- "Nybegynner", "Middels", "Ekspert"
  travel_frequency TEXT,          -- "1-2 per år", etc.
  travel_with TEXT,               -- "Alene", "Partner", "Familie"

  preferred_trip_types JSONB,     -- f.eks ["Natur","Byferie"]
  transport_modes JSONB,          -- f.eks ["Bil","Tog"]
  diet_preferences JSONB,         -- f.eks ["Vegetar","Nøtteallergi"]
  bucket_list JSONB,              -- liste over drømmedestinasjoner

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT,          -- f.eks. "import", "manuell", "kopiert"
  template_json JSONB,  -- hele reise-strukturen du allerede har i admin
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  ...
);

CREATE TABLE IF NOT EXISTS trips (
  ...
);

CREATE INDEX IF NOT EXISTS idx_trips_user_id
  ON trips(user_id);

CREATE INDEX IF NOT EXISTS idx_trips_source_type_episode
  ON trips(source_type, source_episode_id);

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users(LOWER(email));
