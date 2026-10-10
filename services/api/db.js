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
  // API, Scheduler and both Workers bootstrap at the same time. The schema
  // script is idempotent, but concurrent CREATE INDEX / UPDATE statements can
  // still race, so run it under an advisory lock.
  await transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:bootstrap'))");
    await client.query(await fs.readFile(schemaPath, 'utf8'));
  });
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

function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 1) throw new Error('invalid_password');
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${digest.toString('base64')}`;
}

function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || expected.length !== 32) return false;
  const cost = Number(parts[1]);
  const block = Number(parts[2]);
  const parallel = Number(parts[3]);
  if (cost !== 16_384 || block !== 8 || parallel !== 1) return false;
  try {
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: cost, r: block, p: parallel,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function provisionUser(pool, handle, token) {
  const id = crypto.randomUUID();
  const result = await pool.query(
    `INSERT INTO users (id, handle, api_token_hash, password_hash, role)
     VALUES ($1, $2, $3, $4, 'PLAYER')
     ON CONFLICT (handle) DO UPDATE SET
       api_token_hash = EXCLUDED.api_token_hash,
       password_hash = EXCLUDED.password_hash
     RETURNING id, handle, role, created_at`,
    [id, handle, tokenHash(token), passwordHash(token)],
  );
  return result.rows[0];
}

async function provisionPasswordUser(pool, { handle, password, role = 'PLAYER' }) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO users (id, handle, api_token_hash, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (handle) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role, active = true
     RETURNING id, handle, role, created_at`,
    [id, handle, tokenHash(token), passwordHash(password), role],
  );
  return result.rows[0];
}

