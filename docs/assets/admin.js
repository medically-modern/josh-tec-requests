'use strict';
/* Admin dashboard */

$('#logoMark').innerHTML = LOGO_SVG;
$('#logoMark2').innerHTML = LOGO_SVG;

const KEY_STORE = 'mm_admin_key';
let adminKey = '';
let allRequests = [];
let allServices = [];
let currentView = 'inbox';
let currentDetailId = null;
let emailMode = 'manual';

// ---------------------------------------------------------------------------
// Key handling: accept #key=XXX or #XXX in the URL, else localStorage.
(function initKey() {
  const hash = window.location.hash.replace(/^#/, '');
  const fromHash = hash.startsWith('key=') ? hash.slice(4) : hash;
  if (fromHash && fromHash.length >= 16) {
    try { adminKey = decodeURIComponent(fromHash); } catch { adminKey = fromHash; }
    try { localStorage.setItem(KEY_STORE, adminKey); } catch { /* private mode */ }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  } else {
    try { adminKey = localStorage.getItem(KEY_STORE) || ''; } catch { /* private mode */ }
  }
})();

function adminApi(path, opts = {}) {
  opts.headers = Object.assign({}, opts.headers, { 'x-admin-key': adminKey });
  return api(path, opts);
}

function showKeyScreen(bad) {
  $('#keyScreen').classList.remove('hidden');
  $('#dash').classList.add('hidden');
  $('#keyError').style.display = bad ? 'block' : 'none';
}

$('#keyGo').addEventListener('click', async () => {
  adminKey = $('#keyInput').value.trim();
  if (!adminKey) return;
  try { localStorage.setItem(KEY_STORE, adminKey); } catch { /* private mode */ }
  boot();
});
$('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#keyGo').click(); });

$('#logoutBtn').addEventListener('click', () => {
  try { localStorage.removeItem(KEY_STORE); } catch { /* private mode */ }
  adminKey = '';
  showKeyScreen(false);
});

// ---------------------------------------------------------------------------
// Boot + data refresh
async function boot() {
  if (!adminKey) return showKeyScreen(false);
  try {
    await refreshAll(true);
  } catch (err) {
    if (String(err.message).includes('Unauthorized')) return showKeyScreen(true);
    toast(err.message, 'err');
    return showKeyScreen(true);
  }
  $('#keyScreen').classList.add('hidden');
  $('#dash').classList.remove('hidden');
  // Deep link from notification emails: admin.html?req=<id>
  const reqId = new URLSearchParams(window.location.search).get('req');
  if (reqId) {
    history.replaceState(null, '', window.location.pathname);
    openDetail(reqId);
  }
}

async function refreshAll(silent) {
  const [reqData, svcData, health] = await Promise.all([
    adminApi('/api/admin/requests'),
    adminApi('/api/admin/services'),
    api('/api/health').catch(() => ({ email_mode: 'manual' })),
  ]);
  allRequests = reqData.requests || [];
  allServices = svcData.services || [];
  emailMode = health.email_mode || 'manual';
  $('#emailModeBanner').classList.toggle('hidden', emailMode !== 'manual');
  renderCounts();
  renderServiceFilter();
  renderView();
  const open = allRequests.filter((r) => r.status === 'open').length;
  const prog = allRequests.filter((r) => r.status === 'in_progress').length;
  $('#dashSub').textContent = `${open} open · ${prog} in progress · ${allRequests.length} total requests`;
  if (!silent) toast('Refreshed', 'ok');
}

$('#refreshBtn').addEventListener('click', () => refreshAll().catch((e) => toast(e.message, 'err')));
setInterval(() => {
  if (!document.hidden && adminKey && !$('#dash').classList.contains('hidden')) {
    refreshAll(true).catch(() => { /* transient */ });
  }
}, 120000);

function renderCounts() {
  const active = allRequests.filter((r) => r.status === 'open' || r.status === 'in_progress').length;
  const done = allRequests.filter((r) => r.status === 'completed').length;
  $('#cInbox').textContent = active;
  $('#cDone').textContent = done;
}

function renderServiceFilter() {
  const sel = $('#fService');
  const prev = sel.value;
  sel.innerHTML = '<option value="">All services</option>' +
    allServices.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  sel.value = prev;
}

// ---------------------------------------------------------------------------
// Navigation
$$('#nav button').forEach((b) => {
  b.addEventListener('click', () => {
    currentView = b.dataset.view;
    $$('#nav button').forEach((x) => x.classList.toggle('active', x === b));
    renderView();
  });
});

