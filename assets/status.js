'use strict';
/* Ticket status tracker */

$('#logoMark').innerHTML = LOGO_SVG;

const params = new URLSearchParams(window.location.search);
if (params.get('ticket')) $('#ticket').value = params.get('ticket');
if (params.get('email')) $('#email').value = String(params.get('email')).replace(/@medicallymodern\.com$/i, '');
try { if (!$('#email').value) $('#email').value = localStorage.getItem('mm_email_prefix') || ''; } catch { /* private mode */ }

const ACTION_LABEL = {
  created: 'Request submitted',
  status_changed: 'Status updated',
  email_sent: 'Email notification sent',
};

async function lookup() {
  const ticket = $('#ticket').value.trim().toUpperCase();
  // Accept either the prefix or a full pasted @medicallymodern.com address
  let prefix = $('#email').value.trim().replace(/@medicallymodern\.com$/i, '');
  const errBox = $('#trackError');
  errBox.classList.add('hidden');
  if (!ticket || prefix.length < 1) {
    $('#trackErrorText').textContent = 'Enter both your ticket number and your email.';
    errBox.classList.remove('hidden');
    return;
  }
  if (prefix.includes('@')) {
    $('#trackErrorText').textContent = 'Please use your @medicallymodern.com email (just the part before the @).';
    errBox.classList.remove('hidden');
    return;
  }
  $('#email').value = prefix;
  const email = `${prefix}@medicallymodern.com`.toLowerCase();
  const btn = $('#trackBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Looking up…';
  try {
    const data = await api(`/api/track?ticket=${encodeURIComponent(ticket)}&email=${encodeURIComponent(email)}`);
    render(data);
  } catch (err) {
    $('#result').classList.add('hidden');
    $('#trackErrorText').textContent = err.message;
    errBox.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Look up ticket';
  }
}

function render(data) {
  const r = data.request;
  $('#result').classList.remove('hidden');
  $('#rTicket').textContent = r.ticket;
  $('#rStatus').innerHTML = statusBadge(r.status);
  $('#rType').innerHTML = typeBadge(r.type);
  $('#rSev').innerHTML = sevBadge(r.severity);
  $('#rTitle').textContent = r.title;
  $('#rMeta').textContent = `${r.service_name} · submitted ${fmtDate(r.created_at)} by ${r.submitter_name}`;

  const res = $('#rResolution');
  if (r.status === 'completed') {
    $('#rResolutionText').innerHTML = `<strong>Completed ${fmtDate(r.completed_at)}.</strong>` +
      (r.resolution_note ? `<br>${esc(r.resolution_note).replace(/\n/g, '<br>')}` : '');
    res.classList.remove('hidden');
  } else {
    res.classList.add('hidden');
  }

  $('#rTimeline').innerHTML = (data.activity || []).map((a) => {
    const cls = a.action === 'created' ? 'tl-created' : a.action === 'email_sent' ? 'tl-email' : 'tl-status';
    const label = ACTION_LABEL[a.action] || a.action;
    return `<li class="${cls}">
      <div class="tl-text"><strong>${esc(label)}</strong>${a.detail ? ` — ${esc(a.detail)}` : ''}</div>
      <div class="tl-date">${esc(fmtDate(a.created_at))}</div>
    </li>`;
  }).join('') || '<li><div class="tl-text muted">No activity yet.</div></li>';

  const shots = r.screenshots || [];
  $('#rShotsWrap').style.display = shots.length ? '' : 'none';
  // Images preview inline; other documents show as download cards
  $('#rShots').innerHTML = shots.filter(isImageAttachment).map((s) => `
    <a href="${esc(screenshotUrl(s))}" target="_blank" rel="noopener">
      <img src="${esc(screenshotUrl(s))}" alt="" loading="lazy">
      <div class="s-cap">${esc(s.filename)}</div>
    </a>`).join('');
  const docs = shots.filter((s) => !isImageAttachment(s));
  $('#rDocs').innerHTML = docs.map(docCard).join('');
}

$('#trackForm').addEventListener('submit', (e) => { e.preventDefault(); lookup(); });
if (params.get('ticket') && ($('#email').value || params.get('email'))) lookup();
