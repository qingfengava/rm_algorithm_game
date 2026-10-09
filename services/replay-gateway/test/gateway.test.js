const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { parseRequest, createGateway } = require('../index');

test('WebSocket route validates match id and resume position', () => {
  const matchId = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parseRequest({ url: `/matches/${matchId}?after_seq=3` }),
    { matchId, afterSeq: 3 });
  assert.equal(parseRequest({ url: `/matches/${matchId}?after_seq=-2` }), null);
  assert.equal(parseRequest({ url: '/matches/bad' }), null);
});

test('gateway sends metadata, only missing events, and terminal status', async () => {
  const matchId = '123e4567-e89b-42d3-a456-426614174000';
  const server = new EventEmitter();
  let socketServer;
  class FakeSocketServer extends EventEmitter {
    constructor() { super(); socketServer = this; }
    handleUpgrade(_request, _socket, _head, callback) { callback(ws); }
  }
  const sent = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.send = (payload) => sent.push(JSON.parse(payload));
  ws.close = () => { ws.readyState = 3; ws.emit('close'); };
  const pool = { async query(sql, values) {
    if (sql.includes('SELECT id FROM matches')) return { rows: [{ id: matchId }] };
    if (sql.includes('map_seed::text')) return { rows: [{ map_seed: '42', map_data: { obstacles: [] },
      initial_state: { round: 1 }, status: 'FINISHED', winner: 'DRAW', failure_reason: null }] };
    if (sql.includes('FROM match_events')) return { rows: [0, 1, 2]
      .filter((seq) => seq > values[1]).map((seq) => ({ event: { seq, state_hash: `hash:${seq}` } })) };
    throw new Error('unexpected query');
  } };
  let destroyed = false;
  const redis = { duplicate() { return { async connect() {}, destroy() { destroyed = true; } }; } };
  createGateway({ server, pool, redis, WebSocketServerClass: FakeSocketServer });
  const socket = { write() {}, destroy() {} };
  server.emit('upgrade', { url: `/matches/${matchId}?after_seq=1` }, socket, Buffer.alloc(0));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socketServer.listenerCount('connection'), 1);
  assert.deepEqual(sent.map((item) => item.kind), ['snapshot', 'event', 'complete']);
  assert.equal(sent[1].event.seq, 2);
  assert.equal(sent[2].winner, 'DRAW');
  assert.equal(destroyed, true);
});
