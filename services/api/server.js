const http = require('node:http');
const crypto = require('node:crypto');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const submissionPath = new RegExp(`^/submissions/(${UUID})$`, 'i');
const completePath = new RegExp(`^/submissions/(${UUID})/complete$`, 'i');
const leaderboardEntryPath = new RegExp(`^/leaderboard/(${UUID})$`, 'i');
const matchPath = new RegExp(`^/matches/(${UUID})$`, 'i');
const replayPath = new RegExp(`^/matches/(${UUID})/replay$`, 'i');
const adminUserPath = new RegExp(`^/admin/users/(${UUID})$`, 'i');
const adminSubmissionPath = new RegExp(`^/admin/submissions/(${UUID})$`, 'i');
const adminLeaderboardPath = new RegExp(`^/admin/leaderboard/(${UUID})$`, 'i');
const MAX_METADATA_BYTES = 16 * 1024;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  response.end(payload);
}

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_METADATA_BYTES) throw new HttpError(413, 'metadata_too_large');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('expected object');
    }
    return value;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

function pagination(searchParams) {
  const rawLimit = searchParams.get('limit') || '50';
  const rawOffset = searchParams.get('offset') || '0';
  const limit = Number(rawLimit);
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new HttpError(400, 'invalid_pagination');
  }
  return { limit, offset };
}

function serializeSubmission(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    status: row.status,
    is_current: Boolean(row.is_current),
    compile_log: row.compile_log,
    failure_reason: row.failure_reason,
    deleted_at: row.deleted_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: {
      confirmed: Boolean(row.source_uploaded_at),
      size_bytes: row.source_size == null ? null : Number(row.source_size),
      uploaded_at: row.source_uploaded_at,
    },
    match_progress: {
      total: Number(row.match_total || 0),
      completed: Number(row.match_completed || 0),
    },
  };
}

// Public views identify players by their account handle. Version names,
// source links and compiler logs belong to the owner's submission view.
function serializeLeaderboardEntry(row) {
  return {
    rank: row.rank, submission_id: row.submission_id,
    user_id: row.user_id, user_handle: row.user_handle,
    wins: row.wins, draws: row.draws, losses: row.losses,
    win_rate: Number(row.win_rate), points_rate: Number(row.points_rate),
    updated_at: row.updated_at,
  };
}

function serializeMatch(row) {
  return {
    id: row.id, red_submission_id: row.red_submission_id,
    blue_submission_id: row.blue_submission_id,
    red_user: row.red_user, blue_user: row.blue_user,
    opponent_submission_id: row.opponent_submission_id,
    opponent_user: row.opponent_user, result_for_submission: row.result_for_submission,
    map_seed: row.map_seed, status: row.status, winner: row.winner,
    failure_reason: row.failure_reason, event_count: row.event_count,
    created_at: row.created_at, started_at: row.started_at, finished_at: row.finished_at,
    replay_url: `/matches/${row.id}/replay`,
    replay_available: Boolean(row.replay_object_key) || Number(row.event_count) > 0,
  };
}

function serializeAdminUser(row) {
  return {
    id: row.id, handle: row.handle, real_name: row.real_name || null,
    student_no: row.student_no || null, qq_number: row.qq_number || null,
    role: row.role, active: Boolean(row.active),
    created_at: row.created_at,
  };
}

function serializeAdminSubmission(row) {
  return {
    id: row.id, user_id: row.user_id, user_handle: row.user_handle,
    name: row.name, status: row.status, is_current: Boolean(row.is_current),
    deleted_at: row.deleted_at, compile_log: row.compile_log,
    failure_reason: row.failure_reason, created_at: row.created_at, updated_at: row.updated_at,
  };
}

