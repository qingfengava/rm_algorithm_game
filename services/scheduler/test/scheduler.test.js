const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MATCH_QUEUE,
  createScheduler,
  mapSeedForPair,
} = require('../index');

test('pair seed is symmetric and remains a decimal uint64 string', () => {
  const first = mapSeedForPair('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(first, mapSeedForPair('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.match(first, /^\d+$/);
  assert.ok(BigInt(first) <= 18_446_744_073_709_551_615n);
});

test('reconcile enqueues each newly created match and is idempotent at the repository boundary', async () => {
  const pushed = [];
  let calls = 0;
  const queue = {
    async set() { return 'OK'; },
    async del() {},
    async rPush(key, value) { pushed.push({ key, value: JSON.parse(value) }); },
  };
  const repo = {
    async listCurrentAlgorithms() {
      return [{ id: 'a', status: 'QUEUED' }, { id: 'b', status: 'FINISHED' }];
    },
    async ensureMatchesForAlgorithms() {
      calls += 1;
      return calls === 1 ? [
        { id: 'm1', red_submission_id: 'a', blue_submission_id: 'b', map_seed: '7' },
        { id: 'm2', red_submission_id: 'b', blue_submission_id: 'a', map_seed: '7' },
      ] : [];
    },
    async refreshLeaderboard() {},
  };
  const scheduler = createScheduler({ pool: {}, queue, repo, logger: { error() {} } });
  repo.listQueuedMatches = async () => calls === 1 ? [
    { id: 'm1', red_submission_id: 'a', blue_submission_id: 'b', map_seed: '7' },
    { id: 'm2', red_submission_id: 'b', blue_submission_id: 'a', map_seed: '7' },
  ] : [];
  assert.deepEqual(await scheduler.reconcile(), { skipped: false, created: 2, enqueued: 2 });
  assert.deepEqual(await scheduler.reconcile(), { skipped: false, created: 0, enqueued: 0 });
  assert.equal(pushed.length, 2);
  assert.equal(pushed[0].key, MATCH_QUEUE);
  assert.equal(pushed[0].value.map_seed, '7');
});
