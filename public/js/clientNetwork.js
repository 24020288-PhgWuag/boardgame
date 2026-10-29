window.ClientNetwork = class {
  constructor(options = {}) {
    this.options = options;
    this.socket = null;
    this.listeners = new Map();
    this.pingInterval = null;
    this.latency = 0;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.everConnected = false;
    this.stopped = false;

    this.connect();
  }

  connect() {
    if (this.stopped || (this.socket && this.socket.readyState < WebSocket.CLOSING)) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = location.host || 'localhost:3000';
    const wsUrl = `${protocol}//${host}`;

    try {
      this.socket = new WebSocket(wsUrl);

      this.socket.addEventListener('open', () => {
        const reconnecting = this.everConnected;
        this.everConnected = true;
        this.reconnectAttempts = 0;
        this.connected = true;
        this.emit('open');
        this.startPing();
        if (reconnecting) {
          this.rejoinRoom();
          this.emit('reconnect');
        }
      });

      this.socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'pong' && data.time) {
            this.latency = Date.now() - data.time;
            this.emit('latency', this.latency);
            return;
          }
          if (data.type === 'joined') this.rememberRoom(data);
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
        this.scheduleReconnect();
      });

      this.socket.addEventListener('error', (err) => {
        this.emit('error', err);
      });
    } catch (err) {
      console.error('WebSocket connection error:', err);
      this.scheduleReconnect();
    }
  }

  rememberRoom(data) {
    if (data.bot || data.botMatch || data.player === 'spectator') {
      this.clearRoom();
      return;
    }
    if (!data.code || !['p1', 'p2'].includes(data.player)) return;
    try {
      sessionStorage.setItem('ott_active_room', JSON.stringify({
        code: data.code,
        player: data.player
      }));
    } catch (error) {
      console.warn('Could not save room reconnection details:', error);
    }
  }

  rejoinRoom() {
    try {
      const activeRoom = JSON.parse(sessionStorage.getItem('ott_active_room') || 'null');
      if (activeRoom?.code) {
        this.send('join', {
          code: activeRoom.code,
          role: activeRoom.player,
          reconnect: true
        });
      }
    } catch (error) {
      console.warn('Could not restore the previous room:', error);
    }
  }

  clearRoom() {
    try {
      sessionStorage.removeItem('ott_active_room');
    } catch (error) {
      console.warn('Could not clear saved room details:', error);
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** this.reconnectAttempts), 15000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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

  stop() {
    this.stopped = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
  }
};