// Copy PostgreSQL artifact backups into object storage when the object is
// missing, for example after the storage volume was replaced. Failures are
// logged and never stop the API: workers fall back to the same backups.
async function restoreArtifactBackups({ pool, storage, repo, logger = console }) {
  const summary = { restored: 0, failed: 0 };
  if (typeof repo.listBackedUpArtifacts !== 'function' ||
      typeof storage.objectExists !== 'function' ||
      typeof storage.uploadBuffer !== 'function') return summary;
  let artifacts;
  try {
    artifacts = await repo.listBackedUpArtifacts(pool);
  } catch (error) {
    logger.warn('artifact backup listing failed', error);
    return summary;
  }
  for (const artifact of artifacts) {
    try {
      if (await storage.objectExists(artifact.object_key)) continue;
      const payload = await repo.getArtifactPayload(pool, artifact.submission_id, artifact.kind);
      if (!payload) continue;
      await storage.uploadBuffer(artifact.object_key, payload, artifact.content_type);
      summary.restored += 1;
    } catch (error) {
      summary.failed += 1;
      logger.warn('artifact backup restore failed', { key: artifact.object_key, error });
    }
  }
  return summary;
}

async function deletePrunedArtifacts(storage, pruning, logger = console) {
  for (const objectKey of pruning?.objectKeys || []) {
    if (typeof storage.deleteObject !== 'function') continue;
    await storage.deleteObject(objectKey).catch((error) => {
      logger.warn('submission artifact cleanup failed', { objectKey, error });
    });
  }
}

