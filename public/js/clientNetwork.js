window.ClientNetwork = class {
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.listeners = new Map();
    this.pingInterval = null;
    this.latency = 0;
    this.connected = false;
    this.reconnectTimer = null;

    this.connect();
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host || 'localhost:3000';
    const wsUrl = `${protocol}//${host}`;

    try {
      this.socket = new WebSocket(wsUrl);

      this.socket.addEventListener('open', () => {
        this.connected = true;
        this.emit('open');
        this.startPing();
      });

      this.socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong' && data.time) {
            this.latency = Date.now() - data.time;
            this.emit('latency', this.latency);
            return;
          }
          this.emit(data.type, data);
          this.emit('*', data);
        } catch (err) {
          console.error('Failed to parse WebSocket message', err);
        }
      });

      this.socket.addEventListener('close', () => {
        this.connected = false;
        this.stopPing();
        this.emit('close');
      });

      this.socket.addEventListener('error', (err) => {
        this.emit('error', err);
      });
    } catch (err) {
      console.error('WebSocket connection error:', err);
    }
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(handler);
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      for (const handler of this.listeners.get(event)) {
        try {
          handler(data);
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err);
        }
      }
    }
  }

  send(type, payload = {}) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type, ...payload }));
    } else {
      console.warn('Socket not open. Queuing or dropping message:', type);
    }
  }

  startPing() {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.send('ping', { time: Date.now() });
    }, 5000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
};
