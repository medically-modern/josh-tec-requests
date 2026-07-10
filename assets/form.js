'use strict';
/* Employee request form logic */

$('#logoMark').innerHTML = LOGO_SVG;

const MAX_FILES = 6;
const MAX_BYTES = 8 * 1024 * 1024;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

let files = [];          // { file, previewUrl }
let selectedType = '';
let selectedSev = '';
let servicesLoaded = false;

// ---------------------------------------------------------------------------
// Services dropdown
async function loadServices() {
  const sel = $('#service');
  const banner = $('#apiBanner');
  try {
    const data = await api('/api/services');
    sel.innerHTML = '<option value="">— Choose a service —</option>' +
      data.services.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    servicesLoaded = true;
    banner.classList.add('hidden');
    applyPrefill();
  } catch (err) {
    sel.innerHTML = '<option value="">Couldn\'t load services</option>';
    $('#apiBannerDetail').textContent = err.message;
    banner.classList.remove('hidden');
  }
}
function isCommandCenter() {
  const sel = $('#service');
  const label = sel.options[sel.selectedIndex]?.text || '';
  return sel.value !== '' && /command\s*center/i.test(label);
}
$('#service').addEventListener('change', () => {
  $('#f-role').classList.toggle('hidden', !isCommandCenter());
  $('#f-role').classList.remove('invalid');
});
$('#role').addEventListener('change', () => $('#f-role').classList.remove('invalid'));

// Deep-link prefill — the Command Center's report button links here with
// ?service=command-center&role=<role label> so the service and role arrive
// pre-selected. Matching is fuzzy on the service (label OR id, punctuation
// and case ignored) and exact-but-case-insensitive on the role label.
function applyPrefill() {
  const params = new URLSearchParams(window.location.search);
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const svcParam = norm(params.get('service') || '');
  if (svcParam) {
    const sel = $('#service');
    const opt = Array.from(sel.options).find((o) =>
      o.value && (norm(o.text).includes(svcParam) || norm(o.value) === svcParam));
    if (opt && !sel.value) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change'));
    }
  }

  const roleParam = norm(params.get('role') || '');
  if (roleParam) {
    const roleSel = $('#role');
    const opt = Array.from(roleSel.options).find((o) => o.value && norm(o.value) === roleParam);
    if (opt && !roleSel.value) roleSel.value = opt.value;
  }
}

$('#apiRetry').addEventListener('click', loadServices);
loadServices();

// ---------------------------------------------------------------------------
// Type + severity choosers
$$('#typeChoices .choice').forEach((el) => {
  el.addEventListener('click', () => {
    selectedType = el.dataset.type;
    $$('#typeChoices .choice').forEach((c) => c.classList.toggle('selected', c === el));
    $('#f-type').classList.remove('invalid');
    const isIssue = selectedType === 'issue';
    $('#sevHeading').textContent = isIssue ? 'How severe is it?' : 'How important is it?';
    $('#sevHint').textContent = isIssue
      ? 'This helps prioritize the fix.'
      : 'This helps prioritize the work.';
    $('#f-steps').classList.toggle('hidden', !isIssue);
    $('#description').placeholder = isIssue
      ? "Describe what's happening and what you expected instead…"
      : 'Describe the change you\'d like and why it would help…';
    $$('#sevChoices .c-desc').forEach((d) => {
      d.textContent = isIssue ? d.dataset.issue : d.dataset.change;
    });
  });
});

$$('#sevChoices .choice').forEach((el) => {
  el.addEventListener('click', () => {
    selectedSev = el.dataset.sev;
    $$('#sevChoices .choice').forEach((c) => c.classList.toggle('selected', c === el));
    $('#f-severity').classList.remove('invalid');
  });
});

// ---------------------------------------------------------------------------
// Title counter
$('#title').addEventListener('input', () => {
  $('#titleCount').textContent = `${$('#title').value.length} / 200`;
});

// ---------------------------------------------------------------------------
// Screenshots
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');

function addFiles(list) {
  const incoming = Array.from(list || []);
  let added = 0;
  for (const f of incoming) {
    if (!OK_TYPES.includes(f.type)) {
      toast(`"${f.name}" skipped — only PNG, JPG, GIF or WebP images are supported.`, 'err');
      continue;
    }
    if (f.size > MAX_BYTES) {
      toast(`"${f.name}" skipped — larger than 8 MB.`, 'err');
      continue;
    }
    if (files.length >= MAX_FILES) {
      toast(`Maximum ${MAX_FILES} screenshots — extra files skipped.`, 'err');
      break;
    }
    if (files.some((x) => x.file.name === f.name && x.file.size === f.size)) {
      toast(`"${f.name}" is already attached.`);
      continue;
    }
    files.push({ file: f, previewUrl: URL.createObjectURL(f) });
    added++;
  }
  renderThumbs();
  return added;
}