function createServer({ pool, storage, queue, repo, logger = console }) {
  async function authenticatedUser(request) {
    const match = /^Bearer ([^\s]+)$/.exec(String(request.headers.authorization || ''));
    if (!match) throw new HttpError(401, 'authentication_required');
    const user = await repo.findUserByToken(pool, match[1]);
    if (!user) throw new HttpError(401, 'invalid_token');
    return user;
  }

  async function adminUser(request) {
    const user = await authenticatedUser(request);
    if (user.role !== 'ADMIN') throw new HttpError(403, 'admin_required');
    return user;
  }

  function repoError(error) {
    const map = {
      invalid_user: [400, 'invalid_user'], invalid_password: [400, 'invalid_password'],
      user_not_found: [404, 'user_not_found'],
      invalid_role: [400, 'invalid_role'], no_user_changes: [400, 'no_user_changes'],
      self_admin_protected: [409, 'self_admin_protected'],
      last_admin_protected: [409, 'last_admin_protected'],
      invalid_leaderboard_record: [400, 'invalid_leaderboard_record'],
      submission_not_active: [409, 'submission_not_active'],
      invalid_registration: [400, 'invalid_registration'],
      invalid_real_name: [400, 'invalid_real_name'],
      invalid_student_no: [400, 'invalid_student_no'],
      invalid_qq_number: [400, 'invalid_qq_number'],
      registration_already_exists: [409, 'registration_already_exists'],
    };
    const value = map[error?.message];
    return value ? new HttpError(value[0], value[1]) : error;
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;

    if (request.method === 'POST' && path === '/register') {
      const body = await readJson(request);
      try {
        const registration = await repo.createRegistration(pool, {
          realName: body.real_name,
          studentNo: body.student_no,
          qqNumber: body.qq_number,
          password: body.password,
        });
        sendJson(response, 201, {
          registered: true,
          status: registration.status,
          user: {
            id: registration.user.id,
            display_name: registration.user.real_name || registration.user.handle,
            student_no: registration.user.student_no,
            role: registration.user.role,
          },
          message: '注册成功，请使用学号和密码登录。',
        });
      } catch (error) { throw repoError(error); }
      return;
    }

    if (request.method === 'POST' && path === '/login') {
      const body = await readJson(request);
      const handle = typeof body.student_no === 'string'
        ? body.student_no.trim()
        : typeof body.handle === 'string' ? body.handle.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(handle) || password.length < 1) {
        throw new HttpError(400, 'invalid_credentials');
      }
      const user = await repo.findUserByCredentials(pool, handle, password);
      if (!user) throw new HttpError(401, 'invalid_credentials');
      const token = await repo.issueAccessToken(pool, user.id);
      sendJson(response, 200, {
        token,
        token_type: 'Bearer',
        user: {
          id: user.id,
          handle: user.handle,
          display_name: user.real_name || user.handle,
          student_no: user.student_no || null,
          role: user.role,
        },
      });
      return;
    }

    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { status: 'ok', service: 'arena-api' });
      return;
    }
    if (request.method === 'GET' && path === '/health') {
      const checks = await Promise.allSettled([
        pool.query('SELECT 1'),
        typeof queue.ping === 'function' ? queue.ping() : Promise.reject(new Error('redis_unavailable')),
        storage.health(),
      ]);
      const dependencies = {
        postgres: checks[0].status === 'fulfilled',
        redis: checks[1].status === 'fulfilled',
        object_storage: checks[2].status === 'fulfilled',
      };
      const healthy = Object.values(dependencies).every(Boolean);
      sendJson(response, healthy ? 200 : 503, {
        status: healthy ? 'ok' : 'degraded',
        service: 'arena-api',
        dependencies,
      });
      return;
    }

    if (path === '/admin/users' && request.method === 'GET') {
      await adminUser(request);
      const { limit, offset } = pagination(url.searchParams);
      const users = await repo.listUsers(pool, limit, offset);
      sendJson(response, 200, { users: users.map(serializeAdminUser), limit, offset });
      return;
    }

    if (path === '/admin/users' && request.method === 'POST') {
      await adminUser(request);
      const body = await readJson(request);
      const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
      const realName = body.real_name === undefined ? null : body.real_name;
      const studentNo = body.student_no === undefined ? null : body.student_no;
      const qqNumber = body.qq_number === undefined ? null : body.qq_number;
      const password = typeof body.password === 'string' ? body.password : '';
      const role = body.role === undefined ? 'PLAYER' : body.role;
      if ((!handle && studentNo === null) || password.length < 1 ||
          !['PLAYER', 'ADMIN'].includes(role)) throw new HttpError(400, 'invalid_user');
      try {
        const created = await repo.createManagedUser(pool, {
          handle, password, role, realName, studentNo, qqNumber,
        });
        sendJson(response, 201, { user: serializeAdminUser(created) }, { location: `/admin/users/${created.id}` });
      } catch (error) {
        if (error.code === '23505') throw new HttpError(409, 'handle_already_exists');
        throw repoError(error);
      }
      return;
    }

    const adminUserMatch = adminUserPath.exec(path);
    if (adminUserMatch && request.method === 'GET') {
      await adminUser(request);
      const target = await repo.getUserById(pool, adminUserMatch[1]);
      if (!target) throw new HttpError(404, 'user_not_found');
      sendJson(response, 200, { user: serializeAdminUser(target) });
      return;
    }
    if (adminUserMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
      const actor = await adminUser(request);
      const id = adminUserMatch[1];
      const body = request.method === 'PATCH' ? await readJson(request) : { active: false };
      if (body.password !== undefined && (typeof body.password !== 'string' || body.password.length < 1)) {
        throw new HttpError(400, 'invalid_password');
      }
      if (body.active !== undefined && typeof body.active !== 'boolean') throw new HttpError(400, 'invalid_active');
      try {
        const updated = await repo.updateManagedUser(pool, id, {
          password: body.password, role: body.role, active: body.active,
        }, { actorId: actor.id });
        if (!updated) throw new HttpError(404, 'user_not_found');
        sendJson(response, 200, { user: serializeAdminUser(updated) });
      } catch (error) {
        throw repoError(error);
      }
      return;
    }

    if (path === '/admin/submissions' && request.method === 'GET') {
      await adminUser(request);
      const { limit, offset } = pagination(url.searchParams);
      const submissions = await repo.listAdminSubmissions(pool, limit, offset);
      sendJson(response, 200, { submissions: submissions.map(serializeAdminSubmission), limit, offset });
      return;
    }

    const adminSubmissionMatch = adminSubmissionPath.exec(path);
    if (adminSubmissionMatch && request.method === 'DELETE') {
      await adminUser(request);
      const deleted = await repo.deleteSubmission(pool, adminSubmissionMatch[1]);
      if (!deleted) throw new HttpError(404, 'submission_not_found');
      if (typeof repo.refreshLeaderboard === 'function') await repo.refreshLeaderboard(pool);
      sendJson(response, 200, { deleted: true, submission_id: deleted.id });
      return;
    }

    if (path === '/admin/leaderboard/recalculate' && request.method === 'POST') {
      await adminUser(request);
      if (url.searchParams.get('clear_overrides') === 'true' && typeof repo.clearAllLeaderboardOverrides === 'function') {
        await repo.clearAllLeaderboardOverrides(pool);
      }
      const result = await repo.refreshLeaderboard(pool);
      sendJson(response, 200, { entries: result.entries, snapshot_id: result.snapshotId });
      return;
    }

    const adminLeaderboardMatch = adminLeaderboardPath.exec(path);
    if (adminLeaderboardMatch && (request.method === 'PUT' || request.method === 'DELETE')) {
      await adminUser(request);
      const submissionId = adminLeaderboardMatch[1];
      if (request.method === 'DELETE') {
        await repo.clearLeaderboardOverride(pool, submissionId);
      } else {
        const body = await readJson(request);
        const values = [body.wins, body.draws, body.losses];
        if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) {
          throw new HttpError(400, 'invalid_leaderboard_record');
        }
        if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
          throw new HttpError(400, 'invalid_reason');
        }
        try {
          await repo.setLeaderboardOverride(pool, {
            submissionId, wins: body.wins, draws: body.draws, losses: body.losses, reason: body.reason || null,
          });
        } catch (error) { throw repoError(error); }
      }
      const result = await repo.refreshLeaderboard(pool);
      sendJson(response, 200, { entries: result.entries, snapshot_id: result.snapshotId });
      return;
    }

    if (path === '/submissions' && request.method === 'POST') {
      const user = await authenticatedUser(request);
      const body = await readJson(request);
      if (typeof body.name !== 'string' || body.name.trim().length < 1 ||
          body.name.trim().length > 80) {
        throw new HttpError(400, 'invalid_submission_name');
      }
      const id = crypto.randomUUID();
      const stagingKey = `uploads/${id}/${crypto.randomUUID()}.zip`;
      const upload = await storage.createUploadForm(stagingKey);
      const submission = await repo.createSubmission(pool, {
        id,
        userId: user.id,
        name: body.name.trim(),
        stagingKey,
      });
      if (typeof repo.pruneSubmissionHistory === 'function') {
        try {
          const pruning = await repo.pruneSubmissionHistory(pool, user.id);
          await deletePrunedArtifacts(storage, pruning, logger);
        } catch (error) {
          // The new upload is already durable. A cleanup failure must not make
          // the user submit again; the next submission retries pruning.
          logger.warn('submission history pruning failed', { userId: user.id, error });
        }
      }
      sendJson(response, 201, {
        submission: serializeSubmission({
          ...submission, source_size: null, source_uploaded_at: null,
        }),
        upload,
      }, {
        location: `/submissions/${id}`,
      });
      return;
    }

    if (path === '/submissions' && request.method === 'GET') {
      const user = await authenticatedUser(request);
      const { limit, offset } = pagination(url.searchParams);
      const rows = await repo.listSubmissions(pool, user.id, limit, offset);
      sendJson(response, 200, {
        submissions: rows.map((row) => ({
          ...serializeSubmission(row),
          is_current: Boolean(row.is_current),
        })),
        limit,
        offset,
      });
      return;
    }

    const complete = completePath.exec(path);
    if (complete && request.method === 'POST') {
      const user = await authenticatedUser(request);
      const result = await repo.confirmSubmission(pool, {
        id: complete[1],
        userId: user.id,
        confirmSource: async (stagingKey, finalKey) => {
          const byteSize = await storage.confirmSource(stagingKey, finalKey);
          // Keep a private PostgreSQL backup of the confirmed source. S3 is
          // still the transfer path, but an object-store reset can no longer
          // erase the only copy of a submitted algorithm.
          const payload = typeof storage.downloadObjectToBuffer === 'function'
            ? await storage.downloadObjectToBuffer(finalKey, 5 * 1024 * 1024)
            : null;
          return payload == null ? byteSize : { byteSize, payload };
        },
      });
      if (!result) throw new HttpError(404, 'submission_not_found');
      if (result.confirmed) {
        // The staging key is only needed until confirmation. Removing it
        // prevents every confirmed version from consuming two object-store
        // copies of the ZIP. This happens after the database transaction has
        // committed, so a failed transaction cannot lose the source pointer.
        if (result.stagingKey && typeof storage.deleteObject === 'function') {
          await storage.deleteObject(result.stagingKey).catch((error) => {
            logger.warn('submission staging cleanup failed', { stagingKey: result.stagingKey, error });
          });
        }
        // The durable UPLOADED row lets a scheduler recover even if this
        // Redis notification is lost during an API restart.
        try {
          await queue.publish('arena:submissions:uploaded', complete[1]);
        } catch (error) {
          logger.warn('upload notification failed', error);
        }
      }
      const updated = await repo.getSubmission(pool, complete[1], user.id);
      sendJson(response, 200, { submission: serializeSubmission(updated) });
      return;
    }

    const submissionId = submissionPath.exec(path);
    if (submissionId && request.method === 'GET') {
      const user = await authenticatedUser(request);
      const row = await repo.getSubmission(pool, submissionId[1], user.id);
      if (!row) throw new HttpError(404, 'submission_not_found');
      const submission = serializeSubmission(row);
      if (!row.deleted_at && !row.source_uploaded_at) {
        submission.upload = await storage.createUploadForm(row.source_key);
      } else if (row.source_uploaded_at) {
        submission.source.download_url = await storage.sourceDownloadUrl(row.source_key);
        submission.source.download_expires_in_seconds = 300;
      }
      const matches = typeof repo.listSubmissionMatches === 'function'
        ? await repo.listSubmissionMatches(pool, submissionId[1]) : [];
      sendJson(response, 200, { submission, matches: matches.map(serializeMatch) });
      return;
    }

    if (path === '/leaderboard' && request.method === 'GET') {
      const { limit, offset } = pagination(url.searchParams);
      const entries = await repo.listLeaderboard(pool, limit, offset);
      sendJson(response, 200, { entries: entries.map(serializeLeaderboardEntry), limit, offset });
      return;
    }

    const leaderboardEntry = leaderboardEntryPath.exec(path);
    if (leaderboardEntry && request.method === 'GET') {
      if (typeof repo.getLeaderboardEntry !== 'function' ||
          typeof repo.listSubmissionMatches !== 'function') {
        throw new HttpError(404, 'leaderboard_entry_not_found');
      }
      const id = leaderboardEntry[1];
      const entry = await repo.getLeaderboardEntry(pool, id);
      if (!entry) throw new HttpError(404, 'leaderboard_entry_not_found');
      const matches = await repo.listSubmissionMatches(pool, id);
      sendJson(response, 200, {
        entry: serializeLeaderboardEntry(entry),
        matches: matches.map(serializeMatch),
      });
      return;
    }

    if (path === '/matches' && request.method === 'GET') {
      const { limit, offset } = pagination(url.searchParams);
      const matches = await repo.listMatches(pool, limit, offset);
      sendJson(response, 200, { matches: matches.map(serializeMatch), limit, offset });
      return;
    }

    const replayId = replayPath.exec(path);
    if (replayId && request.method === 'GET') {
      const replay = await repo.getReplay(pool, replayId[1]);
      if (!replay) throw new HttpError(404, 'match_not_found');
      if (!replay.map || !replay.initial_state) throw new HttpError(409, 'replay_not_ready');
      if (replay.replay_object_key && typeof storage.objectDownloadUrl === 'function') {
        replay.archive_url = await storage.objectDownloadUrl(replay.replay_object_key);
        replay.archive_expires_in_seconds = 300;
      }
      sendJson(response, 200, replay);
      return;
    }

    const matchId = matchPath.exec(path);
    if (matchId && request.method === 'GET') {
      const match = await repo.getMatch(pool, matchId[1]);
      if (!match) throw new HttpError(404, 'match_not_found');
      sendJson(response, 200, { match: serializeMatch(match) });
      return;
    }

    const known = path === '/login' || path === '/register' || path === '/submissions' || path === '/leaderboard' ||
      path === '/matches' || submissionPath.test(path) || completePath.test(path) ||
      leaderboardEntryPath.test(path) || matchPath.test(path) || replayPath.test(path) ||
      path === '/healthz' || path === '/health' ||
      path.startsWith('/admin/');
    if (known) throw new HttpError(405, 'method_not_allowed');
    throw new HttpError(404, 'not_found');
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError || Number.isInteger(error.statusCode)) {
        sendJson(response, error.status || error.statusCode, { error: error.code || error.message });
        return;
      }
      logger.error('API request failed', error);
      sendJson(response, 500, { error: 'internal_error' });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

