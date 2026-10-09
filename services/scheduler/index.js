const crypto = require('node:crypto');

const SUBMISSION_CHANNEL = 'arena:submissions:uploaded';
const MATCH_QUEUE = 'arena:matches:queue';

function mapSeedForPair(leftId, rightId) {
  const ids = [String(leftId), String(rightId)].sort();
  const digest = crypto.createHash('sha256').update(`${ids[0]}:${ids[1]}`).digest();
  return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`).toString();
}

function createScheduler({ pool, queue, repo, logger = console }) {
  let running = false;

  async function enqueue(matches) {
    let enqueued = 0;
    for (const match of matches) {
      const marker = `arena:match:queued:${match.id}`;
      // This is only a short delivery de-duplication window. If a worker
      // dies after BLPOP, expiry lets the durable QUEUED row be delivered
      // again on the next reconciliation pass.
      const acquired = await queue.set(marker, '1', { NX: true, EX: 15 });
      if (!acquired) continue;
      try {
        await queue.rPush(MATCH_QUEUE, JSON.stringify({
          match_id: match.id,
          red_submission_id: match.red_submission_id,
          blue_submission_id: match.blue_submission_id,
          map_seed: String(match.map_seed),
        }));
        enqueued += 1;
      } catch (error) {
        await queue.del(marker);
        throw error;
      }
    }
    return enqueued;
  }

  async function reconcile() {
    if (running) return { skipped: true, created: 0 };
    running = true;
    try {
      let created = [];
      // Ranked algorithms are FINISHED submissions. A QUEUED submission has
      // passed qualification but must not affect the board until every
      // two-sided match against the current board is terminal.
      const promote = async (submissionId) => {
        if (typeof repo.promoteSubmissionAndRefresh === 'function') {
          return repo.promoteSubmissionAndRefresh(pool, submissionId);
        }
        const promoted = typeof repo.promoteSubmissionToLeaderboard === 'function'
          ? await repo.promoteSubmissionToLeaderboard(pool, submissionId) : null;
        if (promoted && typeof repo.refreshLeaderboard === 'function') {
          await repo.refreshLeaderboard(pool);
        }
        return promoted;
      };
      if (typeof repo.listRankedAlgorithms === 'function' &&
          typeof repo.listPendingAlgorithms === 'function') {
        const ranked = await repo.listRankedAlgorithms(pool);
        const pending = await repo.listPendingAlgorithms(pool);

        if (ranked.length === 0) {
          // The first qualified algorithm is the seed of the leaderboard and
          // has no opponent to wait for. Promote one at a time so multiple
          // submissions cannot bypass the matching stage concurrently.
          if (pending.length > 0) await promote(pending[0].id);
        } else {
          for (const submission of pending) {
            if (typeof repo.ensureMatchesForSubmission !== 'function' ||
                typeof repo.listMatchesForSubmission !== 'function') break;
            const pairMatches = await repo.ensureMatchesForSubmission(
              pool, submission, ranked, mapSeedForPair,
            );
            created.push(...pairMatches);
            const matches = await repo.listMatchesForSubmission(pool, submission.id);
            const expected = ranked.length * 2;
            const rankedIds = new Set(ranked.map((algorithm) => String(algorithm.id)));
            const terminal = matches.filter((match) =>
              ['FINISHED', 'RUNTIME_FAILED'].includes(match.status) &&
              rankedIds.has(String(match.red_submission_id === submission.id
                ? match.blue_submission_id : match.red_submission_id)));
            if (expected > 0 && terminal.length >= expected) {
              await promote(submission.id);
              // The promoted candidate becomes part of the ranked set. Stop
              // this pass so the next pending candidate also plays against it.
              break;
            }
          }
        }
      } else {
        // Compatibility path for older repository test doubles. Production
        // uses the ranked/pending flow above.
        const algorithms = await repo.listCurrentAlgorithms(pool);
        created = await repo.ensureMatchesForAlgorithms(pool, algorithms, mapSeedForPair);
        if (algorithms.length < 2 && typeof repo.refreshLeaderboard === 'function') {
          await repo.refreshLeaderboard(pool);
        }
      }
      const queued = await repo.listQueuedMatches(pool, 1000);
      const enqueued = await enqueue(queued);
      return { skipped: false, created: created.length, enqueued };
    } finally {
      running = false;
    }
  }

  async function start(intervalMs = 5000) {
    const subscriber = queue.duplicate();
    subscriber.on('error', (error) => logger.error('Scheduler Redis subscriber error', error));
    await subscriber.connect();
    await subscriber.subscribe(SUBMISSION_CHANNEL, () => {
      reconcile().catch((error) => logger.error('Scheduler reconcile failed', error));
    });
    await reconcile();
    const timer = setInterval(() => {
      reconcile().catch((error) => logger.error('Scheduler reconcile failed', error));
    }, intervalMs);
    timer.unref();
    return { subscriber, timer };
  }

  return { enqueue, reconcile, start, mapSeedForPair };
}

async function startProcess(env = process.env) {
  const db = require('./api/db');
  const { createClient } = require('redis');
  const pool = db.createPool(env);
  const queue = createClient({
    url: env.REDIS_URL || `redis://${env.REDIS_HOST || 'redis'}:${env.REDIS_PORT || 6379}`,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  queue.on('error', (error) => console.error('Scheduler Redis error', error));
  await db.bootstrap(pool);
  await queue.connect();
  const scheduler = createScheduler({ pool, queue });
  const intervalMs = Number(env.SCHEDULER_INTERVAL_MS || 5000);
  const { subscriber, timer } = await scheduler.start(intervalMs);
  process.stdout.write('arena-scheduler started\n');

  async function shutdown() {
    clearInterval(timer);
    await Promise.allSettled([subscriber.quit(), queue.quit(), pool.end()]);
  }
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  return { scheduler, pool, queue, subscriber, shutdown };
}

if (require.main === module) {
  startProcess().catch((error) => {
    console.error('Scheduler startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = {
  MATCH_QUEUE,
  SUBMISSION_CHANNEL,
  mapSeedForPair,
  createScheduler,
  startProcess,
};
