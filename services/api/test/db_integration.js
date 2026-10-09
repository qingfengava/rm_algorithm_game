const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');

async function main() {
  const pool = db.createPool();
  const schema = `arena_test_${crypto.randomBytes(6).toString('hex')}`;
  const client = await pool.connect();
  const scoped = {
    query: (...args) => client.query(...args),
    connect: async () => ({ query: (...args) => client.query(...args), release() {} }),
  };
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await db.bootstrap(scoped);
    const user = await db.provisionUser(scoped, `test_${schema.slice(-8)}`, 'test-secret');
    const opponent = await db.provisionUser(scoped, `opp_${schema.slice(-8)}`, 'opponent-secret');
    const supersededId = crypto.randomUUID();
    const redId = crypto.randomUUID();
    const blueId = crypto.randomUUID();
    await db.createSubmission(scoped, {
      id: supersededId, userId: user.id, name: 'superseded',
      stagingKey: `uploads/${supersededId}/test.zip`,
    });
    await db.createSubmission(scoped, {
      id: blueId, userId: opponent.id, name: 'blue', stagingKey: `uploads/${blueId}/test.zip`,
    });
    const supersededMatch = await db.createMatch(scoped, {
      redSubmissionId: supersededId, blueSubmissionId: blueId, mapSeed: '1',
    });
    await db.createSubmission(scoped, {
      id: redId, userId: user.id, name: 'red', stagingKey: `uploads/${redId}/test.zip`,
    });
    assert.equal(await db.getSubmission(scoped, supersededId, user.id), null);
    assert.equal((await db.listSubmissions(scoped, user.id)).map((row) => row.id).join(','), redId);
    const deleted = await client.query(
      'SELECT deleted_at, is_current FROM submissions WHERE id = $1', [supersededId],
    );
    assert.ok(deleted.rows[0].deleted_at);
    assert.equal(deleted.rows[0].is_current, false);
    assert.equal((await db.getMatch(scoped, supersededMatch.id)).status, 'RUNTIME_FAILED');
    assert.equal((await db.getSubmission(scoped, redId, user.id)).status, 'UPLOADED');
    assert.equal((await db.listReadySubmissions(scoped)).length, 0);
    for (const [id, owner] of [[redId, user], [blueId, opponent]]) {
      assert.deepEqual(await db.confirmSubmission(scoped, {
        id, userId: owner.id,
        confirmSource: async (stagingKey, finalKey) => {
          assert.equal(stagingKey, `uploads/${id}/test.zip`);
          assert.equal(finalKey, `submissions/${id}/source.zip`);
          return 263;
        },
      }), { confirmed: true, status: 'UPLOADED' });
    }
    assert.equal((await db.listReadySubmissions(scoped)).length, 2);
    await db.setSubmissionStatus(scoped, redId, 'COMPILING', { compileLog: 'compiling' });
    await db.setSubmissionStatus(scoped, redId, 'QUEUED', { compileLog: 'compile ok' });
    assert.equal((await db.getSubmission(scoped, redId, user.id)).compile_log, 'compile ok');

    const match = await db.createMatch(scoped, {
      redSubmissionId: redId, blueSubmissionId: blueId, mapSeed: '18446744073709551615',
    });
    assert.equal(match.status, 'QUEUED');
    await db.startMatch(scoped, match.id, { obstacles: [] }, { round: 1 });
    await db.appendMatchEvent(scoped, match.id, { seq: 1, type: 'MATCH_STARTED' });
    await db.finishMatch(scoped, match.id, { winner: 'RED' });
    assert.equal((await db.getMatch(scoped, match.id)).event_count, 1);
    const replay = await db.getReplay(scoped, match.id);
    assert.equal(replay.map_seed, '18446744073709551615');
    assert.deepEqual(replay.events, [{ seq: 1, type: 'MATCH_STARTED' }]);
    assert.equal((await db.listMatches(scoped, 10, 0)).length, 2);

    await client.query(
      `UPDATE submissions SET status = 'FINISHED', is_current = true
        WHERE id IN ($1, $2)`, [redId, blueId],
    );
    await db.saveLeaderboardSnapshot(scoped, [
      { submissionId: redId, wins: 1, draws: 0, losses: 0 },
      { submissionId: blueId, wins: 0, draws: 0, losses: 1 },
    ]);
    const board = await db.listLeaderboard(scoped, 10, 0);
    assert.equal(board.length, 2);
    assert.equal(board[0].rank, 1);
    assert.equal(Number(board[0].win_rate), 1);

    const live = async (userId) => (await client.query(
      `SELECT id, status, is_current FROM submissions
        WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [userId],
    )).rows;
    const ranking = async () => (await db.listLeaderboard(scoped, 20, 0)).map((row) => ({
      id: row.submission_id, rank: row.rank, record: `${row.wins}/${row.draws}/${row.losses}`,
    }));
    const playable = async () => (await db.listRankedAlgorithms(scoped)).map((row) => row.id);
    const withRunner = (submissionId, text) => db.upsertArtifact(scoped, {
      submissionId, kind: 'COMPILED', objectKey: `submissions/${submissionId}/runner`,
      contentType: 'application/octet-stream', byteSize: text.length, payload: Buffer.from(text),
    });

    // --- Lost artifacts never remove a published algorithm. -------------
    // Without a database backup the artifact is marked unavailable: the entry
    // keeps its rank, but nobody is scheduled against it.
    await db.upsertArtifact(scoped, {
      submissionId: redId, kind: 'COMPILED', objectKey: `submissions/${redId}/runner`,
      contentType: 'application/octet-stream', byteSize: 17,
    });
    assert.deepEqual(await playable(), [redId], 'runner is available while uploaded_at is set');
    const lost = await db.markArtifactLost(scoped, redId, 'COMPILED', 'COMPILED_ARTIFACT_MISSING: gone');
    assert.equal(lost.preserved, true);
    assert.deepEqual(
      (await client.query('SELECT status, is_current FROM submissions WHERE id = $1', [redId])).rows[0],
      { status: 'FINISHED', is_current: true },
    );
    assert.deepEqual(await playable(), [], 'a lost runner is skipped as an opponent');
    assert.ok((await ranking()).some((row) => row.id === redId), 'but it stays on the leaderboard');
    assert.match((await db.getSubmission(scoped, redId, user.id)).failure_reason, /^ARTIFACT_LOST/);

    // With a database backup nothing is lost and nothing changes.
    await withRunner(redId, 'red-runner');
    await withRunner(blueId, 'blue-runner');
    const backed = await db.markArtifactLost(scoped, redId, 'COMPILED', 'object missing');
    assert.equal(backed.recoverable, true);
    assert.deepEqual((await playable()).sort(), [redId, blueId].sort());
    await db.refreshLeaderboard(scoped);
    assert.deepEqual(await ranking(), [
      { id: redId, rank: 1, record: '1/0/0' },
      { id: blueId, rank: 2, record: '0/0/1' },
    ]);

    // --- A new upload does not touch the ranked version. -----------------
    const firstCandidateId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    await db.createSubmission(scoped, {
      id: firstCandidateId, userId: user.id, name: 'candidate 1',
      stagingKey: `uploads/${firstCandidateId}/test.zip`,
    });
    assert.deepEqual((await live(user.id)).map((row) => [row.id, row.is_current]),
      [[redId, true], [firstCandidateId, false]]);
    await db.createSubmission(scoped, {
      id: newId, userId: user.id, name: 'candidate 2', stagingKey: `uploads/${newId}/test.zip`,
    });
    assert.deepEqual((await live(user.id)).map((row) => [row.id, row.is_current]),
      [[redId, true], [newId, false]], 'only the previous candidate is superseded');
    assert.equal(await db.getSubmission(scoped, firstCandidateId, user.id), null);
    assert.deepEqual((await ranking()).map((row) => row.id), [redId, blueId]);

    // Restarting a service re-runs the schema script. It must not retire the
    // ranked version just because its owner also has a candidate.
    await db.bootstrap(scoped);
    assert.equal((await live(user.id)).length, 2);

    await db.confirmSubmission(scoped, {
      id: newId, userId: user.id, confirmSource: async () => 263,
    });
    await db.setSubmissionStatus(scoped, newId, 'COMPILING');
    await withRunner(newId, 'new-runner');
    await db.setSubmissionStatus(scoped, newId, 'QUEUED', { compileLog: 'compile ok' });

    // The candidate must play the other player first; its own previous version
    // is never an opponent.
    assert.equal(await db.promoteSubmissionIfNoOpponents(scoped, newId), null);
    const opponents = (await db.listRankedAlgorithms(scoped)).filter((row) => row.user_id !== user.id);
    assert.deepEqual(opponents.map((row) => row.id), [blueId]);
    const pairMatches = await db.ensureMatchesForSubmission(
      scoped, { id: newId }, opponents, () => '42',
    );
    assert.equal(pairMatches.length, 2);
    assert.equal((await db.ensureMatchesForSubmission(
      scoped, { id: newId }, opponents, () => '42',
    )).length, 0, 'scheduling is idempotent');
    for (const pair of pairMatches) {
      assert.ok(await db.claimMatch(scoped, pair.id));
      await db.finishMatch(scoped, pair.id, {
        winner: pair.red_submission_id === newId ? 'RED' : 'BLUE',
      });
    }
    assert.deepEqual(await ranking(), [
      { id: redId, rank: 1, record: '1/0/0' },
      { id: blueId, rank: 2, record: '0/0/1' },
    ], 'the board is unchanged until the candidate is promoted');

    // Promotion replaces the old version: its results leave the board and the
    // other player's record is rebuilt from the matches against the new one.
    const promotion = await db.promoteSubmissionAndRefresh(scoped, newId);
    assert.deepEqual(promotion.replaced, [redId]);
    assert.deepEqual(await ranking(), [
      { id: newId, rank: 1, record: '2/0/0' },
      { id: blueId, rank: 2, record: '0/0/2' },
    ]);
    assert.deepEqual(await live(user.id), [{ id: newId, status: 'FINISHED', is_current: true }]);
    assert.equal((await db.getMatch(scoped, match.id)).winner, 'RED', 'old match history is kept');
    assert.deepEqual((await db.listSubmissions(scoped, user.id)).map((row) => row.id), [newId]);

    // --- Database guards. -----------------------------------------------
    await assert.rejects(
      client.query(
        `INSERT INTO submissions (id, user_id, name, status, is_current)
         VALUES ($1, $2, 'duplicate', 'FINISHED', true)`, [crypto.randomUUID(), user.id],
      ),
      (error) => error.code === '23505',
    );

    // --- A candidate with nobody to play is promoted at once. ------------
    await client.query(
      `UPDATE submission_artifacts SET payload = NULL, uploaded_at = NULL WHERE kind = 'COMPILED'`,
    );
    assert.deepEqual(await playable(), []);
    const loneId = crypto.randomUUID();
    await db.createSubmission(scoped, {
      id: loneId, userId: user.id, name: 'lone', stagingKey: `uploads/${loneId}/test.zip`,
    });
    await db.confirmSubmission(scoped, { id: loneId, userId: user.id, confirmSource: async () => 263 });
    await db.setSubmissionStatus(scoped, loneId, 'COMPILING');
    await withRunner(loneId, 'lone-runner');
    await db.setSubmissionStatus(scoped, loneId, 'QUEUED');
    // Not promoted before it exists as an opponent-less candidate? It is: no
    // other user has a playable algorithm.
    const lone = await db.promoteSubmissionIfNoOpponents(scoped, loneId);
    assert.deepEqual(lone.replaced, [newId]);
    assert.deepEqual((await ranking()).map((row) => row.id).sort(), [blueId, loneId].sort(),
      'the unplayable opponent keeps its place on the board');

    // --- Platform faults are retried, then become terminal. -------------
    await withRunner(loneId, 'lone-runner');
    await withRunner(blueId, 'blue-runner');
    const retried = await db.createMatch(scoped, {
      redSubmissionId: loneId, blueSubmissionId: blueId, mapSeed: '7',
    });
    assert.ok(await db.claimMatch(scoped, retried.id));
    await db.startMatchReplay(scoped, retried.id, { map: {}, initial_state: {} });
    await db.appendMatchEvent(scoped, retried.id, { seq: 0, type: 'MATCH_STARTED' });
    let outcome = await db.requeueMatch(scoped, retried.id, 'ECONNREFUSED', { maxAttempts: 3 });
    assert.deepEqual(outcome, { requeued: true, attempts: 1 });
    let retriedRow = await db.getMatch(scoped, retried.id);
    assert.equal(retriedRow.status, 'QUEUED');
    assert.equal(retriedRow.event_count, 0, 'partial replay is discarded');
    assert.equal(retriedRow.started_at, null);
    assert.ok(await db.claimMatch(scoped, retried.id));
    assert.deepEqual(await db.requeueMatch(scoped, retried.id, 'ECONNREFUSED', { maxAttempts: 3 }),
      { requeued: true, attempts: 2 });
    assert.ok(await db.claimMatch(scoped, retried.id));
    assert.deepEqual(await db.requeueMatch(scoped, retried.id, 'ECONNREFUSED', { maxAttempts: 3 }),
      { requeued: false, attempts: 3 });
    await db.finishMatch(scoped, retried.id, { failureReason: 'PLATFORM_RETRIES_EXHAUSTED: ECONNREFUSED' });
    retriedRow = await db.getMatch(scoped, retried.id);
    assert.equal(retriedRow.status, 'RUNTIME_FAILED');
    assert.equal(await db.requeueMatch(scoped, retried.id, 'late'), null, 'finished matches are not requeued');

    // --- Legacy data: extra live rows are reduced to one per slot. -------
    await client.query('DROP INDEX submissions_one_ranked_per_user_idx');
    const legacyId = crypto.randomUUID();
    await client.query(
      `INSERT INTO submissions (id, user_id, name, status, is_current, created_at)
       VALUES ($1, $2, 'legacy', 'FINISHED', true, now() - interval '1 day')`, [legacyId, user.id],
    );
    await db.bootstrap(scoped);
    assert.deepEqual((await live(user.id)).map((row) => row.id), [loneId],
      'migration keeps the newest ranked row and retires the older one');
    process.stdout.write('database integration passed\n');
  } finally {
    await client.query('RESET search_path');
    client.release();
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
