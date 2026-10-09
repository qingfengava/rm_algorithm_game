-- Idempotent bootstrap schema. PostgreSQL is the source of truth; Redis is not
-- used to store submission or match state.
CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    handle text NOT NULL UNIQUE CHECK (handle ~ '^[A-Za-z0-9_-]{3,32}$'),
    api_token_hash char(64) NOT NULL UNIQUE,
    password_hash text,
    role text NOT NULL DEFAULT 'PLAYER' CHECK (role IN ('PLAYER', 'ADMIN')),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'PLAYER';
ALTER TABLE users ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PLAYER', 'ADMIN'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS submissions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    status text NOT NULL CHECK (status IN (
        'UPLOADED', 'COMPILING', 'COMPILE_FAILED',
        'QUEUED', 'RUNNING', 'FINISHED', 'RUNTIME_FAILED'
    )),
    is_current boolean NOT NULL DEFAULT false,
    compile_log text,
    failure_reason text,
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_user_created_idx
    ON submissions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_status_created_idx
    ON submissions(status, created_at);

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS submissions_current_idx
    ON submissions(is_current, status, created_at);
CREATE INDEX IF NOT EXISTS submissions_active_idx
    ON submissions(deleted_at, created_at DESC);

CREATE TABLE IF NOT EXISTS submission_artifacts (
    id uuid PRIMARY KEY,
    submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('SOURCE', 'COMPILED', 'COMPILE_LOG')),
    object_key text NOT NULL UNIQUE,
    content_type text NOT NULL,
    byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
    uploaded_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (submission_id, kind)
);

CREATE TABLE IF NOT EXISTS matches (
    id uuid PRIMARY KEY,
    red_submission_id uuid NOT NULL REFERENCES submissions(id),
    blue_submission_id uuid NOT NULL REFERENCES submissions(id),
    map_seed numeric(20, 0) NOT NULL CHECK (map_seed >= 0),
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'FINISHED', 'RUNTIME_FAILED')),
    winner text CHECK (winner IN ('RED', 'BLUE', 'DRAW')),
    failure_reason text,
    map_data jsonb,
    initial_state jsonb,
    replay_object_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CHECK (red_submission_id <> blue_submission_id),
    CHECK (status <> 'FINISHED' OR winner IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS matches_created_idx ON matches(created_at DESC, id DESC);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS replay_object_key text;
CREATE INDEX IF NOT EXISTS matches_red_idx ON matches(red_submission_id, created_at DESC);
CREATE INDEX IF NOT EXISTS matches_blue_idx ON matches(blue_submission_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS matches_pair_seed_idx
    ON matches(red_submission_id, blue_submission_id, map_seed);

CREATE TABLE IF NOT EXISTS match_events (
    match_id uuid NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    seq integer NOT NULL CHECK (seq >= 0),
    event jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (match_id, seq)
);

CREATE TABLE IF NOT EXISTS leaderboard_entries (
    submission_id uuid PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    rank integer NOT NULL CHECK (rank > 0),
    wins integer NOT NULL DEFAULT 0 CHECK (wins >= 0),
    draws integer NOT NULL DEFAULT 0 CHECK (draws >= 0),
    losses integer NOT NULL DEFAULT 0 CHECK (losses >= 0),
    win_rate numeric(7, 6) NOT NULL DEFAULT 0 CHECK (win_rate BETWEEN 0 AND 1),
    points_rate numeric(7, 6) NOT NULL DEFAULT 0 CHECK (points_rate BETWEEN 0 AND 1),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leaderboard_rank_idx ON leaderboard_entries(rank, submission_id);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id uuid PRIMARY KEY,
    entries jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaderboard_overrides (
    submission_id uuid PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
    wins integer NOT NULL CHECK (wins >= 0),
    draws integer NOT NULL CHECK (draws >= 0),
    losses integer NOT NULL CHECK (losses >= 0),
    reason text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leaderboard_snapshots_created_idx
    ON leaderboard_snapshots(created_at DESC);
