-- ═══════════════════════════════════════════════════════════════════════════
-- Over7 – PostgreSQL Schema  (idempotent — safe to re-run)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  firebase_uid          TEXT        UNIQUE NOT NULL,
  email                 TEXT        UNIQUE NOT NULL,

  -- Identity
  name                  TEXT        NOT NULL,
  birth_date            DATE        NOT NULL,
  city                  TEXT,
  bio                   TEXT,
  profile_picture_url   TEXT,                          -- main photo (Cloudinary URL)
  photos                TEXT[]      DEFAULT '{}',      -- additional photos
  tags                  TEXT[]      DEFAULT '{}',      -- passions / interests

  -- Dating preferences
  relation_type         TEXT,
  family_plans          TEXT,
  communication_style   TEXT,
  love_language         TEXT,

  -- Identity & lifestyle
  gender                TEXT,
  height_cm             SMALLINT,
  languages             TEXT[]      DEFAULT '{}',
  astro_sign            TEXT,
  education             TEXT,
  job_title             TEXT,
  company               TEXT,
  pet                   TEXT,
  alcohol               TEXT,
  tobacco               TEXT,
  sport                 TEXT,
  social_media          TEXT,
  evenings_type         TEXT,
  weekends_type         TEXT,
  favorite_song         TEXT,

  -- Profile completeness (0–100, recalculated on every PATCH /users/me)
  completude_pct        SMALLINT    NOT NULL DEFAULT 0,

  -- Arena & pool
  arena_votes_given     SMALLINT    NOT NULL DEFAULT 0,
  is_in_pool            BOOLEAN     NOT NULL DEFAULT FALSE,
  avg_rating            NUMERIC(4,2),

  -- Notifications
  push_token            TEXT,

  -- Metadata
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ
);

-- New columns added after initial migration (ADD COLUMN IF NOT EXISTS is idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender           TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_media     TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photos           TEXT[]    DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS completude_pct   SMALLINT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at       TIMESTAMP;
ALTER TABLE users ADD COLUMN IF NOT EXISTS arena_intro_seen BOOLEAN   NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB NOT NULL
  DEFAULT '{"match":true,"message":true,"speed_date":true,"like":true}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users (firebase_uid);
CREATE INDEX IF NOT EXISTS idx_users_is_in_pool   ON users (is_in_pool) WHERE is_in_pool = TRUE;

-- ─────────────────────────────────────────────────────────────────────────────
-- ARENA VOTES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS arena_votes (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  voter_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  voted_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating      SMALLINT    NOT NULL CHECK (rating BETWEEN 1 AND 10),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_arena_vote UNIQUE (voter_id, voted_id)
);

CREATE INDEX IF NOT EXISTS idx_arena_votes_voter ON arena_votes (voter_id);
CREATE INDEX IF NOT EXISTS idx_arena_votes_voted ON arena_votes (voted_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- LIKES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS likes (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  liker_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  liked_id        UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_vote_id  UUID        REFERENCES arena_votes (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_like UNIQUE (liker_id, liked_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_liker ON likes (liker_id);
CREATE INDEX IF NOT EXISTS idx_likes_liked ON likes (liked_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- MATCHES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS matches (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user1_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user2_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_match        UNIQUE (user1_id, user2_id),
  CONSTRAINT chk_match_order CHECK  (user1_id < user2_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_user1 ON matches (user1_id);
CREATE INDEX IF NOT EXISTS idx_matches_user2 ON matches (user2_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- MESSAGES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id    UUID        NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  sender_id   UUID        NOT NULL REFERENCES users  (id) ON DELETE CASCADE,
  content     TEXT        NOT NULL,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_match  ON messages (match_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER — keep users.updated_at fresh
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- BUG REPORTS
-- In-app bug reports submitted from Settings → "Signaler un bug".
-- user_id is nullable + ON DELETE SET NULL so reports survive account deletion.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bug_reports (
  id           SERIAL PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  description  TEXT NOT NULL,
  device_info  TEXT,
  os_info      TEXT,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_created_at
  ON bug_reports (created_at DESC);
