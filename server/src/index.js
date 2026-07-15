'use strict';

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { pool, migrate, nextTicket } = require('./db');
const { emailMode, sendEmail, senderAddress, receiptEmail, completionEmail, adminNewRequestEmail, followupEmail } = require('./email');
const { imapConfigured, syncInbox } = require('./imap');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const VERSION = '1.0.0';

if (!ADMIN_KEY) {
  console.error('FATAL: ADMIN_KEY is not set — refusing to start without admin authentication');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// CORS — allow configured origins (comma separated). Empty/unset = allow all.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    allowedHeaders: ['Content-Type', 'x-admin-key'],
    maxAge: 86400,
  })
);

// ---------------------------------------------------------------------------
// Minimal in-memory rate limiter (per IP per bucket)
const rateBuckets = new Map();
function rateLimit(bucket, limit, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let hits = rateBuckets.get(key) || [];
    hits = hits.filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      return res.status(429).json({ error: 'Too many requests — please wait a moment and try again.' });
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateBuckets) {
    const alive = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (alive.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, alive);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Admin auth
function timingSafeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  // Header only — a query-param key would leak into access logs and history.
  const key = req.get('x-admin-key') || '';
  if (!key || !timingSafeEq(key, ADMIN_KEY)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Uploads — screenshots are the common case, but any common document type is
// accepted alongside them (max 8 MB x 6 files). Images are verified by magic
// bytes and previewed inline; every other type is stored as-is and only ever
// served as a download, so a crafted file can never execute in this origin.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DOC_TYPES = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain'],
  ['log', 'text/plain'],
  ['md', 'text/plain'],
  ['rtf', 'application/rtf'],
  ['json', 'application/json'],
  ['zip', 'application/zip'],
  ['heic', 'image/heic'],
  ['heif', 'image/heif'],
  ['mp4', 'video/mp4'],
  ['mov', 'video/quicktime'],
  ['webm', 'video/webm'],
  // image extensions map here too, so a picture with a generic mimetype
  // still goes down the verified-image path below
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
]);
const fileExt = (name) => String(name || '').split('.').pop().toLowerCase();
const TYPE_ERROR = 'That file type is not supported — attach images, PDF, Office documents, CSV/text/log, JSON, or ZIP files.';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter(req, file, cb) {
    if (IMAGE_MIME.has(file.mimetype) || DOC_TYPES.has(fileExt(file.originalname))) return cb(null, true);
    return cb(new Error(TYPE_ERROR));
  },
});

function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
const TYPES = new Set(['issue', 'change_request']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const STATUSES = new Set(['open', 'in_progress', 'completed', 'declined']);
const EMAIL_RE = /^[a-z0-9._%+-]+@medicallymodern\.com$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => UUID_RE.test(String(s || ''));

function clean(s, max) {
  return String(s ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

function parseVideoLinks(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    try { arr = JSON.parse(raw); } catch { arr = raw ? [raw] : []; }
  }
  if (!Array.isArray(arr)) arr = [];
  const out = [];
  for (const item of arr.slice(0, 10)) {
    const url = clean(item, 500);
    if (!url) continue;
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.toString());
    } catch { /* skip invalid URLs */ }
  }
  return out;
}

function screenshotMeta(row) {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size_bytes: row.size_bytes,
    url: `/api/screenshots/${row.id}`,
  };
}

function publicRequest(row, screenshots) {
  return {
    id: row.id,
    ticket: row.ticket,
    service_id: row.service_id,
    service_name: row.service_name,
    folder_id: row.folder_id || null,
    type: row.type,
    severity: row.severity,
    title: row.title,
    description: row.description,
    steps: row.steps,
    video_links: row.video_links,
    submitter_name: row.submitter_name,
    submitter_email: row.submitter_email,
    status: row.status,
    resolution_note: row.resolution_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    notified_at: row.notified_at,
    notify_status: row.notify_status,
    screenshots: (screenshots || []).map(screenshotMeta),
  };
}

async function getRequestFull(id, byTicket = false) {
  if (!byTicket && !isUuid(id)) return null;
  const where = byTicket ? 'r.ticket = $1' : 'r.id = $1';
  const { rows } = await pool.query(
    `SELECT r.*, s.name AS service_name FROM requests r JOIN services s ON s.id = r.service_id WHERE ${where}`,
    [id]
  );
  if (!rows.length) return null;
  const shots = await pool.query(
    'SELECT id, filename, mime, size_bytes FROM screenshots WHERE request_id = $1 ORDER BY created_at',
    [rows[0].id]
  );
  return publicRequest(rows[0], shots.rows);
}

