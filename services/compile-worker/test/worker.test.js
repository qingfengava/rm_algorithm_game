const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCompileWorker } = require('../index');

test('compile worker records a successful compiled artifact', async () => {
  const calls = [];
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() {},
      async uploadFile() { return 12; },
    },
    command: process.execPath,
    commandArgs: (_source, runner) => [
      '-e', 'require("node:fs").writeFileSync(process.argv[1], "runner")', runner,
    ],
    repo: {
      async setSubmissionStatus(_pool, _id, status, values) {
        calls.push({ status, values });
        return { id: 's1' };
      },
      async upsertArtifact() { calls.push({ artifact: true }); },
    },
  });
  const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
  assert.equal(result.status, 'queued');
  assert.equal(calls.filter((call) => call.status).map((call) => call.status).join(','), 'COMPILING,QUEUED');
});

test('a candidate with no opponents is promoted immediately', async () => {
  const calls = [];
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() {},
      async uploadFile() { return 12; },
    },
    command: process.execPath,
    commandArgs: (_source, runner) => [
      '-e', 'require("node:fs").writeFileSync(process.argv[1], "runner")', runner,
    ],
    repo: {
      async setSubmissionStatus(_pool, _id, status) {
        calls.push(status);
        return { id: 's1' };
      },
      async upsertArtifact() {},
      async promoteSubmissionIfNoOpponents(_pool, id) {
        calls.push(`promote:${id}`);
        return { submission: { id }, leaderboard: { entries: [] } };
      },
    },
  });

  const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
  assert.equal(result.status, 'finished');
  assert.deepEqual(calls, ['COMPILING', 'QUEUED', 'promote:s1']);
});

test('a source lost from storage and backup fails the candidate instead of being polled forever', async () => {
  const calls = [];
  const missing = new Error('The specified key does not exist.');
  missing.name = 'NoSuchKey';
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() { throw missing; },
    },
    command: process.execPath,
    repo: {
      async setSubmissionStatus(_pool, id, status) {
        calls.push(`status:${status}`);
        return { id, status };
      },
      async markArtifactLost(_pool, id, kind, reason) {
        calls.push({ id, kind, reason });
        return { submission: { id, status: 'COMPILE_FAILED' } };
      },
    },
  });

  const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, [
    'status:COMPILING',
    {
      id: 's1', kind: 'SOURCE',
      reason: 'SOURCE_ARTIFACT_MISSING: The specified key does not exist.',
    },
  ]);
});

test('missing source object is read from the database backup and written back to storage', async () => {
  const uploaded = [];
  const missing = new Error('The specified key does not exist.');
  missing.name = 'NoSuchKey';
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() { throw missing; },
      async uploadFile() { return 12; },
      async uploadBuffer(key, body, contentType) { uploaded.push({ key, body: body.toString(), contentType }); },
    },
    command: process.execPath,
    commandArgs: (source, runner) => [
      '-e', 'const fs=require("node:fs");' +
        'if (fs.readFileSync(process.argv[1], "utf8") !== "zip-backup") process.exit(1);' +
        'fs.writeFileSync(process.argv[2], "runner")', source, runner,
    ],
    repo: {
      async setSubmissionStatus() { return { id: 's1' }; },
      async upsertArtifact() {},
      async getArtifactPayload(_pool, id, kind) {
        assert.deepEqual([id, kind], ['s1', 'SOURCE']);
        return Buffer.from('zip-backup');
      },
    },
  });
  const result = await worker.processSubmission({ id: 's1', source_key: 'submissions/s1/source.zip' });
  assert.equal(result.status, 'queued');
  assert.deepEqual(uploaded, [{
    key: 'submissions/s1/source.zip', body: 'zip-backup', contentType: 'application/zip',
  }]);
});

test('a candidate that stays queued is left for the Scheduler when it has opponents', async () => {
  const calls = [];
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() {},
      async uploadFile() { return 12; },
    },
    command: process.execPath,
    commandArgs: (_source, runner) => [
      '-e', 'require("node:fs").writeFileSync(process.argv[1], "runner")', runner,
    ],
    repo: {
      async setSubmissionStatus(_pool, _id, status) { calls.push(status); return { id: 's1' }; },
      async upsertArtifact() {},
      async promoteSubmissionIfNoOpponents() { calls.push('promote'); return null; },
    },
  });
  const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
  assert.equal(result.status, 'queued');
  assert.deepEqual(calls, ['COMPILING', 'QUEUED', 'promote']);
});

test('a compiled runner above 32 MiB is rejected before it is stored', async () => {
  const calls = [];
  const worker = createCompileWorker({
    pool: {}, queue: {}, storage: {
      async downloadObjectToFile() {},
      async uploadFile() { throw new Error('must not upload an oversized runner'); },
    },
    command: process.execPath,
    commandArgs: (_source, runner) => [
      '-e', 'require("node:fs").writeFileSync(process.argv[1], Buffer.alloc(32 * 1024 * 1024 + 1))', runner,
    ],
    repo: {
      async setSubmissionStatus(_pool, _id, status, values) {
        calls.push({ status, reason: values?.failureReason });
        return { id: 's1' };
      },
    },
  });
  const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls.map((call) => call.status), ['COMPILING', 'COMPILE_FAILED']);
  assert.equal(calls[1].reason, 'COMPILED_ARTIFACT_TOO_LARGE');
});

test('a scratch directory that cannot be created fails the claimed submission instead of leaving it COMPILING', async () => {
  const os = require('node:os');
  const original = os.tmpdir;
  os.tmpdir = () => '/proc/arena-no-such-directory';
  const calls = [];
  try {
    const worker = createCompileWorker({
      pool: {}, queue: {}, storage: {}, command: process.execPath,
      repo: {
        async setSubmissionStatus(_pool, id, status, values) {
          calls.push({ id, status, reason: values?.failureReason });
          return { id };
        },
      },
      logger: { error() {}, warn() {} },
    });
    const result = await worker.processSubmission({ id: 's1', source_key: 'source.zip' });
    assert.equal(result.status, 'failed');
  } finally {
    os.tmpdir = original;
  }
  assert.deepEqual(calls.map((call) => call.status), ['COMPILING', 'COMPILE_FAILED']);
  assert.ok(calls[1].reason, 'the failure reason is recorded for the owner');
});