function renderView() {
  ['inbox', 'board', 'done', 'analytics', 'services'].forEach((v) => {
    $(`#view-${v}`).classList.toggle('hidden', v !== currentView);
  });
  if (currentView === 'inbox') renderInbox();
  if (currentView === 'board') renderBoard();
  if (currentView === 'done') renderDone();
  if (currentView === 'analytics') renderAnalytics();
  if (currentView === 'services') renderServices();
}

// ---------------------------------------------------------------------------
// Inbox
['fSearch', 'fService', 'fType', 'fSeverity', 'fStatus'].forEach((id) => {
  $(`#${id}`).addEventListener('input', renderInbox);
});

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function filteredInbox() {
  const q = $('#fSearch').value.trim().toLowerCase();
  const svc = $('#fService').value;
  const typ = $('#fType').value;
  const sev = $('#fSeverity').value;
  const st = $('#fStatus').value;
  return allRequests.filter((r) => {
    if (st === 'active' && !(r.status === 'open' || r.status === 'in_progress')) return false;
    if (st && st !== 'active' && r.status !== st) return false;
    if (svc && r.service_id !== svc) return false;
    if (typ && r.type !== typ) return false;
    if (sev && r.severity !== sev) return false;
    if (q && !`${r.ticket} ${r.title} ${r.submitter_name} ${r.submitter_email} ${r.service_name}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || (new Date(b.created_at) - new Date(a.created_at)));
}

function renderInbox() {
  if (currentView !== 'inbox') return;
  const rows = filteredInbox();
  $('#inboxEmpty').classList.toggle('hidden', rows.length > 0);
  $('#inboxRows').innerHTML = rows.map((r) => `
    <tr data-id="${esc(r.id)}">
      <td class="t-ticket">${esc(r.ticket)}</td>
      <td>${sevBadge(r.severity)}</td>
      <td>${typeBadge(r.type)}</td>
      <td><div class="t-title">${esc(r.title)}</div></td>
      <td class="t-sub">${esc(r.service_name)}</td>
      <td class="t-sub">${esc(r.submitter_name)}</td>
      <td class="t-sub">${r.screenshot_count ? `&#128206;${r.screenshot_count}` : ''}</td>
      <td class="t-sub nowrap">${esc(relTime(r.created_at))}</td>
      <td>${statusBadge(r.status)}</td>
    </tr>`).join('');
  $$('#inboxRows tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.id)));
}

// ---------------------------------------------------------------------------
// Board
function kcard(r) {
  return `<div class="kcard" data-id="${esc(r.id)}">
    <div class="flex" style="gap:6px">
      <span class="mono small" style="font-weight:700;color:var(--accent-dark)">${esc(r.ticket)}</span>
      ${sevBadge(r.severity)} ${typeBadge(r.type)}
    </div>
    <div class="k-title">${esc(r.title)}</div>
    <div class="k-meta">
      <span>${esc(r.service_name)}</span> · <span>${esc(r.submitter_name)}</span> · <span>${esc(relTime(r.created_at))}</span>
      ${r.screenshot_count ? `<span>&#128206;${r.screenshot_count}</span>` : ''}
    </div>
  </div>`;
}

function renderBoard() {
  const open = allRequests.filter((r) => r.status === 'open');
  const prog = allRequests.filter((r) => r.status === 'in_progress');
  const done = allRequests.filter((r) => r.status === 'completed').slice(0, 15);
  $('#kOpenN').textContent = open.length;
  $('#kProgN').textContent = prog.length;
  $('#kDoneN').textContent = done.length;
  $('#kOpen').innerHTML = open.map(kcard).join('') || '<div class="small faint center" style="padding:16px">Empty</div>';
  $('#kProg').innerHTML = prog.map(kcard).join('') || '<div class="small faint center" style="padding:16px">Empty</div>';
  $('#kDone').innerHTML = done.map(kcard).join('') || '<div class="small faint center" style="padding:16px">Empty</div>';
  $$('.kcard').forEach((c) => c.addEventListener('click', () => openDetail(c.dataset.id)));
}

// ---------------------------------------------------------------------------
// Completed
function renderDone() {
  const rows = allRequests
    .filter((r) => r.status === 'completed' || r.status === 'declined')
    .sort((a, b) => new Date(b.completed_at || b.updated_at) - new Date(a.completed_at || a.updated_at));
  $('#doneEmpty').classList.toggle('hidden', rows.length > 0);
  $('#doneRows').innerHTML = rows.map((r) => `
    <tr data-id="${esc(r.id)}">
      <td class="t-ticket">${esc(r.ticket)}</td>
      <td>${typeBadge(r.type)}</td>
      <td><div class="t-title">${esc(r.title)}</div></td>
      <td class="t-sub">${esc(r.service_name)}</td>
      <td class="t-sub">${esc(r.submitter_name)}</td>
      <td class="t-sub nowrap">${esc(r.completed_at ? fmtDate(r.completed_at) : '—')}</td>
      <td>${notifyBadge(r)}</td>
      <td>${statusBadge(r.status)}</td>
    </tr>`).join('');
  $$('#doneRows tr').forEach((tr) => tr.addEventListener('click', () => openDetail(tr.dataset.id)));
}

function notifyBadge(r) {
  if (r.status !== 'completed') return '<span class="badge badge-neutral">n/a</span>';
  if (r.notify_status === 'sent') return '<span class="badge badge-completed">✓ Emailed</span>';
  if (r.notify_status === 'failed') return '<span class="badge badge-critical">Email failed</span>';
  if (r.notify_status === 'manual') return '<span class="badge badge-medium">Manual email</span>';
  return '<span class="badge badge-neutral">Not notified</span>';
}

// ---------------------------------------------------------------------------
// Analytics
async function renderAnalytics() {
  const host = $('#statTiles');
  host.innerHTML = '<div class="loading-block"><span class="spinner dark"></span></div>';
  let stats;
  try {
    stats = await adminApi('/api/admin/stats');
  } catch (err) {
    host.innerHTML = `<div class="banner banner-error">${esc(err.message)}</div>`;
    return;
  }
  const byStatus = Object.fromEntries(stats.by_status.map((r) => [r.status, r.n]));
  const total = stats.by_status.reduce((a, r) => a + r.n, 0);
  const avgH = stats.avg_resolution_hours;
  const avgLabel = !avgH ? '—' : avgH < 24 ? `${avgH.toFixed(1)}h` : `${(avgH / 24).toFixed(1)}d`;
  host.innerHTML = `
    <div class="stat-tile"><div class="s-num">${total}</div><div class="s-label">Total requests</div></div>
    <div class="stat-tile"><div class="s-num" style="color:var(--blue)">${byStatus.open || 0}</div><div class="s-label">Open</div></div>
    <div class="stat-tile"><div class="s-num" style="color:var(--amber)">${byStatus.in_progress || 0}</div><div class="s-label">In progress</div></div>
    <div class="stat-tile"><div class="s-num" style="color:var(--green)">${byStatus.completed || 0}</div><div class="s-label">Completed</div></div>
    <div class="stat-tile"><div class="s-num">${avgLabel}</div><div class="s-label">Avg. time to complete</div></div>`;

  const barRows = (rows, labelKey, colorFn) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return rows.map((r) => `
      <div class="bar-row">
        <div class="b-label" title="${esc(r[labelKey])}">${esc(SEV_LABEL[r[labelKey]] || TYPE_LABEL[r[labelKey]] || r[labelKey])}</div>
        <div class="b-track"><div class="b-fill" style="width:${(r.n / max) * 100}%;${colorFn ? `background:${colorFn(r[labelKey])}` : ''}"></div></div>
        <div class="b-num">${r.n}</div>
      </div>`).join('') || '<div class="small faint">No data yet</div>';
  };
  $('#chartService').innerHTML = barRows(stats.by_service, 'name');
  const sevColor = (s) => ({ critical: 'var(--red)', high: 'var(--orange)', medium: 'var(--amber)', low: 'var(--slate)' }[s]);
  const sevSorted = [...stats.by_severity].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  $('#chartSeverity').innerHTML = barRows(sevSorted, 'severity', sevColor);
  const typeColor = (t) => (t === 'issue' ? '#be123c' : 'var(--indigo)');
  $('#chartType').innerHTML = barRows(stats.by_type, 'type', typeColor);

  // last 30 days sparkbars — bucketed by the admin's LOCAL calendar day
  const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const byDay = new Map();
  const cutoff = Date.now() - 30 * 86400000;
  allRequests.forEach((r) => {
    const t = new Date(r.created_at);
    if (t.getTime() < cutoff) return;
    const key = localKey(t);
    byDay.set(key, (byDay.get(key) || 0) + 1);
  });
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const key = localKey(new Date(Date.now() - i * 86400000));
    days.push({ key, n: byDay.get(key) || 0 });
  }
  const maxD = Math.max(1, ...days.map((d) => d.n));
  $('#chart30').innerHTML = days.map((d) =>
    `<div class="mc-bar" style="height:${Math.max(3, (d.n / maxD) * 100)}%" title="${esc(d.key)}: ${d.n}"></div>`).join('');
}

// ---------------------------------------------------------------------------
// Services
function renderServices() {
  $('#svcRows').innerHTML = allServices.map((s) => `
    <tr data-id="${esc(s.id)}" style="cursor:default">
      <td style="font-weight:600">${esc(s.name)}</td>
      <td class="t-sub">${esc(s.description || '')}</td>
      <td class="t-sub">${s.request_count || 0}</td>
      <td>${s.active ? '<span class="badge badge-completed">Active</span>' : '<span class="badge badge-neutral">Hidden</span>'}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-act="rename">Rename</button>
        <button class="btn btn-ghost btn-sm" data-act="toggle">${s.active ? 'Hide' : 'Show'}</button>
      </td>
    </tr>`).join('');
  $$('#svcRows button').forEach((b) => {
    b.addEventListener('click', async (e) => {
      const tr = e.target.closest('tr');
      const id = tr.dataset.id;
      const svc = allServices.find((x) => x.id === id);
      try {
        if (b.dataset.act === 'rename') {
          const name = prompt('Service name:', svc.name);
          if (!name || name === svc.name) return;
          await adminApi(`/api/admin/services/${id}`, { method: 'PATCH', body: { name } });
          toast('Service renamed', 'ok');
        } else {
          await adminApi(`/api/admin/services/${id}`, { method: 'PATCH', body: { active: !svc.active } });
          toast(svc.active ? 'Service hidden from the form' : 'Service visible again', 'ok');
        }
        await refreshAll(true);
      } catch (err) { toast(err.message, 'err'); }
    });
  });
}

$('#svcAdd').addEventListener('click', async () => {
  const name = $('#svcName').value.trim();
  const description = $('#svcDesc').value.trim();
  if (name.length < 2) return toast('Give the service a name (2+ characters)', 'err');
  try {
    await adminApi('/api/admin/services', { method: 'POST', body: { name, description } });
    $('#svcName').value = '';
    $('#svcDesc').value = '';
    toast(`Service "${name}" added`, 'ok');
    await refreshAll(true);
  } catch (err) { toast(err.message, 'err'); }
});

// ---------------------------------------------------------------------------
// Detail drawer
async function openDetail(id) {
  currentDetailId = id;
  $('#overlay').classList.add('show');
  $('#drawer').classList.add('show');
  $('#drawerBody').innerHTML = '<div class="loading-block"><span class="spinner dark"></span><div>Loading…</div></div>';
  let data;
  try {
    data = await adminApi(`/api/admin/requests/${id}`);
  } catch (err) {
    $('#drawerBody').innerHTML = `<div class="banner banner-error">${esc(err.message)}</div>`;
    return;
  }
  renderDetail(data);
}

const ACTION_META = {
  created: { cls: 'tl-created', label: 'Submitted' },
  status_changed: { cls: 'tl-status', label: 'Status changed' },
  email_sent: { cls: 'tl-email', label: 'Email sent' },
  email_pending: { cls: 'tl-status', label: 'Email pending' },
  note: { cls: 'tl-note', label: 'Note' },
  resolution_note: { cls: 'tl-note', label: 'Resolution note updated' },
};

function renderDetail(data) {
  const r = data.request;
  $('#dTicket').textContent = r.ticket;
  $('#dStatus').innerHTML = statusBadge(r.status);
  $('#dCreated').textContent = `Submitted ${fmtDate(r.created_at)} · ${relTime(r.created_at)}`;

  const links = (r.video_links || []);
  const shots = (r.screenshots || []);

  const actions = [];
  if (r.status === 'open') {
    actions.push('<button class="btn btn-warn" data-act="start">▶ Start progress</button>');
    actions.push('<button class="btn btn-success" data-act="complete">✓ Mark completed</button>');
    actions.push('<button class="btn btn-ghost" data-act="decline">Decline</button>');
  } else if (r.status === 'in_progress') {
    actions.push('<button class="btn btn-success" data-act="complete">✓ Mark completed</button>');
    actions.push('<button class="btn btn-ghost" data-act="reopen">Back to open</button>');
    actions.push('<button class="btn btn-ghost" data-act="decline">Decline</button>');
  } else {
    actions.push('<button class="btn btn-ghost" data-act="reopen">↩ Reopen</button>');
    if (r.status === 'completed') {
      actions.push(`<button class="btn btn-ghost" data-act="notify">&#9993; ${r.notify_status === 'sent' ? 'Re-send' : 'Send'} completion email</button>`);
    }
  }
  actions.push('<button class="btn btn-danger" data-act="delete">Delete</button>');

  $('#drawerBody').innerHTML = `
    <div class="d-section">
      <div class="flex flex-wrap" style="gap:8px">${typeBadge(r.type)} ${sevBadge(r.severity)} <span class="badge badge-neutral">${esc(r.service_name)}</span>
      ${r.status === 'completed' ? notifyBadge(r) : ''}</div>
      <h3 class="mt1" style="font-size:17px">${esc(r.title)}</h3>
      <div class="small muted">From <strong>${esc(r.submitter_name)}</strong> · <a href="mailto:${esc(r.submitter_email)}">${esc(r.submitter_email)}</a></div>
      ${r.completed_at ? `<div class="small muted">Completed ${esc(fmtDate(r.completed_at))}</div>` : ''}
    </div>

    <div class="d-section"><h4>Actions</h4><div class="d-actions">${actions.join('')}</div></div>

    <div class="d-section"><h4>Description</h4><pre class="d-pre">${esc(r.description)}</pre></div>
    ${r.steps ? `<div class="d-section"><h4>Steps to reproduce</h4><pre class="d-pre">${esc(r.steps)}</pre></div>` : ''}
    ${r.resolution_note ? `<div class="d-section" style="background:var(--green-soft)"><h4>Resolution note</h4><pre class="d-pre">${esc(r.resolution_note)}</pre></div>` : ''}

    ${shots.length ? `<div class="d-section"><h4>Screenshots (${shots.length})</h4>
      <div class="shot-grid">${shots.map((s) => `
        <a href="${esc(screenshotUrl(s))}" data-shot="1">
          <img src="${esc(screenshotUrl(s))}" alt="" loading="lazy">
          <div class="s-cap" title="${esc(s.filename)}">${esc(s.filename)} · ${fmtBytes(s.size_bytes)}</div>
        </a>`).join('')}</div></div>` : ''}

    ${links.length ? `<div class="d-section"><h4>Video links</h4>${links.map((l) =>
      `<div class="small" style="overflow-wrap:anywhere">&#127909; <a href="${esc(l)}" target="_blank" rel="noopener">${esc(l)}</a></div>`).join('')}</div>` : ''}

    <div class="d-section">
      <h4>Internal notes & activity</h4>
      <ul class="tl">${(data.activity || []).map((a) => {
        const meta = ACTION_META[a.action] || { cls: '', label: a.action };
        return `<li class="${meta.cls}">
          <div class="tl-text"><strong>${esc(meta.label)}</strong>${a.action === 'note' ? '' : a.detail ? ` — ${esc(a.detail)}` : ''}</div>
          ${a.action === 'note' ? `<div class="tl-note-body">${esc(a.detail)}</div>` : ''}
          <div class="tl-date">${esc(a.actor)} · ${esc(fmtDate(a.created_at))}</div>
        </li>`;
      }).join('')}</ul>
      <div class="flex mt1">
        <input type="text" id="noteInput" placeholder="Add an internal note (only you see this)…" maxlength="4000">
        <button class="btn btn-ghost" id="noteAdd">Add</button>
      </div>
    </div>`;

  // Wire actions
  $$('#drawerBody [data-act]').forEach((b) => b.addEventListener('click', () => handleAction(b.dataset.act, r)));
  $$('#drawerBody [data-shot]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    $('#lightboxImg').src = a.href;
    $('#lightbox').classList.add('show');
  }));
  const noteAdd = $('#noteAdd');
  if (noteAdd) {
    const submitNote = async () => {
      const note = $('#noteInput').value.trim();
      if (!note) return;
      try {
        await adminApi(`/api/admin/requests/${r.id}/notes`, { method: 'POST', body: { note } });
        toast('Note added', 'ok');
        openDetail(r.id);
      } catch (err) { toast(err.message, 'err'); }
    };
    noteAdd.addEventListener('click', submitNote);
    $('#noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitNote(); });
  }
}