async function logActivity(requestId, actor, action, detail = '') {
  await pool.query(
    'INSERT INTO activity (request_id, actor, action, detail) VALUES ($1, $2, $3, $4)',
    [requestId, actor, action, detail]
  );
}

// In-Reply-To / References for the next email in a ticket's thread, so Gmail
// keeps the whole exchange as one conversation.
async function threadHeadersFor(requestId) {
  const { rows } = await pool.query(
    'SELECT message_id FROM messages WHERE request_id = $1 AND message_id IS NOT NULL ORDER BY created_at',
    [requestId]
  );
  const ids = rows.map((r) => r.message_id);
  return { inReplyTo: ids[ids.length - 1] || null, references: ids };
}

async function storeOutbound(requestId, kind, toAddr, subject, body, messageId, inReplyTo) {
  await pool.query(
    `INSERT INTO messages (request_id, direction, kind, from_addr, to_addr, subject, body, message_id, in_reply_to)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8)`,
    [requestId, kind, senderAddress(), toAddr, subject || '', body || '', messageId || null, inReplyTo || null]
  );
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------------------------------------------------------------------------
// Public endpoints
app.get('/', (req, res) => res.json({ ok: true, service: 'Medically Modern Service Desk API', version: VERSION }));

app.get('/api/health', asyncRoute(async (req, res) => {
  let db = false;
  try {
    await pool.query('SELECT 1');
    db = true;
  } catch { /* db stays false */ }
  res.status(db ? 200 : 503).json({ ok: db, db, email_mode: emailMode(), version: VERSION, time: new Date().toISOString() });
}));

app.get('/api/services', rateLimit('services', 120, 60000), asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, description FROM services WHERE active = TRUE ORDER BY sort_order, name'
  );
  res.json({ services: rows });
}));

