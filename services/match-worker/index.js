const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MATCH_QUEUE = 'arena:matches:queue';

function createMatchWorker({ pool, queue, storage, repo, command, logger = console }) {
  const matchCommand = command || process.env.ARENA_MATCH_BINARY || '/app/arena_match_demo';

  async function runCommand(args, timeoutMs = 15_000, onMessage = null) {
    return new Promise((resolve) => {
      const child = spawn(matchCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let bytes = 0;
      let processing = Promise.resolve();
      let processingError = null;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 32 * 1024 * 1024) { child.kill('SIGKILL'); return; }
        stdout += chunk.toString('utf8');
        if (onMessage) {
          const lines = stdout.split(/\r?\n/);
          stdout = lines.pop();
          if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); return; }
          child.stdout.pause();
          processing = processing.then(async () => {
            for (const line of lines) if (line) await onMessage(JSON.parse(line));
          }).catch((error) => {
            processingError = error;
            child.kill('SIGKILL');
          }).finally(() => child.stdout.resume());
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8').slice(0, 64 * 1024);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, failureReason: 'WORKER_EXEC_ERROR', error: error.message, stderr });
      });
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        await processing;
        if (processingError) {
          resolve({ ok: false, failureReason: 'REPLAY_WRITE_ERROR', error: processingError.message, stderr });
          return;
        }
        if (onMessage) {
          if (stdout.trim()) {
            try { await onMessage(JSON.parse(stdout.trim())); }
            catch (error) {
              resolve({ ok: false, failureReason: 'INVALID_MATCH_STREAM', error: error.message, stderr });
              return;
            }
          }
          resolve({ ok: !timedOut && code === 0, failureReason: timedOut ? 'TIMEOUT' : 'RUNNER_ERROR', stderr });
          return;
        }
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let result = null;
        if (lines.length > 0) {
          try {
            result = JSON.parse(lines[lines.length - 1]);
          } catch {
            result = null;
          }
        }
        if (timedOut || signal === 'SIGKILL') {
          resolve({ ok: false, failureReason: 'TIMEOUT', stderr });
        } else if (!result || result.ok !== true || code !== 0) {
          resolve({
            ok: false,
            failureReason: result?.failure_reason || (code === 127 ? 'RUNNER_MISSING' : 'RUNNER_ERROR'),
            error: result?.error || `exit=${code || 0} signal=${signal || 'none'}`,
            stderr,
            result,
          });
        } else {
          resolve({ ok: true, result });
        }
      });
    });
  }

  async function markFailed(matchId, reason) {
    await repo.finishMatch(pool, matchId, {
      failureReason: String(reason || 'RUNTIME_FAILED').slice(0, 2048),
    });
  }

  async function processMatch(matchId) {
    const claimed = await repo.claimMatch(pool, matchId);
    if (!claimed) return { status: 'already_claimed' };
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-match-'));
    try {
      const artifacts = await repo.getCompiledArtifacts(pool, [
        claimed.red_submission_id,
        claimed.blue_submission_id,
      ]);
      const bySubmission = new Map(artifacts.map((row) => [row.submission_id, row]));
      const redArtifact = bySubmission.get(claimed.red_submission_id);
      const blueArtifact = bySubmission.get(claimed.blue_submission_id);
      if (!redArtifact || !blueArtifact) {
        await markFailed(matchId, 'COMPILED_ARTIFACT_MISSING');
        return { status: 'failed', reason: 'COMPILED_ARTIFACT_MISSING' };
      }

      const redPath = path.join(temporary, 'red_runner');
      const bluePath = path.join(temporary, 'blue_runner');
      await storage.downloadObjectToFile(redArtifact.object_key, redPath);
      await storage.downloadObjectToFile(blueArtifact.object_key, bluePath);
      await fs.chmod(redPath, 0o755);
      await fs.chmod(bluePath, 0o755);

      const replay = { match_id: matchId, map_seed: String(claimed.map_seed), events: [] };
      let finished = false;
      const streamKey = `arena:matches:events:${matchId}`;
      const result = await runCommand([
        '--json-stream', '--seed', String(claimed.map_seed), redPath, bluePath,
      ], Number(process.env.MATCH_TIMEOUT_MS || 15_000), async (message) => {
        if (message.kind === 'start') {
          if (replay.map || message.map_seed !== replay.map_seed || !message.map || !message.initial_state) {
            throw new Error('invalid_match_start');
          }
          replay.map = message.map;
          replay.initial_state = message.initial_state;
          await repo.startMatchReplay(pool, matchId, replay);
        } else if (message.kind === 'event') {
          const event = message.event;
          if (!replay.map || finished || !event || event.seq !== replay.events.length ||
              !/^fnv1a64:[0-9a-f]{16}$/.test(event.state_hash)) throw new Error('invalid_match_event');
          if (event.seq === 0 && (event.type !== 'MATCH_STARTED' ||
              JSON.stringify(event.state_after) !== JSON.stringify(replay.initial_state))) {
            throw new Error('invalid_initial_event');
          }
          await repo.appendMatchEvent(pool, matchId, event);
          replay.events.push(event);
          try {
            await queue.xAdd(streamKey, '*', { event: JSON.stringify(event) });
            await queue.expire(streamKey, 86400);
          } catch (error) { logger.warn('Replay stream publish failed', { matchId, error }); }
        } else if (message.kind === 'result') {
          if (finished || !['RED', 'BLUE', 'DRAW'].includes(message.winner)) throw new Error('invalid_match_result');
          replay.winner = message.winner;
          replay.result = message.result;
          finished = true;
        } else if (message.kind === 'error') {
          throw new Error(message.error || message.failure_reason || 'runner_error');
        } else throw new Error('invalid_match_message');
      });
      if (!result.ok) {
        await markFailed(matchId, result.failureReason);
        logger.error('Match failed', { matchId, reason: result.failureReason, error: result.error });
        return { status: 'failed', reason: result.failureReason };
      }
      if (!finished || replay.events.at(-1)?.type !== 'MATCH_ENDED' ||
          replay.events.at(-1)?.winner !== replay.winner) {
        await markFailed(matchId, 'INVALID_MATCH_RESULT');
        return { status: 'failed', reason: 'INVALID_MATCH_RESULT' };
      }
      const replayPath = path.join(temporary, 'replay.json');
      await fs.writeFile(replayPath, JSON.stringify(replay));
      replay.replay_object_key = `matches/${matchId}/replay.json`;
      await storage.uploadFile(replay.replay_object_key, replayPath, 'application/json');
      await repo.completeStreamedMatch(pool, matchId, replay);
      return { status: 'finished', winner: replay.winner };
    } catch (error) {
      await markFailed(matchId, error.code || error.message || 'WORKER_ERROR');
      logger.error('Match worker error', { matchId, error });
      return { status: 'failed', reason: error.message };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  async function runOnce() {
    const item = await queue.blPop(MATCH_QUEUE, 1);
    if (!item) return { status: 'idle' };
    let payload;
    try {
      payload = JSON.parse(item.element || item[1]);
    } catch {
      return { status: 'invalid_queue_message' };
    }
    if (!payload.match_id || !/^[0-9a-f-]{36}$/i.test(payload.match_id)) {
      return { status: 'invalid_queue_message' };
    }
    return processMatch(payload.match_id);
  }

  async function start() {
    let stopping = false;
    while (!stopping) {
      await runOnce();
    }
  }

  return { runCommand, processMatch, runOnce, start };
}

async function startProcess(env = process.env) {
  const db = require('./api/db');
  const { createStorage } = require('./api/storage');
  const { createClient } = require('redis');
  const pool = db.createPool(env);
  const storage = createStorage(env);
  const queue = createClient({
    url: env.REDIS_URL || `redis://${env.REDIS_HOST || 'redis'}:${env.REDIS_PORT || 6379}`,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  queue.on('error', (error) => console.error('Match Worker Redis error', error));
  await db.bootstrap(pool);
  await storage.ensureBucket();
  await queue.connect();
  const worker = createMatchWorker({ pool, queue, storage, repo: db });
  process.stdout.write('arena-match-worker started\n');
  worker.start().catch((error) => {
    console.error('Match Worker stopped', error);
    process.exitCode = 1;
  });
  async function shutdown() {
    await Promise.allSettled([queue.quit(), pool.end()]);
  }
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  return { worker, pool, queue, shutdown };
}

if (require.main === module) {
  startProcess().catch((error) => {
    console.error('Match Worker startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = { MATCH_QUEUE, createMatchWorker, startProcess };
