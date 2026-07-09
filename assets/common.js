'use strict';
/* Shared helpers for the Medically Modern Service Desk frontend */

const API_BASE = (window.MM_CONFIG && window.MM_CONFIG.API_BASE || '').replace(/\/+$/, '');

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function relTime(d) {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return fmtDate(d).split(',')[0];
}

const TYPE_LABEL = { issue: 'Issue', change_request: 'Change request' };
const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
const STATUS_LABEL = { open: 'Open', in_progress: 'In progress', completed: 'Completed', declined: 'Declined' };

function typeBadge(t) {
  return `<span class="badge badge-${t === 'issue' ? 'issue' : 'change'}">${t === 'issue' ? '&#9888; Issue' : '&#10024; Change'}</span>`;
}
function sevBadge(s) {
  return `<span class="badge badge-${esc(s)}"><span class="bdot" style="background:currentColor"></span>${esc(SEV_LABEL[s] || s)}</span>`;
}
function statusBadge(s) {
  return `<span class="badge badge-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;
}

function toast(msg, kind) {
  let host = $('#toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind || ''}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 4200);
  setTimeout(() => el.remove(), 4700);
}

async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts = Object.assign({}, opts, { body: JSON.stringify(opts.body) });
  }
  let res;
  try {
    res = await fetch(API_BASE + path, Object.assign({}, opts, { headers }));
  } catch (err) {
    throw new Error('Could not reach the server — check your internet connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

function screenshotUrl(s) {
  return API_BASE + (s.url || `/api/screenshots/${s.id}`);
}

// Medically Modern double-M monogram
const LOGO_SVG = `<svg width="30" height="30" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg" aria-label="Medically Modern">
  <path fill="#b9d6d1" d="M0,105 L0,0 L19,0 L52.5,44 L86,0 L105,0 L105,105 L86,105 L86,31 L52.5,75 L19,31 L19,105 Z"/>
  <path fill="#6fa5a0" d="M35,140 L35,35 L54,35 L87.5,79 L121,35 L140,35 L140,140 L121,140 L121,66 L87.5,110 L54,66 L54,140 Z"/>
</svg>`;