app.post(
  '/api/requests',
  rateLimit('submit', 15, 60000),
  (req, res, next) => {
    upload.array('screenshots', 6)(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? 'Each file must be 8 MB or smaller'
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? 'You can attach up to 6 files'
            : err.message || 'Upload failed';
        return res.status(400).json({ error: msg });
      }
      next();
    });
  },
  asyncRoute(async (req, res) => {
    const b = req.body || {};
    const serviceId = clean(b.service_id, 60);
    const type = clean(b.type, 20);
    const severity = clean(b.severity, 20);
    const title = clean(b.title, 200);
    const description = clean(b.description, 8000);
    const steps = clean(b.steps, 8000);
    const submitterName = clean(b.submitter_name, 120);
    const submitterEmail = clean(b.submitter_email, 160).toLowerCase();
    const videoLinks = parseVideoLinks(b.video_links);

    const errors = [];
    if (!serviceId) errors.push('Please choose a service.');
    if (!TYPES.has(type)) errors.push('Please choose a request type (issue or change request).');
    if (!SEVERITIES.has(severity)) errors.push('Please choose a severity level.');
    if (title.length < 4) errors.push('Please give a short summary title (at least 4 characters).');
    if (description.length < 10) errors.push('Please describe the request in a bit more detail (at least 10 characters).');
    if (submitterName.length < 2) errors.push('Please enter your name.');
    if (!EMAIL_RE.test(submitterEmail)) errors.push('Email must be a valid @medicallymodern.com address.');
    if (errors.length) return res.status(400).json({ error: errors.join(' '), errors });

    if (!isUuid(serviceId)) return res.status(400).json({ error: 'That service was not found — refresh the page and pick again.' });
    const svc = await pool.query('SELECT id, name FROM services WHERE id = $1 AND active = TRUE', [serviceId]);
    if (!svc.rows.length) return res.status(400).json({ error: 'That service was not found — refresh the page and pick again.' });

    // Verify every upload before storing: anything claiming to be a
    // previewable image must really be one (magic bytes), and documents must
    // match their extension's signature where the format has one.
    const files = req.files || [];
    for (const f of files) {
      const ext = fileExt(f.originalname);
      const claimsImage = IMAGE_MIME.has(f.mimetype) || IMAGE_MIME.has(DOC_TYPES.get(ext) || '');
      if (claimsImage) {
        const sniffed = sniffImage(f.buffer);
        if (!sniffed) {
          return res.status(400).json({ error: `"${f.originalname}" does not look like a valid image file.` });
        }
        f.verifiedMime = sniffed;
        continue;
      }
      const mapped = DOC_TYPES.get(ext);
      if (!mapped) return res.status(400).json({ error: `"${f.originalname}": ${TYPE_ERROR}` });
      if (mapped === 'application/pdf' && f.buffer.slice(0, 5).toString('ascii') !== '%PDF-') {
        return res.status(400).json({ error: `"${f.originalname}" does not look like a valid PDF file.` });
      }
      if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext) && !(f.buffer[0] === 0x50 && f.buffer[1] === 0x4b)) {
        return res.status(400).json({ error: `"${f.originalname}" does not look like a valid .${ext} file.` });
      }
      f.verifiedMime = mapped;
    }

    const client = await pool.connect();
    let created;
    try {
      await client.query('BEGIN');
      const ticket = await nextTicket(client);
      const ins = await client.query(
        `INSERT INTO requests
           (ticket, service_id, type, severity, title, description, steps, video_links, submitter_name, submitter_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [ticket, serviceId, type, severity, title, description, steps, JSON.stringify(videoLinks), submitterName, submitterEmail]
      );
      created = ins.rows[0];
      for (const f of files) {
        await client.query(
          'INSERT INTO screenshots (request_id, filename, mime, size_bytes, data) VALUES ($1,$2,$3,$4,$5)',
          [created.id, clean(f.originalname, 200) || 'screenshot.png', f.verifiedMime, f.buffer.length, f.buffer]
        );
      }
      await client.query(
        'INSERT INTO activity (request_id, actor, action, detail) VALUES ($1,$2,$3,$4)',
        [created.id, submitterName, 'created', `Submitted with ${files.length} file(s) and ${videoLinks.length} video link(s)`]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const full = await getRequestFull(created.id);

    // Best-effort receipt email (never blocks the submission). Stored as the
    // root of the ticket's email thread so replies and follow-ups thread to it.
    let receipt = { mode: emailMode(), sent: false };
    try {
      const rMsg = receiptEmail(full);
      receipt = await sendEmail(rMsg);
      if (receipt.sent) {
        await logActivity(created.id, 'system', 'email_sent', 'Receipt email sent to submitter');
        await storeOutbound(created.id, 'receipt', full.submitter_email, rMsg.subject, rMsg.text, receipt.messageId, null);
      }
    } catch { /* already logged inside sendEmail */ }

    // Best-effort new-request alert to the admin
    const adminEmail = (process.env.ADMIN_NOTIFY_EMAIL || '').trim();
    if (adminEmail) {
      try {
        const aMsg = adminNewRequestEmail(full, adminEmail);
        const alert = await sendEmail(aMsg);
        if (alert.sent) {
          await logActivity(created.id, 'system', 'email_sent', `New-request alert sent to ${adminEmail}`);
          // Recorded (not shown in the submitter conversation) so the IMAP
          // reader can tell our own alert apart from a genuine reply.
          await storeOutbound(created.id, 'admin_alert', adminEmail, aMsg.subject, '', alert.messageId, null);
        }
      } catch { /* already logged inside sendEmail */ }
    }

    res.status(201).json({ request: full, receipt_email: { mode: receipt.mode, sent: receipt.sent } });
  })
);

// Publicly readable by unguessable UUID (used by the form's "server-verified" echo)
app.get('/api/screenshots/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query('SELECT filename, mime, size_bytes, data FROM screenshots WHERE id = $1', [id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const s = rows[0];
  // Verified images render inline (previews); every other type is
  // download-only so a crafted file can never execute in this origin.
  const inline = IMAGE_MIME.has(s.mime);
  res.set({
    'Content-Type': inline ? s.mime : s.mime || 'application/octet-stream',
    'Content-Length': String(s.size_bytes),
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${s.filename.replace(/[^\w.\- ]/g, '_')}"`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(s.data);
}));

