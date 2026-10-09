const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMatchWorker } = require('../index');

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

test('invalid queue messages do not reach the repository', async () => {
  const worker = createMatchWorker({
    pool: {},
    queue: { async blPop() { return { element: '{"match_id":"bad"}' }; } },
    storage: {},
    repo: { async claimMatch() { throw new Error('must not claim'); } },
  });
  assert.deepEqual(await worker.runOnce(), { status: 'invalid_queue_message' });
});
