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

test('a stopped connection never reconnects or rejoins the room it left', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'clientNetwork.js'), 'utf8');
  const sockets = [];
  const pendingTimers = [];
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
      this.handlers.set(name, [...(this.handlers.get(name) || []), handler]);
    }

    removeEventListener(name, handler) {
      this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item !== handler));
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
  const stored = new Map([['ott_active_room', JSON.stringify({ code: 'ABC123', player: 'p1' })]]);
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
    setTimeout: callback => pendingTimers.push(callback),
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {}
  };
  vm.runInNewContext(source, context);

  const network = new context.window.ClientNetwork();
  sockets[0].emit('open');
  let calledAfterStop = false;
  network.on('probe', () => { calledAfterStop = true; });
  network.stop();

  assert.equal(pendingTimers.length, 0);
  assert.equal(sockets.length, 1);
  assert.deepEqual(sockets[0].sent, []);
  assert.equal(network.listeners.size, 0);
  assert.deepEqual([...sockets[0].handlers.values()].flat(), []);
  sockets[0].emit('message', { data: JSON.stringify({ type: 'probe' }) });
  assert.equal(calledAfterStop, false);
});

test('leaving a room waits for the server acknowledgement', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'clientNetwork.js'), 'utf8');
  const sockets = [];
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
      this.handlers.set(name, [...(this.handlers.get(name) || []), handler]);
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
  const stored = new Map([['ott_active_room', JSON.stringify({ code: 'ABC123', player: 'p1' })]]);
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
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {}
  };
  vm.runInNewContext(source, context);

  const network = new context.window.ClientNetwork();
  sockets[0].emit('open');
  const leaving = network.leaveRoom();

  assert.deepEqual(sockets[0].sent, [{ type: 'leave_room' }]);
  assert.equal(network.stopped, true);
  assert.equal(stored.has('ott_active_room'), false);
  sockets[0].emit('message', { data: JSON.stringify({ type: 'room-left' }) });
  assert.equal(await leaving, true);
  network.stop();
});

test('a late join response cannot restore room state after leaving starts', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'clientNetwork.js'), 'utf8');
  const sockets = [];
  const stored = new Map([['ott_active_room', JSON.stringify({ code: 'OLD123', player: 'p1' })]]);
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;

    constructor() {
      this.readyState = 0;
      this.handlers = new Map();
      sockets.push(this);
    }

    addEventListener(name, handler) {
      this.handlers.set(name, [...(this.handlers.get(name) || []), handler]);
    }

    send() {}

    close() {
      this.readyState = 3;
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
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {}
  };
  vm.runInNewContext(source, context);

  const network = new context.window.ClientNetwork();
  sockets[0].readyState = FakeWebSocket.OPEN;
  const joined = [];
  network.on('joined', data => joined.push(data));
  const leaving = network.leaveRoom(5);
  sockets[0].handlers.get('message')[0]({ data: JSON.stringify({
    type: 'joined',
    code: 'OLD123',
    player: 'p1'
  }) });

  assert.deepEqual(joined, []);
  assert.equal(stored.has('ott_active_room'), false);
  assert.equal(await leaving, false);
  network.stop();
});

test('loading the current user keeps the existing WebSocket connection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'auth.js'), 'utf8');
  const context = {
    window: {},
    fetch: async () => ({ ok: true, json: async () => ({ user: { id: 'user-1', username: 'alpha' } }) })
  };
  vm.runInNewContext(source, context);
  const notifications = [];
  context.window.Auth.onChange((user, options) => notifications.push({ user, options }));

  await context.window.Auth.load();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.preserveConnection, true);

  await context.window.Auth.login('alpha', 'password-123');
  assert.equal(notifications.length, 2);
  assert.equal(Boolean(notifications[1].options.preserveConnection), false);
});
