window.Auth = (() => {
  let user = null;
  const listeners = new Set();

  function notify() {
    listeners.forEach(listener => listener(user));
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Không thể thực hiện yêu cầu.');
    return data;
  }

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUser() { return user; },
    async load() {
      const data = await request('/api/auth/me');
      user = data.user;
      notify();
      return user;
    },
    async register(username, password) {
      const data = await request('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      user = data.user;
      notify();
      return user;
    },
    async login(username, password) {
      const data = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      user = data.user;
      notify();
      return user;
    },
    async logout() {
      await request('/api/auth/logout', { method: 'POST' });
      user = null;
      notify();
    }
  };
})();
