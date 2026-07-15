'use strict';
/* Company review sheet — all unresolved requests, spreadsheet style.
   Change requests are grouped at the top, reported issues below.
   Click any row to expand the full ticket: steps, screenshots, video links,
   the email conversation, and the activity timeline. */

$('#logoMark').innerHTML = LOGO_SVG;

const reviewKey = new URLSearchParams(window.location.search).get('key') || '';
const keyQS = reviewKey ? `?key=${encodeURIComponent(reviewKey)}` : '';

// Most recent review payload, kept so a freshly added note can update the
// row's note count in place without refetching the whole sheet.
let lastData = null;

function daysOpen(created) {
  const days = Math.floor((Date.now() - new Date(created).getTime()) / 86400000);
  return days < 1 ? '<1' : String(days);
}

function fmtDay(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sectionRow(cls, label, count) {
  return `<tr class="sheet-section ${cls}"><td colspan="10">${label} <span class="sec-count">${count}</span></td></tr>`;
}

// Notes cell — a 📝 count that reveals the notes on hover, plus a quick-add
// button. Mirrors the admin inbox's notes column so it works the same here.
function notesCellInner(r) {
  const n = (r.notes || []).length;
  return `${n ? `<button type="button" class="note-ind" title="Hover to read notes">&#128221; ${n}</button>` : ''}
    <button type="button" class="cell-btn note-add" title="Add a note">&#65291;</button>`;
}

function metaChips(r) {
  const bits = [];
  if (r.screenshot_count > 0) bits.push(`&#128206; ${r.screenshot_count} file${r.screenshot_count === 1 ? '' : 's'}`);
  if (r.video_count > 0) bits.push(`&#127909; ${r.video_count} video${r.video_count === 1 ? '' : 's'}`);
  if (r.message_count > 0) bits.push(`&#9993;&#65039; ${r.message_count} email${r.message_count === 1 ? '' : 's'}`);
  if (r.has_steps) bits.push('&#128221; steps');
  return bits.length ? `<div class="row-meta">${bits.join(' &middot; ')}</div>` : '';
}

function requestRow(r, idx) {
  return `<tr class="sheet-row ${idx % 2 ? 'band' : ''} sev-${esc(r.severity)}" data-ticket="${esc(r.ticket)}" title="Click to expand full details">
    <td class="col-ticket mono"><span class="caret">&#9656;</span>${esc(r.ticket)}</td>
    <td class="col-title">${esc(r.title)}${metaChips(r)}</td>
    <td class="col-desc">${esc(r.description)}</td>
    <td class="col-sev">${sevBadge(r.severity)}</td>
    <td class="col-status">${statusBadge(r.status)}</td>
    <td class="col-svc">${esc(r.service_name)}</td>
    <td class="col-by">${esc(r.submitter_name)}</td>
    <td class="col-date">${esc(fmtDay(r.created_at))}</td>
    <td class="col-days">${esc(daysOpen(r.created_at))}</td>
    <td class="col-notes t-notes">${notesCellInner(r)}</td>
  </tr>`;
}

function render(data) {
  lastData = data;
  const all = data.requests || [];
  const changes = all.filter((r) => r.type === 'change_request');
  const issues = all.filter((r) => r.type !== 'change_request');

  let html = '';
  html += sectionRow('sec-change', '&#10024; Change Requests', changes.length);
  html += changes.length
    ? changes.map(requestRow).join('')
    : '<tr class="sheet-empty"><td colspan="10">No unresolved change requests.</td></tr>';
  html += sectionRow('sec-issue', '&#9888; Reported Issues', issues.length);
  html += issues.length
    ? issues.map(requestRow).join('')
    : '<tr class="sheet-empty"><td colspan="10">No unresolved issues.</td></tr>';
  $('#sheetBody').innerHTML = html;
  $$('#sheetBody tr.sheet-row').forEach((tr) => {
    const r = all.find((x) => x.ticket === tr.dataset.ticket);
    if (r) wireNotesCell(tr, r);
  });

  $('#counts').innerHTML =
    `<span class="chip chip-change">${changes.length} change request${changes.length === 1 ? '' : 's'}</span>` +
    `<span class="chip chip-issue">${issues.length} open issue${issues.length === 1 ? '' : 's'}</span>` +
    `<span class="chip">${all.length} total unresolved</span>`;
  $('#updatedAt').textContent = `Updated ${fmtDate(data.generated_at || new Date())}`;
  $('#sheet').classList.remove('hidden');
}

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
};

function detailSection(title, inner) {
  return `<div class="dd-section"><h4>${title}</h4>${inner}</div>`;
}

