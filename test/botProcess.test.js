const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const BotProcess = require('../src/botProcess');
const { runMatch } = require('../src/matchRunner');

test('Docker runner uses resource and isolation restrictions', () => {
  const args = BotProcess.dockerArguments('C:\\bots\\player.py', 'bot-test', 'runner:test');
  const joined = args.join(' ');

  for (const expected of [
    '--network none', '--read-only', '--memory 128m', '--memory-swap 128m',
    '--cpus 0.5', '--pids-limit 32', '--cap-drop ALL',
    '--security-opt no-new-privileges', '--user 65534:65534',
    '--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m',
    'target=/bot/main.py,readonly', 'runner:test python -I -S /bot/main.py'
  ]) {
    assert.ok(joined.includes(expected), `Missing Docker restriction: ${expected}`);
  }
});

test('bot timeout rejects the request and force-kills the process', async () => {
  const child = new EventEmitter();
  child.stdin = {
    write(_value, callback) {
      callback();
    }
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = signal => {
    child.killed = true;
    child.killSignal = signal;
    return true;
  };

  const bot = new BotProcess({
    timeoutMs: 10,
    spawnProcess: () => child
  });
  bot.start();

  await assert.rejects(bot.request({ type: 'your_turn' }), /timed out/);
  assert.equal(child.killed, true);
  assert.equal(child.killSignal, 'SIGKILL');
});

test('match deadline stops both bots and returns a draw', async () => {
  const script = require('node:path').resolve(__dirname, '..', 'bots', 'random_bot.py');
  const result = await runMatch({
    maxTurns: 500,
    matchTimeoutMs: 1,
    botP1: { id: 'p1', script },
    botP2: { id: 'p2', script }
  });

  assert.equal(result.winner, null);
  assert.match(result.reason, /match exceeded/);
});
