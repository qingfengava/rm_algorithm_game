const http = require('node:http');

const MATCH_PATH = /^(?:\/v1)?\/matches\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function parseRequest(request) {
  const url = new URL(request.url, 'http://localhost');
  const match = MATCH_PATH.exec(url.pathname);
  const afterSeq = Number(url.searchParams.get('after_seq') ?? '-1');
  if (!match || !Number.isSafeInteger(afterSeq) || afterSeq < -1) return null;
  return { matchId: match[1], afterSeq };
}

function createGateway({ server, pool, redis, logger = console, WebSocketServerClass }) {
  const SocketServer = WebSocketServerClass || require('ws').WebSocketServer;
  const sockets = new SocketServer({ noServer: true });
  server.on('upgrade', async (request, socket, head) => {
    const options = parseRequest(request);
    if (!options) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
    try {
      const result = await pool.query(
        'SELECT id FROM matches WHERE id = $1', [options.matchId],
      );
      if (!result.rows[0]) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, (ws) => {
        sockets.emit('connection', ws, options);
      });
    } catch (error) {
      logger.error('Replay upgrade failed', error);
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
    }
  });

  sockets.on('connection', (ws, { matchId, afterSeq }) => {
    let closed = false;
    let cursor = afterSeq;
    const streamKey = `arena:matches:events:${matchId}`;
    const subscriber = redis.duplicate();
    ws.on('close', () => { closed = true; subscriber.destroy(); });
    ws.on('error', () => { closed = true; });
    const send = (message) => {
      if (!closed && ws.readyState === 1) ws.send(JSON.stringify(message));
    };

    async function catchUp() {
      const metadata = await pool.query(
        `SELECT map_seed::text, map_data, initial_state, status, winner, failure_reason
           FROM matches WHERE id = $1`, [matchId],
      );
      const match = metadata.rows[0];
      if (!match) { ws.close(1008, 'match_not_found'); return true; }
      send({ kind: 'snapshot', match_id: matchId, map_seed: match.map_seed,
        map: match.map_data, initial_state: match.initial_state, status: match.status,
        winner: match.winner, failure_reason: match.failure_reason });
      while (!closed) {
        const result = await pool.query(
          'SELECT event FROM match_events WHERE match_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT 128',
          [matchId, cursor],
        );
        if (!result.rows.length) break;
        for (const row of result.rows) {
          const event = row.event;
          if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) continue;
          cursor = event.seq;
          send({ kind: 'event', event });
        }
        if (result.rows.length < 128) break;
      }
      if (match.status === 'FINISHED' || match.status === 'RUNTIME_FAILED') {
        send({ kind: 'complete', status: match.status, winner: match.winner,
          failure_reason: match.failure_reason });
        ws.close(1000);
        return true;
      }
      return false;
    }

    (async () => {
      await subscriber.connect();
      let streamId = '0-0';
      while (!closed) {
        if (await catchUp()) return;
        // The stream is a low-latency wake-up path. PostgreSQL remains the
        // source of truth when Redis trims events or the gateway reconnects.
        const updates = await subscriber.xRead([{ key: streamKey, id: streamId }],
          { BLOCK: 3000, COUNT: 128 });
        for (const group of updates || []) {
          for (const message of group.messages) streamId = message.id;
        }
      }
    })().catch((error) => {
      logger.error('Replay connection failed', { matchId, error });
      if (ws.readyState === 1) ws.close(1011, 'replay_unavailable');
    }).finally(() => subscriber.destroy());
  });
  return sockets;
}

async function start(env = process.env) {
  const { Pool } = require('pg');
  const { createClient } = require('redis');
  const pool = new Pool({ host: env.POSTGRES_HOST || 'postgres',
    port: Number(env.POSTGRES_PORT || 5432), database: env.POSTGRES_DB || 'arena',
    user: env.POSTGRES_USER || 'arena', password: env.POSTGRES_PASSWORD || 'arena_local_only' });
  const redis = createClient({ url: env.REDIS_URL ||
    `redis://${env.REDIS_HOST || 'redis'}:${env.REDIS_PORT || 6379}` });
  redis.on('error', (error) => console.error('Replay Redis error', error));
  await redis.connect();
  const server = http.createServer((request, response) => {
    if (request.url === '/healthz') { response.writeHead(200); response.end('ok'); }
    else { response.writeHead(404); response.end(); }
  });
  createGateway({ server, pool, redis });
  const port = Number(env.PORT || 8082);
  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));
  process.stdout.write(`arena-replay-gateway listening on ${port}\n`);
  return { server, pool, redis };
}

if (require.main === module) start().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { parseRequest, createGateway, start };
