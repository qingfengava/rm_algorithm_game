const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const schemaPath = path.join(__dirname, 'schema.sql');

function createPool(env = process.env) {
  return new Pool({
    ...(env.DATABASE_URL
      ? { connectionString: env.DATABASE_URL }
      : {
          host: env.POSTGRES_HOST || 'postgres',
          port: Number(env.POSTGRES_PORT || 5432),
          database: env.POSTGRES_DB || 'arena',
          user: env.POSTGRES_USER || 'arena',
          password: env.POSTGRES_PASSWORD || 'arena_local_only',
        }),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
}

async function bootstrap(pool) {
  await pool.query(await fs.readFile(schemaPath, 'utf8'));
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function provisionUser(pool, handle, token) {
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO users (id, handle, api_token_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (handle) DO UPDATE SET api_token_hash = EXCLUDED.api_token_hash
     RETURNING id, handle, created_at`,
    [id, handle, tokenHash(token)],
  );
  return result.rows[0];
}

async function findUserByToken(pool, token) {
  const result = await pool.query(
    'SELECT id, handle FROM users WHERE api_token_hash = $1',
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}

async function createSubmission(pool, { id, userId, name, stagingKey }) {
  return transaction(pool, async (client) => {
    const submission = await client.query(
      `INSERT INTO submissions (id, user_id, name, status, is_current)
       VALUES ($1, $2, $3, 'UPLOADED', false)
       RETURNING id, user_id, name, status, created_at, updated_at`,
      [id, userId, name],
    );
    await client.query(
      `INSERT INTO submission_artifacts
       (id, submission_id, kind, object_key, content_type)
       VALUES ($1, $2, 'SOURCE', $3, 'application/zip')`,
      [crypto.randomUUID(), id, stagingKey],
    );
    return submission.rows[0];
  });
}

async function getSubmission(pool, id, userId) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.name, s.status, s.compile_log,
            s.failure_reason, s.created_at, s.updated_at,
            a.object_key AS source_key, a.byte_size AS source_size,
            a.uploaded_at AS source_uploaded_at
       FROM submissions s
       JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
      WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  return result.rows[0] || null;
}

async function listReadySubmissions(pool, limit = 50) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, a.object_key AS source_key
       FROM submissions s
       JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
      WHERE s.status = 'UPLOADED' AND a.uploaded_at IS NOT NULL
      ORDER BY s.created_at, s.id
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function listCurrentAlgorithms(pool) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.name, s.status,
            a.object_key AS runner_key, a.byte_size AS runner_size
       FROM submissions s
       JOIN submission_artifacts a
         ON a.submission_id = s.id AND a.kind = 'COMPILED'
      WHERE s.is_current = true
        AND s.status IN ('QUEUED', 'RUNNING', 'FINISHED')
        AND a.uploaded_at IS NOT NULL
      ORDER BY s.created_at ASC, s.id ASC`,
  );
  return result.rows;
}

async function getCompiledArtifacts(pool, submissionIds) {
  if (!Array.isArray(submissionIds) || submissionIds.length === 0) return [];
  const result = await pool.query(
    `SELECT s.id AS submission_id, s.name, s.status, s.is_current,
            a.object_key, a.byte_size, a.content_type
       FROM submissions s
       JOIN submission_artifacts a
         ON a.submission_id = s.id AND a.kind = 'COMPILED'
      WHERE s.id = ANY($1::uuid[]) AND a.uploaded_at IS NOT NULL`,
    [submissionIds],
  );
  return result.rows;
}

async function confirmSubmission(pool, { id, userId, confirmSource }) {
  return transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT s.status, a.object_key, a.uploaded_at
         FROM submissions s
         JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
        WHERE s.id = $1 AND s.user_id = $2
        FOR UPDATE OF s, a`,
      [id, userId],
    );
    if (!current.rows[0]) return null;
    if (current.rows[0].uploaded_at || current.rows[0].status !== 'UPLOADED') {
      return { confirmed: false, status: current.rows[0].status };
    }
    const stagingKey = current.rows[0].object_key;
    const finalKey = `submissions/${id}/source.zip`;
    const byteSize = await confirmSource(stagingKey, finalKey);
    await client.query(
      `UPDATE submission_artifacts
          SET object_key = $2, byte_size = $3, uploaded_at = now()
        WHERE submission_id = $1 AND kind = 'SOURCE'`,
      [id, finalKey, byteSize],
    );
    await client.query(
      `UPDATE submissions
          SET status = 'UPLOADED', updated_at = now()
        WHERE id = $1`,
      [id],
    );
    return { confirmed: true, status: 'UPLOADED' };
  });
}

async function listLeaderboard(pool, limit, offset) {
  const result = await pool.query(
    `SELECT e.rank, e.submission_id, s.name AS submission_name,
            u.id AS user_id, u.handle AS user_handle,
            e.wins, e.draws, e.losses, e.win_rate, e.points_rate, e.updated_at
       FROM leaderboard_entries e
       JOIN submissions s ON s.id = e.submission_id
       JOIN users u ON u.id = s.user_id
      ORDER BY e.rank ASC, e.submission_id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  // node-postgres deliberately returns PostgreSQL numeric values as strings.
  // These rates are bounded to [0, 1] by the schema, so a JSON number is safe
  // and is the representation expected by the public API.
  return result.rows.map((row) => ({
    ...row,
    win_rate: Number(row.win_rate),
    points_rate: Number(row.points_rate),
  }));
}

async function listMatches(pool, limit, offset) {
  const result = await pool.query(
    `SELECT m.id, m.red_submission_id, m.blue_submission_id,
            rs.name AS red_name, bs.name AS blue_name,
            ru.handle AS red_user, bu.handle AS blue_user,
            m.map_seed::text, m.status, m.winner, m.created_at,
            m.started_at, m.finished_at
       FROM matches m
       JOIN submissions rs ON rs.id = m.red_submission_id
       JOIN submissions bs ON bs.id = m.blue_submission_id
       JOIN users ru ON ru.id = rs.user_id
       JOIN users bu ON bu.id = bs.user_id
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

async function getMatch(pool, id) {
  const result = await pool.query(
    `SELECT m.id, m.red_submission_id, m.blue_submission_id,
            rs.name AS red_name, bs.name AS blue_name,
            ru.handle AS red_user, bu.handle AS blue_user,
            m.map_seed::text, m.status, m.winner, m.failure_reason,
            m.created_at, m.started_at, m.finished_at,
            (SELECT count(*)::integer FROM match_events e WHERE e.match_id = m.id) AS event_count
       FROM matches m
       JOIN submissions rs ON rs.id = m.red_submission_id
       JOIN submissions bs ON bs.id = m.blue_submission_id
       JOIN users ru ON ru.id = rs.user_id
       JOIN users bu ON bu.id = bs.user_id
      WHERE m.id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

async function getReplay(pool, id) {
  return transaction(pool, async (client) => {
    // A repeatable-read snapshot keeps the match metadata and event list aligned.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const match = await client.query(
      `SELECT id, map_seed::text, map_data, initial_state, status
         FROM matches WHERE id = $1`,
      [id],
    );
    if (!match.rows[0]) return null;
    const events = await client.query(
      `SELECT event FROM match_events WHERE match_id = $1 ORDER BY seq ASC`,
      [id],
    );
    return {
      match_id: match.rows[0].id,
      map_seed: match.rows[0].map_seed,
      map: match.rows[0].map_data,
      initial_state: match.rows[0].initial_state,
      events: events.rows.map((row) => row.event),
      status: match.rows[0].status,
    };
  });
}

// Worker-facing repository methods. Scheduler and workers share this
// repository module; the public HTTP API does not expose state mutation
// endpoints.
async function setSubmissionStatus(pool, id, status, { compileLog = null, failureReason = null } = {}) {
  const previous = {
    COMPILING: 'UPLOADED',
    COMPILE_FAILED: 'COMPILING',
    QUEUED: 'COMPILING',
    RUNNING: 'QUEUED',
    FINISHED: 'RUNNING',
    RUNTIME_FAILED: 'RUNNING',
  }[status];
  if (!previous) throw new Error('invalid_submission_status');
  return transaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE submissions s SET status = $2,
              compile_log = COALESCE($3, s.compile_log),
              failure_reason = COALESCE($4, s.failure_reason), updated_at = now()
        WHERE s.id = $1 AND s.status = $5
          AND EXISTS (
            SELECT 1 FROM submission_artifacts a
             WHERE a.submission_id = s.id AND a.kind = 'SOURCE' AND a.uploaded_at IS NOT NULL
          )
        RETURNING id, user_id, status, updated_at`,
      [id, status, typeof compileLog === 'string' ? compileLog.slice(0, 65536) : null,
        typeof failureReason === 'string' ? failureReason.slice(0, 2048) : null, previous],
    );
    if (!result.rows[0]) return null;
    if (status === 'QUEUED') {
      await client.query(
        `UPDATE submissions SET is_current = false, updated_at = now()
          WHERE user_id = $1 AND id <> $2 AND is_current = true`,
        [result.rows[0].user_id, id],
      );
      await client.query(
        'UPDATE submissions SET is_current = true, updated_at = now() WHERE id = $1',
        [id],
      );
    }
    return result.rows[0];
  });
}

async function upsertArtifact(pool, { submissionId, kind, objectKey, contentType, byteSize = null }) {
  if (!['SOURCE', 'COMPILED', 'COMPILE_LOG'].includes(kind)) {
    throw new Error('invalid_artifact_kind');
  }
  const result = await pool.query(
    `INSERT INTO submission_artifacts
       (id, submission_id, kind, object_key, content_type, byte_size, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (submission_id, kind) DO UPDATE SET
       object_key = EXCLUDED.object_key, content_type = EXCLUDED.content_type,
       byte_size = EXCLUDED.byte_size, uploaded_at = EXCLUDED.uploaded_at
     RETURNING id, submission_id, kind, object_key, content_type, byte_size, uploaded_at`,
    [crypto.randomUUID(), submissionId, kind, objectKey, contentType, byteSize],
  );
  return result.rows[0];
}

async function createMatch(pool, { id = crypto.randomUUID(), redSubmissionId, blueSubmissionId, mapSeed }) {
  const result = await pool.query(
    `INSERT INTO matches (id, red_submission_id, blue_submission_id, map_seed, status)
     VALUES ($1, $2, $3, $4, 'QUEUED')
     RETURNING id, status`,
    [id, redSubmissionId, blueSubmissionId, String(mapSeed)],
  );
  return result.rows[0];
}

async function ensureMatchesForAlgorithms(pool, algorithms, mapSeedForPair) {
  if (!Array.isArray(algorithms)) throw new Error('invalid_algorithms');
  if (typeof mapSeedForPair !== 'function') throw new Error('invalid_seed_function');
  return transaction(pool, async (client) => {
    // One scheduler transaction at a time makes the create-and-enqueue pass
    // deterministic; the unique index remains the final duplicate guard.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:scheduler'))");
    const created = [];
    for (let left = 0; left < algorithms.length; left += 1) {
      for (let right = left + 1; right < algorithms.length; right += 1) {
        const first = algorithms[left];
        const second = algorithms[right];
        const mapSeed = String(mapSeedForPair(first.id, second.id));
        for (const [red, blue] of [[first, second], [second, first]]) {
          const result = await client.query(
            `INSERT INTO matches
               (id, red_submission_id, blue_submission_id, map_seed, status)
             VALUES ($1, $2, $3, $4, 'QUEUED')
             ON CONFLICT (red_submission_id, blue_submission_id, map_seed) DO NOTHING
             RETURNING id, red_submission_id, blue_submission_id, map_seed::text, status`,
            [crypto.randomUUID(), red.id, blue.id, mapSeed],
          );
          if (result.rows[0]) created.push(result.rows[0]);
        }
      }
    }
    return created;
  });
}

async function startMatch(pool, id, mapData, initialState) {
  const result = await pool.query(
    `UPDATE matches SET status = 'RUNNING', map_data = $2::jsonb,
            initial_state = $3::jsonb, started_at = now()
      WHERE id = $1 AND status = 'QUEUED' RETURNING id, status`,
    [id, JSON.stringify(mapData), JSON.stringify(initialState)],
  );
  return result.rows[0] || null;
}

async function claimMatch(pool, id) {
  return transaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT id, red_submission_id, blue_submission_id, map_seed::text
         FROM matches
        WHERE id = $1 AND status = 'QUEUED'
        FOR UPDATE SKIP LOCKED`,
      [id],
    );
    if (!selected.rows[0]) return null;
    const result = await client.query(
      `UPDATE matches SET status = 'RUNNING', started_at = now()
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING id, red_submission_id, blue_submission_id, map_seed::text, status`,
      [id],
    );
    return result.rows[0] || null;
  });
}

async function listQueuedMatches(pool, limit = 100) {
  const result = await pool.query(
    `SELECT id, red_submission_id, blue_submission_id, map_seed::text, status
       FROM matches WHERE status = 'QUEUED'
      ORDER BY created_at ASC, id ASC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

async function countPendingMatches(pool) {
  const result = await pool.query(
    `SELECT count(*)::integer AS count
       FROM matches WHERE status IN ('QUEUED', 'RUNNING')`,
  );
  return Number(result.rows[0]?.count || 0);
}

async function appendMatchEvent(pool, matchId, event) {
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) throw new Error('invalid_event_seq');
  await pool.query(
    `INSERT INTO match_events (match_id, seq, event) VALUES ($1, $2, $3::jsonb)`,
    [matchId, event.seq, JSON.stringify(event)],
  );
}

async function replaceMatchReplay(pool, matchId, replay) {
  if (!replay || !Array.isArray(replay.events)) throw new Error('invalid_replay');
  return transaction(pool, async (client) => {
    const updated = await client.query(
      `UPDATE matches SET map_data = $2::jsonb, initial_state = $3::jsonb
        WHERE id = $1`,
      [matchId, JSON.stringify(replay.map), JSON.stringify(replay.initial_state)],
    );
    if (updated.rowCount !== 1) throw new Error('match_not_found');
    await client.query('DELETE FROM match_events WHERE match_id = $1', [matchId]);
    for (const event of replay.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new Error('invalid_event_seq');
      }
      await client.query(
        `INSERT INTO match_events (match_id, seq, event)
         VALUES ($1, $2, $3::jsonb)`,
        [matchId, event.seq, JSON.stringify(event)],
      );
    }
  });
}

// Store the replay and terminal result together. A replay must never be
// visible as complete without its winner, and a failed retry must not leave a
// second copy of the event stream behind.
async function completeMatch(pool, matchId, replay) {
  if (!replay || !Array.isArray(replay.events)) throw new Error('invalid_replay');
  if (!['RED', 'BLUE', 'DRAW'].includes(replay.winner)) {
    throw new Error('invalid_winner');
  }
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:leaderboard'))");
    const updated = await client.query(
      `UPDATE matches
          SET map_data = $2::jsonb, initial_state = $3::jsonb,
              status = 'FINISHED', winner = $4, failure_reason = NULL,
              finished_at = now()
        WHERE id = $1 AND status = 'RUNNING'
        RETURNING id, status, winner`,
      [matchId, JSON.stringify(replay.map), JSON.stringify(replay.initial_state), replay.winner],
    );
    if (updated.rowCount !== 1) throw new Error('match_not_running');
    await client.query('DELETE FROM match_events WHERE match_id = $1', [matchId]);
    const sequences = new Set();
    for (const event of replay.events) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || sequences.has(event.seq)) {
        throw new Error('invalid_event_seq');
      }
      sequences.add(event.seq);
      await client.query(
        `INSERT INTO match_events (match_id, seq, event)
         VALUES ($1, $2, $3::jsonb)`,
        [matchId, event.seq, JSON.stringify(event)],
      );
    }
    if (await leaderboardReadyInTransaction(client)) {
      await refreshLeaderboardInTransaction(client);
    }
    return updated.rows[0];
  });
}

async function finishMatch(pool, id, { winner = null, failureReason = null } = {}) {
  if (winner !== null && !['RED', 'BLUE', 'DRAW'].includes(winner)) {
    throw new Error('invalid_winner');
  }
  const status = failureReason ? 'RUNTIME_FAILED' : 'FINISHED';
  if (status === 'FINISHED' && winner === null) throw new Error('winner_required');
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:leaderboard'))");
    const result = await client.query(
    `UPDATE matches SET status = $2, winner = $3, failure_reason = $4,
            finished_at = now()
      WHERE id = $1 AND status = 'RUNNING' RETURNING id, status, winner`,
      [id, status, winner, failureReason],
    );
    if (!result.rows[0]) return null;
    if (await leaderboardReadyInTransaction(client)) {
      await refreshLeaderboardInTransaction(client);
    }
    return result.rows[0];
  });
}

async function saveLeaderboardSnapshot(pool, entries) {
  if (!Array.isArray(entries)) throw new Error('invalid_leaderboard_entries');
  return transaction(pool, async (client) => {
    await client.query('DELETE FROM leaderboard_entries');
    const snapshot = [];
    for (const [index, entry] of entries.entries()) {
      const { submissionId, wins, draws, losses } = entry;
      if (![wins, draws, losses].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error('invalid_leaderboard_record');
      }
      const total = wins + draws + losses;
      const winRate = total === 0 ? 0 : wins / total;
      const pointsRate = total === 0 ? 0 : (wins + draws * 0.5) / total;
      const row = {
        rank: index + 1, submission_id: submissionId,
        wins, draws, losses, win_rate: winRate, points_rate: pointsRate,
      };
      await client.query(
        `INSERT INTO leaderboard_entries
         (submission_id, rank, wins, draws, losses, win_rate, points_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [submissionId, row.rank, wins, draws, losses, winRate, pointsRate],
      );
      snapshot.push(row);
    }
    const id = crypto.randomUUID();
    await client.query(
      'INSERT INTO leaderboard_snapshots (id, entries) VALUES ($1, $2::jsonb)',
      [id, JSON.stringify(snapshot)],
    );
    return id;
  });
}

