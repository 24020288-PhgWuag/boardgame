const crypto = require('crypto');
const express = require('express');
const Redis = require('ioredis');
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.MATCH_SHEETS_SPREADSHEET_ID ||
  '1ih-uW88lfBq_e1d0meTgUvZtVWXX455aNl5nxbqNGD4';
const SHEET_RANGE = process.env.MATCH_SHEETS_RANGE || 'Matches!A:E';
const SHEET_TITLE = getSheetTitle(SHEET_RANGE);
const QUEUE_KEY = 'match-results:pending';
const PROCESSING_KEY = 'match-results:processing';
const LOCK_KEY = 'match-results:worker-lock';
const LAST_APPEND_KEY = 'match-results:last-append';
const USE_MEMORY_QUEUE = process.env.MATCH_RESULTS_QUEUE === 'memory';
const BATCH_SIZE = boundedInteger(process.env.MATCH_SHEETS_BATCH_SIZE, 500, 1, 500);
const MAX_QUEUE_SIZE = boundedInteger(process.env.MATCH_RESULTS_MAX_QUEUE, 100000, 1000, 1000000);
const FLUSH_INTERVAL_MS = boundedInteger(process.env.MATCH_SHEETS_FLUSH_INTERVAL_MS, 3000, 1000, 60000);
const MIN_APPEND_INTERVAL_MS = boundedInteger(process.env.MATCH_SHEETS_MIN_APPEND_INTERVAL_MS, 1200, 0, 60000);
const MAX_BODY_RECORDS = 100;
const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const enqueueScript = `
local queueLength = redis.call('LLEN', KEYS[1])
local accepted = {}
local ids = {}
local seen = {}
for i = 4, #ARGV do
  local item = cjson.decode(ARGV[i])
  local dedupKey = ARGV[2] .. item.matchId
  if not seen[dedupKey] and redis.call('EXISTS', dedupKey) == 0 then
    table.insert(accepted, ARGV[i])
    table.insert(ids, dedupKey)
    seen[dedupKey] = true
  end
end
if queueLength + #accepted > tonumber(ARGV[1]) then
  return {-1, queueLength}
end
for i, record in ipairs(accepted) do
  redis.call('LPUSH', KEYS[1], record)
  redis.call('SET', ids[i], '1', 'EX', tonumber(ARGV[3]))
end
return {#accepted, redis.call('LLEN', KEYS[1])}
`;
const moveBatchScript = `
local moved = 0
while moved < tonumber(ARGV[1]) do
  local record = redis.call('RPOPLPUSH', KEYS[1], KEYS[2])
  if not record then break end
  moved = moved + 1
end
return moved
`;
const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function getSheetTitle(range) {
  const separator = range.indexOf('!');
  const title = separator < 0 ? range : range.slice(0, separator);
  return title.replace(/^'|'$/g, '').replace(/''/g, "'");
}

function quoteSheetTitle(title) {
  return `'${title.replace(/'/g, "''")}'`;
}

function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { matchId, bot1, bot2, winner, playedAt } = input;
  if (typeof matchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(matchId)) return null;
  if (typeof bot1 !== 'string' || bot1.trim().length < 1 || bot1.length > 100) return null;
  if (typeof bot2 !== 'string' || bot2.trim().length < 1 || bot2.length > 100) return null;
  if (!['bot1', 'bot2', 'draw'].includes(winner)) return null;
  const timestamp = playedAt === undefined ? new Date().toISOString() : playedAt;
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
  return {
    matchId,
    bot1: bot1.trim(),
    bot2: bot2.trim(),
    winner,
    playedAt: new Date(timestamp).toISOString()
  };
}

function createSheetsClient() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS must point to the service account JSON file.');
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

let redis;
let sheetsClient;
let sheetsSetupPromise;
let workerTimer;
let workerActive = false;
const memoryQueue = [];
const memoryProcessing = [];
const memoryDedup = new Map();
let memoryLastAppendAt = 0;
let memoryWorkerActive = false;

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: attempt => Math.min(attempt * 250, 2000)
    });
    redis.on('error', error => console.error('Match result Redis error:', error.message));
    redis.connect().catch(error => console.error('Match result Redis connection failed:', error.message));
  }
  return redis;
}