async function ensurePasswordUser(pool, { handle, password, role = 'PLAYER' }) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO users (id, handle, api_token_hash, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (handle) DO UPDATE SET
       active = true, role = EXCLUDED.role,
       password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)
     RETURNING id, handle, role, active, created_at`,
    [id, handle, tokenHash(token), passwordHash(password), role],
  );
  return result.rows[0];
}

async function findUserByToken(pool, token) {
  const result = await pool.query(
    `SELECT id, handle, real_name, student_no, role, active
       FROM users WHERE api_token_hash = $1 AND active = true`,
    [tokenHash(token)],
  );
  return result.rows[0] || null;
}

async function findUserByCredentials(pool, handle, password) {
  const result = await pool.query(
    `SELECT id, handle, real_name, student_no, role, password_hash
       FROM users
      WHERE (student_no = $1 OR handle = $1) AND active = true`,
    [handle],
  );
  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return {
    id: user.id,
    handle: user.handle,
    real_name: user.real_name,
    student_no: user.student_no,
    role: user.role,
  };
}

async function issueAccessToken(pool, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'UPDATE users SET api_token_hash = $2 WHERE id = $1',
    [userId, tokenHash(token)],
  );
  return token;
}

function normalizeRegistration({ realName, studentNo, qqNumber, password }) {
  const real_name = typeof realName === 'string' ? realName.normalize('NFC').trim() : '';
  const student_no = typeof studentNo === 'string' ? studentNo.trim() : '';
  const qq_number = typeof qqNumber === 'string' ? qqNumber.trim() : '';
  if (!real_name || !student_no || !qq_number || typeof password !== 'string') {
    throw new Error('invalid_registration');
  }
  if ([...real_name].length < 2 || [...real_name].length > 40 || /[\u0000-\u001f\u007f]/u.test(real_name)) {
    throw new Error('invalid_real_name');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(student_no)) {
    throw new Error('invalid_student_no');
  }
  if (!/^\d{5,12}$/.test(qq_number)) throw new Error('invalid_qq_number');
  if (password.length < 8 || password.length > 128) throw new Error('invalid_password');
  return { real_name, student_no, qq_number, password_hash: passwordHash(password) };
}

async function createRegistration(pool, values) {
  const normalized = normalizeRegistration(values);
  return transaction(pool, async (client) => {
    const existing = await client.query(
      'SELECT id FROM users WHERE student_no = $1 OR handle = $1 LIMIT 1',
      [normalized.student_no],
    );
    if (existing.rows[0]) throw new Error('registration_already_exists');
    const userId = crypto.randomUUID();
    const apiToken = crypto.randomBytes(32).toString('hex');
    const user = await client.query(
      `INSERT INTO users
         (id, handle, api_token_hash, password_hash, real_name, student_no, qq_number, role, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PLAYER', true)
       RETURNING id, handle, real_name, student_no, qq_number, role, active, created_at`,
      [userId, normalized.student_no, tokenHash(apiToken), normalized.password_hash,
        normalized.real_name, normalized.student_no, normalized.qq_number],
    );
    return { user: user.rows[0], status: 'ACTIVE' };
  }).catch((error) => {
    if (error.code === '23505') throw new Error('registration_already_exists');
    throw error;
  });
}

// A user owns one ranked version (is_current) and at most one candidate. A new
// upload only supersedes the previous unpublished candidate: the ranked version
// stays on the leaderboard until the new candidate has played its matches and is
// promoted by promoteSubmissionAndRefresh.
async function createSubmission(pool, { id, userId, name, stagingKey }) {
  return transaction(pool, async (client) => {
    // Locking the user row makes replacing the candidate atomic even when two
    // upload requests arrive together.
    const user = await client.query(
      'SELECT id FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (!user.rows[0]) throw new Error('user_not_found');
    const superseded = await client.query(
      `UPDATE submissions
          SET deleted_at = now(), is_current = false, updated_at = now()
        WHERE user_id = $1 AND deleted_at IS NULL AND is_current = false AND id <> $2
        RETURNING id`,
      [userId, id],
    );
    // Matches that have not started yet must not pull a superseded candidate
    // back into the worker queue. Running matches are allowed to finish so
    // their replay remains valid; leaderboard queries already exclude it.
    if (superseded.rows.length > 0) {
      await client.query(
        `UPDATE matches
            SET status = 'RUNTIME_FAILED',
                failure_reason = 'SUBMISSION_REPLACED',
                finished_at = now()
          WHERE status = 'QUEUED'
            AND (red_submission_id = ANY($1::uuid[]) OR blue_submission_id = ANY($1::uuid[]))`,
        [superseded.rows.map((row) => row.id)],
      );
    }
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
    `SELECT s.id, s.user_id, s.name, s.status, s.is_current, s.compile_log,
            s.failure_reason, s.deleted_at, s.created_at, s.updated_at,
            a.object_key AS source_key, a.byte_size AS source_size,
            a.uploaded_at AS source_uploaded_at,
            (SELECT count(*)::integer FROM matches m
              WHERE m.red_submission_id = s.id OR m.blue_submission_id = s.id) AS match_total,
            (SELECT count(*)::integer FROM matches m
              WHERE (m.red_submission_id = s.id OR m.blue_submission_id = s.id)
                AND m.status IN ('FINISHED', 'RUNTIME_FAILED')) AS match_completed
       FROM submissions s
       JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
      WHERE s.id = $1 AND s.user_id = $2`,
    [id, userId],
  );
  return result.rows[0] || null;
}

async function listSubmissions(pool, userId, limit, offset) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.name, s.status, s.compile_log,
            s.failure_reason, s.deleted_at, s.created_at, s.updated_at, s.is_current,
            a.byte_size AS source_size, a.uploaded_at AS source_uploaded_at
       FROM submissions s
       LEFT JOIN submission_artifacts a
         ON a.submission_id = s.id AND a.kind = 'SOURCE'
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  return result.rows;
}

async function listUsers(pool, limit, offset) {
  const result = await pool.query(
    `SELECT id, handle, real_name, student_no, qq_number, role, active, created_at
       FROM users ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

async function getUserById(pool, id) {
  const result = await pool.query(
    'SELECT id, handle, real_name, student_no, qq_number, role, active, created_at FROM users WHERE id = $1',
    [id],
  );
  return result.rows[0] || null;
}

async function listAdminSubmissions(pool, limit, offset) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, COALESCE(u.real_name, u.handle) AS user_handle, s.name, s.status,
            s.is_current, s.deleted_at, s.compile_log, s.failure_reason,
            s.created_at, s.updated_at
       FROM submissions s
       JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

async function createManagedUser(pool, {
  handle, password, role = 'PLAYER', realName = null, studentNo = null, qqNumber = null,
}) {
  if (studentNo !== null || realName !== null || qqNumber !== null) {
    const profile = normalizeRegistration({ realName, studentNo, qqNumber, password: password || 'placeholder' });
    handle = profile.student_no;
    realName = profile.real_name;
    studentNo = profile.student_no;
    qqNumber = profile.qq_number;
  }
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(handle) || !['PLAYER', 'ADMIN'].includes(role)) {
    throw new Error('invalid_user');
  }
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const result = await pool.query(
    `INSERT INTO users
       (id, handle, api_token_hash, password_hash, real_name, student_no, qq_number, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, handle, real_name, student_no, qq_number, role, active, created_at`,
    [id, handle, tokenHash(token), passwordHash(password), realName, studentNo, qqNumber, role],
  );
  return result.rows[0];
}