async function handleAction(act, r) {
  try {
    if (act === 'start') {
      await adminApi(`/api/admin/requests/${r.id}`, { method: 'PATCH', body: { status: 'in_progress' } });
      toast(`${r.ticket} moved to In progress`, 'ok');
    } else if (act === 'reopen') {
      await adminApi(`/api/admin/requests/${r.id}`, { method: 'PATCH', body: { status: r.status === 'in_progress' ? 'open' : 'open' } });
      toast(`${r.ticket} reopened`, 'ok');
    } else if (act === 'complete') {
      return openCompleteModal(r, false);
    } else if (act === 'decline') {
      return openCompleteModal(r, true);
    } else if (act === 'notify') {
      const res = await adminApi(`/api/admin/requests/${r.id}/notify`, { method: 'POST' });
      handleEmailResult(res.email, r);
    } else if (act === 'delete') {
      if (!confirm(`Permanently delete ${r.ticket} and its screenshots? This cannot be undone.`)) return;
      await adminApi(`/api/admin/requests/${r.id}`, { method: 'DELETE' });
      toast(`${r.ticket} deleted`, 'ok');
      closeDrawer();
      await refreshAll(true);
      return;
    }
    await refreshAll(true);
    if (act !== 'delete') openDetail(r.id);
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Complete / decline modal
let modalCtx = null;

function openCompleteModal(r, isDecline) {
  modalCtx = { r, isDecline };
  $('#modalTitle').textContent = isDecline ? `Decline ${r.ticket}` : `Mark ${r.ticket} as completed`;
  $('#modalHint').textContent = isDecline
    ? 'Optionally note why this is being declined (kept internally; no email is sent for declines).'
    : "Add a short note about what was done — it's included in the email to the submitter.";
  $('#modalNote').value = r.resolution_note || '';
  $('#modalNotify').checked = !isDecline;
  $('#modalNotify').parentElement.style.display = isDecline ? 'none' : '';
  $('#modalNotifyLabel').textContent = emailMode === 'manual'
    ? 'Notify submitter (opens a prefilled email for you to send)'
    : `Email ${r.submitter_email} automatically`;
  $('#modalOk').textContent = isDecline ? 'Decline request' : 'Mark completed';
  $('#modalOk').className = isDecline ? 'btn btn-danger' : 'btn btn-success';
  $('#modalBack').classList.add('show');
}

$('#modalCancel').addEventListener('click', () => $('#modalBack').classList.remove('show'));
$('#modalBack').addEventListener('click', (e) => { if (e.target === $('#modalBack')) $('#modalBack').classList.remove('show'); });

$('#modalOk').addEventListener('click', async () => {
  const { r, isDecline } = modalCtx || {};
  if (!r) return;
  const btn = $('#modalOk');
  btn.disabled = true;
  try {
    const body = isDecline
      ? { status: 'declined', resolution_note: $('#modalNote').value.trim() }
      : { status: 'completed', resolution_note: $('#modalNote').value.trim(), skip_email: !$('#modalNotify').checked };
    const res = await adminApi(`/api/admin/requests/${r.id}`, { method: 'PATCH', body });
    $('#modalBack').classList.remove('show');
    if (isDecline) {
      toast(`${r.ticket} declined`, 'ok');
    } else {
      toast(`${r.ticket} marked completed 🎉`, 'ok');
      if (res.email) handleEmailResult(res.email, r);
    }
    await refreshAll(true);
    openDetail(r.id);
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
  }
});

function handleEmailResult(email, r) {
  if (!email) return;
  if (email.sent) {
    toast(`✓ Completion email sent to ${r.submitter_email}`, 'ok');
  } else if (email.mailto) {
    toast(email.mode === 'manual'
      ? 'Auto-email not configured — opening a prefilled email for you.'
      : `Auto-email failed (${email.error || 'unknown'}) — opening a prefilled email instead.`, 'err');
    window.open(email.mailto, '_blank');
  }
}

// ---------------------------------------------------------------------------
// Drawer / lightbox chrome
function closeDrawer() {
  $('#overlay').classList.remove('show');
  $('#drawer').classList.remove('show');
  currentDetailId = null;
}
$('#drawerClose').addEventListener('click', closeDrawer);
$('#overlay').addEventListener('click', closeDrawer);
$('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('show'));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('#lightbox').classList.contains('show')) $('#lightbox').classList.remove('show');
    else if ($('#modalBack').classList.contains('show')) $('#modalBack').classList.remove('show');
    else closeDrawer();
  }
});

// ---------------------------------------------------------------------------
// CSV export
$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/api/admin/export.csv`, { headers: { 'x-admin-key': adminKey } });
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `service-requests-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { toast(err.message, 'err'); }
});

boot();
