const readline = require('readline');
const { spawn } = require('child_process');

class BotProcess {
  constructor(options = {}) {
    this.command = options.command || process.env.PYTHON_BIN || 'python';
    this.script = options.script || process.env.BOT_SCRIPT || 'bots/random_bot.py';
    this.cwd = options.cwd;
    this.timeoutMs = options.timeoutMs || 5000;
    this.pending = null;
    this.closed = false;
    this.process = null;
    this.onError = options.onError || (() => {});
  }

  start() {
    this.process = spawn(this.command, [this.script], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    const output = readline.createInterface({ input: this.process.stdout });
    output.on('line', line => this.handleResponse(line));
    this.process.stderr.on('data', chunk => {
      process.stderr.write(`[python-bot] ${chunk}`);
    });
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
        this.pending = null;
        reject(new Error('Bot response timed out.'));
      }, this.timeoutMs);

      this.pending = { resolve, reject, timer };
      try {
        this.process.stdin.write(`${JSON.stringify(snapshot)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending = null;
        reject(error);
      }
    });
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
    this.onError(error);
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  stop() {
    this.closed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('Bot process stopped.'));
    }
    if (this.process && !this.process.killed) {
      this.process.kill();
    }
  }
}

module.exports = BotProcess;
