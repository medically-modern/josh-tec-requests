'use strict';
/*
 * Email pipeline test: runs a minimal local SMTP server and verifies that with
 * SMTP_* configured, sendEmail() genuinely delivers all three templates
 * (submitter receipt, admin new-request alert, completion notice) with the
 * expected subjects and recipients.
 *
 * Usage: node server/test/email.test.js
 */

const net = require('net');
const assert = require('assert');

const received = []; // { from, to, data }

const smtp = net.createServer((socket) => {
  let msg = { from: '', to: [], data: '' };
  let inData = false;
  socket.write('220 localhost test SMTP\r\n');
  socket.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (inData) {
      msg.data += text;
      if (msg.data.includes('\r\n.\r\n')) {
        inData = false;
        received.push(msg);
        msg = { from: '', to: [], data: '' };
        socket.write('250 OK queued\r\n');
      }
      return;
    }
    for (const line of text.split('\r\n').filter(Boolean)) {
      const upper = line.toUpperCase();
      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        socket.write('250-localhost\r\n250 8BITMIME\r\n');
      } else if (upper.startsWith('MAIL FROM:')) {
        msg.from = line.slice(10).trim();
        socket.write('250 OK\r\n');
      } else if (upper.startsWith('RCPT TO:')) {
        msg.to.push(line.slice(8).trim());
        socket.write('250 OK\r\n');
      } else if (upper.startsWith('DATA')) {
        inData = true;
        socket.write('354 go ahead\r\n');
      } else if (upper.startsWith('QUIT')) {
        socket.write('221 bye\r\n');
        socket.end();
      } else {
        socket.write('250 OK\r\n');
      }
    }
  });
});

function decodeSubject(data) {
  // Subjects with emoji arrive MIME-encoded (=?UTF-8?B?...?= or ?Q?...)
  const m = data.match(/^Subject: (.*(?:\r\n[ \t].*)*)/im);
  if (!m) return '';
  const raw = m[1]
    .replace(/\r\n[ \t]/g, '')       // unfold header
    .replace(/\?=\s+=\?/g, '?==?');  // whitespace between adjacent encoded-words is not content
  return raw.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc, payload) => {
    if (enc.toLowerCase() === 'b') return Buffer.from(payload, 'base64').toString('utf8');
    const bytes = [];
    const s = payload.replace(/_/g, ' ');
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /^[0-9A-F]{2}$/i.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(s.charCodeAt(i));
      }
    }
    return Buffer.from(bytes).toString('utf8');
  });
}

(async () => {
  await new Promise((r) => smtp.listen(2525, '127.0.0.1', r));

  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '2525';
  process.env.SMTP_SECURE = 'false';
  delete process.env.SMTP_USER;
  delete process.env.RESEND_API_KEY;
  process.env.PUBLIC_BASE_URL = 'https://example.test/desk';
  process.env.EMAIL_FROM = 'MM Service Desk <desk@medicallymodern.com>';

  const { emailMode, sendEmail, receiptEmail, completionEmail, adminNewRequestEmail } = require('../src/email.js');

  assert.strictEqual(emailMode(), 'smtp');

  const fakeReq = {
    id: '5d1c1a34-0000-4000-8000-000000000000',
    ticket: 'MM-1042',
    service_name: 'Patient Portal',
    type: 'issue',
    severity: 'critical',
    title: "Calendar won't load",
    description: 'The Monday view throws an error every time.',
    steps: '1. Open portal\n2. Click calendar',
    video_links: ['https://www.loom.com/share/abc'],
    submitter_name: 'Sarah',
    submitter_email: 'sarah@medicallymodern.com',
    resolution_note: 'Rebuilt the calendar query.',
    screenshots: [{ id: 'x' }, { id: 'y' }],
  };

  let pass = 0;

  const r1 = await sendEmail(receiptEmail(fakeReq));
  assert.strictEqual(r1.sent, true, JSON.stringify(r1));
  pass++;

  const r2 = await sendEmail(adminNewRequestEmail(fakeReq, 'josh@medicallymodern.com'));
  assert.strictEqual(r2.sent, true, JSON.stringify(r2));
  pass++;

  const r3 = await sendEmail(completionEmail(fakeReq));
  assert.strictEqual(r3.sent, true, JSON.stringify(r3));
  pass++;

  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(received.length, 3, `expected 3 delivered emails, got ${received.length}`);

  const [receipt, alert, done] = received;
  assert.ok(receipt.to[0].includes('sarah@medicallymodern.com'));
  assert.ok(decodeSubject(receipt.data).includes('[MM-1042] We received your issue report'));

  assert.ok(alert.to[0].includes('josh@medicallymodern.com'), 'admin alert must go to Josh');
  const alertSubject = decodeSubject(alert.data);
  assert.ok(alertSubject.includes('Critical Issue'), `subject missing severity/type: ${alertSubject}`);
  assert.ok(alertSubject.includes('Patient Portal'), `subject missing service: ${alertSubject}`);
  assert.ok(alertSubject.includes('Sarah'), `subject missing submitter: ${alertSubject}`);
  assert.ok(alertSubject.includes('MM-1042'), `subject missing ticket: ${alertSubject}`);
  const alertBody = alert.data.replace(/=\r\n/g, '').replace(/=3D/gi, '=');
  assert.ok(alertBody.includes('admin.html?req='), 'alert body missing dashboard deep link');

  assert.ok(done.to[0].includes('sarah@medicallymodern.com'));
  assert.ok(decodeSubject(done.data).includes('[MM-1042] Completed'));
  assert.ok(done.data.includes('Rebuilt the calendar query'), 'completion email missing resolution note');

  console.log(`email pipeline: ${pass} sends + 3 deliveries verified (receipt, admin alert, completion)`);
  smtp.close();
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
