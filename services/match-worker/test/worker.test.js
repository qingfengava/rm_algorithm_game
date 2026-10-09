const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMatchWorker, downloadRunnerWithBackup } = require('../index');

test('match command parses a structured result', {
  skip: process.env.ARENA_RUN_CHILD_TESTS !== '1',
}, async () => {
  const worker = createMatchWorker({
    pool: {},
    queue: {},
    storage: {},
    repo: {},
    command: '/bin/echo',
  });
  const result = await worker.runCommand([
    '{"ok":true,"winner":"DRAW"}',
  ], 1000);
  assert.deepEqual(result, { ok: true, result: { ok: true, winner: 'DRAW' } });
});

test('match command preserves ordered replay stream messages', async () => {
  const worker = createMatchWorker({
    pool: {}, queue: {}, storage: {}, repo: {}, command: '/bin/sh',
  });
  const messages = [];
  const result = await worker.runCommand([
    '-c', 'printf "%s\\n%s\\n" "{\\"kind\\":\\"event\\",\\"event\\":{\\"seq\\":1}}" "{\\"kind\\":\\"result\\",\\"winner\\":\\"DRAW\\"}"',
  ], 1000, async (message) => messages.push(message));
  assert.equal(result.ok, true);
  assert.deepEqual(messages.map((message) => message.kind), ['event', 'result']);
});

test('runner stream errors are reported as runtime failures, not replay write failures', async () => {
  const worker = createMatchWorker({
    pool: {},
    queue: {},
    storage: {},
    repo: {},
    command: '/bin/sh',
  });
  const result = await worker.runCommand([
    '-c', 'printf "%s\\n" "{\\"kind\\":\\"error\\",\\"error\\":\\"runner is not executable\\"}"',
  ], 1000, async (message) => {
    if (message.kind === 'error') throw new Error(message.error);
  });
  assert.equal(result.ok, false);
  assert.equal(result.failureReason, 'RUNNER_ERROR');
  assert.match(result.error, /runner is not executable/);
});

function missingObjectError() {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  return error;
}

function artifactsFor(...ids) {
  return ids.map((id) => ({ submission_id: id, object_key: `submissions/${id}/runner` }));
}

test('a runner lost from storage and backup fails the match and marks only that artifact lost', async () => {
  const calls = [];
  const worker = createMatchWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() { throw missingObjectError(); },
    },
    repo: {
      async claimMatch() {
        return { id: 'm1', red_submission_id: 's1', blue_submission_id: 's2', map_seed: '1' };
      },
      async getCompiledArtifacts() { return artifactsFor('s1', 's2'); },
      async getArtifactPayload() { return null; },
      async finishMatch(_pool, id, values) { calls.push({ finish: id, values }); },
      async requeueMatch() { calls.push('requeue'); return { requeued: true }; },
      async markArtifactLost(_pool, id, kind, reason) { calls.push({ lost: id, kind, reason }); },
    },
  });
  const result = await worker.processMatch('m1');
  assert.deepEqual(result, { status: 'failed', reason: 'COMPILED_ARTIFACT_MISSING' });
  assert.equal(calls.includes('requeue'), false, 'a lost runner cannot be fixed by retrying');
  assert.deepEqual(calls[0], {
    lost: 's1', kind: 'COMPILED',
    reason: 'COMPILED_ARTIFACT_MISSING: compiled runner object is missing: submissions/s1/runner',
  });
  assert.equal(calls[1].finish, 'm1');
  assert.match(calls[1].values.failureReason, /^COMPILED_ARTIFACT_MISSING: compiled runner object is missing/);
});

test('a storage outage is a platform fault: the match is requeued, not recorded as a result', async () => {
  const calls = [];
  const deleted = [];
  const worker = createMatchWorker({
    pool: {}, queue: { async del(key) { deleted.push(key); } }, storage: {
      async downloadObjectToFile() { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
    },
    repo: {
      async claimMatch() {
        return { id: 'm1', red_submission_id: 's1', blue_submission_id: 's2', map_seed: '1' };
      },
      async getCompiledArtifacts() { return artifactsFor('s1', 's2'); },
      async finishMatch() { calls.push('finish'); },
      async requeueMatch(_pool, id, reason, options) {
        calls.push({ requeue: id, reason, maxAttempts: options.maxAttempts });
        return { requeued: true, attempts: 1 };
      },
      async markArtifactLost() { calls.push('lost'); },
    },
  });
  const result = await worker.processMatch('m1');
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].requeue, 'm1');
  assert.match(calls[0].reason, /^ECONNREFUSED: connect ECONNREFUSED/);
  assert.deepEqual(deleted, ['arena:matches:events:m1']);
});