async function leaderboardReadyInTransaction(client) {
  const result = await client.query([
    'WITH current_algorithms AS (',
    '  SELECT id FROM submissions WHERE is_current = true',
    '), expected AS (',
    '  SELECT count(*)::bigint * greatest(count(*) - 1, 0)::bigint AS count',
    '    FROM current_algorithms',
    '), scored AS (',
    "  SELECT count(*)::bigint AS count FROM matches m WHERE m.status = 'FINISHED'",
    '    AND m.red_submission_id IN (SELECT id FROM current_algorithms)',
    '    AND m.blue_submission_id IN (SELECT id FROM current_algorithms)',
    '), failed AS (',
    "  SELECT count(*)::bigint AS count FROM matches m WHERE m.status = 'RUNTIME_FAILED'",
    '    AND m.red_submission_id IN (SELECT id FROM current_algorithms)',
    '    AND m.blue_submission_id IN (SELECT id FROM current_algorithms)',
    ')',
    'SELECT expected.count AS expected, scored.count AS scored, failed.count AS failed',
    '  FROM expected, scored, failed',
  ].join('\n'));
  const row = result.rows[0];
  // Runtime failures are terminal for scheduling. They are recorded and
  // excluded from score statistics, but must not leave the board permanently
  // stuck in the previous snapshot.
  return BigInt(row.expected) === BigInt(row.scored) + BigInt(row.failed);
}

