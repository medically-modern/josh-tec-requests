'use strict';
/* Company change-request board — spreadsheet style, change requests only.
   Tabs (All / Tec Implementation / OPS Review), inline priority + category
   editing (persisted and synced everywhere), drag-to-reorder (persisted),
   and collaborative notes with document attachments. Click a row to expand
   the full ticket: description, attachments, email thread, activity. */

$('#logoMark').innerHTML = LOGO_SVG;

const reviewKey = new URLSearchParams(window.location.search).get('key') || '';
const keyQS = reviewKey ? `?key=${encodeURIComponent(reviewKey)}` : '';

const COLSPAN = 13;
const CATEGORY_LABEL = { tec_implementation: 'Tec Implementation', ops_review: 'OPS Review' };
const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const SEV_OPTS = ['critical', 'high', 'medium', 'low'];

// Most recent board payload (requests kept in display order) so inline edits,
// note additions and drags can update the view without a full refetch.
let lastData = null;
let currentTab = 'all'; // 'all' | 'tec_implementation' | 'ops_review'

function daysOpen(created) {
  const days = Math.floor((Date.now() - new Date(created).getTime()) / 86400000);
  return days < 1 ? '<1' : String(days);
}
function fmtDay(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const hasManualOrder = () => !!lastData && lastData.requests.some((r) => r.board_position !== null && r.board_position !== undefined);

// Client-side ordering mirrors the server: manual board_position first
// (unpositioned last), then priority (critical→low), then oldest first.
function sortRequests(arr) {
  return arr.sort((a, b) => {
    const aHas = a.board_position !== null && a.board_position !== undefined;
    const bHas = b.board_position !== null && b.board_position !== undefined;
    if (aHas && bHas && a.board_position !== b.board_position) return a.board_position - b.board_position;
    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    const s = SEV_RANK[a.severity] - SEV_RANK[b.severity];
    return s || (new Date(a.created_at) - new Date(b.created_at));
  });
}

function metaChips(r) {
  const bits = [];
  if (r.screenshot_count > 0) bits.push(`&#128206; ${r.screenshot_count} file${r.screenshot_count === 1 ? '' : 's'}`);
  if (r.video_count > 0) bits.push(`&#127909; ${r.video_count} video${r.video_count === 1 ? '' : 's'}`);
  if (r.message_count > 0) bits.push(`&#9993;&#65039; ${r.message_count} email${r.message_count === 1 ? '' : 's'}`);
  if (r.has_steps) bits.push('&#128221; steps');
  return bits.length ? `<div class="row-meta">${bits.join(' &middot; ')}</div>` : '';
}

// Notes cell — a 📝 count that reveals the notes on hover, plus a quick-add
// button. Mirrors the admin inbox's notes column so it works the same here.
function notesCellInner(r) {
  const n = (r.notes || []).length;
  return `${n ? `<button type="button" class="note-ind" title="Hover to read notes">&#128221; ${n}</button>` : ''}
    <button type="button" class="cell-btn note-add" title="Add a note or document">&#65291;</button>`;
}

function sevSelect(r) {
  return `<select class="cell-select sev-edit sev-${esc(r.severity)}" aria-label="Priority for ${esc(r.ticket)}">` +
    SEV_OPTS.map((s) => `<option value="${s}" ${r.severity === s ? 'selected' : ''}>${SEV_LABEL[s]}</option>`).join('') +
    '</select>';
}
function catSelect(r) {
  const cur = r.category || '';
  const opt = (v, label) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
  return `<select class="cell-select cat-edit ${cur ? `cat-${esc(cur)}` : 'cat-none'}" aria-label="Category for ${esc(r.ticket)}">` +
    opt('', '— Unassigned') + opt('tec_implementation', 'Tec Implementation') + opt('ops_review', 'OPS Review') +
    '</select>';
}

function requestRow(r, idx) {
  return `<tr class="sheet-row ${idx % 2 ? 'band' : ''} sev-${esc(r.severity)}" data-ticket="${esc(r.ticket)}" draggable="true" title="Drag to reorder · click to expand">
    <td class="col-drag" title="Drag to reorder">&#8942;&#8942;</td>
    <td class="col-ticket mono"><span class="caret">&#9656;</span>${esc(r.ticket)}</td>
    <td class="col-title">${esc(r.title)}${metaChips(r)}</td>
    <td class="col-desc">${esc(r.description)}</td>
    <td class="col-patient">${r.patient_name ? esc(r.patient_name) : '<span class="faint">—</span>'}</td>
    <td class="col-sev">${sevSelect(r)}</td>
    <td class="col-cat">${catSelect(r)}</td>
    <td class="col-status">${statusBadge(r.status)}</td>
    <td class="col-svc">${esc(r.service_name)}</td>
    <td class="col-by">${esc(r.submitter_name)}</td>
    <td class="col-date">${esc(fmtDay(r.created_at))}</td>
    <td class="col-days">${esc(daysOpen(r.created_at))}</td>
    <td class="col-notes t-notes">${notesCellInner(r)}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Tabs + rows

function visibleRequests() {
  const reqs = lastData ? lastData.requests : [];
  return currentTab === 'all' ? reqs : reqs.filter((r) => r.category === currentTab);
}

function renderTabs() {
  const reqs = lastData ? lastData.requests : [];
  const defs = [
    { key: 'all', label: 'All', count: reqs.length },
    { key: 'tec_implementation', label: 'Tec Implementation', count: reqs.filter((r) => r.category === 'tec_implementation').length },
    { key: 'ops_review', label: 'OPS Review', count: reqs.filter((r) => r.category === 'ops_review').length },
  ];
  $('#boardTabs').innerHTML = defs.map((t) =>
    `<button type="button" class="board-tab ${currentTab === t.key ? 'active' : ''}" data-tab="${t.key}">${esc(t.label)} <span class="tab-count">${t.count}</span></button>`
  ).join('');
  $$('#boardTabs .board-tab').forEach((b) => b.addEventListener('click', () => {
    currentTab = b.dataset.tab;
    renderTabs();
    renderRows();
  }));
}

function renderRows() {
  const rows = visibleRequests();
  if (!rows.length) {
    $('#sheetBody').innerHTML = `<tr class="sheet-empty"><td colspan="${COLSPAN}">No change requests${currentTab === 'all' ? '' : ' in this tab'} right now.</td></tr>`;
    return;
  }
  $('#sheetBody').innerHTML = rows.map((r, i) => requestRow(r, i)).join('');
  $$('#sheetBody tr.sheet-row').forEach((tr) => {
    const r = rows.find((x) => x.ticket === tr.dataset.ticket);
    if (r) { wireNotesCell(tr, r); wireRowControls(tr, r); }
  });
}

function resortAndRerender() {
  if (lastData) sortRequests(lastData.requests);
  renderRows();
}

function renderCounts() {
  const n = lastData ? lastData.requests.length : 0;
  $('#counts').innerHTML = `<span class="chip chip-change">${n} open change request${n === 1 ? '' : 's'}</span>`;
}

function render(data) {
  lastData = { requests: sortRequests((data.requests || []).slice()), generated_at: data.generated_at };
  renderCounts();
  $('#updatedAt').textContent = `Updated ${fmtDate(data.generated_at || new Date())}`;
  renderTabs();
  renderRows();
  $('#sheet').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Inline edits — priority + category. These PATCH the canonical record, so the
// change is reflected in the admin dashboard and everywhere else.

async function editTicket(ticket, body) {
  return api(`/api/review/${encodeURIComponent(ticket)}${keyQS}`, {
    method: 'PATCH',
    body: Object.assign({ actor: getAuthor() || 'Review' }, body),
  });
}

function wireRowControls(tr, r) {
  const sev = $('.sev-edit', tr);
  if (sev) sev.addEventListener('change', async () => {
    const val = sev.value;
    const prev = r.severity;
    try {
      await editTicket(r.ticket, { severity: val });
      r.severity = val;
      detailCache.delete(r.ticket); // activity timeline changed
      if (hasManualOrder()) {
        // Manual order is unaffected by priority — restyle in place.
        SEV_OPTS.forEach((s) => { tr.classList.remove(`sev-${s}`); sev.classList.remove(`sev-${s}`); });
        tr.classList.add(`sev-${val}`); sev.classList.add(`sev-${val}`);
      } else {
        resortAndRerender();
      }
      toast(`${r.ticket} priority → ${SEV_LABEL[val]}`, 'ok');
    } catch (err) { toast(err.message, 'err'); sev.value = prev; }
  });

  const cat = $('.cat-edit', tr);
  if (cat) cat.addEventListener('change', async () => {
    const val = cat.value || null;
    const prev = r.category || '';
    try {
      await editTicket(r.ticket, { category: val });
      r.category = val;
      detailCache.delete(r.ticket);
      renderTabs(); // counts changed
      if (currentTab !== 'all' && r.category !== currentTab) renderRows(); // left this tab
      else cat.className = `cell-select cat-edit ${val ? `cat-${val}` : 'cat-none'}`;
      toast(`${r.ticket} → ${val ? CATEGORY_LABEL[val] : 'Unassigned'}`, 'ok');
    } catch (err) { toast(err.message, 'err'); cat.value = prev; }
  });
}

// ---------------------------------------------------------------------------
// Drag to reorder — persists a single global order for the whole board.

let dragTicket = null;
const sheetBody = $('#sheetBody');

function cleanupDrag() {
  $$('#sheetBody tr.dragging, #sheetBody tr.drop-before, #sheetBody tr.drop-after')
    .forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
  dragTicket = null;
}

function moveTicket(dragT, targetT, before) {
  const arr = lastData.requests;
  const from = arr.findIndex((r) => r.ticket === dragT);
  if (from < 0) return;
  const [item] = arr.splice(from, 1);
  let to = arr.findIndex((r) => r.ticket === targetT);
  if (to < 0) { arr.push(item); return; }
  if (!before) to += 1;
  arr.splice(to, 0, item);
}

async function saveOrder() {
  try {
    await api(`/api/review/order${keyQS}`, { method: 'POST', body: { order: lastData.requests.map((r) => r.ticket) } });
  } catch (err) {
    toast(`Couldn't save the order: ${err.message}`, 'err');
    load(); // resync from the server
  }
}

