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
    const redId = crypto.randomUUID();
    const blueId = crypto.randomUUID();
    await db.createSubmission(scoped, {
      id: redId, userId: user.id, name: 'red', stagingKey: `uploads/${redId}/test.zip`,
    });
    await db.createSubmission(scoped, {
      id: blueId, userId: user.id, name: 'blue', stagingKey: `uploads/${blueId}/test.zip`,
    });
    assert.equal((await db.getSubmission(scoped, redId, user.id)).status, 'UPLOADED');
    assert.equal((await db.listReadySubmissions(scoped)).length, 0);
    for (const id of [redId, blueId]) {
      assert.deepEqual(await db.confirmSubmission(scoped, {
        id, userId: user.id,
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
    assert.equal((await db.listMatches(scoped, 10, 0)).length, 1);

    await db.saveLeaderboardSnapshot(scoped, [
      { submissionId: redId, wins: 1, draws: 0, losses: 0 },
      { submissionId: blueId, wins: 0, draws: 0, losses: 1 },
    ]);
    const board = await db.listLeaderboard(scoped, 10, 0);
    assert.equal(board.length, 2);
    assert.equal(board[0].rank, 1);
    assert.equal(Number(board[0].win_rate), 1);
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
