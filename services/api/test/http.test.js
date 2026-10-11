const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');
const { Readable } = require('node:stream');
const { createServer, restoreArtifactBackups } = require('../server');

function fixture() {
  const submissions = new Map();
  const user = { id: randomUUID(), handle: 'test_player' };
  const otherUser = { id: randomUUID(), handle: 'other_player', role: 'PLAYER', active: true };
  const admin = { id: randomUUID(), handle: 'root', role: 'ADMIN', active: true };
  const users = new Map([[user.id, { ...user, role: 'PLAYER', active: true }], [otherUser.id, otherUser], [admin.id, admin]]);
  let uploaded = false;
  let published = 0;
  const repo = {
    async findUserByCredentials(_pool, handle, password) {
      return handle === 'test_player' && password === 'secret'
        ? { ...user, role: 'PLAYER' } : null;
    },
    async createRegistration(_pool, values) {
      return {
        status: 'ACTIVE',
        user: {
          id: randomUUID(), handle: values.studentNo, real_name: values.realName,
          student_no: values.studentNo, qq_number: values.qqNumber,
          role: 'PLAYER', active: true, created_at: '2026-01-01T00:00:00Z',
        },
      };
    },
    async issueAccessToken() { return 'issued-token'; },
    async findUserByToken(_pool, token) {
      if (token === 'secret') return { ...user, role: 'PLAYER', active: true };
      if (token === 'other-secret') return otherUser;
      if (token === 'admin-secret') return admin;
      return null;
    },
    async createSubmission(_pool, { id, userId, name, stagingKey }) {
      // Only the unpublished candidate is superseded; the ranked version
      // (is_current) stays visible until a new candidate is promoted.
      for (const row of submissions.values()) {
        if (row.user_id === userId && !row.deleted_at && !row.is_current) {
          row.deleted_at = '2026-01-01T00:00:00.500Z';
        }
      }
      const row = {
        id, user_id: userId, name, status: 'UPLOADED', is_current: false,
        compile_log: null, failure_reason: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        source_key: stagingKey, source_size: null, source_uploaded_at: null,
      };
      submissions.set(id, row);
      return row;
    },
    async pruneSubmissionHistory() { return { objectKeys: [] }; },
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
    async confirmSubmission(_pool, { id, userId, confirmSource }) {
      const row = submissions.get(id);
      if (!row || row.user_id !== userId || row.deleted_at) return null;
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
    async getLeaderboardEntry(_pool, id) {
      return id === leaderboardId ? {
        rank: 1, submission_id: id, submission_name: 'ranked', user_id: user.id,
        user_handle: user.handle, wins: 1, draws: 0, losses: 0,
        win_rate: 1, points_rate: 1,
      } : null;
    },
    async listSubmissionMatches(_pool, id) {
      return id === leaderboardId ? [{
        id: matchId, red_submission_id: id, blue_submission_id: randomUUID(),
        opponent_name: 'opponent', opponent_user: 'other', map_seed: '7',
        status: 'FINISHED', winner: 'RED', result_for_submission: 'WIN',
        created_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z',
      }] : [];
    },
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
const leaderboardId = randomUUID();

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
  response = await app.request('GET', `/leaderboard/${leaderboardId}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.entry.rank, 1);
  assert.equal(response.body.matches[0].result_for_submission, 'WIN');
  response = await app.request('GET', '/matches');
  assert.deepEqual(response.body.matches, []);
  response = await app.request('GET', `/matches/${matchId}`);
  assert.equal(response.status, 200);
  response = await app.request('GET', `/matches/${matchId}/replay`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.events, []);
});

test('a new upload supersedes only the unpublished candidate and keeps the ranked version', async () => {
  const dependencies = fixture();
  const app = serve(dependencies);
  let response = await app.request('POST', '/submissions', {
    token: 'secret', body: { name: 'ranked bot' },
  });
  assert.equal(response.status, 201);
  const rankedId = response.body.submission.id;
  Object.assign(dependencies.submissions.get(rankedId), { status: 'FINISHED', is_current: true });

  response = await app.request('POST', '/submissions', {
    token: 'secret', body: { name: 'first candidate' },
  });
  assert.equal(response.status, 201);
  const oldCandidateId = response.body.submission.id;
  response = await app.request('POST', '/submissions', {
    token: 'secret', body: { name: 'second candidate' },
  });
  assert.equal(response.status, 201);
  const newCandidateId = response.body.submission.id;
  assert.notEqual(oldCandidateId, newCandidateId);

  response = await app.request('GET', '/submissions', { token: 'secret' });
  assert.deepEqual(
    response.body.submissions.map((submission) => [submission.id, submission.is_current]).sort(),
    [[rankedId, true], [oldCandidateId, false], [newCandidateId, false]].sort(),
  );
  response = await app.request('GET', `/submissions/${rankedId}`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.status, 'FINISHED');
  response = await app.request('GET', `/submissions/${oldCandidateId}`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.deleted_at, '2026-01-01T00:00:00.500Z');
  assert.equal(response.body.submission.upload, undefined);
  response = await app.request('POST', `/submissions/${oldCandidateId}/complete`, { token: 'secret' });
  assert.equal(response.status, 404);
});

test('public leaderboard and match APIs expose user handles, not version names', async () => {
  const dependencies = fixture();
  const entry = {
    rank: 1, submission_id: leaderboardId, submission_name: 'private-version-name',
    user_id: randomUUID(), user_handle: 'test_player',
    wins: 1, draws: 0, losses: 0, win_rate: 1, points_rate: 1,
    compile_log: 'private-compile-log', source_key: 'private-source-key',
  };
  const match = {
    id: matchId, red_submission_id: leaderboardId, blue_submission_id: randomUUID(),
    red_name: 'private-red-name', blue_name: 'private-blue-name',
    opponent_name: 'private-blue-name', opponent_user: 'other_player',
    red_user: 'test_player', blue_user: 'other_player',
    status: 'FINISHED', winner: 'RED', created_at: '2026-01-01T00:00:00Z',
    result_for_submission: 'WIN', replay_object_key: 'private-replay-key', event_count: 1,
  };
  dependencies.repo.listLeaderboard = async () => [entry];
  dependencies.repo.getLeaderboardEntry = async () => entry;
  dependencies.repo.listMatches = async () => [match];
  dependencies.repo.getMatch = async () => match;
  dependencies.repo.listSubmissionMatches = async () => [match];
  const app = serve(dependencies);
  let response = await app.request('GET', '/leaderboard');
  assert.equal(response.status, 200);
  assert.equal(response.body.entries[0].submission_name, undefined);
  assert.equal(response.body.entries[0].user_handle, 'test_player');
  response = await app.request('GET', '/matches');
  assert.equal(response.status, 200);
  assert.equal(response.body.matches[0].red_name, undefined);
  assert.equal(response.body.matches[0].red_user, 'test_player');
  for (const path of ['/leaderboard', `/leaderboard/${leaderboardId}`, '/matches', `/matches/${matchId}`]) {
    response = await app.request('GET', path);
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(response.body);
    for (const privateValue of ['private-version-name', 'private-red-name', 'private-blue-name',
      'private-compile-log', 'private-source-key', 'private-replay-key']) {
      assert.equal(serialized.includes(privateValue), false, `${path} leaked ${privateValue}`);
    }
  }
  response = await app.request('GET', `/leaderboard/${leaderboardId}`);
  assert.equal(response.body.matches[0].opponent_user, 'other_player');
  assert.equal(response.body.matches[0].replay_available, true);
  match.replay_object_key = null;
  response = await app.request('GET', `/matches/${matchId}`);
  assert.equal(response.body.match.replay_available, true);
  match.event_count = 0;
  response = await app.request('GET', `/matches/${matchId}`);
  assert.equal(response.body.match.replay_available, false);
});

test('version lists and details belong to the owner, whose detail includes formal matches', async () => {
  const dependencies = fixture();
  const app = serve(dependencies);
  let response = await app.request('POST', '/submissions', {
    token: 'secret', body: { name: 'my private strategy' },
  });
  const ownId = response.body.submission.id;
  response = await app.request('POST', '/submissions', {
    token: 'other-secret', body: { name: 'their private strategy' },
  });
  const otherId = response.body.submission.id;
  Object.assign(dependencies.submissions.get(ownId), {
    status: 'FINISHED', compile_log: 'compile ok', match_total: 2, match_completed: 1,
  });
  let matchReads = 0;
  dependencies.repo.listSubmissionMatches = async (_pool, id) => {
    assert.equal(id, ownId);
    matchReads += 1;
    return [{
      id: matchId, red_submission_id: ownId, blue_submission_id: otherId,
      red_user: 'test_player', blue_user: 'other_player', opponent_user: 'other_player',
      opponent_name: 'their private strategy', status: 'FINISHED', winner: 'RED',
      result_for_submission: 'WIN', map_seed: '7', event_count: 3,
    }];
  };
  for (const path of ['/submissions', `/submissions/${ownId}`]) {
    response = await app.request('GET', path);
    assert.equal(response.status, 401);
  }
  for (const token of ['other-secret', 'admin-secret']) {
    response = await app.request('GET', `/submissions/${ownId}`, { token });
    assert.equal(response.status, 404);
  }
  assert.equal(matchReads, 0);
  response = await app.request('GET', '/submissions', { token: 'secret' });
  assert.deepEqual(response.body.submissions.map((row) => row.name), ['my private strategy']);
  response = await app.request('GET', '/submissions', { token: 'other-secret' });
  assert.deepEqual(response.body.submissions.map((row) => row.name), ['their private strategy']);
  response = await app.request('GET', `/submissions/${otherId}`, { token: 'secret' });
  assert.equal(response.status, 404);
  response = await app.request('GET', `/submissions/${ownId}`, { token: 'secret' });
  assert.equal(response.status, 200);
  assert.equal(response.body.submission.name, 'my private strategy');
  assert.equal(response.body.submission.compile_log, 'compile ok');
  assert.deepEqual(response.body.submission.match_progress, { total: 2, completed: 1 });
  assert.equal(response.body.matches[0].opponent_user, 'other_player');
  assert.equal(response.body.matches[0].opponent_name, undefined);
  assert.equal(response.body.matches[0].result_for_submission, 'WIN');
  assert.equal(response.body.matches[0].replay_available, true);
  assert.equal(response.body.matches[0].replay_url, `/matches/${matchId}/replay`);
  assert.equal(matchReads, 1);
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

test('registration creates an active account immediately', async () => {
  const dependencies = fixture();
  const app = serve(dependencies);
  let response = await app.request('POST', '/register', {
    body: { real_name: '张三', student_no: '202012345678', qq_number: '123456789', password: 'password8' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.registered, true);
  assert.equal(response.body.status, 'ACTIVE');
  assert.equal(response.body.user.display_name, '张三');
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
  response = await app.request('DELETE', `/admin/users/${userId}`, { token: 'admin-secret' });
  assert.equal(response.status, 200);
  response = await app.request('PATCH', `/admin/users/${userId}`, {
    token: 'admin-secret', body: { active: true },
  });
  assert.equal(response.status, 200);

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

test('start-up restore copies only missing artifact backups into object storage', async () => {
  const stored = new Map([['submissions/present/runner', Buffer.from('already there')]]);
  const rows = [
    { submission_id: 'a', kind: 'SOURCE', object_key: 'submissions/a/source.zip', content_type: 'application/zip' },
    { submission_id: 'b', kind: 'COMPILED', object_key: 'submissions/present/runner', content_type: 'application/octet-stream' },
    { submission_id: 'c', kind: 'COMPILED', object_key: 'submissions/c/runner', content_type: 'application/octet-stream' },
  ];
  const payloads = { a: Buffer.from('zip'), b: Buffer.from('replacement'), c: Buffer.from('elf') };
  const warnings = [];
  const repo = {
    async listBackedUpArtifacts() { return rows; },
    async getArtifactPayload(_pool, id) {
      if (id === 'c') throw new Error('database unavailable');
      return payloads[id];
    },
  };
  const storage = {
    async objectExists(key) { return stored.has(key); },
    async uploadBuffer(key, body, contentType) { stored.set(key, { body, contentType }); },
  };
  const result = await restoreArtifactBackups({
    pool: {}, storage, repo, logger: { warn: (...args) => warnings.push(args) },
  });
  assert.deepEqual(result, { restored: 1, failed: 1 });
  assert.deepEqual(stored.get('submissions/a/source.zip'),
    { body: Buffer.from('zip'), contentType: 'application/zip' });
  assert.deepEqual(stored.get('submissions/present/runner'), Buffer.from('already there'));
  assert.equal(stored.has('submissions/c/runner'), false);
  assert.equal(warnings.length, 1);

  // Storage or repository implementations without backup support are ignored.
  assert.deepEqual(await restoreArtifactBackups({ pool: {}, storage: {}, repo: {} }),
    { restored: 0, failed: 0 });
});
