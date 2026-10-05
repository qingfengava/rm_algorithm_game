const assert = require('node:assert/strict');

const archive = Buffer.from(
  'UEsDBBQAAAAIAHp0RV11hlD1lwAAAN0AAAAHAAAAYm90LmNwcFWOwQrCQAxE7/2KoCCtB71vRVA/QP9A0hhwYdldstmqlP67bWkPPc6byUy21pPLL4YTCns8YrSHd4znghymBNegYCDmxlmCKWHMw+GPBboZm4VfSG3wgKQlBZ904fcmsbQ4mrsKQssidhjsQFiz+PW5MYlC1rKqoYe+LvirPGQ2t816fg8kjMrPOMmy6uY2z5/x66GgL/5QSwECHgMUAAAACAB6dEVddYZQ9ZcAAADdAAAABwAAAAAAAAABAAAAtIEAAAAAYm90LmNwcFBLBQYAAAAAAQABADUAAAC8AAAAAAA=',
  'base64',
);
const apiUrl = process.env.API_URL || 'http://localhost:8080';
const token = process.env.ARENA_TEST_TOKEN || 'arena_local_dev_token_replace_me';
const auth = { authorization: `Bearer ${token}` };

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function verify(id) {
  const body = await json(`${apiUrl}/submissions/${id}`, { headers: auth });
  assert.equal(body.submission.status, 'UPLOADED');
  assert.equal(body.submission.source.size_bytes, archive.length);
  const downloaded = await fetch(body.submission.source.download_url);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), archive);
  return body.submission;
}

async function main() {
  const health = await json(`${apiUrl}/health`);
  assert.equal(health.status, 'ok');
  await json(`${apiUrl}/leaderboard`);
  await json(`${apiUrl}/matches`);

  if (process.argv[2] === '--verify') {
    if (!process.argv[3]) throw new Error('usage: node tests/api_integration.js --verify SUBMISSION_ID');
    await verify(process.argv[3]);
    console.log(`persisted submission verified: ${process.argv[3]}`);
    return;
  }

  const created = await json(`${apiUrl}/submissions`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'API integration bot' }),
  });
  const id = created.submission.id;
  assert.equal(created.upload.method, 'POST');
  const form = new FormData();
  for (const [key, value] of Object.entries(created.upload.fields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([archive], { type: 'application/zip' }), 'submission.zip');
  const upload = await fetch(created.upload.url, { method: 'POST', body: form });
  if (!upload.ok) {
    throw new Error(`S3 upload failed: ${upload.status} ${(await upload.text()).slice(0, 1000)}`);
  }
  await json(`${apiUrl}/submissions/${id}/complete`, { method: 'POST', headers: auth });
  await verify(id);
  console.log(`submission_id=${id}`);
  console.log('API upload/download integration passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
