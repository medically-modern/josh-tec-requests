'use strict';
/* Company review sheet — all unresolved requests, spreadsheet style.
   Change requests are grouped at the top, reported issues below. */

$('#logoMark').innerHTML = LOGO_SVG;

const reviewKey = new URLSearchParams(window.location.search).get('key') || '';

function daysOpen(created) {
  const days = Math.floor((Date.now() - new Date(created).getTime()) / 86400000);
  return days < 1 ? '<1' : String(days);
}

function fmtDay(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function sectionRow(cls, label, count) {
  return `<tr class="sheet-section ${cls}"><td colspan="9">${label} <span class="sec-count">${count}</span></td></tr>`;
}

function requestRow(r, idx) {
  return `<tr class="${idx % 2 ? 'band' : ''} sev-${esc(r.severity)}">
    <td class="col-ticket mono">${esc(r.ticket)}</td>
    <td class="col-title">${esc(r.title)}</td>
    <td class="col-desc">${esc(r.description)}</td>
    <td class="col-sev">${sevBadge(r.severity)}</td>
    <td class="col-status">${statusBadge(r.status)}</td>
    <td class="col-svc">${esc(r.service_name)}</td>
    <td class="col-by">${esc(r.submitter_name)}</td>
    <td class="col-date">${esc(fmtDay(r.created_at))}</td>
    <td class="col-days">${esc(daysOpen(r.created_at))}</td>
  </tr>`;
}

function render(data) {
  const all = data.requests || [];
  const changes = all.filter((r) => r.type === 'change_request');
  const issues = all.filter((r) => r.type !== 'change_request');

  let html = '';
  html += sectionRow('sec-change', '&#10024; Change Requests', changes.length);
  html += changes.length
    ? changes.map(requestRow).join('')
    : '<tr class="sheet-empty"><td colspan="9">No unresolved change requests.</td></tr>';
  html += sectionRow('sec-issue', '&#9888; Reported Issues', issues.length);
  html += issues.length
    ? issues.map(requestRow).join('')
    : '<tr class="sheet-empty"><td colspan="9">No unresolved issues.</td></tr>';
  $('#sheetBody').innerHTML = html;

  $('#counts').innerHTML =
    `<span class="chip chip-change">${changes.length} change request${changes.length === 1 ? '' : 's'}</span>` +
    `<span class="chip chip-issue">${issues.length} open issue${issues.length === 1 ? '' : 's'}</span>` +
    `<span class="chip">${all.length} total unresolved</span>`;
  $('#updatedAt').textContent = `Updated ${fmtDate(data.generated_at || new Date())}`;
  $('#sheet').classList.remove('hidden');
}

async function load() {
  const btn = $('#refreshBtn');
  btn.disabled = true;
  $('#loadError').classList.add('hidden');
  try {
    const data = await api('/api/review' + (reviewKey ? `?key=${encodeURIComponent(reviewKey)}` : ''));
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
