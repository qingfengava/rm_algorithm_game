const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createServer } = require('../server');

function fixture() {
  const submissions = new Map();
  const user = { id: randomUUID(), handle: 'test_player' };
  let uploaded = false;
  let published = 0;
  const repo = {
    async findUserByToken(_pool, token) { return token === 'secret' ? user : null; },
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