function authenticate(req, res, next) {
  const expected = process.env.MATCH_INGEST_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Match result ingestion is not configured.' });
  const supplied = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(supplied);
  if (!match) return res.status(401).json({ error: 'Bearer token required.' });
  const actual = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
    return res.status(401).json({ error: 'Invalid bearer token.' });
  }
  next();
}

async function enqueueMatchResults(input) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Set GOOGLE_APPLICATION_CREDENTIALS to enable match result reporting.');
  }
  const records = input.map(validateRecord);
  if (!records.length || records.length > MAX_BODY_RECORDS || records.some(record => !record)) {
    throw new Error('Invalid match result batch.');
  }

  if (USE_MEMORY_QUEUE) {
    const now = Date.now();
    for (const [matchId, expiresAt] of memoryDedup) {
      if (expiresAt <= now) memoryDedup.delete(matchId);
    }
    const freshRecords = [...new Map(records.map(record => [record.matchId, record])).values()]
      .filter(record => !memoryDedup.has(record.matchId));
    const queued = memoryQueue.length + memoryProcessing.length;
    if (queued + freshRecords.length > MAX_QUEUE_SIZE) {
      const error = new Error(`Result queue is full (${queued} queued).`);
      error.code = 'MATCH_RESULT_QUEUE_FULL';
      throw error;
    }
    for (const record of freshRecords) {
      memoryQueue.push(record);
      memoryDedup.set(record.matchId, now + DEDUP_TTL_SECONDS * 1000);
    }
    return { accepted: freshRecords.length, queued: memoryQueue.length + memoryProcessing.length };
  }

  const result = await getRedis().eval(
    enqueueScript,
    1,
    QUEUE_KEY,
    String(MAX_QUEUE_SIZE),
    'match-results:dedup:',
    String(DEDUP_TTL_SECONDS),
    ...records.map(record => JSON.stringify(record))
  );
  if (result[0] === -1) {
    const error = new Error(`Result queue is full (${result[1]} queued).`);
    error.code = 'MATCH_RESULT_QUEUE_FULL';
    throw error;
  }
  return { accepted: result[0], queued: result[1] };
}

const router = express.Router();
router.post('/', authenticate, async (req, res) => {
  const input = Array.isArray(req.body?.results) ? req.body.results : [req.body];
  if (input.length < 1 || input.length > MAX_BODY_RECORDS) {
    return res.status(400).json({ error: `Send 1-${MAX_BODY_RECORDS} results per request.` });
  }
  const records = input.map(validateRecord);
  if (records.some(record => !record)) {
    return res.status(400).json({
      error: 'Each result needs matchId, bot1, bot2, winner (bot1, bot2, draw), and a valid optional playedAt timestamp.'
    });
  }

  try {
    res.status(202).json(await enqueueMatchResults(records));
  } catch (error) {
    console.error('Could not enqueue match results:', error.message);
    res.set('Retry-After', '3');
    res.status(503).json({ error: 'Result queue is temporarily unavailable.' });
  }
});

async function acquireLock(client, token) {
  return client.set(LOCK_KEY, token, 'PX', 60000, 'NX');
}

async function reserveAppendSlot(client) {
  const now = Date.now();
  const lastAppend = Number(await client.get(LAST_APPEND_KEY) || 0);
  if (now - lastAppend < MIN_APPEND_INTERVAL_MS) return false;
  await client.set(LAST_APPEND_KEY, String(now));
  return true;
}