async function start(env = process.env) {
  const db = require('./db');
  const { createStorage } = require('./storage');
  const { createClient } = require('redis');
  const pool = db.createPool(env);
  const storage = createStorage(env);
  const queue = createClient({
    url: env.REDIS_URL || `redis://${env.REDIS_HOST || 'redis'}:${env.REDIS_PORT || 6379}`,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  queue.on('error', (error) => console.error('Redis error', error));
  async function retry(operation, attempts = 20) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    throw lastError;
  }
  try {
    await retry(() => db.bootstrap(pool));
    await db.ensurePasswordUser(pool, {
      handle: env.ARENA_ADMIN_HANDLE || 'root',
      password: env.ARENA_ADMIN_PASSWORD || '416',
      role: 'ADMIN',
    });
    if (env.ARENA_DEV_HANDLE && env.ARENA_DEV_TOKEN) {
      await db.provisionUser(pool, env.ARENA_DEV_HANDLE, env.ARENA_DEV_TOKEN);
    }
    await retry(() => storage.ensureBucket());
    const restored = await restoreArtifactBackups({ pool, storage, repo: db });
    if (restored.restored || restored.failed) {
      process.stdout.write(
        `object storage restore: ${restored.restored} restored, ${restored.failed} failed\n`,
      );
    }
    // Apply the retention rule to versions that existed before this release.
    // New submissions run the same cleanup path in createServer; doing this
    // once at startup avoids leaving old installations over the disk budget.
    if (typeof db.listSubmissionOwnerIds === 'function' &&
        typeof db.pruneSubmissionHistory === 'function') {
      const owners = await db.listSubmissionOwnerIds(pool);
      for (const ownerId of owners) {
        try {
          await deletePrunedArtifacts(
            storage, await db.pruneSubmissionHistory(pool, ownerId), console,
          );
        } catch (error) {
          console.warn('startup submission history pruning failed', { ownerId, error });
        }
      }
    }
    await retry(async () => {
      if (!queue.isReady) {
        if (queue.isOpen) await queue.ping();
        else await queue.connect();
      }
    });
  } catch (error) {
    await Promise.allSettled([pool.end(), queue.isOpen ? queue.quit() : Promise.resolve()]);
    throw error;
  }

  const server = createServer({ pool, storage, queue, repo: db });
  const port = Number(env.PORT || 8080);
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  process.stdout.write(`arena-api listening on ${port}\n`);

  async function shutdown() {
    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([queue.quit(), pool.end()]);
  }
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  return { server, pool, storage, queue, shutdown };
}

if (require.main === module) {
  start().catch((error) => {
    console.error('API startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = { createServer, restoreArtifactBackups, start, HttpError };