sheetBody.addEventListener('dragstart', (e) => {
  const row = e.target.closest('tr.sheet-row');
  if (!row) return;
  if (e.target.closest('select, input, button, textarea, a, .col-notes')) { e.preventDefault(); return; }
  dragTicket = row.dataset.ticket;
  row.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', dragTicket); } catch { /* IE guard */ }
});
sheetBody.addEventListener('dragover', (e) => {
  if (!dragTicket) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const row = e.target.closest('tr.sheet-row');
  $$('#sheetBody tr.drop-before, #sheetBody tr.drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
  if (!row || row.dataset.ticket === dragTicket) return;
  const rect = row.getBoundingClientRect();
  row.classList.add((e.clientY - rect.top) < rect.height / 2 ? 'drop-before' : 'drop-after');
});
sheetBody.addEventListener('drop', (e) => {
  if (!dragTicket) return;
  e.preventDefault();
  const row = e.target.closest('tr.sheet-row');
  if (row && row.dataset.ticket !== dragTicket) {
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    moveTicket(dragTicket, row.dataset.ticket, before);
    lastData.requests.forEach((r, i) => { r.board_position = i; });
    renderRows();
    saveOrder();
  }
  cleanupDrag();
});
sheetBody.addEventListener('dragend', cleanupDrag);

// ---------------------------------------------------------------------------
// Expandable ticket detail

const MSG_KIND = { receipt: 'Receipt', followup: 'Follow-up', completion: 'Completion notice', reply: 'Reply' };
const ACT_LABEL = {
  created: 'Request submitted',
  status_changed: 'Status updated',
  email_sent: 'Email sent',
  email_pending: 'Email pending',
  followup: 'Follow-up sent',
  reply: 'Reply received',
  resolution_note: 'Resolution note updated',
  review_note: 'Note',
  priority_changed: 'Priority changed',
  category_changed: 'Category changed',
  type_changed: 'Type changed',
};

function detailSection(title, inner) {
  return `<div class="dd-section"><h4>${title}</h4>${inner}</div>`;
}

function attachmentsHtml(list) {
  if (!list || !list.length) return '';
  const imgs = list.filter(isImageAttachment);
  const docs = list.filter((s) => !isImageAttachment(s));
  return '<div class="tl-attach">' +
    imgs.map((s) => `<a href="${esc(screenshotUrl(s))}" target="_blank" rel="noopener" class="tl-shot" title="${esc(s.filename)}">
      <img src="${esc(screenshotUrl(s))}" alt="" loading="lazy"></a>`).join('') +
    docs.map(docCard).join('') +
    '</div>';
}

function detailHtml(data) {
  const r = data.request;
  let html = `<div class="dd-meta">
    ${r.patient_name ? `<span class="dd-chip">&#129492; Patient: <strong>${esc(r.patient_name)}</strong></span>` : ''}
    <span class="dd-chip">Category: <strong>${r.category ? esc(CATEGORY_LABEL[r.category]) : 'Unassigned'}</strong></span>
    <span class="dd-chip">Priority: <strong>${esc(SEV_LABEL[r.severity] || r.severity)}</strong></span>
    <span class="dd-chip">Type: <strong>${esc(TYPE_LABEL[r.type] || r.type)}</strong>
      ${r.type === 'change_request' ? '<button type="button" class="btn btn-sm btn-ghost dd-convert" title="Filed as a change request but really a bug? Reclassify it as an issue.">&#9888; Actually a bug &mdash; convert to Issue</button>' : ''}
    </span>
  </div><div class="dd-grid">`;

  let left = detailSection('Full description', `<div class="dd-pre">${esc(r.description)}</div>`);
  if (r.steps) left += detailSection('Steps to reproduce', `<div class="dd-pre">${esc(r.steps)}</div>`);
  if ((r.video_links || []).length) {
    left += detailSection('Video links', '<ul class="dd-links">' +
      r.video_links.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></li>`).join('') + '</ul>');
  }
  if ((r.screenshots || []).length) {
    const imgs = r.screenshots.filter(isImageAttachment);
    const docs = r.screenshots.filter((s) => !isImageAttachment(s));
    left += detailSection(`Original attachments (${r.screenshots.length})`,
      (imgs.length ? '<div class="shot-grid">' + imgs.map((s) => `
        <a href="${esc(screenshotUrl(s))}" target="_blank" rel="noopener">
          <img src="${esc(screenshotUrl(s))}" alt="" loading="lazy">
          <div class="s-cap">${esc(s.filename)}</div>
        </a>`).join('') + '</div>' : '') +
      (docs.length ? `<div class="${imgs.length ? 'mt1' : ''}">${docs.map(docCard).join('')}</div>` : ''));
  }
  if (r.resolution_note) left += detailSection('Resolution note', `<div class="dd-pre">${esc(r.resolution_note)}</div>`);
  html += `<div>${left}</div>`;

  let right = '';
  const msgs = data.messages || [];
  right += detailSection(`Email conversation (${msgs.length})`, msgs.length
    ? '<div class="dd-msgs">' + msgs.map((m) => `
        <div class="dd-msg ${m.direction === 'inbound' ? 'in' : 'out'}">
          <div class="dd-msg-head">
            <strong>${m.direction === 'inbound' ? esc(r.submitter_name) : 'Service Desk'}</strong>
            <span class="dd-msg-kind">${esc(MSG_KIND[m.kind] || m.kind)}</span>
            <span class="dd-msg-date">${esc(fmtDate(m.created_at))}</span>
          </div>
          <div class="dd-pre">${esc(m.body || m.subject || '')}</div>
        </div>`).join('') + '</div>'
    : '<div class="muted small">No emails on this ticket yet.</div>');

  const actList = '<ul class="tl">' +
    (data.activity || []).map((a) => {
      const isNote = a.action === 'review_note';
      const cls = isNote ? 'tl-note' : a.action === 'created' ? 'tl-created' : a.action.startsWith('email') ? 'tl-email' : 'tl-status';
      return `<li class="${cls}">
        <div class="tl-text"><strong>${esc(ACT_LABEL[a.action] || a.action)}</strong>${isNote ? '' : a.detail ? ` — ${esc(a.detail)}` : ''}</div>
        ${isNote && a.detail ? `<div class="tl-note-body">${esc(a.detail)}</div>` : ''}
        ${attachmentsHtml(a.attachments)}
        <div class="tl-date">${isNote && a.actor ? `${esc(a.actor)} &middot; ` : ''}${esc(fmtDate(a.created_at))}</div>
      </li>`;
    }).join('') + '</ul>';
  const noteBox = `<div class="dd-note-add">
    <input type="text" class="dd-note-name" placeholder="Your name" maxlength="120" autocomplete="name">
    <div class="dd-note-row">
      <input type="text" class="dd-note-input" placeholder="Add a note to this ticket&hellip;" maxlength="4000">
      <button type="button" class="btn btn-sm btn-primary dd-note-save">Add note</button>
    </div>
    <label class="dd-note-files-label">&#128206; Attach documents
      <input type="file" class="dd-note-files" multiple accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.log,.md,.rtf,.json,.zip,.heic,.heif,.mp4,.mov,.webm">
    </label>
    <div class="dd-note-picked small faint"></div>
  </div>`;
  right += detailSection('Activity &amp; notes', actList + noteBox);
  html += `<div>${right}</div>`;

  html += '</div>';
  return html;
}