test('repeated platform faults end in a terminal PLATFORM_RETRIES_EXHAUSTED failure', async () => {
  const finished = [];
  const worker = createMatchWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() { throw new Error('storage unavailable'); },
    },
    repo: {
      async claimMatch() {
        return { id: 'm1', red_submission_id: 's1', blue_submission_id: 's2', map_seed: '1' };
      },
      async getCompiledArtifacts() { return artifactsFor('s1', 's2'); },
      async requeueMatch() { return { requeued: false, attempts: 5 }; },
      async finishMatch(_pool, id, values) { finished.push({ id, values }); },
    },
  });
  await worker.processMatch('m1');
  assert.equal(finished.length, 1);
  assert.match(finished[0].values.failureReason, /^PLATFORM_RETRIES_EXHAUSTED: WORKER_ERROR: storage unavailable/);
});

test('an unavailable runner row fails the match without touching any submission', async () => {
  const calls = [];
  const worker = createMatchWorker({
    pool: {}, queue: {}, storage: {},
    repo: {
      async claimMatch() {
        return { id: 'm1', red_submission_id: 's1', blue_submission_id: 's2', map_seed: '1' };
      },
      async getCompiledArtifacts() { return artifactsFor('s1'); },
      async finishMatch(_pool, id, values) { calls.push({ id, values }); },
      async requeueMatch() { calls.push('requeue'); return { requeued: true }; },
      async markArtifactLost() { calls.push('lost'); },
    },
  });
  const result = await worker.processMatch('m1');
  assert.deepEqual(result, { status: 'failed', reason: 'COMPILED_ARTIFACT_MISSING' });
  assert.deepEqual(calls.map((call) => call.id || call), ['m1']);
  assert.equal(calls[0].values.failureReason, 'COMPILED_ARTIFACT_MISSING: s2');
});

test('invalid queue messages do not reach the repository', async () => {
  const worker = createMatchWorker({
    pool: {},
    queue: { async blPop() { return { element: '{"match_id":"bad"}' }; } },
    storage: {},
    repo: { async claimMatch() { throw new Error('must not claim'); } },
  });
  assert.deepEqual(await worker.runOnce(), { status: 'invalid_queue_message' });
});

test('missing runner object is read from the database backup and written back to storage', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-runner-test-'));
  try {
    const uploaded = [];
    const missing = new Error('The specified key does not exist.');
    missing.name = 'NoSuchKey';
    const storage = {
      async downloadObjectToFile() { throw missing; },
      async uploadBuffer(key, body, contentType) { uploaded.push({ key, body: body.toString(), contentType }); },
    };
    const repo = {
      async getArtifactPayload(_pool, id, kind) {
        assert.deepEqual([id, kind], ['s1', 'COMPILED']);
        return Buffer.from('runner-backup');
      },
    };
    const destination = path.join(directory, 'runner');
    const size = await downloadRunnerWithBackup(storage, repo, {}, {
      submission_id: 's1', object_key: 'submissions/s1/runner',
    }, destination);
    assert.equal(size, 'runner-backup'.length);
    assert.equal(await fs.readFile(destination, 'utf8'), 'runner-backup');
    assert.deepEqual(uploaded, [{
      key: 'submissions/s1/runner', body: 'runner-backup', contentType: 'application/octet-stream',
    }]);

    // Without a backup the original missing-object error is preserved.
    repo.getArtifactPayload = async () => null;
    await assert.rejects(
      downloadRunnerWithBackup(storage, repo, {}, {
        submission_id: 's2', object_key: 'submissions/s2/runner',
      }, destination),
      (error) => error.name === 'NoSuchKey',
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
