async function main() {
  const apiUrl = process.env.API_URL || 'http://localhost:8080';
  const webUrl = process.env.WEB_URL || 'http://localhost:8081';

  async function getJson(url) {
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }

  const health = await getJson(`${apiUrl}/v1/health`);
  if (health.status !== 'ok') {
    throw new Error(`API dependencies are not healthy: ${JSON.stringify(health)}`);
  }

  const webResponse = await fetch(webUrl);
  if (!webResponse.ok) {
    throw new Error(`Web service returned ${webResponse.status}`);
  }

  console.log('compose smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