const detailCache = new Map();

async function toggleDetail(row) {
  const open = row.nextElementSibling && row.nextElementSibling.classList.contains('sheet-detail');
  if (open) {
    row.nextElementSibling.remove();
    row.classList.remove('expanded');
    return;
  }
  const ticket = row.dataset.ticket;
  const tr = document.createElement('tr');
  tr.className = 'sheet-detail';
  tr.innerHTML = `<td colspan="${COLSPAN}"><div class="muted small"><span class="spinner dark"></span> Loading ${esc(ticket)}&hellip;</div></td>`;
  row.after(tr);
  row.classList.add('expanded');
  try {
    let data = detailCache.get(ticket);
    if (!data) {
      data = await api(`/api/review/${encodeURIComponent(ticket)}${keyQS}`);
      detailCache.set(ticket, data);
    }
    tr.firstElementChild.innerHTML = detailHtml(data);
    wireDetail(tr.firstElementChild, ticket);
  } catch (err) {
    tr.firstElementChild.innerHTML = `<div class="banner banner-error"><span>&#9888;</span><div>${esc(err.message)}</div></div>`;
  }
}

sheetBody.addEventListener('click', (e) => {
  // Let links, inline controls and the notes column handle their own clicks.
  if (e.target.closest('a, select, button, input, textarea, .col-notes, .col-drag, .col-sev, .col-cat')) return;
  const row = e.target.closest('tr.sheet-row');
  if (row) toggleDetail(row);
});

