const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createServer } = require('../server');

function fixture() {
  const submissions = new Map();
  const user = { id: randomUUID(), handle: 'test_player' };
  const admin = { id: randomUUID(), handle: 'root', role: 'ADMIN', active: true };
  const users = new Map([[user.id, { ...user, role: 'PLAYER', active: true }], [admin.id, admin]]);
  let uploaded = false;
  let published = 0;
  const repo = {
    async findUserByCredentials(_pool, handle, password) {
      return handle === 'test_player' && password === 'secret'
        ? { ...user, role: 'PLAYER' } : null;
    },
    async issueAccessToken() { return 'issued-token'; },
    async findUserByToken(_pool, token) {
      if (token === 'secret') return { ...user, role: 'PLAYER', active: true };
      if (token === 'admin-secret') return admin;
      return null;
    },
    async createSubmission(_pool, { id, userId, name, stagingKey }) {
      const row = {
        id, user_id: userId, name, status: 'UPLOADED',
        compile_log: null, failure_reason: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        source_key: stagingKey, source_size: null, source_uploaded_at: null,
      };
      submissions.set(id, row);
      return row;
    },
    async getSubmission(_pool, id, userId) {
      const row = submissions.get(id);
      return row?.user_id === userId ? row : null;
    },
    async listSubmissions(_pool, userId) {
      return [...submissions.values()].filter((row) => row.user_id === userId);
    },
    async listUsers() { return [...users.values()]; },
    async createManagedUser(_pool, values) {
      const created = { id: randomUUID(), handle: values.handle, role: values.role, active: true, created_at: '2026-01-01T00:00:00Z' };
      users.set(created.id, created);
      return created;
    },
    async updateManagedUser(_pool, id, values) {
      const target = users.get(id);
      if (!target) return null;
      Object.assign(target, values);
      return target;
    },
    async deleteSubmission(_pool, id) {
      const row = submissions.get(id);
      if (!row) return null;
      row.deleted_at = '2026-01-01T00:00:02Z';
      row.is_current = false;
      return { id };
    },
    async listAdminSubmissions() { return [...submissions.values()].map((row) => ({ ...row, user_handle: 'test_player', is_current: false })); },
    async setLeaderboardOverride(_pool, values) { return values; },
    async clearLeaderboardOverride() {},
    async clearAllLeaderboardOverrides() {},
    async refreshLeaderboard() { return { entries: [], snapshotId: randomUUID() }; },
    async confirmSubmission(_pool, { id, confirmSource }) {
      const row = submissions.get(id);
      if (!row) return null;
      if (row.source_uploaded_at) return { confirmed: false, status: row.status };
      const finalKey = `submissions/${id}/source.zip`;
      const byteSize = await confirmSource(row.source_key, finalKey);
      row.status = 'UPLOADED';
      row.source_key = finalKey;
      row.source_size = byteSize;
      row.source_uploaded_at = '2026-01-01T00:00:01Z';
      return { confirmed: true, status: 'UPLOADED' };
    },
    async listLeaderboard() { return []; },
    async listMatches() { return []; },
    async getMatch(_pool, id) { return id === matchId ? { id, status: 'FINISHED' } : null; },
    async getReplay(_pool, id) {
      return id === matchId
        ? { match_id: id, map_seed: '1', map: {}, initial_state: {}, events: [], status: 'FINISHED' }
        : null;
    },
  };
  const storage = {
    async createUploadForm(key) {
      return { method: 'POST', url: 'http://storage/upload', fields: { key }, max_bytes: 5242880 };
    },
    async confirmSource() {
      if (!uploaded) throw Object.assign(new Error('source_not_uploaded'), { statusCode: 409 });
      return 123;
    },
    async sourceDownloadUrl() { return 'http://storage/download'; },
    async health() { return true; },
  };
  const queue = {
    async ping() { return 'PONG'; },
    async publish() { published += 1; },
  };
  const pool = { async query() { return { rows: [{ '?column?': 1 }] }; } };
  return {
    repo, storage, queue, pool, submissions,
    markUploaded() { uploaded = true; },
    setCompileLog(id, value) { submissions.get(id).compile_log = value; },
    publishedCount() { return published; },
  };
}

const matchId = randomUUID();