// Company review sheet — every unresolved request (open + in progress), fresh
// on each load. Shareable read-only link; set REVIEW_KEY on Railway to require
// ?key=… in the link, leave it unset for an open link.
const REVIEW_KEY = (process.env.REVIEW_KEY || '').trim();
app.get('/api/review', rateLimit('review', 60, 60000), asyncRoute(async (req, res) => {
  if (REVIEW_KEY && !timingSafeEq(clean(req.query.key, 200), REVIEW_KEY)) {
    return res.status(401).json({ error: 'This review link is missing or has the wrong access key.' });
  }
  const { rows } = await pool.query(
    `SELECT r.ticket, r.type, r.severity, r.status, r.title, r.description,
            r.submitter_name, r.created_at, r.updated_at, s.name AS service_name,
            COALESCE(jsonb_array_length(r.video_links), 0)::int AS video_count,
            (r.steps <> '') AS has_steps,
            COALESCE(sc.n, 0)::int AS screenshot_count,
            COALESCE(mc.n, 0)::int AS message_count,
            nt.notes
     FROM requests r
     JOIN services s ON s.id = r.service_id
     LEFT JOIN (SELECT request_id, COUNT(*) AS n FROM screenshots GROUP BY request_id) sc ON sc.request_id = r.id
     LEFT JOIN (SELECT request_id, COUNT(*) AS n FROM messages WHERE kind <> 'admin_alert' GROUP BY request_id) mc ON mc.request_id = r.id
     LEFT JOIN (SELECT request_id,
                       json_agg(json_build_object('actor', actor, 'detail', detail, 'created_at', created_at)
                                ORDER BY created_at DESC) AS notes
                FROM activity WHERE action = 'review_note' GROUP BY request_id) nt ON nt.request_id = r.id
     WHERE r.status IN ('open', 'in_progress')
     ORDER BY (r.type = 'change_request') DESC,
              CASE r.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
              r.created_at`
  );
  res.set('Cache-Control', 'no-store');
  res.json({ requests: rows.map((r) => ({ ...r, notes: r.notes || [] })), generated_at: new Date().toISOString() });
}));

// Full detail for one ticket on the review sheet: steps, video links,
// screenshots, the email conversation, and the activity timeline. Internal
// admin notes and raw email addresses are never included.
app.get('/api/review/:ticket', rateLimit('review_detail', 120, 60000), asyncRoute(async (req, res) => {
  if (REVIEW_KEY && !timingSafeEq(clean(req.query.key, 200), REVIEW_KEY)) {
    return res.status(401).json({ error: 'This review link is missing or has the wrong access key.' });
  }
  const full = await getRequestFull(clean(req.params.ticket, 24).toUpperCase(), true);
  if (!full) return res.status(404).json({ error: 'Ticket not found.' });
  delete full.submitter_email;
  const { rows: acts } = await pool.query(
    `SELECT actor, action, detail, created_at FROM activity
     WHERE request_id = $1
       AND action IN ('created','status_changed','email_sent','email_pending','followup','reply','resolution_note','review_note')
     ORDER BY created_at`,
    [full.id]
  );
  const { rows: msgs } = await pool.query(
    `SELECT direction, kind, subject, body, created_at
     FROM messages WHERE request_id = $1 AND kind <> 'admin_alert' ORDER BY created_at`,
    [full.id]
  );
  res.set('Cache-Control', 'no-store');
  res.json({ request: full, activity: acts, messages: msgs });
}));

// Add a collaborative note to a ticket straight from the review sheet. Gated by
// the same REVIEW_KEY as the rest of the sheet (open link when unset), and
// recorded as a distinct 'review_note' action so these shared notes never mix
// with admins' PRIVATE internal notes (action 'note'), which stay hidden from
// the review sheet. The author's name is captured for attribution.
app.post('/api/review/:ticket/notes', rateLimit('review_note', 30, 60000), asyncRoute(async (req, res) => {
  if (REVIEW_KEY && !timingSafeEq(clean(req.query.key, 200), REVIEW_KEY)) {
    return res.status(401).json({ error: 'This review link is missing or has the wrong access key.' });
  }
  const full = await getRequestFull(clean(req.params.ticket, 24).toUpperCase(), true);
  if (!full) return res.status(404).json({ error: 'Ticket not found.' });
  const note = clean((req.body || {}).note, 4000);
  if (!note) return res.status(400).json({ error: 'Note text is required.' });
  const author = clean((req.body || {}).author, 120) || 'Anonymous';
  const { rows } = await pool.query(
    `INSERT INTO activity (request_id, actor, action, detail)
     VALUES ($1, $2, 'review_note', $3)
     RETURNING actor, action, detail, created_at`,
    [full.id, author, note]
  );
  await pool.query('UPDATE requests SET updated_at = now() WHERE id = $1', [full.id]);
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ note: rows[0] });
}));