async function refreshLeaderboardInTransaction(client) {
    const result = await client.query(
      `WITH current_algorithms AS (
             SELECT id FROM submissions WHERE is_current = true
           ), outcomes AS (
             SELECT red_submission_id AS submission_id,
                    CASE WHEN winner = 'RED' THEN 1 ELSE 0 END AS wins,
                    CASE WHEN winner = 'DRAW' THEN 1 ELSE 0 END AS draws,
                    CASE WHEN winner = 'BLUE' THEN 1 ELSE 0 END AS losses
               FROM matches m
              WHERE m.status = 'FINISHED'
                AND m.red_submission_id IN (SELECT id FROM current_algorithms)
                AND m.blue_submission_id IN (SELECT id FROM current_algorithms)
             UNION ALL
             SELECT blue_submission_id AS submission_id,
                    CASE WHEN winner = 'BLUE' THEN 1 ELSE 0 END AS wins,
                    CASE WHEN winner = 'DRAW' THEN 1 ELSE 0 END AS draws,
                    CASE WHEN winner = 'RED' THEN 1 ELSE 0 END AS losses
               FROM matches m
              WHERE m.status = 'FINISHED'
                AND m.red_submission_id IN (SELECT id FROM current_algorithms)
                AND m.blue_submission_id IN (SELECT id FROM current_algorithms)
           ), totals AS (
             SELECT c.id AS submission_id,
                    COALESCE(SUM(o.wins), 0)::integer AS wins,
                    COALESCE(SUM(o.draws), 0)::integer AS draws,
                    COALESCE(SUM(o.losses), 0)::integer AS losses
               FROM current_algorithms c
               LEFT JOIN outcomes o ON o.submission_id = c.id
              GROUP BY c.id
           )
       SELECT submission_id, wins, draws, losses,
              CASE WHEN wins + draws + losses = 0 THEN 0
                   ELSE wins::numeric / (wins + draws + losses) END AS win_rate,
              CASE WHEN wins + draws + losses = 0 THEN 0
                   ELSE (wins + draws * 0.5)::numeric / (wins + draws + losses) END AS points_rate
         FROM totals
        ORDER BY points_rate DESC, win_rate DESC, wins DESC, submission_id ASC`,
    );
    await client.query('DELETE FROM leaderboard_entries');
    const entries = result.rows.map((row, index) => ({
      rank: index + 1,
      submission_id: row.submission_id,
      wins: Number(row.wins),
      draws: Number(row.draws),
      losses: Number(row.losses),
      win_rate: Number(row.win_rate),
      points_rate: Number(row.points_rate),
    }));
    for (const entry of entries) {
      await client.query(
        `INSERT INTO leaderboard_entries
           (submission_id, rank, wins, draws, losses, win_rate, points_rate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.submission_id, entry.rank, entry.wins, entry.draws, entry.losses,
          entry.win_rate, entry.points_rate],
      );
    }
    const snapshotId = crypto.randomUUID();
    await client.query(
      'INSERT INTO leaderboard_snapshots (id, entries) VALUES ($1, $2::jsonb)',
      [snapshotId, JSON.stringify(entries)],
    );
    return { snapshotId, entries };
}

async function refreshLeaderboard(pool) {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:leaderboard'))");
    return refreshLeaderboardInTransaction(client);
  });
}

module.exports = {
  createPool,
  bootstrap,
  tokenHash,
  provisionUser,
  findUserByToken,
  createSubmission,
  getSubmission,
  listReadySubmissions,
  listCurrentAlgorithms,
  getCompiledArtifacts,
  confirmSubmission,
  listLeaderboard,
  listMatches,
  getMatch,
  getReplay,
  setSubmissionStatus,
  upsertArtifact,
  createMatch,
  ensureMatchesForAlgorithms,
  claimMatch,
  listQueuedMatches,
  countPendingMatches,
  startMatch,
  appendMatchEvent,
  replaceMatchReplay,
  completeMatch,
  finishMatch,
  saveLeaderboardSnapshot,
  refreshLeaderboard,
};
