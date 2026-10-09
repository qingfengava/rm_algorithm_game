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

test('first qualified algorithm is promoted directly when the ranked board is empty', async () => {
  const calls = [];
  const queue = {
    async set() { return 'OK'; },
    async del() {},
    async rPush() {},
  };
  const repo = {
    async listRankedAlgorithms() { return []; },
    async listPendingAlgorithms() { return [{ id: 'candidate', status: 'QUEUED' }]; },
    async promoteSubmissionToLeaderboard(_pool, id) { calls.push(['promote', id]); return { id }; },
    async refreshLeaderboard() { calls.push(['refresh']); },
    async listQueuedMatches() { return []; },
  };
  const scheduler = createScheduler({ pool: {}, queue, repo, logger: { error() {} } });
  assert.deepEqual(await scheduler.reconcile(), { skipped: false, created: 0, enqueued: 0 });
  assert.deepEqual(calls, [['promote', 'candidate'], ['refresh']]);
});

test('qualified algorithm is matched against each ranked algorithm in both colors', async () => {
  const pushed = [];
  const queue = {
    async set() { return 'OK'; },
    async del() {},
    async rPush(key, value) { pushed.push({ key, value: JSON.parse(value) }); },
  };
  const candidate = { id: 'candidate', status: 'QUEUED' };
  const ranked = [{ id: 'ranked', status: 'FINISHED' }];
  const matches = [
    { id: 'm-red', red_submission_id: 'candidate', blue_submission_id: 'ranked', map_seed: '9', status: 'QUEUED' },
    { id: 'm-blue', red_submission_id: 'ranked', blue_submission_id: 'candidate', map_seed: '9', status: 'QUEUED' },
  ];
  let promoted = false;
  let calls = 0;
  const repo = {
    async listRankedAlgorithms() { return ranked; },
    async listPendingAlgorithms() { return promoted ? [] : [candidate]; },
    async ensureMatchesForSubmission(_pool, pending, opponents, seed) {
      calls += 1;
      assert.equal(pending.id, 'candidate');
      assert.deepEqual(opponents, ranked);
      assert.equal(seed('candidate', 'ranked'), seed('ranked', 'candidate'));
      return calls === 1 ? matches : [];
    },
    async listMatchesForSubmission() { return matches; },
    async listQueuedMatches() { return matches; },
    async promoteSubmissionToLeaderboard() { promoted = true; return { id: 'candidate' }; },
    async refreshLeaderboard() {},
  };
  const scheduler = createScheduler({ pool: {}, queue, repo, logger: { error() {} } });
  const result = await scheduler.reconcile();
  assert.equal(result.created, 2);
  assert.equal(result.enqueued, 2);
  assert.equal(pushed[0].value.map_seed, pushed[1].value.map_seed);
  assert.equal(pushed[0].value.red_submission_id, 'candidate');
  assert.equal(pushed[1].value.red_submission_id, 'ranked');
});

test('candidate is promoted only after both matches are terminal', async () => {
  const queue = { async set() { return 'OK'; }, async del() {}, async rPush() {} };
  const candidate = { id: 'candidate' };
  const ranked = [{ id: 'ranked' }];
  let states = [
    { id: 'm1', red_submission_id: 'candidate', blue_submission_id: 'ranked', status: 'FINISHED' },
    { id: 'm2', red_submission_id: 'ranked', blue_submission_id: 'candidate', status: 'RUNNING' },
  ];
  const calls = [];
  const repo = {
    async listRankedAlgorithms() { return ranked; },
    async listPendingAlgorithms() { return [candidate]; },
    async ensureMatchesForSubmission() { return []; },
    async listMatchesForSubmission() { return states; },
    async listQueuedMatches() { return []; },
    async promoteSubmissionToLeaderboard() { calls.push('promote'); return { id: 'candidate' }; },
    async refreshLeaderboard() { calls.push('refresh'); },
  };
  const scheduler = createScheduler({ pool: {}, queue, repo, logger: { error() {} } });
  await scheduler.reconcile();
  assert.deepEqual(calls, []);
  states = states.map((match) => ({ ...match, status: 'FINISHED' }));
  await scheduler.reconcile();
  assert.deepEqual(calls, ['promote', 'refresh']);
});
