#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const TournamentManager = require(path.join(projectRoot, 'src', 'tournamentManager'));
const { runMatch } = require(path.join(projectRoot, 'src', 'matchRunner'));

function parseArgs(argv) {
  const args = { inputDir: null, options: {} };
  const opts = args.options;
  opts.mode = 'army';
  opts.maxTurns = 300;
  opts.poolSize = 20;
  opts.advance = 2;
  opts.concurrency = Number(process.env.TOURNAMENT_CONCURRENCY) || 2;
  opts.python = process.env.PYTHON_BIN || null;
  opts.metadata = null;
  opts.output = null;
  opts.format = 'swiss';
  opts.validateOnly = false;
  opts.dryRun = false;
  opts.sandboxed = true;

  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--mode') { opts.mode = argv[++i]; continue; }
    if (token === '--max-turns') { opts.maxTurns = Number(argv[++i]); continue; }
    if (token === '--pool-size') { opts.poolSize = Number(argv[++i]); continue; }
    if (token === '--advance') { opts.advance = Number(argv[++i]); continue; }
    if (token === '--concurrency') { opts.concurrency = Number(argv[++i]); continue; }
    if (token === '--python') { opts.python = argv[++i]; continue; }
    if (token === '--metadata') { opts.metadata = argv[++i]; continue; }
    if (token === '--output') { opts.output = argv[++i]; continue; }
    if (token === '--format') { opts.format = argv[++i]; continue; }
    if (token === '--validate-only') { opts.validateOnly = true; continue; }
    if (token === '--dry-run') { opts.dryRun = true; continue; }
    if (token === '--no-sandbox') { opts.sandboxed = false; continue; }
    if (token.startsWith('--')) throw new Error(`Unknown option: ${token}`);
    rest.push(token);
  }
  if (!rest.length) throw new Error('Usage: node tools/batch-intake.js <inputDir> [options]');
  args.inputDir = path.resolve(rest[0]);
  if (!opts.output) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    opts.output = path.join(projectRoot, 'matches', 'batch-results', stamp);
  } else {
    opts.output = path.resolve(opts.output);
  }
  return args;
}

function detectPython() {
  const candidates = [process.env.PYTHON_BIN, 'python', 'python3', 'py'].filter(Boolean);
  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
      if (result.status === 0) return cmd;
    } catch (error) {
      // try next
    }
  }
  return null;
}

