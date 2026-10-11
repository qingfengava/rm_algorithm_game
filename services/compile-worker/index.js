const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
// The image copies shared API modules beside the worker entrypoint, while the
// source-tree tests resolve them from the sibling api service.
function loadLimits() {
  try {
    return require('./api/limits');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
    return require('../api/limits');
  }
}

const { MAX_COMPILED_BYTES } = loadLimits();

const SUBMISSION_CHANNEL = 'arena:submissions:uploaded';

function isMissingObject(error) {
  return error?.name === 'NoSuchKey' || error?.Code === 'NoSuchKey' ||
    error?.$metadata?.httpStatusCode === 404;
}

async function downloadWithBackup(storage, repo, pool, key, submissionId, kind, destination, maxBytes) {
  try {
    return await storage.downloadObjectToFile(key, destination, maxBytes);
  } catch (error) {
    if (!isMissingObject(error) || typeof repo.getArtifactPayload !== 'function') throw error;
    const payload = await repo.getArtifactPayload(pool, submissionId, kind);
    if (!payload) throw error;
    const bytes = Buffer.from(payload);
    if (bytes.byteLength > maxBytes) throw new Error('artifact_backup_too_large');
    await fs.writeFile(destination, bytes);
    // Heal object storage so later readers do not need the database copy.
    if (typeof storage.uploadBuffer === 'function') {
      await storage.uploadBuffer(
        key, bytes, kind === 'SOURCE' ? 'application/zip' : 'application/octet-stream',
      ).catch(() => {});
    }
    return bytes.byteLength;
  }
}