// ---------------------------------------------------------------------------
// Notes — shared notes + document attachments on a ticket. The author name is
// remembered locally so it doesn't have to be typed every time.

const AUTHOR_STORE = 'mm_review_author';
function getAuthor() {
  try { return localStorage.getItem(AUTHOR_STORE) || ''; } catch { return ''; }
}
function setAuthor(name) {
  try { if (name) localStorage.setItem(AUTHOR_STORE, name); } catch { /* private mode */ }
}

async function addNote(ticket, note, author, files) {
  setAuthor(author);
  const fd = new FormData();
  if (note) fd.append('note', note);
  if (author) fd.append('author', author);
  (files || []).forEach((f) => fd.append('attachments', f, f.name));
  return api(`/api/review/${encodeURIComponent(ticket)}/notes${keyQS}`, { method: 'POST', body: fd });
}

// Fold a freshly-created note into the in-memory data and refresh just the
// affected bits of the DOM — the row's note count, and the open detail (if any).
function applyNewNote(ticket, note) {
  if (!note) return;
  const row = lastData && lastData.requests.find((x) => x.ticket === ticket);
  if (row) { row.notes = row.notes || []; row.notes.unshift(note); }
  const cached = detailCache.get(ticket);
  if (cached) { cached.activity = cached.activity || []; cached.activity.push(note); }

  const rowEl = $(`#sheetBody tr.sheet-row[data-ticket="${ticket}"]`);
  if (!rowEl) return;
  if (row) {
    const cell = $('.col-notes', rowEl);
    if (cell) { cell.innerHTML = notesCellInner(row); wireNotesCell(rowEl, row); }
  }
  const det = rowEl.nextElementSibling;
  if (det && det.classList.contains('sheet-detail') && cached) {
    det.firstElementChild.innerHTML = detailHtml(cached);
    wireDetail(det.firstElementChild, ticket);
  }
}