async function getOrCreateSheets() {
  if (!sheetsClient) sheetsClient = createSheetsClient();
  if (!sheetsSetupPromise) {
    sheetsSetupPromise = (async () => {
      let spreadsheet = await sheetsClient.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        fields: 'sheets.properties(sheetId,title)'
      });
      let exists = spreadsheet.data.sheets?.some(sheet => sheet.properties?.title === SHEET_TITLE);
      if (!exists) {
        try {
          await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TITLE } } }] }
          });
        } catch (error) {
          spreadsheet = await sheetsClient.spreadsheets.get({
            spreadsheetId: SPREADSHEET_ID,
            fields: 'sheets.properties(sheetId,title)'
          });
          exists = spreadsheet.data.sheets?.some(sheet => sheet.properties?.title === SHEET_TITLE);
          if (!exists) throw error;
        }
      }

      const headerRange = `${quoteSheetTitle(SHEET_TITLE)}!A1:E1`;
      const header = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: headerRange
      });
      if (!header.data.values?.length || header.data.values[0].every(value => !value)) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: headerRange,
          valueInputOption: 'RAW',
          requestBody: { values: [['matchId', 'bot1', 'bot2', 'winner', 'playedAt']] }
        });
      }
    })().catch(error => {
      sheetsSetupPromise = null;
      throw error;
    });
  }
  await sheetsSetupPromise;
  return sheetsClient;
}

async function flushOneBatch() {
  if (USE_MEMORY_QUEUE) {
    if (memoryWorkerActive || Date.now() - memoryLastAppendAt < MIN_APPEND_INTERVAL_MS) return;
    memoryWorkerActive = true;
    const records = memoryProcessing.length
      ? memoryProcessing.slice(0, BATCH_SIZE)
      : memoryQueue.splice(0, BATCH_SIZE);
    if (!memoryProcessing.length) memoryProcessing.push(...records);
    try {
      if (!memoryProcessing.length) return;
      const sheets = await getOrCreateSheets();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: SHEET_RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: memoryProcessing.slice(0, BATCH_SIZE).map(record => [
            record.matchId, record.bot1, record.bot2, record.winner, record.playedAt
          ])
        }
      });
      memoryProcessing.splice(0, BATCH_SIZE);
      memoryLastAppendAt = Date.now();
      console.info(`Appended ${records.length} match results to Google Sheets.`);
    } finally {
      memoryWorkerActive = false;
    }
    return;
  }

  const client = getRedis();
  const token = crypto.randomUUID();
  const acquired = await acquireLock(client, token);
  if (acquired !== 'OK') return;

  try {
    const processingCount = await client.llen(PROCESSING_KEY);
    if (!processingCount) {
      const pendingCount = await client.llen(QUEUE_KEY);
      if (!pendingCount) return;
      await client.eval(moveBatchScript, 2, QUEUE_KEY, PROCESSING_KEY, String(BATCH_SIZE));
    }

    const records = (await client.lrange(PROCESSING_KEY, 0, BATCH_SIZE - 1)).reverse();
    if (!records.length) return;
    if (!(await reserveAppendSlot(client))) return;
    const sheets = await getOrCreateSheets();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: SHEET_RANGE,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: records.map(serialized => {
          const record = JSON.parse(serialized);
          return [record.matchId, record.bot1, record.bot2, record.winner, record.playedAt];
        })
      }
    });
    await client.del(PROCESSING_KEY);
    console.info(`Appended ${records.length} match results to Google Sheets.`);
  } finally {
    await client.eval(releaseLockScript, 1, LOCK_KEY, token);
  }
}

function startWorker() {
  if (workerTimer || !process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  if (USE_MEMORY_QUEUE) {
    console.warn('Match result queue is in memory only; queued results are lost if this process stops.');
  } else {
    const client = getRedis();
    client.on('ready', () => console.info('Match result Redis queue is ready.'));
  }
  workerTimer = setInterval(async () => {
    if (workerActive) return;
    workerActive = true;
    try {
      await flushOneBatch();
    } catch (error) {
      console.error('Google Sheets batch append failed; batch retained for retry:', error.message);
    } finally {
      workerActive = false;
    }
  }, FLUSH_INTERVAL_MS);
  workerTimer.unref();
}

async function stopWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  if (redis) {
    await redis.quit().catch(error => console.error('Could not close result queue:', error.message));
    redis = null;
  }
}

module.exports = { router, startWorker, stopWorker, validateRecord, enqueueMatchResults };
