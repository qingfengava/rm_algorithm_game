const db = require('./db');

async function main() {
  const handle = process.argv[2];
  const password = process.argv[3];
  if (!handle || !/^[A-Za-z0-9_-]{3,32}$/.test(handle)) {
    throw new Error('usage: node provision_user.js HANDLE [PASSWORD]');
  }
  if (!password) throw new Error('a password is required');
  const pool = db.createPool();
  try {
    await db.bootstrap(pool);
    const user = await db.provisionPasswordUser(pool, { handle, password });
    process.stdout.write(`user_id=${user.id}\nhandle=${user.handle}\npassword=${password}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
