window.AdminDashboard = (() => {
  const toggleButton = document.getElementById('admin-dashboard-btn');
  const panel = document.getElementById('admin-dashboard');
  const status = document.getElementById('admin-dashboard-status');
  const metrics = document.getElementById('admin-dashboard-metrics');
  const users = document.getElementById('admin-dashboard-users');
  const events = document.getElementById('admin-dashboard-events');
  const eventStatus = document.getElementById('admin-dashboard-event-status');
  let isAdmin = false;
  let refreshTimer = null;

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Không thể thực hiện thao tác quản trị.');
    return data;
  }

  async function loadMetrics() {
    const data = await request('/api/admin/metrics');
    const values = [
      ['WebSocket', data.connections],
      ['Phòng', data.rooms],
      ['Phòng có người', data.roomsWithPlayers],
      ['RAM RSS', `${(data.memory.rssBytes / 1024 / 1024).toFixed(1)} MB`],
      ['CPU tiến trình', `${data.cpu.percent.toFixed(1)}%`],
      ['Bot đang chạy', data.botProcesses],
      ['Uptime', `${Math.floor(data.uptimeSeconds / 60)} phút`]
    ];
    metrics.innerHTML = values.map(([label, value]) => `
      <div style="padding:12px;border:1px solid var(--line);border-radius:8px">
        <small>${escapeHtml(label)}</small><div style="font-size:1.2rem;font-weight:700">${escapeHtml(value)}</div>
      </div>`).join('');
  }

  async function loadUsers() {
    const data = await request('/api/admin/users');
    const table = document.createElement('table');
    table.className = 'standings';
    table.innerHTML = '<thead><tr><th>Tài khoản</th><th>Hạng</th><th>ELO</th><th>Thắng / Trận</th><th>Ngày tạo</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const user of data.users) {
      const row = document.createElement('tr');
      for (const value of [
        user.username,
        user.isAdmin ? 'Admin' : user.rank,
        user.elo,
        `${user.wins}/${user.games}`,
        user.createdAt
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    users.replaceChildren(table);
  }

  async function loadEvents() {
    const data = await request('/api/community-tournaments');
    events.innerHTML = data.tournaments.length ? data.tournaments.map(event => `
      <article class="tournament-item">
        <strong>${escapeHtml(event.name)}</strong>
        <span class="muted"> · ${escapeHtml(event.status)} · ${event.players.length}/12</span>
        <ul>${event.players.map(player =>
          `<li>${escapeHtml(player.username)} — ${escapeHtml(player.botName || 'Đang chờ tải bot')}</li>`
        ).join('') || '<li class="muted">Chưa có người tham gia.</li>'}</ul>
        ${event.status === 'registration' ? `
          <button type="button" class="secondary-button" data-start-event="${escapeHtml(event.id)}"
            ${event.players.length < 2 || event.players.some(player => !player.botId) ? 'disabled' : ''}>
            Bắt đầu giải
          </button>` : ''}
      </article>`).join('') : '<p class="muted">Chưa có giải cộng đồng.</p>';
  }

  async function refresh() {
    if (!isAdmin || panel.classList.contains('hidden')) return;
    status.textContent = '';
    const results = await Promise.allSettled([loadMetrics(), loadUsers(), loadEvents()]);
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason.message);
    if (errors.length) status.textContent = errors.join(' ');
  }

  function show() {
    if (!isAdmin) return;
    panel.classList.remove('hidden');
    refresh().catch(error => { status.textContent = error.message; });
    if (!refreshTimer) refreshTimer = setInterval(() => {
      refresh().catch(error => { status.textContent = error.message; });
    }, 5000);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function hide() {
    panel.classList.add('hidden');
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function setRole(user) {
    const nextIsAdmin = Boolean(user?.isAdmin);
    toggleButton.classList.toggle('hidden', !nextIsAdmin);
    if (isAdmin && !nextIsAdmin) hide();
    isAdmin = nextIsAdmin;
    if (isAdmin) show();
  }

  toggleButton.addEventListener('click', () => {
    if (panel.classList.contains('hidden')) show();
    else hide();
  });
  document.getElementById('admin-dashboard-close').addEventListener('click', hide);

  document.getElementById('admin-dashboard-create-event').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    eventStatus.textContent = 'Đang tạo giải…';
    try {
      await request('/api/community-tournaments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.elements.name.value,
          mode: form.elements.mode.value,
          maxTurns: Number(form.elements.maxTurns.value)
        })
      });
      form.reset();
      eventStatus.textContent = 'Đã tạo giải đăng ký.';
      await loadEvents();
    } catch (error) {
      eventStatus.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  events.addEventListener('click', async event => {
    const button = event.target.closest('[data-start-event]');
    if (!button || !isAdmin) return;
    button.disabled = true;
    eventStatus.textContent = 'Đang bắt đầu giải…';
    try {
      await request(`/api/community-tournaments/${encodeURIComponent(button.dataset.startEvent)}/start`, {
        method: 'POST'
      });
      eventStatus.textContent = 'Đã bắt đầu giải.';
      await loadEvents();
    } catch (error) {
      eventStatus.textContent = error.message;
      button.disabled = false;
    }
  });

  return { setRole, show, hide };
})();
