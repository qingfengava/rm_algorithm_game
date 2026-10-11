const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_COMPILED_BYTES } = require('../api/limits');

const MATCH_QUEUE = 'arena:matches:queue';

// Failures that are a property of the submitted algorithm or of the match
// itself. They are recorded as the match result and are never retried. Any
// other failure (storage, database, worker process) is a platform fault: the
// match is requeued and only becomes a terminal failure after repeated attempts.
const ALGORITHM_FAILURES = new Set([
  'TIMEOUT', 'RUNNER_ERROR', 'INVALID_MATCH_STREAM', 'INVALID_MATCH_RESULT',
  'COMPILED_ARTIFACT_MISSING',
]);
const MAX_MATCH_ATTEMPTS = Number(process.env.MATCH_MAX_ATTEMPTS || 5);

function matchError(reason, message) {
  const error = new Error(message);
  error.failureReason = reason;
  return error;
}

function isMissingObject(error) {
  return error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey' ||
    error?.$metadata?.httpStatusCode === 404;
}

async function downloadRunner(storage, key, destination, maxBytes = MAX_COMPILED_BYTES) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await storage.downloadObjectToFile(key, destination, maxBytes);
    } catch (error) {
      lastError = error;
      if (!isMissingObject(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function downloadRunnerWithBackup(storage, repo, pool, artifact, destination) {
  try {
    return await downloadRunner(storage, artifact.object_key, destination);
  } catch (error) {
    if (!isMissingObject(error) || typeof repo.getArtifactPayload !== 'function') throw error;
    const payload = await repo.getArtifactPayload(pool, artifact.submission_id, 'COMPILED');
    if (!payload) throw error;
    const bytes = Buffer.from(payload);
    if (bytes.byteLength > MAX_COMPILED_BYTES) throw new Error('compiled_artifact_too_large');
    await fs.writeFile(destination, bytes);
    // Heal object storage so later readers do not need the database copy.
    if (typeof storage.uploadBuffer === 'function') {
      await storage.uploadBuffer(artifact.object_key, bytes, 'application/octet-stream')
        .catch(() => {});
    }
    return bytes.byteLength;
  }
}

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
      const consumeLine = async (line) => {
        let message;
        try { message = JSON.parse(line); }
        catch (error) { throw matchError('INVALID_MATCH_STREAM', error.message); }
        if (message?.kind === 'error') {
          throw matchError(message.failure_reason || 'RUNNER_ERROR',
            message.error || message.failure_reason || 'runner_error');
        }
        await onMessage(message);
      };
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
            if (processingError) return;
            for (const line of lines) if (line) await consumeLine(line);
          }).catch((error) => {
            processingError = error;
            child.kill('SIGKILL');
          }).finally(() => child.stdout.resume());
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-64 * 1024);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, failureReason: 'WORKER_EXEC_ERROR', error: error.message, stderr });
      });
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        await processing;
        if (processingError) {
          const failureReason = processingError.failureReason || 'REPLAY_WRITE_ERROR';
          resolve({ ok: false, failureReason, error: processingError.message, stderr });
          return;
        }
        if (onMessage) {
          if (stdout.trim()) {
            try { await consumeLine(stdout.trim()); }
            catch (error) {
              resolve({ ok: false, failureReason: error.failureReason || 'REPLAY_WRITE_ERROR',
                error: error.message, stderr });
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

  // Record a failed match. Platform faults go back to the queue (discarding the
  // partial replay) until the attempt limit is reached.
  async function markFailed(matchId, reason, detail = null) {
    const failureReason = `${reason || 'RUNTIME_FAILED'}${detail ? `: ${detail}` : ''}`.slice(0, 2048);
    if (!ALGORITHM_FAILURES.has(reason) && typeof repo.requeueMatch === 'function') {
      const outcome = await repo.requeueMatch(pool, matchId, failureReason, {
        maxAttempts: MAX_MATCH_ATTEMPTS,
      });
      if (outcome?.requeued) {
        await queue.del?.(`arena:matches:events:${matchId}`)?.catch?.(() => {});
        return { requeued: true, attempts: outcome.attempts };
      }
      if (outcome) {
        await repo.finishMatch(pool, matchId, {
          failureReason: `PLATFORM_RETRIES_EXHAUSTED: ${failureReason}`.slice(0, 2048),
        });
        return { requeued: false, exhausted: true };
      }
      return { requeued: false };
    }
    await repo.finishMatch(pool, matchId, { failureReason });
    return { requeued: false };
  }

  // A runner that is gone from object storage and from the database backup can
  // never be played again. Mark it unavailable (it stays on the leaderboard)
  // so the Scheduler stops creating matches against it.
  async function markRunnerLost(submissionId, reason) {
    if (!submissionId || typeof repo.markArtifactLost !== 'function') return null;
    return repo.markArtifactLost(pool, submissionId, 'COMPILED', reason);
  }

  async function processMatch(matchId) {
    const claimed = await repo.claimMatch(pool, matchId);
    if (!claimed) return { status: 'already_claimed' };
    let temporary;
    try {
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-match-'));
      const artifacts = await repo.getCompiledArtifacts(pool, [
        claimed.red_submission_id,
        claimed.blue_submission_id,
      ]);
      const bySubmission = new Map(artifacts.map((row) => [row.submission_id, row]));
      const redArtifact = bySubmission.get(claimed.red_submission_id);
      const blueArtifact = bySubmission.get(claimed.blue_submission_id);
      if (!redArtifact || !blueArtifact) {
        // Either side has no available runner (replaced, deleted or lost).
        const missingIds = [
          !redArtifact ? claimed.red_submission_id : null,
          !blueArtifact ? claimed.blue_submission_id : null,
        ].filter(Boolean);
        await markFailed(matchId, 'COMPILED_ARTIFACT_MISSING', missingIds.join(','));
        return { status: 'failed', reason: 'COMPILED_ARTIFACT_MISSING' };
      }

      const redPath = path.join(temporary, 'red_runner');
      const bluePath = path.join(temporary, 'blue_runner');
      try {
        for (const [artifact, destination] of [[redArtifact, redPath], [blueArtifact, bluePath]]) {
          try {
            await downloadRunnerWithBackup(storage, repo, pool, artifact, destination);
          } catch (error) {
            if (!isMissingObject(error)) throw error;
            const missing = matchError('COMPILED_ARTIFACT_MISSING',
              `compiled runner object is missing: ${artifact.object_key}`);
            missing.submissionId = artifact.submission_id;
            throw missing;
          }
        }
      } catch (error) {
        throw error;
      }
      await fs.chmod(redPath, 0o755);
      await fs.chmod(bluePath, 0o755);
      try {
        await fs.access(redPath, fs.constants.X_OK);
        await fs.access(bluePath, fs.constants.X_OK);
      } catch (error) {
        throw matchError('RUNNER_NOT_EXECUTABLE',
          `${error.message}; TMPDIR must be on an executable filesystem`);
      }

      const replay = { match_id: matchId, map_seed: String(claimed.map_seed), events: [] };
      let finished = false;
      const streamKey = `arena:matches:events:${matchId}`;
      const result = await runCommand([
        '--json-stream', '--seed', String(claimed.map_seed), redPath, bluePath,
      ], Number(process.env.MATCH_TIMEOUT_MS || 15_000), async (message) => {
        if (message.kind === 'start') {
          if (replay.map || message.map_seed !== replay.map_seed || !message.map || !message.initial_state) {
            throw matchError('INVALID_MATCH_STREAM', 'invalid_match_start');
          }
          replay.map = message.map;
          replay.initial_state = message.initial_state;
          await repo.startMatchReplay(pool, matchId, replay);
        } else if (message.kind === 'event') {
          const event = message.event;
          if (!replay.map || finished || !event || event.seq !== replay.events.length ||
              !/^fnv1a64:[0-9a-f]{16}$/.test(event.state_hash)) {
            throw matchError('INVALID_MATCH_STREAM', 'invalid_match_event');
          }
          if (event.seq === 0 && (event.type !== 'MATCH_STARTED' ||
              JSON.stringify(event.state_after) !== JSON.stringify(replay.initial_state))) {
            throw matchError('INVALID_MATCH_STREAM', 'invalid_initial_event');
          }
          await repo.appendMatchEvent(pool, matchId, event);
          replay.events.push(event);
          try {
            await queue.xAdd(streamKey, '*', { event: JSON.stringify(event) });
            await queue.expire(streamKey, 86400);
          } catch (error) { logger.warn('Replay stream publish failed', { matchId, error }); }
        } else if (message.kind === 'result') {
          if (finished || !['RED', 'BLUE', 'DRAW'].includes(message.winner)) {
            throw matchError('INVALID_MATCH_STREAM', 'invalid_match_result');
          }
          replay.winner = message.winner;
          replay.result = message.result;
          finished = true;
        } else throw matchError('INVALID_MATCH_STREAM', 'invalid_match_message');
      });
      if (!result.ok) {
        await markFailed(matchId, result.failureReason, result.error || result.stderr);
        logger.error('Match failed', { matchId, reason: result.failureReason,
          error: result.error, stderr: result.stderr });
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
      const reason = error.failureReason || error.code || 'WORKER_ERROR';
      if (reason === 'COMPILED_ARTIFACT_MISSING' && error.submissionId) {
        try {
          await markRunnerLost(error.submissionId, `${reason}: ${error.message}`);
        } catch (lostError) {
          logger.error('failed to mark compiled artifact as lost', {
            matchId, submissionId: error.submissionId, error: lostError,
          });
        }
      }
      try {
        await markFailed(matchId, reason, error.message);
      } catch (failError) {
        logger.error('failed to record match failure', { matchId, error: failError });
      }
      logger.error('Match worker error', { matchId, error });
      return { status: 'failed', reason: error.failureReason || error.message };
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
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

module.exports = { MATCH_QUEUE, createMatchWorker, downloadRunnerWithBackup, startProcess };
