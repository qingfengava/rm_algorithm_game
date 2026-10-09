const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MATCH_QUEUE,
  createScheduler,
  mapSeedForPair,
} = require('../index');

function fakeQueue(pushed = []) {
  return {
    async set() { return 'OK'; },
    async del() {},
    async rPush(key, value) { pushed.push({ key, value: JSON.parse(value) }); },
  };
}

function fakeRepo(overrides = {}) {
  const calls = [];
  const repo = {
    calls,
    async listRankedAlgorithms() { return []; },
    async listPendingAlgorithms() { return []; },
    async ensureMatchesForSubmission() { return []; },
    async listMatchesForSubmission() { return []; },
    async listQueuedMatches() { return []; },
    async promoteSubmissionAndRefresh(_pool, id) { calls.push(['promote', id]); return { submission: { id } }; },
    async promoteSubmissionIfNoOpponents(_pool, id) { calls.push(['promote-no-opponents', id]); return { submission: { id } }; },
    ...overrides,
  };
  return repo;
}

const logger = { error() {} };

test('pair seed is symmetric and remains a decimal uint64 string', () => {
  const first = mapSeedForPair('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  assert.equal(first, mapSeedForPair('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
  assert.match(first, /^\d+$/);
  assert.ok(BigInt(first) <= 18_446_744_073_709_551_615n);
});

test('a qualified candidate gets red/blue matches against other players and they are enqueued', async () => {
  const pushed = [];
  const candidate = { id: 'candidate', user_id: 'u1' };
  const ranked = [{ id: 'ranked', user_id: 'u2' }];
  const matches = [
    { id: 'm-red', red_submission_id: 'candidate', blue_submission_id: 'ranked', map_seed: '9', status: 'QUEUED' },
    { id: 'm-blue', red_submission_id: 'ranked', blue_submission_id: 'candidate', map_seed: '9', status: 'QUEUED' },
  ];
  let ensureCalls = 0;
  const repo = fakeRepo({
    async listRankedAlgorithms() { return ranked; },
    async listPendingAlgorithms() { return [candidate]; },
    async ensureMatchesForSubmission(_pool, pending, opponents, seed) {
      ensureCalls += 1;
      assert.equal(pending.id, 'candidate');
      assert.deepEqual(opponents, ranked);
      assert.equal(seed('candidate', 'ranked'), seed('ranked', 'candidate'));
      return ensureCalls === 1 ? matches : [];
    },
    async listMatchesForSubmission() { return matches; },
    async listQueuedMatches() { return matches; },
  });
  const scheduler = createScheduler({ pool: {}, queue: fakeQueue(pushed), repo, logger });
  const result = await scheduler.reconcile();
  assert.deepEqual(result, { skipped: false, created: 2, enqueued: 2 });
  assert.equal(pushed[0].key, MATCH_QUEUE);
  assert.equal(pushed[0].value.map_seed, pushed[1].value.map_seed);
  assert.equal(pushed[0].value.red_submission_id, 'candidate');
  assert.equal(pushed[1].value.red_submission_id, 'ranked');
  assert.deepEqual(repo.calls, [], 'must not promote while matches are still queued');
});

test('a candidate is promoted only after every match is terminal, and a runtime failure counts as terminal', async () => {
  const candidate = { id: 'candidate', user_id: 'u1' };
  const ranked = [{ id: 'ranked', user_id: 'u2' }];
  let states = [
    { id: 'm1', red_submission_id: 'candidate', blue_submission_id: 'ranked', status: 'FINISHED' },
    { id: 'm2', red_submission_id: 'ranked', blue_submission_id: 'candidate', status: 'RUNNING' },
  ];
  const repo = fakeRepo({
    async listRankedAlgorithms() { return ranked; },
    async listPendingAlgorithms() { return [candidate]; },
    async listMatchesForSubmission() { return states; },
  });
  const scheduler = createScheduler({ pool: {}, queue: fakeQueue(), repo, logger });
  await scheduler.reconcile();
  assert.deepEqual(repo.calls, []);
  states = states.map((match) => ({ ...match, status: match.id === 'm2' ? 'RUNTIME_FAILED' : 'FINISHED' }));
  await scheduler.reconcile();
  assert.deepEqual(repo.calls, [['promote', 'candidate']]);
});

test('the owner\'s previous ranked version is not an opponent: nothing to play means immediate promotion', async () => {
  let ensured = false;
  const repo = fakeRepo({
    async listRankedAlgorithms() { return [{ id: 'old-version', user_id: 'u1' }]; },
    async listPendingAlgorithms() { return [{ id: 'new-version', user_id: 'u1' }]; },
    async ensureMatchesForSubmission() { ensured = true; return []; },
  });
  const scheduler = createScheduler({ pool: {}, queue: fakeQueue(), repo, logger });
  await scheduler.reconcile();
  assert.equal(ensured, false, 'a player must never be scheduled against their own previous version');
  assert.deepEqual(repo.calls, [['promote-no-opponents', 'new-version']]);
});

test('only other players\' ranked algorithms are opponents when the owner already has one', async () => {
  const seen = [];
  const repo = fakeRepo({
    async listRankedAlgorithms() {
      return [{ id: 'mine', user_id: 'u1' }, { id: 'theirs', user_id: 'u2' }];
    },
    async listPendingAlgorithms() { return [{ id: 'candidate', user_id: 'u1' }]; },
    async ensureMatchesForSubmission(_pool, _pending, opponents) {
      seen.push(...opponents.map((algorithm) => algorithm.id));
      return [];
    },
  });
  const scheduler = createScheduler({ pool: {}, queue: fakeQueue(), repo, logger });
  await scheduler.reconcile();
  assert.deepEqual(seen, ['theirs']);
  assert.deepEqual(repo.calls, []);
});

test('an empty board promotes the first candidate and stops so the next one plays it', async () => {
  const repo = fakeRepo({
    async listPendingAlgorithms() {
      return [{ id: 'first', user_id: 'u1' }, { id: 'second', user_id: 'u2' }];
    },
  });
  const scheduler = createScheduler({ pool: {}, queue: fakeQueue(), repo, logger });
  await scheduler.reconcile();
  assert.deepEqual(repo.calls, [['promote-no-opponents', 'first']]);
});

test('queued matches are delivered once while the delivery marker exists', async () => {
  const pushed = [];
  const markers = new Set();
  const queue = {
    async set(key, _value, options) {
      if (options?.NX && markers.has(key)) return null;
      markers.add(key);
      return 'OK';
    },
    async del(key) { markers.delete(key); },
    async rPush(key, value) { pushed.push({ key, value: JSON.parse(value) }); },
  };
  const repo = fakeRepo({
    async listQueuedMatches() {
      return [{ id: 'm1', red_submission_id: 'a', blue_submission_id: 'b', map_seed: '7' }];
    },
  });
  const scheduler = createScheduler({ pool: {}, queue, repo, logger });
  assert.equal((await scheduler.reconcile()).enqueued, 1);
  assert.equal((await scheduler.reconcile()).enqueued, 0);
  assert.equal(pushed.length, 1);
});
