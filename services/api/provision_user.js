const crypto = require('node:crypto');
const db = require('./db');

async function main() {
  const handle = process.argv[2];
  if (!handle || !/^[A-Za-z0-9_-]{3,32}$/.test(handle)) {
    throw new Error('usage: node provision_user.js HANDLE');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const pool = db.createPool();
  try {
    await db.bootstrap(pool);
    const user = await db.provisionUser(pool, handle, token);
    process.stdout.write(`user_id=${user.id}\nhandle=${user.handle}\ntoken=${token}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