async function updateManagedUser(pool, id, { password, role, active }, { actorId = null } = {}) {
  const fields = [];
  const values = [id];
  if (password !== undefined) { values.push(passwordHash(password)); fields.push(`password_hash = $${values.length}`); }
  if (role !== undefined) { if (!['PLAYER', 'ADMIN'].includes(role)) throw new Error('invalid_role'); values.push(role); fields.push(`role = $${values.length}`); }
  if (active !== undefined) { values.push(Boolean(active)); fields.push(`active = $${values.length}`); }
  if (!fields.length) throw new Error('no_user_changes');
  return transaction(pool, async (client) => {
    const current = await client.query(
      'SELECT id, handle, role, active FROM users WHERE id = $1 FOR UPDATE', [id],
    );
    const target = current.rows[0];
    if (!target) return null;
    const demoting = role !== undefined && role !== target.role && role !== 'ADMIN';
    const disabling = active === false && target.active;
    if (actorId && actorId === id && (demoting || disabling)) throw new Error('self_admin_protected');
    if (target.role === 'ADMIN' && target.active && (demoting || disabling)) {
      const admins = await client.query(
        "SELECT count(*)::integer AS count FROM users WHERE role = 'ADMIN' AND active = true",
      );
      if (admins.rows[0].count <= 1) throw new Error('last_admin_protected');
    }
    const result = await client.query(
      `UPDATE users SET ${fields.join(', ')} WHERE id = $1
       RETURNING id, handle, role, active, created_at`, values,
    );
    return result.rows[0] || null;
  });
}

