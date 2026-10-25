require('dotenv').config();

const { isIP } = require('node:net');

const target = new URL(process.env.MATCH_RESULTS_TEST_URL ||
  'http://127.0.0.1:3000/api/match-results');
const count = parseInteger(process.env.MATCH_RESULTS_TEST_COUNT, 1000, 1, 100000);
const concurrency = parseInteger(process.env.MATCH_RESULTS_TEST_CONCURRENCY, 25, 1, 100);
const token = process.env.MATCH_RESULTS_TEST_TOKEN || process.env.MATCH_INGEST_TOKEN;

if (!token) throw new Error('Set MATCH_RESULTS_TEST_TOKEN or MATCH_INGEST_TOKEN.');
if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Target must use HTTP or HTTPS.');
if (!isLoopback(target.hostname) && process.env.ALLOW_EXTERNAL_LOAD_TEST !== 'true') {
  throw new Error('Non-local targets require ALLOW_EXTERNAL_LOAD_TEST=true.');
}

function parseInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    if (value === undefined) return fallback;
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.startsWith('127.'));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendResult(index) {
  const result = {
    matchId: `loadtest-${Date.now()}-${index}`,
    bot1: `test-bot-${index % 10000}`,
    bot2: `test-bot-${(index + 1) % 10000}`,
    winner: ['bot1', 'bot2', 'draw'][index % 3],
    playedAt: new Date().toISOString()
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 202) return;
      if (![429, 503].includes(response.status)) {
        throw new Error(`Request failed with HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await delay(250 * (attempt + 1));
  }
}

async function main() {
  let next = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      await sendResult(index);
      completed++;
      if (completed % 100 === 0 || completed === count) {
        process.stdout.write(`\r${completed}/${count} results accepted`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write('\n');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
