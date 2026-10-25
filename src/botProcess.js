const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;

function dockerArguments(script, containerName, image) {
  return [
    'run', '--rm', '--interactive', '--init',
    '--name', containerName,
    '--network', 'none',
    '--read-only',
    '--memory', '128m',
    '--memory-swap', '128m',
    '--cpus', '0.5',
    '--pids-limit', '32',
    '--ulimit', 'nofile=64:64',
    '--ulimit', 'nproc=32:32',
    '--ulimit', 'fsize=1048576:1048576',
    '--security-opt', 'no-new-privileges',
    '--cap-drop', 'ALL',
    '--user', '65534:65534',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--mount', `type=bind,source=${path.resolve(script)},target=/bot/main.py,readonly`,
    '--workdir', '/tmp',
    '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'PYTHONUNBUFFERED=1',
    image, 'python', '-I', '-S', '/bot/main.py'
  ];
}

class BotProcess {
  constructor(options = {}) {
    this.command = options.command || process.env.PYTHON_BIN || 'python';
    this.dockerCommand = options.dockerCommand || process.env.DOCKER_BIN || 'docker';
    this.dockerImage = options.dockerImage || process.env.BOT_DOCKER_IMAGE || 'boardgame-python-bot:latest';
    this.script = options.script || process.env.BOT_SCRIPT || 'bots/random_bot.py';
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs || 5000;
    this.sandboxed = Boolean(options.sandboxed);
    this.pending = null;
    this.closed = false;
    this.failureReported = false;
    this.process = null;
    this.outputBuffer = '';
    this.outputDecoder = new StringDecoder('utf8');
    this.stderrBytes = 0;
    this.stderrDecoder = new StringDecoder('utf8');
    this.containerName = this.sandboxed ? `boardgame-bot-${crypto.randomUUID()}` : null;
    this.containerKillStarted = false;
    this.spawnProcess = options.spawnProcess || spawn;
    this.onError = options.onError || (() => {});
  }

  start() {
    const command = this.sandboxed ? this.dockerCommand : this.command;
    const args = this.sandboxed
      ? dockerArguments(path.resolve(this.cwd || process.cwd(), this.script), this.containerName, this.dockerImage)
      : [this.script];
    this.process = this.spawnProcess(command, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout.on('data', chunk => this.handleOutput(chunk));
    this.process.stderr.on('data', chunk => this.handleStderr(chunk));
    this.process.on('error', error => this.fail(error));
    this.process.on('close', (code, signal) => {
      this.closed = true;
      if (this.pending) {
        this.fail(new Error(`Bot process exited (code=${code}, signal=${signal || 'none'}).`));
      }
    });
  }

  request(snapshot) {
    if (!this.process || this.closed) {
      return Promise.reject(new Error('Bot process is not running.'));
    }
    if (this.pending) {
      return Promise.reject(new Error('Bot already has a pending request.'));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('Bot response timed out.');
        this.fail(error);
      }, this.timeoutMs);

      this.outputBuffer = '';
      this.pending = { resolve, reject, timer };
      try {
        this.process.stdin.write(`${JSON.stringify(snapshot)}\n`, error => {
          if (error) this.fail(error);
        });
      } catch (error) {
        this.fail(error);
      }
    });
  }

  handleOutput(chunk) {
    this.outputBuffer += this.outputDecoder.write(chunk);
    if (Buffer.byteLength(this.outputBuffer, 'utf8') > MAX_RESPONSE_BYTES) {
      return this.fail(new Error('Bot response exceeded the 64 KB limit.'));
    }

    let newline;
    while ((newline = this.outputBuffer.indexOf('\n')) !== -1) {
      const line = this.outputBuffer.slice(0, newline).replace(/\r$/, '');
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      if (!this.pending) {
        return this.fail(new Error('Bot wrote output without a pending request.'));
      }
      this.handleResponse(line);
    }

    if (Buffer.byteLength(this.outputBuffer, 'utf8') > MAX_RESPONSE_BYTES) {
      this.fail(new Error('Bot response exceeded the 64 KB limit.'));
    }
  }

  handleStderr(chunk) {
    if (this.stderrBytes >= MAX_STDERR_BYTES) return;
    const remaining = MAX_STDERR_BYTES - this.stderrBytes;
    const text = this.stderrDecoder.write(chunk);
    const limitedText = Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8');
    this.stderrBytes += Buffer.byteLength(limitedText, 'utf8');
    if (limitedText) process.stderr.write(`[python-bot] ${limitedText}`);
  }

  handleResponse(line) {
    if (!this.pending) return;
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      this.fail(new Error(`Bot returned invalid JSON: ${error.message}`));
      return;
    }

    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  fail(error) {
    if (this.failureReported) return;
    this.failureReported = true;
    this.onError(error);
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.terminate();
  }

  killContainer(attempt = 0) {
    if (!this.containerName || this.containerKillStarted) return;
    this.containerKillStarted = true;
    let retryScheduled = false;
    const kill = () => {
      const killer = this.spawnProcess(this.dockerCommand, ['kill', this.containerName], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => retry());
      killer.once('close', code => {
        if (code !== 0) retry();
      });
    };
    const retry = () => {
      if (attempt >= 4 || retryScheduled) return;
      retryScheduled = true;
      setTimeout(() => {
        this.containerKillStarted = false;
        this.killContainer(attempt + 1);
      }, 100);
    };
    kill();
  }

  terminate() {
    this.closed = true;
    this.killContainer();
    if (this.process && !this.process.killed) {
      this.process.kill('SIGKILL');
    }
  }

  stop() {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('Bot process stopped.'));
    }
    this.terminate();
  }
}

BotProcess.dockerArguments = dockerArguments;

module.exports = BotProcess;