async function deleteSubmission(pool, id) {
  return transaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE submissions SET deleted_at = now(), is_current = false, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`, [id],
    );
    return result.rows[0] || null;
  });
}

async function setLeaderboardOverride(pool, { submissionId, wins, draws, losses, reason = null }) {
  for (const value of [wins, draws, losses]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_leaderboard_record');
  return transaction(pool, async (client) => {
    const current = await client.query(
      "SELECT id FROM submissions WHERE id = $1 AND is_current = true AND deleted_at IS NULL AND status = 'FINISHED'",
      [submissionId],
    );
    if (!current.rows[0]) throw new Error('submission_not_active');
    const result = await client.query(
      `INSERT INTO leaderboard_overrides (submission_id, wins, draws, losses, reason)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (submission_id) DO UPDATE SET wins = EXCLUDED.wins, draws = EXCLUDED.draws,
         losses = EXCLUDED.losses, reason = EXCLUDED.reason, updated_at = now()
       RETURNING submission_id, wins, draws, losses, reason, updated_at`,
      [submissionId, wins, draws, losses, reason],
    );
    return result.rows[0];
  });
}

async function clearLeaderboardOverride(pool, submissionId) {
  await pool.query('DELETE FROM leaderboard_overrides WHERE submission_id = $1', [submissionId]);
}

async function clearAllLeaderboardOverrides(pool) {
  await pool.query('DELETE FROM leaderboard_overrides');
}

async function listReadySubmissions(pool, limit = 50) {
  const result = await pool.query(
      `SELECT s.id, s.user_id, a.object_key AS source_key
       FROM submissions s
       JOIN users u ON u.id = s.user_id AND u.active = true
       JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
      WHERE s.status = 'UPLOADED' AND s.deleted_at IS NULL
        AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
      ORDER BY s.created_at, s.id
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

// Published algorithms that can currently be played: ranked, not replaced, and
// with a runner in object storage or in the PostgreSQL backup. An algorithm
// whose runner is lost for good stays on the leaderboard (see markArtifactLost)
// but is skipped as an opponent until its owner submits again.
async function listRankedAlgorithms(pool) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.name, s.status,
            a.object_key AS runner_key, a.byte_size AS runner_size
       FROM submissions s
       JOIN users u ON u.id = s.user_id AND u.active = true
       JOIN submission_artifacts a
         ON a.submission_id = s.id AND a.kind = 'COMPILED'
      WHERE s.is_current = true AND s.deleted_at IS NULL
        AND s.status = 'FINISHED'
        AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
      ORDER BY s.created_at ASC, s.id ASC`,
  );
  return result.rows;
}

// `QUEUED` means qualification succeeded and the submission is waiting for
// its complete set of two-sided matches. It is deliberately kept out of the
// ranked set until those matches reach a terminal state.
async function listPendingAlgorithms(pool) {
  const result = await pool.query(
    `SELECT s.id, s.user_id, s.name, s.status,
            a.object_key AS runner_key, a.byte_size AS runner_size
       FROM submissions s
       JOIN users u ON u.id = s.user_id AND u.active = true
       JOIN submission_artifacts a
         ON a.submission_id = s.id AND a.kind = 'COMPILED'
      WHERE s.deleted_at IS NULL
        AND s.status = 'QUEUED'
        AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
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
      WHERE s.id = ANY($1::uuid[]) AND s.deleted_at IS NULL
        AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)`,
    [submissionIds],
  );
  return result.rows;
}

async function getArtifactPayload(pool, submissionId, kind) {
  if (!submissionId || !['SOURCE', 'COMPILED', 'COMPILE_LOG'].includes(kind)) return null;
  const result = await pool.query(
    `SELECT payload FROM submission_artifacts
      WHERE submission_id = $1 AND kind = $2 AND payload IS NOT NULL`,
    [submissionId, kind],
  );
  return result.rows[0]?.payload || null;
}

// Artifacts that have a private PostgreSQL backup. API start-up uses this list
// to copy the backups into a freshly created object-storage volume.
async function listBackedUpArtifacts(pool) {
  const result = await pool.query(
    `SELECT submission_id, kind, object_key, content_type
       FROM submission_artifacts
      WHERE payload IS NOT NULL
      ORDER BY created_at ASC, id ASC`,
  );
  return result.rows;
}

async function confirmSubmission(pool, { id, userId, confirmSource }) {
  return transaction(pool, async (client) => {
    const current = await client.query(
      `SELECT s.status, a.object_key, a.uploaded_at
         FROM submissions s
         JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = 'SOURCE'
        WHERE s.id = $1 AND s.user_id = $2 AND s.deleted_at IS NULL
        FOR UPDATE OF s, a`,
      [id, userId],
    );
    if (!current.rows[0]) return null;
    if (current.rows[0].uploaded_at || current.rows[0].status !== 'UPLOADED') {
      return { confirmed: false, status: current.rows[0].status };
    }
    const stagingKey = current.rows[0].object_key;
    const finalKey = `submissions/${id}/source.zip`;
    const confirmed = await confirmSource(stagingKey, finalKey);
    const byteSize = Number(confirmed && typeof confirmed === 'object'
      ? confirmed.byteSize : confirmed);
    const payload = confirmed && typeof confirmed === 'object' && confirmed.payload != null
      ? Buffer.from(confirmed.payload) : null;
    if (!Number.isSafeInteger(byteSize) || byteSize < 1) throw new Error('source_size_invalid');
    await client.query(
      `UPDATE submission_artifacts
          SET object_key = $2, byte_size = $3,
              payload = COALESCE($4, payload), uploaded_at = now()
        WHERE submission_id = $1 AND kind = 'SOURCE'`,
      [id, finalKey, byteSize, payload],
    );
    await client.query(
      `UPDATE submissions
          SET status = 'UPLOADED', updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return { confirmed: true, status: 'UPLOADED' };
  });
}