// Ticket tracking for submitters (requires matching ticket + email)
app.get('/api/track', rateLimit('track', 20, 60000), asyncRoute(async (req, res) => {
  const ticket = clean(req.query.ticket, 24).toUpperCase();
  const email = clean(req.query.email, 160).toLowerCase();
  if (!ticket || !email) return res.status(400).json({ error: 'Ticket number and email are required.' });
  const full = await getRequestFull(ticket, true);
  if (!full || full.submitter_email !== email) {
    return res.status(404).json({ error: 'No ticket found with that number and email combination.' });
  }
  const { rows: acts } = await pool.query(
    `SELECT actor, action, detail, created_at FROM activity
     WHERE request_id = $1 AND action IN ('created','status_changed','email_sent')
     ORDER BY created_at`,
    [full.id]
  );
  res.json({ request: full, activity: acts });
}));

// ---------------------------------------------------------------------------
// Admin endpoints
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/requests', asyncRoute(async (req, res) => {
  const conds = [];
  const params = [];
  const add = (sql, val) => { params.push(val); conds.push(sql.replace('?', `$${params.length}`)); };

  const status = clean(req.query.status, 20);
  if (status && STATUSES.has(status)) add('r.status = ?', status);
  const service = clean(req.query.service_id, 60);
  if (service && isUuid(service)) add('r.service_id = ?', service);
  const type = clean(req.query.type, 20);
  if (type && TYPES.has(type)) add('r.type = ?', type);
  const severity = clean(req.query.severity, 20);
  if (severity && SEVERITIES.has(severity)) add('r.severity = ?', severity);
  const q = clean(req.query.q, 100);
  if (q) add('(r.title ILIKE ? OR r.description ILIKE $' + (params.length + 2) + ' OR r.ticket ILIKE $' + (params.length + 3) + ' OR r.submitter_name ILIKE $' + (params.length + 4) + ')', `%${q}%`);
  if (q) { params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // Internal notes and submitter-reply counts ride along so the dashboard can
  // preview notes on hover and flag unread replies without opening each ticket.
  const { rows } = await pool.query(
    `SELECT r.*, s.name AS service_name,
            COALESCE(sc.n, 0)::int AS screenshot_count,
            nt.notes,
            COALESCE(rp.reply_count, 0)::int AS reply_count,
            COALESCE(rp.unseen_replies, 0)::int AS unseen_replies,
            rp.last_reply_at
     FROM requests r
     JOIN services s ON s.id = r.service_id
     LEFT JOIN (SELECT request_id, COUNT(*) AS n FROM screenshots GROUP BY request_id) sc ON sc.request_id = r.id
     LEFT JOIN (SELECT request_id,
                       json_agg(json_build_object('actor', actor, 'detail', detail, 'created_at', created_at)
                                ORDER BY created_at DESC) AS notes
                FROM activity WHERE action = 'note' GROUP BY request_id) nt ON nt.request_id = r.id
     LEFT JOIN (SELECT request_id,
                       COUNT(*) AS reply_count,
                       COUNT(*) FILTER (WHERE seen_at IS NULL) AS unseen_replies,
                       MAX(created_at) AS last_reply_at
                FROM messages WHERE direction = 'inbound' GROUP BY request_id) rp ON rp.request_id = r.id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT 500`,
    params
  );
  res.json({
    requests: rows.map((r) => ({
      ...publicRequest(r, []),
      screenshots: undefined,
      screenshot_count: r.screenshot_count,
      notes: r.notes || [],
      reply_count: r.reply_count,
      unseen_replies: r.unseen_replies,
      last_reply_at: r.last_reply_at,
    })),
  });
}));

admin.get('/requests/:id', asyncRoute(async (req, res) => {
  const full = await getRequestFull(clean(req.params.id, 60));
  if (!full) return res.status(404).json({ error: 'Not found' });
  const { rows: acts } = await pool.query(
    'SELECT actor, action, detail, created_at FROM activity WHERE request_id = $1 ORDER BY created_at',
    [full.id]
  );
  const { rows: msgs } = await pool.query(
    `SELECT direction, kind, from_addr, to_addr, subject, body, created_at
     FROM messages WHERE request_id = $1 AND kind <> 'admin_alert' ORDER BY created_at`,
    [full.id]
  );
  // Opening a ticket counts as reading its replies — clears the inbox badge.
  await pool.query(
    "UPDATE messages SET seen_at = now() WHERE request_id = $1 AND direction = 'inbound' AND seen_at IS NULL",
    [full.id]
  );
  res.json({
    request: full,
    activity: acts,
    messages: msgs,
    email_mode: emailMode(),
    imap: { configured: imapConfigured() },
  });
}));

