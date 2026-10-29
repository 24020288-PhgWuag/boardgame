const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

test('reconnects with bounded retry and rejoins the last player room', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'clientNetwork.js'), 'utf8');
  const sockets = [];
  const pendingTimers = [];
  const stored = new Map();
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;

    constructor() {
      this.readyState = 0;
      this.handlers = new Map();
      this.sent = [];
      sockets.push(this);
    }

    addEventListener(name, handler) {
      const handlers = this.handlers.get(name) || [];
      handlers.push(handler);
      this.handlers.set(name, handlers);
    }

    emit(name, event = {}) {
      if (name === 'open') this.readyState = FakeWebSocket.OPEN;
      if (name === 'close') this.readyState = 3;
      for (const handler of this.handlers.get(name) || []) handler(event);
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.emit('close');
    }
  }

  const context = {
    window: {},
    location: { protocol: 'http:', host: 'localhost:3000' },
    WebSocket: FakeWebSocket,
    sessionStorage: {
      getItem: key => stored.get(key) || null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key)
    },
    console,
    setTimeout: callback => {
      pendingTimers.push(callback);
      return pendingTimers.length;
    },
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {}
  };
  vm.runInNewContext(source, context);

  const network = new context.window.ClientNetwork();
  sockets[0].emit('open');
  sockets[0].emit('message', {
    data: JSON.stringify({ type: 'joined', code: 'ABC123', player: 'p1' })
  });
  assert.equal(JSON.parse(stored.get('ott_active_room')).code, 'ABC123');

  sockets[0].emit('close');
  assert.equal(pendingTimers.length, 1);
  pendingTimers[0]();
  sockets[1].emit('open');

  assert.deepEqual(sockets[1].sent, [{
    type: 'join',
    code: 'ABC123',
    role: 'p1',
    reconnect: true
  }]);
  network.clearRoom();
  assert.equal(stored.has('ott_active_room'), false);
  network.stop();
});