async function listLeaderboard(pool, limit, offset) {
  const result = await pool.query(
    `SELECT e.rank, e.submission_id,
            u.id AS user_id, COALESCE(u.real_name, u.handle) AS user_handle,
            e.wins, e.draws, e.losses, e.win_rate, e.points_rate, e.updated_at
      FROM leaderboard_entries e
      JOIN submissions s ON s.id = e.submission_id
      JOIN users u ON u.id = s.user_id
      WHERE u.active = true AND s.deleted_at IS NULL AND s.is_current = true AND s.status = 'FINISHED'
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

async function getLeaderboardEntry(pool, submissionId) {
  const result = await pool.query(
    `SELECT e.rank, e.submission_id,
            u.id AS user_id, COALESCE(u.real_name, u.handle) AS user_handle,
            e.wins, e.draws, e.losses, e.win_rate, e.points_rate, e.updated_at
       FROM leaderboard_entries e
       JOIN submissions s ON s.id = e.submission_id
       JOIN users u ON u.id = s.user_id
      WHERE u.active = true AND e.submission_id = $1 AND s.deleted_at IS NULL
        AND s.is_current = true AND s.status = 'FINISHED'`,
    [submissionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...row, win_rate: Number(row.win_rate), points_rate: Number(row.points_rate) };
}

async function listSubmissionMatches(pool, submissionId) {
  const result = await pool.query(
    `SELECT m.id, m.red_submission_id, m.blue_submission_id,
            COALESCE(ru.real_name, ru.handle) AS red_user,
            COALESCE(bu.real_name, bu.handle) AS blue_user,
            CASE WHEN m.red_submission_id = $1 THEN m.blue_submission_id
                 ELSE m.red_submission_id END AS opponent_submission_id,
            CASE WHEN m.red_submission_id = $1
                 THEN COALESCE(bu.real_name, bu.handle)
                 ELSE COALESCE(ru.real_name, ru.handle) END AS opponent_user,
            m.map_seed::text, m.status, m.winner, m.failure_reason,
            CASE
              WHEN m.status = 'RUNTIME_FAILED' THEN 'RUNTIME_FAILED'
              WHEN m.status <> 'FINISHED' THEN NULL
              WHEN m.winner = 'DRAW' THEN 'DRAW'
              WHEN (m.red_submission_id = $1 AND m.winner = 'RED') OR
                   (m.blue_submission_id = $1 AND m.winner = 'BLUE') THEN 'WIN'
              ELSE 'LOSS'
            END AS result_for_submission,
            m.replay_object_key, m.created_at, m.started_at, m.finished_at,
            (SELECT count(*)::integer FROM match_events e WHERE e.match_id = m.id) AS event_count
       FROM matches m
       JOIN submissions rs ON rs.id = m.red_submission_id
       JOIN submissions bs ON bs.id = m.blue_submission_id
       JOIN users ru ON ru.id = rs.user_id
       JOIN users bu ON bu.id = bs.user_id
      WHERE m.red_submission_id = $1 OR m.blue_submission_id = $1
      ORDER BY m.created_at ASC, m.id ASC`,
    [submissionId],
  );
  return result.rows;
}

async function listMatches(pool, limit, offset) {
  const result = await pool.query(
    `SELECT m.id, m.red_submission_id, m.blue_submission_id,
            COALESCE(ru.real_name, ru.handle) AS red_user,
            COALESCE(bu.real_name, bu.handle) AS blue_user,
            m.map_seed::text, m.status, m.winner, m.created_at,
            m.started_at, m.finished_at, m.replay_object_key,
            (SELECT count(*)::integer FROM match_events e WHERE e.match_id = m.id) AS event_count
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
            COALESCE(ru.real_name, ru.handle) AS red_user,
            COALESCE(bu.real_name, bu.handle) AS blue_user,
            m.map_seed::text, m.status, m.winner, m.failure_reason,
            m.created_at, m.started_at, m.finished_at,
            m.replay_object_key,
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
      `SELECT id, map_seed::text, map_data, initial_state, status, winner, replay_object_key
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
      winner: match.rows[0].winner,
      replay_object_key: match.rows[0].replay_object_key,
    };
  });
}

async function getMatchEventsAfter(pool, matchId, afterSeq, limit = 128) {
  const result = await pool.query(
    'SELECT event FROM match_events WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3',
    [matchId, afterSeq, limit],
  );
  return result.rows.map((row) => row.event);
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
        WHERE s.id = $1 AND s.status = $5 AND s.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM submission_artifacts a
             WHERE a.submission_id = s.id AND a.kind = 'SOURCE'
               AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
          )
        RETURNING id, user_id, status, updated_at`,
      [id, status, typeof compileLog === 'string' ? compileLog.slice(0, 65536) : null,
        typeof failureReason === 'string' ? failureReason.slice(0, 2048) : null, previous],
    );
    if (!result.rows[0]) return null;
    return result.rows[0];
  });
}

