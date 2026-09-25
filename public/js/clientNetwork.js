window.ClientNetwork = class {
  constructor(onMessage) { this.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); this.socket.addEventListener('message', event => onMessage(JSON.parse(event.data))); }
  send(type, payload = {}) { this.socket.send(JSON.stringify({ type, ...payload })); }
};