function createCompileWorker({
  pool, queue, storage, repo, command, commandArgs, logger = console,
}) {
  const compileCommand = command || process.env.ARENA_COMPILE_COMMAND || '/app/compile_submission.sh';
  let active = false;

  function runCommand(args, timeoutMs = 45_000) {
    return new Promise((resolve) => {
      const child = spawn(compileCommand, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-64 * 1024);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-128 * 1024);
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'COMPILE_WORKER_EXEC_ERROR', log: error.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const log = `${stdout}${stderr ? `\n${stderr}` : ''}`.slice(-256 * 1024);
        resolve({
          ok: !timedOut && code === 0,
          reason: timedOut ? 'COMPILE_TIMEOUT' : (code === 0 ? null : 'COMPILE_FAILED'),
          log,
          code,
          signal,
        });
      });
    });
  }

  async function processSubmission(submission) {
    const claimed = await repo.setSubmissionStatus(pool, submission.id, 'COMPILING');
    if (!claimed) return { status: 'already_claimed' };
    let temporary;
    try {
      // Inside the try: if the scratch directory cannot be created the failure
      // must be recorded, not leave the claimed submission stuck in COMPILING.
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-compile-'));
      const source = path.join(temporary, 'source.zip');
      const runner = path.join(temporary, 'runner');
      await downloadWithBackup(
        storage, repo, pool, submission.source_key, submission.id, 'SOURCE', source,
        8 * 1024 * 1024,
      );
      const args = typeof commandArgs === 'function'
        ? commandArgs(source, runner)
        : [source, runner];
      const result = await runCommand(args, Number(process.env.COMPILE_TIMEOUT_MS || 45_000));
      if (!result.ok) {
        await repo.setSubmissionStatus(pool, submission.id, 'COMPILE_FAILED', {
          compileLog: result.log,
          failureReason: result.reason,
        });
        return { status: 'failed', reason: result.reason };
      }
      const runnerStat = await fs.stat(runner);
      if (!runnerStat.isFile() || runnerStat.size > MAX_COMPILED_BYTES) {
        const error = new Error(
          `compiled runner is ${runnerStat.size} bytes; maximum is ${MAX_COMPILED_BYTES} bytes`,
        );
        error.code = 'COMPILED_ARTIFACT_TOO_LARGE';
        throw error;
      }
      const objectKey = `submissions/${submission.id}/runner`;
      const byteSize = await storage.uploadFile(objectKey, runner, 'application/octet-stream');
      const runnerPayload = await fs.readFile(runner);
      await repo.upsertArtifact(pool, {
        submissionId: submission.id,
        kind: 'COMPILED',
        objectKey,
        contentType: 'application/octet-stream',
        byteSize,
        payload: runnerPayload,
      });
      if (result.log) {
        const logKey = `submissions/${submission.id}/compile.log`;
        const logPath = path.join(temporary, 'compile.log');
        await fs.writeFile(logPath, result.log);
        const logSize = await storage.uploadFile(logKey, logPath, 'text/plain; charset=utf-8');
        await repo.upsertArtifact(pool, {
          submissionId: submission.id,
          kind: 'COMPILE_LOG',
          objectKey: logKey,
          contentType: 'text/plain; charset=utf-8',
          byteSize: logSize,
        });
      }
      await repo.setSubmissionStatus(pool, submission.id, 'QUEUED', {
        compileLog: result.log || 'COMPILE_OK',
      });
      // A candidate with nobody to play (empty board, or the only ranked
      // algorithm is the owner's previous version) is published immediately.
      // Scheduler performs the same locked check on its next scan and handles
      // every candidate that has opponents.
      let promoted = null;
      try {
        if (typeof repo.promoteSubmissionIfNoOpponents === 'function') {
          promoted = await repo.promoteSubmissionIfNoOpponents(pool, submission.id);
        }
      } catch (error) {
        // Compilation and qualification have already succeeded. A failed
        // publication is retried by Scheduler from the durable QUEUED row.
        logger.warn('promotion without opponents failed', error);
      }
      try {
        if (typeof queue.publish === 'function') {
          await queue.publish(SUBMISSION_CHANNEL, submission.id);
        }
      } catch (error) {
        // The scheduler also scans durable QUEUED rows, so a lost wake-up is
        // recoverable without rolling back a successful compilation.
        logger.warn('compile completion notification failed', error);
      }
      return { status: promoted ? 'finished' : 'queued' };
    } catch (error) {
      const reason = error.code || error.message || 'COMPILE_WORKER_ERROR';
      try {
        // The source is in neither object storage nor the database backup. It
        // cannot be compiled, so fail the candidate (asking for a new upload)
        // instead of leaving it to be polled forever.
        if (isMissingObject(error) && typeof repo.markArtifactLost === 'function') {
          await repo.markArtifactLost(
            pool, submission.id, 'SOURCE', `SOURCE_ARTIFACT_MISSING: ${String(reason)}`,
          );
        } else {
          await repo.setSubmissionStatus(pool, submission.id, 'COMPILE_FAILED', {
            compileLog: String(reason), failureReason: String(reason),
          });
        }
      } catch (statusError) {
        logger.error('failed to persist compile failure', statusError);
      }
      logger.error('compile worker failed', { submissionId: submission.id, error });
      return { status: 'failed', reason };
    } finally {
      if (temporary) await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  async function reconcile() {
    if (active) return { skipped: true, processed: 0 };
    active = true;
    try {
      const submissions = await repo.listReadySubmissions(pool, 20);
      let processed = 0;
      for (const submission of submissions) {
        await processSubmission(submission);
        processed += 1;
      }
      return { skipped: false, processed };
    } finally {
      active = false;
    }
  }

  async function start(intervalMs = 5000) {
    const subscriber = queue.duplicate();
    subscriber.on('error', (error) => logger.error('Compile Worker Redis error', error));
    await subscriber.connect();
    await subscriber.subscribe(SUBMISSION_CHANNEL, () => {
      reconcile().catch((error) => logger.error('compile reconcile failed', error));
    });
    await reconcile();
    const timer = setInterval(() => {
      reconcile().catch((error) => logger.error('compile reconcile failed', error));
    }, intervalMs);
    timer.unref();
    return { subscriber, timer };
  }

  return { runCommand, processSubmission, reconcile, start };
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
  queue.on('error', (error) => console.error('Compile Worker Redis error', error));
  await db.bootstrap(pool);
  await storage.ensureBucket();
  await queue.connect();
  const worker = createCompileWorker({ pool, queue, storage, repo: db });
  const { subscriber, timer } = await worker.start(Number(env.COMPILE_INTERVAL_MS || 5000));
  process.stdout.write('arena-compile-worker started\n');
  async function shutdown() {
    clearInterval(timer);
    await Promise.allSettled([subscriber.quit(), queue.quit(), pool.end()]);
  }
  process.once('SIGTERM', () => shutdown().then(() => process.exit(0)));
  process.once('SIGINT', () => shutdown().then(() => process.exit(0)));
  return { worker, pool, queue, subscriber, shutdown };
}

if (require.main === module) {
  startProcess().catch((error) => {
    console.error('Compile Worker startup failed', error);
    process.exitCode = 1;
  });
}

module.exports = { SUBMISSION_CHANNEL, createCompileWorker, startProcess };