async function upsertArtifact(pool, {
  submissionId, kind, objectKey, contentType, byteSize = null, payload = null,
}) {
  if (!['SOURCE', 'COMPILED', 'COMPILE_LOG'].includes(kind)) {
    throw new Error('invalid_artifact_kind');
  }
  const result = await pool.query(
    `INSERT INTO submission_artifacts
       (id, submission_id, kind, object_key, content_type, byte_size, payload, uploaded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (submission_id, kind) DO UPDATE SET
       object_key = EXCLUDED.object_key, content_type = EXCLUDED.content_type,
       byte_size = EXCLUDED.byte_size,
       payload = COALESCE(EXCLUDED.payload, submission_artifacts.payload),
       uploaded_at = EXCLUDED.uploaded_at
     RETURNING id, submission_id, kind, object_key, content_type, byte_size, uploaded_at`,
    [crypto.randomUUID(), submissionId, kind, objectKey, contentType, byteSize,
      payload == null ? null : Buffer.from(payload)],
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

async function ensureMatchesForSubmission(pool, pending, ranked, mapSeedForPair) {
  if (!pending || !pending.id || !Array.isArray(ranked)) throw new Error('invalid_pending_algorithm');
  if (typeof mapSeedForPair !== 'function') throw new Error('invalid_seed_function');
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:scheduler'))");
    const created = [];
    for (const opponent of ranked) {
      if (!opponent || !opponent.id || opponent.id === pending.id) continue;
      const pairSeed = String(mapSeedForPair(pending.id, opponent.id));
      for (const [red, blue] of [[pending, opponent], [opponent, pending]]) {
        const result = await client.query(
          `INSERT INTO matches
             (id, red_submission_id, blue_submission_id, map_seed, retry_count, status)
           VALUES ($1, $2, $3, $4, 0, 'QUEUED')
           ON CONFLICT (red_submission_id, blue_submission_id, map_seed, retry_count) DO NOTHING
           RETURNING id, red_submission_id, blue_submission_id, map_seed::text, status`,
          [crypto.randomUUID(), red.id, blue.id, pairSeed],
        );
        if (result.rows[0]) created.push(result.rows[0]);
      }
    }
    return created;
  });
}

async function listMatchesForSubmission(pool, submissionId) {
  const result = await pool.query(
    `SELECT id, red_submission_id, blue_submission_id, map_seed::text,
            status, winner, failure_reason, created_at, started_at, finished_at
       FROM matches
      WHERE red_submission_id = $1 OR blue_submission_id = $1
      ORDER BY created_at ASC, id ASC`,
    [submissionId],
  );
  return result.rows;
}

// Promote a qualified candidate and publish the board in one transaction, so a
// restart can never expose a finished submission without its rank entry, or a
// board that has lost the user's previous version without gaining the new one.
//
// This is the only place a ranked version is replaced: the user's previous
// version is retired (kept with its matches and replays, but no longer current)
// and the leaderboard is recomputed from the matches the candidate played.
// With onlyIfNoOpponents the promotion happens only when no other user has a
// playable ranked algorithm, i.e. when there is nobody for the candidate to play.
async function promoteSubmissionAndRefresh(pool, submissionId, { onlyIfNoOpponents = false } = {}) {
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:scheduler'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:leaderboard'))");
    const candidate = await client.query(
      `SELECT s.id, s.user_id
         FROM submissions s
        WHERE s.id = $1 AND s.status = 'QUEUED' AND s.is_current = false
          AND s.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM submission_artifacts a
             WHERE a.submission_id = s.id AND a.kind = 'COMPILED'
               AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
          )
        FOR UPDATE`,
      [submissionId],
    );
    if (!candidate.rows[0]) return null;
    const userId = candidate.rows[0].user_id;
    if (onlyIfNoOpponents) {
      const opponents = await client.query(
        `SELECT 1
           FROM submissions o
           JOIN submission_artifacts a
             ON a.submission_id = o.id AND a.kind = 'COMPILED'
          WHERE o.is_current = true AND o.deleted_at IS NULL AND o.status = 'FINISHED'
            AND o.user_id <> $1
            AND (a.uploaded_at IS NOT NULL OR a.payload IS NOT NULL)
          LIMIT 1`,
        [userId],
      );
      if (opponents.rows[0]) return null;
    }
    const retired = await client.query(
      `UPDATE submissions
          SET is_current = false, deleted_at = now(), updated_at = now()
        WHERE user_id = $1 AND id <> $2 AND is_current = true AND deleted_at IS NULL
        RETURNING id`,
      [userId, submissionId],
    );
    if (retired.rows.length > 0) {
      await client.query(
        `UPDATE matches
            SET status = 'RUNTIME_FAILED',
                failure_reason = 'SUBMISSION_REPLACED',
                finished_at = now()
          WHERE status = 'QUEUED'
            AND (red_submission_id = ANY($1::uuid[]) OR blue_submission_id = ANY($1::uuid[]))`,
        [retired.rows.map((row) => row.id)],
      );
    }
    const promoted = await client.query(
      `UPDATE submissions
          SET status = 'FINISHED', is_current = true, failure_reason = NULL, updated_at = now()
        WHERE id = $1 AND status = 'QUEUED'
        RETURNING id, user_id, status, is_current, updated_at`,
      [submissionId],
    );
    if (!promoted.rows[0]) return null;
    const leaderboard = await refreshLeaderboardInTransaction(client);
    return {
      submission: promoted.rows[0],
      replaced: retired.rows.map((row) => row.id),
      leaderboard,
    };
  });
}

