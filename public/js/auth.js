window.Auth = (() => {
  let user = null;
  const listeners = new Set();

  function notify(options = {}) {
    listeners.forEach(listener => listener(user, options));
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Không thể thực hiện yêu cầu.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUser() { return user; },
    setUser(nextUser) {
      user = nextUser;
      notify({ preserveConnection: true });
    },
    async load() {
      const data = await request('/api/auth/me');
      user = data.user;
      // Kết nối WebSocket đã mang sẵn cookie phiên, không cần mở lại khi chỉ nạp thông tin.
      notify({ preserveConnection: true });
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
      const options = { method: 'POST', body: JSON.stringify({ username, password }) };
      let data;
      try {
        data = await request('/api/auth/login', options);
      } catch (error) {
        if (error.status !== 403) throw error;
        data = await request('/api/admin/login', options);
      }
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