// Send a follow-up / question to the submitter as a reply in the ticket thread.
admin.post('/requests/:id/message', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  const full = await getRequestFull(id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  const bodyText = clean((req.body || {}).body, 8000);
  if (bodyText.length < 1) return res.status(400).json({ error: 'Message text is required' });

  const msg = followupEmail(full, bodyText);
  const th = await threadHeadersFor(id);
  const result = await sendEmail({ ...msg, inReplyTo: th.inReplyTo, references: th.references });

  if (!result.sent) {
    return res.status(200).json({ sent: false, mode: result.mode, error: result.error, mailto: result.mailto });
  }
  await storeOutbound(id, 'followup', full.submitter_email, msg.subject, bodyText, result.messageId, th.inReplyTo);
  await logActivity(id, 'admin', 'followup', `Follow-up email sent to ${full.submitter_email}`);
  await pool.query('UPDATE requests SET updated_at = now() WHERE id = $1', [id]);
  res.status(201).json({ sent: true, mode: result.mode });
}));

// Pull new submitter replies from the mailbox (also runs on a timer).
admin.post('/sync', asyncRoute(async (req, res) => {
  const result = await syncInbox(pool);
  res.json(result);
}));

admin.patch('/requests/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  const existing = await getRequestFull(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  const updates = [];
  const params = [];
  let emailResult = null;

  const newStatus = b.status !== undefined ? clean(b.status, 20) : null;
  if (newStatus !== null && !STATUSES.has(newStatus)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (b.resolution_note !== undefined) {
    params.push(clean(b.resolution_note, 8000));
    updates.push(`resolution_note = $${params.length}`);
  }
  // Personal organization: file the ticket into a folder (null = back to inbox).
  if (b.folder_id !== undefined) {
    const folderId = b.folder_id === null || b.folder_id === '' ? null : clean(b.folder_id, 60);
    if (folderId !== null) {
      if (!isUuid(folderId)) return res.status(400).json({ error: 'That folder was not found — refresh and try again.' });
      const f = await pool.query('SELECT id FROM folders WHERE id = $1', [folderId]);
      if (!f.rows.length) return res.status(400).json({ error: 'That folder was not found — refresh and try again.' });
    }
    params.push(folderId);
    updates.push(`folder_id = $${params.length}`);
  }
  if (newStatus && newStatus !== existing.status) {
    params.push(newStatus);
    updates.push(`status = $${params.length}`);
    if (newStatus === 'completed') {
      updates.push('completed_at = now()');
    } else if (existing.status === 'completed') {
      updates.push('completed_at = NULL');
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

  updates.push('updated_at = now()');
  params.push(id);
  await pool.query(`UPDATE requests SET ${updates.join(', ')} WHERE id = $${params.length}`, params);

  if (newStatus && newStatus !== existing.status) {
    await logActivity(id, 'admin', 'status_changed', `Status changed from ${existing.status} to ${newStatus}`);
  }
  if (b.resolution_note !== undefined && clean(b.resolution_note, 8000) !== existing.resolution_note) {
    await logActivity(id, 'admin', 'resolution_note', 'Resolution note updated');
  }

  // Completion email
  if (newStatus === 'completed' && existing.status !== 'completed' && b.skip_email !== true) {
    const fresh = await getRequestFull(id);
    const cMsg = completionEmail(fresh);
    const th = await threadHeadersFor(id);
    emailResult = await sendEmail({ ...cMsg, inReplyTo: th.inReplyTo, references: th.references });
    if (emailResult.sent) {
      await storeOutbound(id, 'completion', fresh.submitter_email, cMsg.subject, cMsg.text, emailResult.messageId, th.inReplyTo);
    }
    const notifyStatus = emailResult.sent ? 'sent' : emailResult.mode === 'manual' ? 'manual' : 'failed';
    await pool.query(
      'UPDATE requests SET notify_status = $1, notified_at = CASE WHEN $1 = $2 THEN now() ELSE notified_at END WHERE id = $3',
      [notifyStatus, 'sent', id]
    );
    await logActivity(
      id, 'system',
      emailResult.sent ? 'email_sent' : 'email_pending',
      emailResult.sent
        ? `Completion email sent to ${existing.submitter_email}`
        : emailResult.mode === 'manual'
          ? 'Automatic email not configured — use the one-click compose link in the dashboard'
          : `Email failed: ${emailResult.error || 'unknown error'}`
    );
  }

  const full = await getRequestFull(id);
  res.json({
    request: full,
    email: emailResult
      ? { mode: emailResult.mode, sent: emailResult.sent, error: emailResult.error, mailto: emailResult.mailto }
      : null,
  });
}));

admin.post('/requests/:id/notes', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  const existing = await getRequestFull(id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const note = clean((req.body || {}).note, 4000);
  if (!note) return res.status(400).json({ error: 'Note text required' });
  await logActivity(id, 'admin', 'note', note);
  await pool.query('UPDATE requests SET updated_at = now() WHERE id = $1', [id]);
  res.status(201).json({ ok: true });
}));

