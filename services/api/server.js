const http = require('node:http');
const net = require('node:net');

const port = Number(process.env.PORT || 8080);

function checkTcp(host, servicePort, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port: servicePort });
    let settled = false;

    const finish = (healthy) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(healthy);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function dependencyStatus() {
  const checks = await Promise.all([
    checkTcp(process.env.POSTGRES_HOST || 'postgres', Number(process.env.POSTGRES_PORT || 5432)),
    checkTcp(process.env.REDIS_HOST || 'redis', Number(process.env.REDIS_PORT || 6379)),
    checkTcp(process.env.OBJECT_STORAGE_HOST || 'minio', Number(process.env.OBJECT_STORAGE_PORT || 9000)),
  ]);

  return {
    postgres: checks[0],
    redis: checks[1],
    object_storage: checks[2],
  };
}

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' });
    return;
  }

  if (request.url === '/healthz') {
    sendJson(response, 200, { status: 'ok', service: 'arena-api' });
    return;
  }

  if (request.url === '/v1/health') {
    const dependencies = await dependencyStatus();
    const healthy = Object.values(dependencies).every(Boolean);
    sendJson(response, healthy ? 200 : 503, {
      status: healthy ? 'ok' : 'degraded',
      service: 'arena-api',
      dependencies,
    });
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`arena-api listening on ${port}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
