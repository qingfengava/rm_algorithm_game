const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MATCH_QUEUE = 'arena:matches:queue';

function createMatchWorker({ pool, queue, storage, repo, command, logger = console }) {
  const matchCommand = command || process.env.ARENA_MATCH_BINARY || '/app/arena_match_demo';

  async function runCommand(args, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const child = spawn(matchCommand, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 32 * 1024 * 1024) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8').slice(0, 64 * 1024);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, failureReason: 'WORKER_EXEC_ERROR', error: error.message, stderr });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
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

      const result = await runCommand([
        '--json', '--seed', String(claimed.map_seed), redPath, bluePath,
      ], Number(process.env.MATCH_TIMEOUT_MS || 15_000));
      if (!result.ok) {
        await markFailed(matchId, result.failureReason);
        logger.error('Match failed', { matchId, reason: result.failureReason, error: result.error });
        return { status: 'failed', reason: result.failureReason };
      }
      const replay = result.result;
      if (!['RED', 'BLUE', 'DRAW'].includes(replay.winner)) {
        await markFailed(matchId, 'INVALID_MATCH_RESULT');
        return { status: 'failed', reason: 'INVALID_MATCH_RESULT' };
      }
      await repo.completeMatch(pool, matchId, replay);
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