// (Re)send the completion email for an already-completed request
admin.post('/requests/:id/notify', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  const full = await getRequestFull(id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  if (full.status !== 'completed') return res.status(400).json({ error: 'Request is not completed yet' });
  const emailResult = await sendEmail(completionEmail(full));
  const notifyStatus = emailResult.sent ? 'sent' : emailResult.mode === 'manual' ? 'manual' : 'failed';
  await pool.query(
    'UPDATE requests SET notify_status = $1, notified_at = CASE WHEN $1 = $2 THEN now() ELSE notified_at END WHERE id = $3',
    [notifyStatus, 'sent', id]
  );
  await logActivity(id, 'system', emailResult.sent ? 'email_sent' : 'email_pending',
    emailResult.sent ? `Completion email re-sent to ${full.submitter_email}` : 'Manual email compose link generated');
  res.json({ email: { mode: emailResult.mode, sent: emailResult.sent, error: emailResult.error, mailto: emailResult.mailto } });
}));

admin.delete('/requests/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const { rowCount } = await pool.query('DELETE FROM requests WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// Services management (the ever-growing list)
admin.get('/services', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, COALESCE(rc.n,0)::int AS request_count
     FROM services s
     LEFT JOIN (SELECT service_id, COUNT(*) AS n FROM requests GROUP BY service_id) rc ON rc.service_id = s.id
     ORDER BY s.sort_order, s.name`
  );
  res.json({ services: rows });
}));

admin.post('/services', asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 120);
  const description = clean(b.description, 500);
  if (name.length < 2) return res.status(400).json({ error: 'Service name required (2+ characters)' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO services (name, description) VALUES ($1, $2) RETURNING *',
      [name, description]
    );
    res.status(201).json({ service: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A service with that name already exists' });
    throw err;
  }
}));

admin.patch('/services/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const updates = [];
  const params = [];
  if (b.name !== undefined) {
    const name = clean(b.name, 120);
    if (name.length < 2) return res.status(400).json({ error: 'Service name required (2+ characters)' });
    params.push(name);
    updates.push(`name = $${params.length}`);
  }
  if (b.description !== undefined) { params.push(clean(b.description, 500)); updates.push(`description = $${params.length}`); }
  if (b.active !== undefined) { params.push(Boolean(b.active)); updates.push(`active = $${params.length}`); }
  if (b.sort_order !== undefined && Number.isFinite(Number(b.sort_order))) {
    params.push(Math.trunc(Number(b.sort_order)));
    updates.push(`sort_order = $${params.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(id);
  try {
    const { rows } = await pool.query(
      `UPDATE services SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ service: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A service with that name already exists' });
    throw err;
  }
}));

// Only services with no requests can be deleted; others should be hidden instead
admin.delete('/services/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM requests WHERE service_id = $1', [id]);
  if (rows[0].n > 0) {
    return res.status(409).json({ error: 'This service has requests attached — hide it instead of deleting.' });
  }
  const { rowCount } = await pool.query('DELETE FROM services WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

// Inbox folders — personal organization for the admin dashboard. Filing a
// ticket into a folder tucks it out of the main inbox; the folder chips pull
// it back up. Deleting a folder returns its tickets to the inbox
// (folder_id has ON DELETE SET NULL), so nothing is ever lost.
admin.get('/folders', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT f.*, COALESCE(rc.n, 0)::int AS request_count,
            COALESCE(rc.active_n, 0)::int AS active_count
     FROM folders f
     LEFT JOIN (SELECT folder_id, COUNT(*) AS n,
                       COUNT(*) FILTER (WHERE status IN ('open', 'in_progress')) AS active_n
                FROM requests WHERE folder_id IS NOT NULL GROUP BY folder_id) rc ON rc.folder_id = f.id
     ORDER BY f.sort_order, f.name`
  );
  res.json({ folders: rows });
}));

admin.post('/folders', asyncRoute(async (req, res) => {
  const name = clean((req.body || {}).name, 60);
  if (name.length < 1) return res.status(400).json({ error: 'Folder name required' });
  try {
    const { rows } = await pool.query('INSERT INTO folders (name) VALUES ($1) RETURNING *', [name]);
    res.status(201).json({ folder: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A folder with that name already exists' });
    throw err;
  }
}));

admin.patch('/folders/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const name = clean((req.body || {}).name, 60);
  if (name.length < 1) return res.status(400).json({ error: 'Folder name required' });
  try {
    const { rows } = await pool.query('UPDATE folders SET name = $1 WHERE id = $2 RETURNING *', [name, id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ folder: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A folder with that name already exists' });
    throw err;
  }
}));

admin.delete('/folders/:id', asyncRoute(async (req, res) => {
  const id = clean(req.params.id, 60);
  if (!isUuid(id)) return res.status(404).json({ error: 'Not found' });
  const { rowCount } = await pool.query('DELETE FROM folders WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
}));

admin.get('/stats', asyncRoute(async (req, res) => {
  const [byStatus, byService, bySeverity, byType, recent, resolution] = await Promise.all([
    pool.query('SELECT status, COUNT(*)::int AS n FROM requests GROUP BY status'),
    pool.query(`SELECT s.name, COUNT(r.id)::int AS n FROM requests r JOIN services s ON s.id = r.service_id GROUP BY s.name ORDER BY n DESC`),
    pool.query('SELECT severity, COUNT(*)::int AS n FROM requests GROUP BY severity'),
    pool.query('SELECT type, COUNT(*)::int AS n FROM requests GROUP BY type'),
    pool.query(`SELECT date_trunc('day', created_at)::date AS day, COUNT(*)::int AS n
                FROM requests WHERE created_at > now() - interval '30 days'
                GROUP BY day ORDER BY day`),
    pool.query(`SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)))/3600, 0)::float AS avg_hours
                FROM requests WHERE completed_at IS NOT NULL`),
  ]);
  res.json({
    by_status: byStatus.rows,
    by_service: byService.rows,
    by_severity: bySeverity.rows,
    by_type: byType.rows,
    last_30_days: recent.rows,
    avg_resolution_hours: resolution.rows[0].avg_hours,
    email_mode: emailMode(),
  });
}));

admin.get('/export.csv', asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.ticket, s.name AS service, r.type, r.severity, r.status, r.title, r.description,
            r.submitter_name, r.submitter_email, r.created_at, r.completed_at, r.resolution_note
     FROM requests r JOIN services s ON s.id = r.service_id ORDER BY r.created_at DESC`
  );
  const cols = ['ticket', 'service', 'type', 'severity', 'status', 'title', 'description', 'submitter_name', 'submitter_email', 'created_at', 'completed_at', 'resolution_note'];
  const escCsv = (v) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Neutralize spreadsheet formula injection (=, +, -, @, tab at cell start)
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => escCsv(r[c])).join(','))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="service-requests.csv"' });
  res.send(csv);
}));

app.use('/api/admin', rateLimit('admin', 240, 60000), admin);

// ---------------------------------------------------------------------------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on our side — please try again.' });
});

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MM Service Desk API listening on :${PORT} (email mode: ${emailMode()}, imap: ${imapConfigured()})`);
    });
    // Poll the mailbox for submitter replies on a timer (in addition to the
    // on-demand sync when the admin opens a ticket).
    if (imapConfigured()) {
      setTimeout(() => syncInbox(pool).catch(() => {}), 15000).unref();
      setInterval(() => syncInbox(pool).catch(() => {}), 180000).unref();
    }
  })
  .catch((err) => {
    console.error('FATAL: could not initialize database:', err);
    process.exit(1);
  });
