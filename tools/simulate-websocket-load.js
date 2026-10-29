require('dotenv').config();

const { isIP } = require('node:net');
const WebSocket = require('ws');

const target = new URL(process.env.WS_LOAD_TEST_URL || 'ws://127.0.0.1:3000');
const count = parseInteger(process.env.WS_LOAD_TEST_CLIENTS, 100, 1, 10000);
const rampConcurrency = parseInteger(process.env.WS_LOAD_TEST_RAMP, 25, 1, 250);
const durationSeconds = parseInteger(process.env.WS_LOAD_TEST_DURATION_SECONDS, 10, 1, 300);
const connectTimeoutMs = 10000;

if (!['ws:', 'wss:'].includes(target.protocol)) {
  throw new Error('WS_LOAD_TEST_URL must use ws:// or wss://.');
}
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

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)];
}

function openClient(index, sockets, latencies, errors) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Client ${index + 1} did not connect within ${connectTimeoutMs} ms.`));
    }, connectTimeoutMs);
    sockets.push(socket);

    socket.once('open', () => {
      clearTimeout(timer);
      socket.send(JSON.stringify({ type: 'list_rooms' }));
      socket.send(JSON.stringify({ type: 'ping', time: Date.now() }));
      resolve();
    });
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'pong' && Number.isFinite(message.time)) {
          latencies.push(Date.now() - message.time);
        }
      } catch (error) {
        errors.push(error.message);
      }
    });
    socket.once('error', error => {
      clearTimeout(timer);
      errors.push(error.message);
      reject(error);
    });
  });
}

async function main() {
  const sockets = [];
  const latencies = [];
  const errors = [];
  let nextClient = 0;
  let stopping = false;
  const workers = Array.from({ length: Math.min(count, rampConcurrency) }, async () => {
    while (!stopping && nextClient < count) {
      const index = nextClient++;
      try {
        await openClient(index, sockets, latencies, errors);
      } catch (error) {
        stopping = true;
        throw error;
      }
    }
  });

  try {
    const results = await Promise.allSettled(workers);
    const failedWorker = results.find(result => result.status === 'rejected');
    if (failedWorker) throw failedWorker.reason;
    console.log(`${sockets.length} WebSocket clients connected; holding for ${durationSeconds}s.`);
    const pingTimer = setInterval(() => {
      const time = Date.now();
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', time }));
        }
      }
    }, 5000);
    await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
    clearInterval(pingTimer);
    console.log(JSON.stringify({
      target: target.origin,
      clients: sockets.length,
      errors: errors.length,
      latencyMs: {
        p50: percentile(latencies, 0.50),
        p95: percentile(latencies, 0.95),
        max: latencies.length ? latencies.reduce((highest, value) => Math.max(highest, value), 0) : null
      }
    }, null, 2));
    if (errors.length) console.error(`First connection/protocol error: ${errors[0]}`);
  } finally {
    for (const socket of sockets) socket.close(1000, 'Load test complete');
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
