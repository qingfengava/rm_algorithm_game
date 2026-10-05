const http = require('node:http');
const crypto = require('node:crypto');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const submissionPath = new RegExp(`^/submissions/(${UUID})$`, 'i');
const completePath = new RegExp(`^/submissions/(${UUID})/complete$`, 'i');
const matchPath = new RegExp(`^/matches/(${UUID})$`, 'i');
const replayPath = new RegExp(`^/matches/(${UUID})/replay$`, 'i');
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
    compile_log: row.compile_log,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: {
      confirmed: Boolean(row.source_uploaded_at),
      size_bytes: row.source_size == null ? null : Number(row.source_size),
      uploaded_at: row.source_uploaded_at,
    },
  };
}

function createServer({ pool, storage, queue, repo, logger = console }) {
  async function authenticatedUser(request) {
    const match = /^Bearer ([^\s]+)$/.exec(String(request.headers.authorization || ''));
    if (!match) throw new HttpError(401, 'authentication_required');
    const user = await repo.findUserByToken(pool, match[1]);
    if (!user) throw new HttpError(401, 'invalid_token');
    return user;
  }

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;

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

    const complete = completePath.exec(path);
    if (complete && request.method === 'POST') {
      const user = await authenticatedUser(request);
      const result = await repo.confirmSubmission(pool, {
        id: complete[1],
        userId: user.id,
        confirmSource: (stagingKey, finalKey) => storage.confirmSource(stagingKey, finalKey),
      });
      if (!result) throw new HttpError(404, 'submission_not_found');
      if (result.confirmed) {
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
      if (!row.source_uploaded_at) {
        submission.upload = await storage.createUploadForm(row.source_key);
      } else if (row.source_uploaded_at) {
        submission.source.download_url = await storage.sourceDownloadUrl(row.source_key);
        submission.source.download_expires_in_seconds = 300;
      }
      sendJson(response, 200, { submission });
      return;
    }

    if (path === '/leaderboard' && request.method === 'GET') {
      const { limit, offset } = pagination(url.searchParams);
      const entries = await repo.listLeaderboard(pool, limit, offset);
      sendJson(response, 200, { entries, limit, offset });
      return;
    }

    if (path === '/matches' && request.method === 'GET') {
      const { limit, offset } = pagination(url.searchParams);
      const matches = await repo.listMatches(pool, limit, offset);
      sendJson(response, 200, { matches, limit, offset });
      return;
    }

    const replayId = replayPath.exec(path);
    if (replayId && request.method === 'GET') {
      const replay = await repo.getReplay(pool, replayId[1]);
      if (!replay) throw new HttpError(404, 'match_not_found');
      if (!replay.map || !replay.initial_state) throw new HttpError(409, 'replay_not_ready');
      sendJson(response, 200, replay);
      return;
    }

    const matchId = matchPath.exec(path);
    if (matchId && request.method === 'GET') {
      const match = await repo.getMatch(pool, matchId[1]);
      if (!match) throw new HttpError(404, 'match_not_found');
      sendJson(response, 200, { match });
      return;
    }

    const known = path === '/submissions' || path === '/leaderboard' ||
      path === '/matches' || submissionPath.test(path) || completePath.test(path) ||
      matchPath.test(path) || replayPath.test(path) || path === '/healthz' || path === '/health';
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
    if (env.ARENA_DEV_HANDLE && env.ARENA_DEV_TOKEN) {
      await db.provisionUser(pool, env.ARENA_DEV_HANDLE, env.ARENA_DEV_TOKEN);
    }
    await retry(() => storage.ensureBucket());
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

module.exports = { createServer, start, HttpError };