function serve(dependencies) {
  const server = createServer({ ...dependencies, logger: { error() {}, warn() {} } });
  return {
    request(method, url, { token, body } = {}) {
      return new Promise((resolve) => {
        const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const request = Readable.from(raw ? [raw] : []);
        request.method = method;
        request.url = url;
        request.headers = {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(raw ? { 'content-type': 'application/json' } : {}),
        };
        const response = {
          headersSent: false,
          writeHead(status) { this.status = status; this.headersSent = true; },
          end(payload) { resolve({ status: this.status, body: JSON.parse(payload) }); },
          destroy() { throw new Error('response destroyed'); },
        };
        server.emit('request', request, response);
      });
    },
  };
}

test('submission upload, persisted status, and read APIs', async () => {
  const dependencies = fixture();
  let app = serve(dependencies);
  let response = await app.request('POST', '/submissions', {
    token: 'secret', body: { name: 'My C++ bot' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.submission.status, 'UPLOADED');
  assert.equal(response.body.submission.source.confirmed, false);
  assert.equal(response.body.upload.method, 'POST');
  const id = response.body.submission.id;

  response = await app.request('GET', `/submissions/${id}`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.source.confirmed, false);
  assert.equal(response.body.submission.upload.method, 'POST');

  response = await app.request('POST', `/submissions/${id}/complete`, { token: 'secret' });
  assert.equal(response.status, 409);
  dependencies.markUploaded();
  response = await app.request('POST', `/submissions/${id}/complete`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.status, 'UPLOADED');
  assert.equal(response.body.submission.source.confirmed, true);
  assert.equal(dependencies.publishedCount(), 1);

  dependencies.setCompileLog(id, 'compile ok');
  app = serve(dependencies);
  response = await app.request('GET', `/submissions/${id}`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.source.size_bytes, 123);
  assert.equal(response.body.submission.compile_log, 'compile ok');
  assert.equal(response.body.submission.source.download_url, 'http://storage/download');

  response = await app.request('GET', '/submissions?limit=10', { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submissions.length, 1);

  response = await app.request('GET', '/leaderboard');
  assert.deepEqual(response.body.entries, []);
  response = await app.request('GET', '/matches');
  assert.deepEqual(response.body.matches, []);
  response = await app.request('GET', `/matches/${matchId}`);
  assert.equal(response.status, 200);
  response = await app.request('GET', `/matches/${matchId}/replay`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.events, []);
});

test('account password login issues a bearer token', async () => {
  const app = serve(fixture());
  let response = await app.request('POST', '/login', {
    body: { handle: 'test_player', password: 'secret' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.token, 'issued-token');
  assert.equal(response.body.user.role, 'PLAYER');
  response = await app.request('POST', '/login', {
    body: { handle: 'test_player', password: 'wrong' },
  });
  assert.equal(response.status, 401);
});

test('API rejects unauthenticated and invalid requests', async () => {
  const app = serve(fixture());
  let response = await app.request('POST', '/submissions', { body: { name: 'bot' } });
  assert.equal(response.status, 401);
  response = await app.request('POST', '/submissions', { token: 'secret', body: { name: '' } });
  assert.equal(response.status, 400);
  response = await app.request('GET', '/leaderboard?limit=101');
  assert.equal(response.status, 400);
  response = await app.request('GET', `/matches/${randomUUID()}/replay`);
  assert.equal(response.status, 404);
  response = await app.request('GET', '/health');
  assert.equal(response.status, 200);
});

test('administrator APIs enforce role and manage accounts, algorithms, and board', async () => {
  const dependencies = fixture();
  const app = serve(dependencies);
  let response = await app.request('GET', '/admin/users', { token: 'secret' });
  assert.equal(response.status, 403);
  response = await app.request('GET', '/admin/users');
  assert.equal(response.status, 401);

  response = await app.request('POST', '/admin/users', {
    token: 'admin-secret', body: { handle: 'new_player', password: 'password', role: 'PLAYER' },
  });
  assert.equal(response.status, 201);
  const userId = response.body.user.id;
  response = await app.request('PATCH', `/admin/users/${userId}`, {
    token: 'admin-secret', body: { active: false },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.user.active, false);

  const submissionId = randomUUID();
  dependencies.submissions.set(submissionId, {
    id: submissionId, user_id: userId, name: 'managed', status: 'FINISHED',
    is_current: true, deleted_at: null,
  });
  response = await app.request('PUT', `/admin/leaderboard/${submissionId}`, {
    token: 'admin-secret', body: { wins: 2, draws: 1, losses: 0, reason: 'manual review' },
  });
  assert.equal(response.status, 200);
  response = await app.request('DELETE', `/admin/submissions/${submissionId}`, { token: 'admin-secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.deleted, true);
  response = await app.request('POST', '/admin/leaderboard/recalculate', { token: 'admin-secret', body: {} });
  assert.equal(response.status, 200);
});