function renderThumbs() {
  const host = $('#thumbs');
  host.innerHTML = '';
  files.forEach((item, i) => {
    const div = document.createElement('div');
    div.className = 'thumb';
    div.innerHTML = `
      <img alt="">
      <button type="button" class="t-x" aria-label="Remove">&#10005;</button>
      <div class="t-meta"><div class="t-name"></div>${fmtBytes(item.file.size)}</div>`;
    div.querySelector('img').src = item.previewUrl;
    div.querySelector('.t-name').textContent = item.file.name;
    div.querySelector('.t-x').addEventListener('click', () => {
      URL.revokeObjectURL(item.previewUrl);
      files.splice(i, 1);
      renderThumbs();
    });
    host.appendChild(div);
  });
}

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

['dragenter', 'dragover'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); }));
dropzone.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

// A drop that misses the dropzone must never navigate away and destroy the form
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

document.addEventListener('paste', (e) => {
  if ($('#successView').classList.contains('hidden') === false) return;
  const items = Array.from(e.clipboardData?.items || []);
  const imgs = items.filter((it) => it.kind === 'file' && OK_TYPES.includes(it.type)).map((it) => it.getAsFile());
  if (imgs.length) {
    // Give pasted images a friendlier name than "image.png"
    const named = imgs.map((f, idx) => new File([f], `pasted-screenshot-${Date.now()}-${idx + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }));
    const added = addFiles(named);
    if (added > 0) toast(`${added} screenshot${added > 1 ? 's' : ''} pasted from clipboard.`, 'ok');
  }
});

// ---------------------------------------------------------------------------
// Video link rows
function addLinkRow(value) {
  const row = document.createElement('div');
  row.className = 'link-row';
  row.innerHTML = `
    <input type="url" placeholder="https://www.loom.com/share/…" maxlength="500">
    <button type="button" class="btn btn-ghost btn-sm" aria-label="Remove link">&#10005;</button>`;
  row.querySelector('input').value = value || '';
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('#linkRows').appendChild(row);
}
$('#addLink').addEventListener('click', () => addLinkRow());
addLinkRow();

// ---------------------------------------------------------------------------
// Remember who you are
try {
  $('#name').value = localStorage.getItem('mm_name') || '';
  $('#email').value = localStorage.getItem('mm_email_prefix') || '';
} catch { /* private mode */ }

// ---------------------------------------------------------------------------
// Validation + submit
function setInvalid(id, bad) {
  $(id).classList.toggle('invalid', bad);
  return bad;
}

function validate() {
  const problems = [];
  if (setInvalid('#f-service', !$('#service').value)) problems.push('choose a service');
  if (setInvalid('#f-type', !selectedType)) problems.push('choose a request type');
  if (setInvalid('#f-severity', !selectedSev)) problems.push('choose a severity');
  if (setInvalid('#f-role', isCommandCenter() && !$('#role').value)) problems.push('select which Command Center role this is about');
  if (setInvalid('#f-title', $('#title').value.trim().length < 4)) problems.push('add a short summary');
  if (setInvalid('#f-description', $('#description').value.trim().length < 10)) problems.push('describe the request');
  if (setInvalid('#f-name', $('#name').value.trim().length < 2)) problems.push('enter your name');
  if (setInvalid('#f-email', !/^[a-z0-9._%+-]+$/i.test($('#email').value.trim()))) problems.push('enter your email');
  return problems;
}

function collectLinks() {
  return $$('#linkRows input')
    .map((i) => i.value.trim())
    .filter(Boolean);
}

$('#requestForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const problems = validate();
  const errBox = $('#formErrors');
  if (problems.length) {
    $('#formErrorsText').textContent = `Almost there — please ${problems.join(', ')}.`;
    errBox.classList.remove('hidden');
    errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  errBox.classList.add('hidden');

  // Warn about malformed video links but don't block (server also validates)
  const links = collectLinks();
  const badLinks = links.filter((l) => { try { const u = new URL(l); return !/^https?:$/.test(u.protocol); } catch { return true; } });
  if (badLinks.length) {
    $('#formErrorsText').textContent = `This link doesn't look like a URL: ${badLinks[0]} — please fix or remove it.`;
    errBox.classList.remove('hidden');
    errBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  try {
    localStorage.setItem('mm_name', $('#name').value.trim());
    localStorage.setItem('mm_email_prefix', $('#email').value.trim());
  } catch { /* private mode */ }

  const fd = new FormData();
  fd.append('service_id', $('#service').value);
  fd.append('type', selectedType);
  fd.append('severity', selectedSev);
  const rolePrefix = isCommandCenter() ? `[${$('#role').value.trim()}] ` : '';
  fd.append('title', (rolePrefix + $('#title').value.trim()).slice(0, 200));
  fd.append('description', $('#description').value.trim());
  fd.append('steps', selectedType === 'issue' ? $('#steps').value.trim() : '');
  fd.append('video_links', JSON.stringify(links));
  fd.append('submitter_name', $('#name').value.trim());
  fd.append('submitter_email', `${$('#email').value.trim()}@medicallymodern.com`.toLowerCase());
  files.forEach((item) => fd.append('screenshots', item.file, item.file.name));

  submitWithProgress(fd);
});

function submitWithProgress(fd) {
  const btn = $('#submitBtn');
  const label = $('#submitLabel');
  btn.disabled = true;
  label.innerHTML = '<span class="spinner"></span> Submitting…';
  const prog = $('#uploadProgress');
  const bar = $('#progressBar');
  const pct = $('#progressPct');
  const plabel = $('#progressLabel');
  prog.classList.remove('hidden');
  bar.style.width = '0%';

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${API_BASE}/api/requests`);
  xhr.timeout = 120000;

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const p = Math.round((e.loaded / e.total) * 100);
    bar.style.width = `${p}%`;
    pct.textContent = `${p}%`;
    plabel.textContent = p >= 100 ? 'Processing on server…' : `Uploading${files.length ? ` ${files.length} attachment${files.length > 1 ? 's' : ''}` : ''}…`;
  });

  const fail = (msg) => {
    btn.disabled = false;
    label.textContent = 'Submit request';
    prog.classList.add('hidden');
    $('#formErrorsText').textContent = msg;
    $('#formErrors').classList.remove('hidden');
    $('#formErrors').scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  xhr.addEventListener('load', () => {
    let data = null;
    try { data = JSON.parse(xhr.responseText); } catch { /* leave null */ }
    if (xhr.status === 201 && data && data.request) {
      showSuccess(data);
    } else {
      fail((data && data.error) || `Submission failed (HTTP ${xhr.status}). Please try again.`);
    }
  });
  xhr.addEventListener('error', () => fail('Network error — your request was NOT submitted. Please check your connection and try again.'));
  xhr.addEventListener('timeout', () => fail('The upload timed out — your request was NOT submitted. Try smaller screenshots or a better connection.'));
  xhr.send(fd);
}

// ---------------------------------------------------------------------------
// Success view with server-verified attachment echo
function showSuccess(data) {
  const r = data.request;
  $('#requestForm').classList.add('hidden');
  $('#successView').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  $('#okTicket').textContent = r.ticket;
  $('#okTrackLink').href = `status.html?ticket=${encodeURIComponent(r.ticket)}&email=${encodeURIComponent(r.submitter_email)}`;

  const rec = data.receipt_email || {};
  $('#okEmailNote').innerHTML = rec.sent
    ? `A confirmation email was sent to <strong>${esc(r.submitter_email)}</strong>.`
    : `We'll email <strong>${esc(r.submitter_email)}</strong> when this is completed.`;

  const rows = [
    ['Service', r.service_name],
    ['Type', TYPE_LABEL[r.type] || r.type],
    ['Severity', SEV_LABEL[r.severity] || r.severity],
    ['Summary', r.title],
    ['Submitted by', `${r.submitter_name} (${r.submitter_email})`],
    ['Video links', (r.video_links && r.video_links.length) ? r.video_links.join('\n') : 'None'],
    ['Screenshots', r.screenshots.length ? `${r.screenshots.length} file(s) — verified below` : 'None'],
  ];
  $('#okSummary').innerHTML = rows.map(([k, v]) =>
    `<div class="row"><div class="k">${esc(k)}</div><div class="v">${esc(v).replace(/\n/g, '<br>')}</div></div>`).join('');

  const wrap = $('#okShotsWrap');
  const host = $('#okShots');
  host.innerHTML = '';
  if (r.screenshots.length) {
    wrap.classList.remove('hidden');
    r.screenshots.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `
        <img alt="" loading="lazy">
        <div class="t-meta">
          <div class="t-name"></div>${fmtBytes(s.size_bytes)}
          <div class="t-verify">&#8987; Verifying…</div>
        </div>`;
      div.querySelector('.t-name').textContent = s.filename;
      const img = div.querySelector('img');
      const badge = div.querySelector('.t-verify');
      img.addEventListener('load', () => { badge.textContent = '✓ Stored on server'; badge.className = 't-verify ok'; });
      img.addEventListener('error', () => { badge.textContent = '⚠ Could not verify — contact Josh'; badge.className = 't-verify warn'; });
      img.src = screenshotUrl(s);
      host.appendChild(div);
    });
  } else {
    wrap.classList.add('hidden');
  }
}

$('#okAgain').addEventListener('click', () => window.location.reload());