// Fast path used by Compile Worker right after qualification, so a candidate
// with nobody to play does not wait for the Scheduler's next scan.
async function promoteSubmissionIfNoOpponents(pool, submissionId) {
  return promoteSubmissionAndRefresh(pool, submissionId, { onlyIfNoOpponents: true });
}

// An artifact that exists in neither object storage nor the PostgreSQL backup
// cannot be recovered. Mark it unavailable so nothing schedules it again.
// A published submission keeps its leaderboard entry and ranking: only its
// owner is told to submit again. An unpublished candidate has nothing to
// protect and simply fails. The leaderboard is never touched here.
async function markArtifactLost(pool, submissionId, kind, reason) {
  if (!['SOURCE', 'COMPILED'].includes(kind)) throw new Error('invalid_artifact_kind');
  const detail = `ARTIFACT_LOST: ${String(reason || `${kind}_MISSING`)}`.slice(0, 2048);
  return transaction(pool, async (client) => {
    const found = await client.query(
      `SELECT s.id, s.status, s.is_current, a.payload IS NOT NULL AS has_backup
         FROM submissions s
         JOIN submission_artifacts a ON a.submission_id = s.id AND a.kind = $2
        WHERE s.id = $1 AND s.deleted_at IS NULL
        FOR UPDATE OF s, a`,
      [submissionId, kind],
    );
    const row = found.rows[0];
    if (!row) return null;
    // The backup can still be restored by the caller; nothing is lost.
    if (row.has_backup) return { recoverable: true, submission: { id: row.id, status: row.status } };
    await client.query(
      `UPDATE submission_artifacts SET uploaded_at = NULL
        WHERE submission_id = $1 AND kind = $2`,
      [submissionId, kind],
    );
    if (row.is_current) {
      await client.query(
        'UPDATE submissions SET failure_reason = $2, updated_at = now() WHERE id = $1',
        [submissionId, detail],
      );
      return {
        recoverable: false, preserved: true, reason: detail,
        submission: { id: row.id, status: row.status },
      };
    }
    const failed = await client.query(
      `UPDATE submissions
          SET status = 'COMPILE_FAILED', failure_reason = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, status`,
      [submissionId, detail],
    );
    await client.query(
      `UPDATE matches
          SET status = 'RUNTIME_FAILED',
              failure_reason = 'SUBMISSION_ARTIFACT_LOST',
              finished_at = now()
        WHERE status = 'QUEUED'
          AND (red_submission_id = $1 OR blue_submission_id = $1)`,
      [submissionId],
    );
    return { recoverable: false, preserved: false, reason: detail, submission: failed.rows[0] };
  });
}

