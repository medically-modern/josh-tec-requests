'use strict';

// Reads submitter replies out of the mailbox via IMAP and files them against
// the right ticket. Uses the SAME credentials as SMTP (a Google app password
// grants both SMTP send and IMAP read), so no extra setup beyond enabling IMAP
// in Gmail. Set IMAP_DISABLED=true to turn this off.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function imapConfig() {
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASS || process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE ? process.env.IMAP_SECURE === 'true' : true,
    auth: { user, pass },
    logger: false,
  };
}

function imapConfigured() {
  return process.env.IMAP_DISABLED !== 'true' && !!imapConfig();
}

function normId(id) {
  if (!id) return '';
  return String(id).trim().replace(/^<|>$/g, '').toLowerCase();
}

function extractRefs(parsed) {
  const out = new Set();
  const push = (v) => {
    if (!v) return;
    const parts = Array.isArray(v) ? v : String(v).split(/\s+/);
    for (const p of parts) {
      const n = normId(p);
      if (n) out.add(`<${n}>`);
    }
  };
  push(parsed.references);
  push(parsed.inReplyTo);
  return [...out];
}

// Best-effort strip of quoted reply history so the UI shows just what they wrote.
function cleanReplyText(raw) {
  if (!raw) return '';
  const lines = String(raw).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*On .+wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^_{5,}\s*$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 8000);
}

function firstAddr(obj) {
  return (obj && obj.value && obj.value[0] && obj.value[0].address ? obj.value[0].address : '').toLowerCase();
}
function addrList(obj) {
  if (!obj || !obj.value) return '';
  return obj.value.map((v) => v.address).filter(Boolean).join(', ').slice(0, 300);
}

let syncing = false;

// Scans the mailbox for submitter replies and stores any new ones. Idempotent
// (deduped by Message-ID). Returns a summary; never throws.
async function syncInbox(pool) {
  if (!imapConfigured()) return { ok: false, configured: false, reason: 'IMAP not configured' };
  if (syncing) return { ok: true, skipped: true, ingested: 0 };
  syncing = true;

  const client = new ImapFlow(imapConfig());
  let ingested = 0;
  let scanned = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const { rows: out } = await pool.query('SELECT message_id FROM messages WHERE message_id IS NOT NULL');
      const ownIds = new Set(out.map((r) => normId(r.message_id)));

      const since = new Date(Date.now() - 45 * 86400000);
      let uids = [];
      try {
        uids = (await client.search({ subject: 'MM-', since }, { uid: true })) || [];
      } catch (err) {
        return { ok: false, configured: true, reason: `IMAP search failed: ${err.message}` };
      }

      for (const uid of uids.slice(-400)) {
        scanned++;
        let source;
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          source = msg && msg.source;
        } catch { continue; }
        if (!source) continue;

        let parsed;
        try { parsed = await simpleParser(source); } catch { continue; }

        const mid = normId(parsed.messageId);
        if (!mid || ownIds.has(mid)) continue; // skip our own sends / no id

        const subject = (parsed.subject || '').slice(0, 500);
        let request = null;
        const m = subject.match(/MM-(\d+)/i);
        if (m) {
          const { rows } = await pool.query(
            'SELECT id, submitter_email FROM requests WHERE ticket = $1',
            [`MM-${m[1]}`]
          );
          request = rows[0] || null;
        }
        if (!request) {
          const refs = extractRefs(parsed);
          if (refs.length) {
            const { rows } = await pool.query(
              `SELECT r.id, r.submitter_email FROM messages mm
               JOIN requests r ON r.id = mm.request_id
               WHERE mm.message_id = ANY($1) LIMIT 1`,
              [refs]
            );
            request = rows[0] || null;
          }
        }
        if (!request) continue;

        // Only the ticket's own submitter counts as a reply (excludes the admin
        // alert copy and any unrelated mail that mentions the ticket number).
        const fromAddr = firstAddr(parsed.from);
        if (!fromAddr || fromAddr !== String(request.submitter_email).toLowerCase()) continue;

        const body = cleanReplyText(parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ') : ''));
        const inReplyTo = normId(Array.isArray(parsed.inReplyTo) ? parsed.inReplyTo[0] : parsed.inReplyTo);

        const ins = await pool.query(
          `INSERT INTO messages (request_id, direction, kind, from_addr, to_addr, subject, body, message_id, in_reply_to)
           VALUES ($1, 'inbound', 'reply', $2, $3, $4, $5, $6, $7)
           ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [request.id, fromAddr, addrList(parsed.to), subject, body || '(no text)', `<${mid}>`, inReplyTo ? `<${inReplyTo}>` : null]
        );
        if (ins.rowCount) {
          ingested++;
          await pool.query(
            "INSERT INTO activity (request_id, actor, action, detail) VALUES ($1, $2, 'reply', $3)",
            [request.id, fromAddr, `Reply received: ${(body || '').slice(0, 140)}`]
          );
          await pool.query('UPDATE requests SET updated_at = now() WHERE id = $1', [request.id]);
        }
      }
    } finally {
      lock.release();
    }
    return { ok: true, configured: true, ingested, scanned };
  } catch (err) {
    console.error('IMAP sync failed:', err.message);
    return { ok: false, configured: true, reason: err.message };
  } finally {
    syncing = false;
    try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } }
  }
}

module.exports = { imapConfigured, syncInbox };