function detailHtml(data) {
  const r = data.request;
  let html = '<div class="dd-grid">';

  let left = detailSection('Full description', `<div class="dd-pre">${esc(r.description)}</div>`);
  if (r.steps) left += detailSection('Steps to reproduce', `<div class="dd-pre">${esc(r.steps)}</div>`);
  if ((r.video_links || []).length) {
    left += detailSection('Video links', '<ul class="dd-links">' +
      r.video_links.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></li>`).join('') + '</ul>');
  }
  if ((r.screenshots || []).length) {
    const imgs = r.screenshots.filter(isImageAttachment);
    const docs = r.screenshots.filter((s) => !isImageAttachment(s));
    left += detailSection(`Attachments (${r.screenshots.length})`,
      (imgs.length ? `<div class="shot-grid">` + imgs.map((s) => `
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
        ${isNote ? `<div class="tl-note-body">${esc(a.detail)}</div>` : ''}
        <div class="tl-date">${isNote && a.actor ? `${esc(a.actor)} &middot; ` : ''}${esc(fmtDate(a.created_at))}</div>
      </li>`;
    }).join('') + '</ul>';
  const noteBox = `<div class="dd-note-add">
    <input type="text" class="dd-note-name" placeholder="Your name" maxlength="120" autocomplete="name">
    <div class="dd-note-row">
      <input type="text" class="dd-note-input" placeholder="Add a note to this ticket&hellip;" maxlength="4000">
      <button type="button" class="btn btn-sm btn-primary dd-note-save">Add note</button>
    </div>
  </div>`;
  right += detailSection('Activity', actList + noteBox);
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
  tr.innerHTML = `<td colspan="10"><div class="muted small"><span class="spinner dark"></span> Loading ${esc(ticket)}&hellip;</div></td>`;
  row.after(tr);
  row.classList.add('expanded');
  try {
    let data = detailCache.get(ticket);
    if (!data) {
      data = await api(`/api/review/${encodeURIComponent(ticket)}${keyQS}`);
      detailCache.set(ticket, data);
    }
    tr.firstElementChild.innerHTML = detailHtml(data);
    wireDetailNoteBox(tr.firstElementChild, ticket);
  } catch (err) {
    tr.firstElementChild.innerHTML = `<div class="banner banner-error"><span>&#9888;</span><div>${esc(err.message)}</div></div>`;
  }
}

$('#sheetBody').addEventListener('click', (e) => {
  if (e.target.closest('a')) return; // let links (videos, screenshots) work normally
  if (e.target.closest('.col-notes')) return; // notes column has its own controls
  const row = e.target.closest('tr.sheet-row');
  if (row) toggleDetail(row);
});

// ---------------------------------------------------------------------------
// Notes — add a shared note to a ticket right from the review sheet. The note
// author is remembered locally so it doesn't have to be typed every time.

const AUTHOR_STORE = 'mm_review_author';
function getAuthor() {
  try { return localStorage.getItem(AUTHOR_STORE) || ''; } catch { return ''; }
}
function setAuthor(name) {
  try { if (name) localStorage.setItem(AUTHOR_STORE, name); } catch { /* private mode */ }
}

async function addNote(ticket, note, author) {
  setAuthor(author);
  return api(`/api/review/${encodeURIComponent(ticket)}/notes${keyQS}`, {
    method: 'POST',
    body: { note, author },
  });
}

// Fold a freshly-created note into the in-memory data and refresh just the
// affected bits of the DOM — the row's note count, and the open detail (if any).
function applyNewNote(ticket, note) {
  if (!note) return;
  const row = lastData && (lastData.requests || []).find((x) => x.ticket === ticket);
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
    wireDetailNoteBox(det.firstElementChild, ticket);
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

// The note box shown at the bottom of the Activity list in an expanded ticket.
function wireDetailNoteBox(host, ticket) {
  const nameEl = $('.dd-note-name', host);
  const input = $('.dd-note-input', host);
  const btn = $('.dd-note-save', host);
  if (!input || !btn) return;
  if (nameEl) nameEl.value = getAuthor();
  const save = async () => {
    const note = input.value.trim();
    if (!note) return toast('Write a note first', 'err');
    btn.disabled = true;
    try {
      const res = await addNote(ticket, note, nameEl ? nameEl.value.trim() : '');
      toast('Note added', 'ok');
      applyNewNote(ticket, res.note); // re-renders this detail, so stop here
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ---------------------------------------------------------------------------
// Floating panels: the hover preview of a ticket's notes + the quick-add popover.
// Appended to <body> so the table's scroll container never clips them.
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
      <div class="nh-body">${esc(n.detail)}</div>
      <div class="nh-meta">${esc(n.actor)} · ${esc(fmtDate(n.created_at))}</div>
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
    <div class="fp-row">
      <span class="small faint grow">Ctrl/Cmd+Enter to save</span>
      <button type="button" class="btn btn-ghost btn-sm" data-x="cancel">Cancel</button>
      <button type="button" class="btn btn-primary btn-sm" data-x="save">Save note</button>
    </div>`);
  const ta = $('textarea', el);
  const nameEl = $('.fp-name', el);
  (savedName ? ta : nameEl).focus();
  const save = async () => {
    const note = ta.value.trim();
    if (!note) return toast('Write a note first', 'err');
    try {
      const res = await addNote(r.ticket, note, nameEl.value.trim());
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
