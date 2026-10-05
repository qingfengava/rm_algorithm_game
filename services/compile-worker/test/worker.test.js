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