// Platform failures (storage or database errors, a crashed worker) say nothing
// about the algorithms, so they must not become a match result. The match goes
// back to the queue and anything it partially wrote is discarded. After
// maxAttempts the caller records a terminal failure instead, so a persistent
// fault cannot hold a promotion back forever.
async function requeueMatch(pool, matchId, reason, { maxAttempts = 5 } = {}) {
  const detail = String(reason || 'PLATFORM_ERROR').slice(0, 2048);
  return transaction(pool, async (client) => {
    const current = await client.query(
      "SELECT attempts FROM matches WHERE id = $1 AND status = 'RUNNING' FOR UPDATE",
      [matchId],
    );
    if (!current.rows[0]) return null;
    const attempts = Number(current.rows[0].attempts) + 1;
    if (attempts >= maxAttempts) {
      await client.query('UPDATE matches SET attempts = $2 WHERE id = $1', [matchId, attempts]);
      return { requeued: false, attempts };
    }
    await client.query('DELETE FROM match_events WHERE match_id = $1', [matchId]);
    await client.query(
      `UPDATE matches
          SET status = 'QUEUED', attempts = $2, failure_reason = $3,
              map_data = NULL, initial_state = NULL, started_at = NULL
        WHERE id = $1`,
      [matchId, attempts, detail],
    );
    return { requeued: true, attempts };
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

async function startMatchReplay(pool, matchId, replay) {
  const result = await pool.query(
    `UPDATE matches SET map_data = $2::jsonb, initial_state = $3::jsonb
      WHERE id = $1 AND status = 'RUNNING' RETURNING id`,
    [matchId, JSON.stringify(replay.map), JSON.stringify(replay.initial_state)],
  );
  if (result.rowCount !== 1) throw new Error('match_not_running');
}

async function completeStreamedMatch(pool, matchId, replay) {
  if (!['RED', 'BLUE', 'DRAW'].includes(replay.winner) || !Array.isArray(replay.events) ||
      !replay.replay_object_key) throw new Error('invalid_replay');
  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('arena:leaderboard'))");
    const saved = await client.query(
      `SELECT seq, event FROM match_events WHERE match_id = $1 ORDER BY seq ASC`, [matchId],
    );
    if (saved.rows.length !== replay.events.length ||
        saved.rows.some((row, index) => row.seq !== index ||
          row.event.state_hash !== replay.events[index].state_hash ||
          row.event.type !== replay.events[index].type)) throw new Error('replay_event_mismatch');
    const terminal = replay.events.at(-1);
    if (terminal?.type !== 'MATCH_ENDED' || terminal.winner !== replay.winner ||
        terminal.state_after?.winner !== replay.winner || !terminal.state_after?.finished) {
      throw new Error('replay_terminal_mismatch');
    }
    const updated = await client.query(
      `UPDATE matches SET status = 'FINISHED', winner = $2, failure_reason = NULL,
              replay_object_key = $3, finished_at = now()
        WHERE id = $1 AND status = 'RUNNING' RETURNING id, status, winner`,
      [matchId, replay.winner, replay.replay_object_key],
    );
    if (updated.rowCount !== 1) throw new Error('match_not_running');
    if (await leaderboardReadyInTransaction(client)) await refreshLeaderboardInTransaction(client);
    return updated.rows[0];
  });
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
    "  SELECT s.id FROM submissions s JOIN users u ON u.id = s.user_id",
    "   WHERE s.is_current = true AND s.deleted_at IS NULL AND s.status = 'FINISHED' AND u.active = true",
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
             SELECT s.id FROM submissions s JOIN users u ON u.id = s.user_id
              WHERE s.is_current = true AND s.deleted_at IS NULL AND s.status = 'FINISHED' AND u.active = true
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
           ), raw_totals AS (
             SELECT c.id AS submission_id,
                    COALESCE(SUM(o.wins), 0)::integer AS wins,
                    COALESCE(SUM(o.draws), 0)::integer AS draws,
                    COALESCE(SUM(o.losses), 0)::integer AS losses
               FROM current_algorithms c
               LEFT JOIN outcomes o ON o.submission_id = c.id
              GROUP BY c.id
           ), totals AS (
             SELECT r.submission_id,
                    COALESCE(o.wins, r.wins) AS wins,
                    COALESCE(o.draws, r.draws) AS draws,
                    COALESCE(o.losses, r.losses) AS losses
               FROM raw_totals r
               LEFT JOIN leaderboard_overrides o ON o.submission_id = r.submission_id
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
  passwordHash,
  verifyPassword,
  provisionUser,
  provisionPasswordUser,
  findUserByToken,
  findUserByCredentials,
  issueAccessToken,
  normalizeRegistration,
  createRegistration,
  ensurePasswordUser,
  createSubmission,
  getSubmission,
  listSubmissions,
  listUsers,
  getUserById,
  listAdminSubmissions,
  createManagedUser,
  updateManagedUser,
  deleteSubmission,
  setLeaderboardOverride,
  clearLeaderboardOverride,
  clearAllLeaderboardOverrides,
  listReadySubmissions,
  listRankedAlgorithms,
  listPendingAlgorithms,
  getCompiledArtifacts,
  getArtifactPayload,
  listBackedUpArtifacts,
  confirmSubmission,
  listLeaderboard,
  getLeaderboardEntry,
  listSubmissionMatches,
  listMatches,
  getMatch,
  getReplay,
  getMatchEventsAfter,
  setSubmissionStatus,
  upsertArtifact,
  createMatch,
  ensureMatchesForSubmission,
  listMatchesForSubmission,
  claimMatch,
  listQueuedMatches,
  countPendingMatches,
  startMatch,
  appendMatchEvent,
  startMatchReplay,
  completeStreamedMatch,
  replaceMatchReplay,
  completeMatch,
  finishMatch,
  requeueMatch,
  markArtifactLost,
  promoteSubmissionAndRefresh,
  promoteSubmissionIfNoOpponents,
  saveLeaderboardSnapshot,
  refreshLeaderboard,
};