function collectPythonFiles(dir) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectPythonFiles(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) result.push(full);
  }
  return result.sort();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadMetadata(metadataPath) {
  if (!metadataPath) return null;
  const resolved = path.resolve(metadataPath);
  if (!fs.existsSync(resolved)) throw new Error(`Metadata file not found: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();
  if (ext === '.json') {
    const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return normalizeMetadata(value);
  }
  if (ext === '.csv') {
    const text = fs.readFileSync(resolved, 'utf8');
    return normalizeMetadata(parseCsv(text));
  }
  throw new Error('Metadata must be .json or .csv');
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
  if (!lines.length) return [];
  const rows = lines.map(splitCsvLine);
  const header = rows[0].map(cell => cell.trim());
  const data = rows.slice(1);
  return data.map(row => {
    const record = {};
    header.forEach((name, index) => { record[name] = (row[index] || '').trim(); });
    return record;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function normalizeMetadata(value) {
  const rows = Array.isArray(value) ? value : (value && Array.isArray(value.rows) ? value.rows : []);
  if (!Array.isArray(rows)) throw new Error('Metadata JSON must be an array of records.');
  return rows;
}

function findColumn(record, patterns) {
  const keys = Object.keys(record);
  for (const pattern of patterns) {
    const key = keys.find(k => pattern.test(k.toLowerCase()));
    if (key) return key;
  }
  return null;
}

function buildMetadataMap(metadataRows, files) {
  if (!metadataRows || !metadataRows.length) return new Map();
  const fileKey = findColumn(metadataRows[0], [/file/, /filename/, /submission/, /bot/]);
  const nameKey = findColumn(metadataRows[0], [/name/]);
  const studentKey = findColumn(metadataRows[0], [/student/, /mssv/, /id/]);
  const emailKey = findColumn(metadataRows[0], [/email/, /mail/]);

  const map = new Map();
  let ordered = false;
  if (!fileKey) ordered = true;

  if (ordered) {
    const sortedFiles = [...files].sort();
    metadataRows.forEach((row, index) => {
      if (index >= sortedFiles.length) return;
      map.set(path.basename(sortedFiles[index]), {
        name: nameKey ? row[nameKey] : null,
        studentId: studentKey ? row[studentKey] : null,
        email: emailKey ? row[emailKey] : null
      });
    });
    return map;
  }

  for (const row of metadataRows) {
    const rawFile = row[fileKey];
    if (!rawFile) continue;
    const base = path.basename(String(rawFile).trim());
    map.set(base, {
      name: nameKey ? row[nameKey] : null,
      studentId: studentKey ? row[studentKey] : null,
      email: emailKey ? row[emailKey] : null
    });
  }
  return map;
}

function validateFile(filePath, pythonCmd) {
  const stats = fs.statSync(filePath);
  if (stats.size === 0) return { ok: false, reason: 'empty file' };
  if (stats.size > 1024 * 1024) return { ok: false, reason: 'file larger than 1 MB' };
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, reason: `cannot read as UTF-8: ${error.message}` };
  }
  if (!source.trim()) return { ok: false, reason: 'file contains only whitespace' };

  if (pythonCmd) {
    const result = spawnSync(pythonCmd, ['-m', 'py_compile', filePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000
    });
    if (result.status !== 0) {
      const stderr = (result.stderr || Buffer.from('')).toString('utf8').trim();
      return { ok: false, reason: `Python syntax error: ${stderr || `exit ${result.status}`}` };
    }
  }

  return { ok: true, source, sha256: crypto.createHash('sha256').update(source, 'utf8').digest('hex') };
}

function sanitizeName(name, fallback) {
  const value = String(name || '').trim().slice(0, 60);
  return value || fallback;
}

function waitForCompletion(manager, id) {
  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      const tournament = manager.read(id);
      if (!tournament) {
        clearInterval(interval);
        reject(new Error(`Tournament ${id} disappeared.`));
        return;
      }
      const completed = (tournament.matches || []).filter(match => match.status === 'completed').length;
      const total = (tournament.matches || []).length;
      process.stdout.write(`\r    ${completed}/${total} matches (round ${tournament.currentRound || 1}/${tournament.totalRounds || '?'})`);
      if (tournament.status === 'completed') {
        clearInterval(interval);
        process.stdout.write('\n');
        resolve(tournament);
      } else if (tournament.status === 'failed') {
        clearInterval(interval);
        process.stdout.write('\n');
        reject(new Error(tournament.error || 'Tournament failed.'));
      }
    }, 1000);
  });
}

function standingsToCsv(standings, botLookup) {
  const header = ['rank', 'botId', 'name', 'studentId', 'email', 'played', 'wins', 'draws', 'losses', 'byes', 'points', 'buchholz', 'headToHeadPoints'];
  const lines = [header.join(',')];
  standings.forEach((row, index) => {
    const bot = botLookup.get(row.botId) || {};
    const values = [
      index + 1,
      row.botId,
      csvEscape(bot.name || row.name),
      csvEscape(bot.studentId || ''),
      csvEscape(bot.email || ''),
      row.played,
      row.wins,
      row.draws,
      row.losses,
      row.byes,
      row.points,
      row.buchholz,
      row.headToHeadPoints
    ];
    lines.push(values.join(','));
  });
  return `${lines.join('\n')}\n`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function copyDirectoryContents(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectoryContents(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

async function main() {
  const { inputDir, options } = parseArgs(process.argv.slice(2));
  const pythonCmd = options.python || detectPython();

  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Input directory not found: ${inputDir}`);
  }
  if (!['classic', 'tactical', 'army'].includes(options.mode)) {
    throw new Error('Mode must be classic, tactical, or army.');
  }
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 20 || options.maxTurns > 2000) {
    throw new Error('Turn limit must be between 20 and 2000.');
  }
  if (!Number.isInteger(options.poolSize) || options.poolSize < 2) {
    throw new Error('Pool size must be at least 2.');
  }
  if (!Number.isInteger(options.advance) || options.advance < 1) {
    throw new Error('Advance count must be at least 1.');
  }

  const files = collectPythonFiles(inputDir);
  if (!files.length) throw new Error(`No .py files found in ${inputDir}`);

  console.log(`Found ${files.length} Python file(s) in ${inputDir}`);
  if (pythonCmd) console.log(`Using Python for syntax validation: ${pythonCmd}`);
  else console.warn('Python not found; syntax validation will be skipped.');

  const metadataRows = loadMetadata(options.metadata);
  const metadataMap = buildMetadataMap(metadataRows, files);

  const accepted = [];
  const rejected = [];
  const seenHashes = new Map();

  for (const filePath of files) {
    const base = path.basename(filePath);
    const meta = metadataMap.get(base) || {};
    const validation = validateFile(filePath, pythonCmd);
    if (!validation.ok) {
      rejected.push({ file: filePath, reason: validation.reason });
      console.log(`  REJECT ${base}: ${validation.reason}`);
      continue;
    }
    if (seenHashes.has(validation.sha256)) {
      rejected.push({ file: filePath, reason: `duplicate of ${seenHashes.get(validation.sha256)}` });
      console.log(`  REJECT ${base}: duplicate content`);
      continue;
    }
    seenHashes.set(validation.sha256, base);

    const fallbackName = base.replace(/\.py$/i, '').replace(/[_-]+/g, ' ').trim();
    const displayName = sanitizeName(meta.name, fallbackName || base);
    const bot = {
      id: crypto.randomUUID(),
      name: displayName,
      displayName,
      studentId: meta.studentId || null,
      email: meta.email || null,
      sourceFile: filePath,
      sha256: validation.sha256,
      size: fs.statSync(filePath).size
    };
    accepted.push(bot);
    console.log(`  OK     ${base} -> ${displayName}${bot.studentId ? ` (${bot.studentId})` : ''}`);
  }

  const validationReport = {
    inputDir,
    totalFiles: files.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejectedDetails: rejected,
    generatedAt: new Date().toISOString()
  };

  const outputDir = options.output;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'validation.json'), `${JSON.stringify(validationReport, null, 2)}\n`, 'utf8');

  if (options.validateOnly) {
    console.log(`\nValidation complete: ${accepted.length} accepted, ${rejected.length} rejected. Report: ${path.join(outputDir, 'validation.json')}`);
    return;
  }
  if (accepted.length < 2) {
    throw new Error('Need at least 2 valid bots to run a tournament.');
  }

  // Stage validated bots so the run is self-contained.
  const submissionsDir = path.join(outputDir, 'submissions');
  fs.mkdirSync(submissionsDir, { recursive: true });
  for (const bot of accepted) {
    const stagedPath = path.join(submissionsDir, `${bot.id}.py`);
    fs.copyFileSync(bot.sourceFile, stagedPath);
    fs.writeFileSync(path.join(submissionsDir, `${bot.id}.json`), `${JSON.stringify({
      id: bot.id, name: bot.displayName, originalFile: path.basename(bot.sourceFile),
      studentId: bot.studentId, email: bot.email, sha256: bot.sha256,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, 'utf8');
    bot.stagedPath = stagedPath;
  }

  // Organize into pools.
  const sorted = [...accepted].sort((a, b) => {
    const aKey = a.studentId || a.displayName;
    const bKey = b.studentId || b.displayName;
    return String(aKey).localeCompare(String(bKey));
  });
  const pools = [];
  for (let i = 0; i < sorted.length; i += options.poolSize) {
    pools.push(sorted.slice(i, i + options.poolSize));
  }
  // Avoid a trailing singleton pool by merging it into the previous pool.
  if (pools.length > 1 && pools[pools.length - 1].length < 2) {
    const trailing = pools.pop();
    pools[pools.length - 1].push(...trailing);
  }
  if (pools.some(pool => pool.length < 2)) {
    throw new Error('A pool has fewer than 2 bots; reduce pool size or add more submissions.');
  }

  console.log(`\nOrganized ${accepted.length} bots into ${pools.length} pool(s): ${pools.map(p => p.length).join(', ')}`);

  if (options.dryRun) {
    const plan = pools.map((pool, index) => ({
      pool: index + 1,
      bots: pool.map(bot => ({ id: bot.id, name: bot.displayName, studentId: bot.studentId }))
    }));
    fs.writeFileSync(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    console.log(`Dry run: plan written to ${path.join(outputDir, 'plan.json')}`);
    return;
  }

  const tournamentDir = path.join(outputDir, 'tournaments');
  fs.mkdirSync(tournamentDir, { recursive: true });

  const botLookup = new Map(accepted.map(bot => [bot.id, bot]));
  const runResults = [];

  for (let poolIndex = 0; poolIndex < pools.length; poolIndex++) {
    const pool = pools[poolIndex];
    const poolNumber = poolIndex + 1;
    console.log(`\n=== Pool ${poolNumber}/${pools.length}: ${pool.length} bots ===`);

    const poolBotMap = new Map(pool.map(bot => [bot.id, bot]));
    const manager = new TournamentManager(tournamentDir, {
      resolveBot: id => {
        const bot = poolBotMap.get(id);
        if (!bot) return null;
        return {
          id: bot.id,
          name: bot.displayName,
          script: bot.stagedPath,
          sha256: bot.sha256,
          untrusted: options.sandboxed
        };
      },
      runMatch,
      maxBots: 100000,
      autoStart: true,
      maxConcurrentMatches: options.concurrency
    });

    const tournament = manager.create({
      name: `Batch pool ${poolNumber} (${options.mode})`,
      botIds: pool.map(bot => bot.id),
      mode: options.mode,
      maxTurns: options.maxTurns,
      format: options.format === 'swiss' ? 'swiss' : options.format
    });

    console.log(`Tournament ${tournament.id}: ${tournament.totalRounds || '?'} rounds`);
    await waitForCompletion(manager, tournament.id);

    const finalTournament = manager.read(tournament.id);
    const standings = manager.standings(finalTournament);
    const standingsPath = path.join(outputDir, `standings-pool-${poolNumber}.csv`);
    fs.writeFileSync(standingsPath, standingsToCsv(standings, botLookup), 'utf8');
    fs.writeFileSync(path.join(outputDir, `standings-pool-${poolNumber}.json`), `${JSON.stringify(standings, null, 2)}\n`, 'utf8');

    runResults.push({
      pool: poolNumber,
      tournamentId: tournament.id,
      botCount: pool.length,
      totalRounds: finalTournament.totalRounds,
      champion: finalTournament.champion || standings[0]?.name || null,
      standings: standings.map(row => ({ botId: row.botId, name: row.name, points: row.points, rank: standings.indexOf(row) + 1 }))
    });

    console.log(`Pool ${poolNumber} champion: ${runResults[runResults.length - 1].champion}`);
  }

  // Optional final across pools.
  let finalResult = null;
  if (pools.length > 1 && options.advance > 0) {
    const finalists = [];
    for (let poolIndex = 0; poolIndex < pools.length; poolIndex++) {
      const poolNumber = poolIndex + 1;
      const pool = pools[poolIndex];
      const tournamentId = runResults[poolIndex].tournamentId;
      const manager = new TournamentManager(tournamentDir, {
        resolveBot: id => {
          const bot = botLookup.get(id);
          if (!bot) return null;
          return { id: bot.id, name: bot.displayName, script: bot.stagedPath, sha256: bot.sha256, untrusted: options.sandboxed };
        },
        runMatch,
        maxBots: 100000,
        autoStart: false,
        maxConcurrentMatches: options.concurrency
      });
      const tournament = manager.read(tournamentId);
      const standings = manager.standings(tournament);
      const top = standings.slice(0, options.advance).map(row => row.botId);
      for (const botId of top) {
        const bot = botLookup.get(botId);
        if (bot && !finalists.some(item => item.id === bot.id)) finalists.push(bot);
      }
    }

    if (finalists.length >= 2) {
      console.log(`\n=== Final: ${finalists.length} bots from ${pools.length} pools ===`);
      const finalistMap = new Map(finalists.map(bot => [bot.id, bot]));
      const manager = new TournamentManager(tournamentDir, {
        resolveBot: id => {
          const bot = finalistMap.get(id);
          if (!bot) return null;
          return { id: bot.id, name: bot.displayName, script: bot.stagedPath, sha256: bot.sha256, untrusted: options.sandboxed };
        },
        runMatch,
        maxBots: 100000,
        autoStart: true,
        maxConcurrentMatches: options.concurrency
      });
      const tournament = manager.create({
        name: `Batch final (${options.mode})`,
        botIds: finalists.map(bot => bot.id),
        mode: options.mode,
        maxTurns: options.maxTurns,
        format: 'swiss'
      });
      console.log(`Final tournament ${tournament.id}`);
      await waitForCompletion(manager, tournament.id);
      const finalTournament = manager.read(tournament.id);
      const standings = manager.standings(finalTournament);
      fs.writeFileSync(path.join(outputDir, 'standings-final.csv'), standingsToCsv(standings, botLookup), 'utf8');
      fs.writeFileSync(path.join(outputDir, 'standings-final.json'), `${JSON.stringify(standings, null, 2)}\n`, 'utf8');
      finalResult = {
        tournamentId: tournament.id,
        botCount: finalists.length,
        champion: finalTournament.champion || standings[0]?.name || null,
        standings: standings.map(row => ({ botId: row.botId, name: row.name, points: row.points }))
      };
      console.log(`Final champion: ${finalResult.champion}`);
    }
  }

  // Copy replay artifacts for distribution.
  const replaySource = path.join(tournamentDir, 'replays');
  const replayDest = path.join(outputDir, 'replays');
  copyDirectoryContents(replaySource, replayDest);

  const summary = {
    generatedAt: new Date().toISOString(),
    inputDir,
    outputDir,
    mode: options.mode,
    maxTurns: options.maxTurns,
    poolSize: options.poolSize,
    pools: runResults,
    final: finalResult,
    validation: validationReport,
    replayDir: replayDest
  };
  fs.writeFileSync(path.join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(`\nBatch run complete. Results: ${outputDir}`);
  console.log(`  validation.json, standings-pool-*.csv/json, ${finalResult ? 'standings-final.csv/json, ' : ''}summary.json, replays/`);
}

main().catch(error => {
  console.error(`\nBatch intake failed: ${error.message}`);
  process.exitCode = 1;
});