function wireNotesCell(rowEl, r) {
  const ind = $('.note-ind', rowEl);
  if (ind) {
    ind.addEventListener('click', (e) => { e.stopPropagation(); showNoteHover(ind, r); });
    ind.addEventListener('mouseenter', () => showNoteHover(ind, r));
    ind.addEventListener('mouseleave', scheduleNoteHoverHide);
  }
  const add = $('.note-add', rowEl);
  if (add) add.addEventListener('click', (e) => { e.stopPropagation(); openQuickNote(add, r); });
}

// Wire everything interactive inside an expanded ticket detail.
function wireDetail(host, ticket) {
  wireDetailNoteBox(host, ticket);
  const convert = $('.dd-convert', host);
  if (convert) convert.addEventListener('click', () => convertToIssue(ticket, convert));
}

// A "change request" that's really a bug: reclassify it as an issue. The
// ticket keeps its number and history but leaves this board (which lists
// change requests only) and shows up as an Issue in the admin dashboard.
async function convertToIssue(ticket, btn) {
  if (!confirm(`Convert ${ticket} to an Issue?\n\nIt keeps its ticket number and history, but moves off this change-request board into the issues queue.`)) return;
  btn.disabled = true;
  try {
    await editTicket(ticket, { type: 'issue' });
    detailCache.delete(ticket);
    if (lastData) lastData.requests = lastData.requests.filter((r) => r.ticket !== ticket);
    renderCounts();
    renderTabs();
    renderRows();
    toast(`${ticket} is now an Issue — it has moved off this board`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
}

// The note box shown at the bottom of the Activity list in an expanded ticket.
function wireDetailNoteBox(host, ticket) {
  const nameEl = $('.dd-note-name', host);
  const input = $('.dd-note-input', host);
  const btn = $('.dd-note-save', host);
  const filesEl = $('.dd-note-files', host);
  const picked = $('.dd-note-picked', host);
  if (!input || !btn) return;
  if (nameEl) nameEl.value = getAuthor();
  if (filesEl && picked) {
    filesEl.addEventListener('change', () => {
      const names = Array.from(filesEl.files).map((f) => f.name);
      picked.textContent = names.length ? `Attached: ${names.join(', ')}` : '';
    });
  }
  const save = async () => {
    const note = input.value.trim();
    const files = filesEl ? Array.from(filesEl.files) : [];
    if (!note && !files.length) return toast('Write a note or attach a document', 'err');
    btn.disabled = true;
    try {
      const res = await addNote(ticket, note, nameEl ? nameEl.value.trim() : '', files);
      toast('Note added', 'ok');
      applyNewNote(ticket, res.note); // re-renders this detail
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ---------------------------------------------------------------------------
// Floating panels: the hover preview of a ticket's notes + the quick-add
// popover. Appended to <body> so the table's scroll container never clips them.
let hoverEl = null;
let hoverHideTimer = null;
let floatEl = null;

function placeNear(el, anchor) {
  const a = anchor.getBoundingClientRect();
  const left = Math.max(12, Math.min(a.right - el.offsetWidth, window.innerWidth - el.offsetWidth - 12));
  const below = window.innerHeight - a.bottom - 18;
  const above = a.top - 18;
  const side = el.offsetHeight <= below || below >= above ? 'below' : 'above';
  el.style.maxHeight = `${Math.max(120, side === 'below' ? below : above)}px`;
  const h = el.offsetHeight;
  el.style.left = `${left}px`;
  el.style.top = `${side === 'below' ? a.bottom + 6 : Math.max(12, a.top - h - 6)}px`;
}

function hideNoteHover() {
  clearTimeout(hoverHideTimer);
  if (hoverEl) { hoverEl.remove(); hoverEl = null; }
}
function scheduleNoteHoverHide() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(hideNoteHover, 220);
}
function showNoteHover(anchor, r) {
  hideNoteHover();
  const notes = r.notes || [];
  if (!notes.length) return;
  hoverEl = document.createElement('div');
  hoverEl.className = 'note-hover';
  hoverEl.innerHTML = `<div class="nh-head">${esc(r.ticket)} — notes</div>` +
    notes.map((n) => `<div class="nh-item">
      <div class="nh-body">${esc(n.detail || '(attachment)')}</div>
      <div class="nh-meta">${esc(n.actor)} · ${esc(fmtDate(n.created_at))}${n.attachments && n.attachments.length ? ` · &#128206;${n.attachments.length}` : ''}</div>
    </div>`).join('');
  document.body.appendChild(hoverEl);
  placeNear(hoverEl, anchor);
  hoverEl.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer));
  hoverEl.addEventListener('mouseleave', scheduleNoteHoverHide);
}

function closeFloat() {
  if (floatEl) { floatEl.remove(); floatEl = null; }
}
function openFloat(anchor, className, html) {
  closeFloat();
  hideNoteHover();
  floatEl = document.createElement('div');
  floatEl.className = className;
  floatEl.innerHTML = html;
  floatEl.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(floatEl);
  placeNear(floatEl, anchor);
  return floatEl;
}
document.addEventListener('click', (e) => {
  if (floatEl && !floatEl.contains(e.target)) closeFloat();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (floatEl) closeFloat(); else hideNoteHover(); }
});

// Quick add-a-note popover, launched from the notes column's + button.
function openQuickNote(anchor, r) {
  const savedName = getAuthor();
  const el = openFloat(anchor, 'float-panel', `
    <div class="fp-title">Add note — <span class="mono">${esc(r.ticket)}</span></div>
    <input type="text" class="fp-name" placeholder="Your name" maxlength="120" autocomplete="name" value="${esc(savedName)}">
    <textarea maxlength="4000" placeholder="Add a note to this ticket…"></textarea>
    <label class="fp-files-label">&#128206; Attach documents
      <input type="file" class="fp-files" multiple accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.log,.md,.rtf,.json,.zip,.heic,.heif,.mp4,.mov,.webm">
    </label>
    <div class="fp-picked small faint"></div>
    <div class="fp-row">
      <span class="small faint grow">Ctrl/Cmd+Enter to save</span>
      <button type="button" class="btn btn-ghost btn-sm" data-x="cancel">Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" data-x="save">Save note</button>
    </div>`);
  const ta = $('textarea', el);
  const nameEl = $('.fp-name', el);
  const filesEl = $('.fp-files', el);
  const picked = $('.fp-picked', el);
  (savedName ? ta : nameEl).focus();
  if (filesEl && picked) filesEl.addEventListener('change', () => {
    const names = Array.from(filesEl.files).map((f) => f.name);
    picked.textContent = names.length ? `Attached: ${names.join(', ')}` : '';
  });
  const save = async () => {
    const note = ta.value.trim();
    const files = filesEl ? Array.from(filesEl.files) : [];
    if (!note && !files.length) return toast('Write a note or attach a document', 'err');
    try {
      const res = await addNote(r.ticket, note, nameEl.value.trim(), files);
      closeFloat();
      toast(`Note added to ${r.ticket}`, 'ok');
      applyNewNote(r.ticket, res.note);
    } catch (err) { toast(err.message, 'err'); }
  };
  $('[data-x="cancel"]', el).addEventListener('click', closeFloat);
  $('[data-x="save"]', el).addEventListener('click', save);
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save(); });
}

// ---------------------------------------------------------------------------

async function load() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  $('#loadError').classList.add('hidden');
  try {
    const data = await api('/api/review' + keyQS);
    detailCache.clear();
    render(data);
  } catch (err) {
    $('#sheet').classList.add('hidden');
    $('#loadErrorText').textContent = err.message;
    $('#loadError').classList.remove('hidden');
  } finally {
    $('#loadState').classList.add('hidden');
    btn.disabled = false;
  }
}

$('#refreshBtn').addEventListener('click', load);
load();
