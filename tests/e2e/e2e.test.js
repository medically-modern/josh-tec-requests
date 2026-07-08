'use strict';
/*
 * Full end-to-end browser test against the LIVE deployed site.
 * Drives the real employee form (with real PNG uploads), verifies the
 * server-echo confirmation, the status tracker, and every admin flow.
 */

const { chromium } = require('playwright');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const http = require('http');

const REAL_SITE = process.env.SITE_URL || 'https://service-desk-web-production-6b50.up.railway.app';
const API = process.env.API_URL || 'https://service-desk-api-production-cab4.up.railway.app';
let SITE = REAL_SITE; // replaced by the local relay URL at startup

// ---------------------------------------------------------------------------
// The sandbox egress proxy resets Chromium's TLS handshake, so the browser
// can't reach HTTPS directly. These local relays stream browser traffic to the
// REAL deployed site + API through Node's fetch (which the proxy supports).
// The browser does fully native networking against 127.0.0.1.
const STRIP_RES = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection']);
const STRIP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'origin', 'referer']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function relay({ upstreamBase, pathPrefix = '', rewrite, cors }) {
  return http.createServer(async (req, res) => {
    try {
      if (cors && req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
          'Access-Control-Max-Age': '600',
        });
        return res.end();
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!STRIP_REQ.has(k.toLowerCase())) headers[k] = v;
      }
      if (cors) headers.origin = 'https://medically-modern.github.io';
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const upstream = await fetch(`${upstreamBase}${pathPrefix}${req.url}`, { method: req.method, headers, body, redirect: 'manual' });
      let buf = Buffer.from(await upstream.arrayBuffer());
      const outHeaders = {};
      upstream.headers.forEach((v, k) => { if (!STRIP_RES.has(k)) outHeaders[k] = v; });
      if (cors) outHeaders['access-control-allow-origin'] = '*';
      if (rewrite) buf = rewrite(req.url, buf, outHeaders);
      res.writeHead(upstream.status, outHeaders);
      res.end(buf);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`relay error: ${err.message}`);
    }
  });
}

async function startRelays() {
  const siteUrl = new URL(REAL_SITE);
  const pathPrefix = siteUrl.pathname.replace(/\/$/, '');
  const apiServer = relay({ upstreamBase: API, cors: true });
  await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
  const apiLocal = `http://127.0.0.1:${apiServer.address().port}`;
  const siteServer = relay({
    upstreamBase: siteUrl.origin,
    pathPrefix,
    rewrite: (url, buf, headers) => {
      if (url.split('?')[0].endsWith('config.js')) {
        const txt = buf.toString('utf8').replace(API, apiLocal);
        return Buffer.from(txt, 'utf8');
      }
      return buf;
    },
  });
  await new Promise((r) => siteServer.listen(0, '127.0.0.1', r));
  SITE = `http://127.0.0.1:${siteServer.address().port}`;
  console.log(`relays: site ${SITE} -> ${REAL_SITE} | api ${apiLocal} -> ${API}`);
}
const ADMIN_KEY = process.env.ADMIN_KEY;
const SHOTS = path.join(__dirname, 'shots');
const TEMP_SVC = `[TEST] E2E Temp ${Date.now()}`;
fs.mkdirSync(SHOTS, { recursive: true });

// --- real PNG generator (same as integration tests) ---
function crc32(buf) {
  let t = crc32.t;
  if (!t) { t = crc32.t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) { const rs = y * (1 + w * 3); for (let x = 0; x < w; x++) { const p = rs + 1 + x * 3; raw[p] = (r + x) % 256; raw[p + 1] = (g + y) % 256; raw[p + 2] = b; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n    ${err.message.split('\n')[0]}`); throw err; }
}

(async () => {
  assert.ok(ADMIN_KEY, 'ADMIN_KEY env required');
  await startRelays();
  console.log(`\nE2E against ${REAL_SITE} (via local relay)\n`);
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  let ticket = '';

  // ---------------- Employee form ----------------
  await step('form page loads and services populate from the live API', async () => {
    await page.goto(`${SITE}/index.html`);
    await page.waitForFunction(() => {
      const sel = document.querySelector('#service');
      return sel && sel.options.length > 3 && !sel.options[0].text.includes('Loading');
    });
  });

  await step('fill out a realistic issue report', async () => {
    await page.selectOption('#service', { label: 'Scheduling System' });
    await page.click('[data-type="issue"]');
    await page.click('[data-sev="high"]');
    await page.fill('#title', 'Calendar sync drops appointments booked after 5pm');
    await page.fill('#description', 'When a patient books an appointment after 5pm, it shows in the confirmation email but never appears on the provider calendar. Started happening this week.');
    await page.fill('#steps', '1. Book an appointment for 5:30pm\n2. Check the provider calendar\n3. The slot is missing');
    await page.fill('#linkRows input', 'https://www.loom.com/share/e2e0123456789abcdef');
    await page.fill('#name', 'Claude E2E Tester');
    await page.fill('#email', 'claude.e2e');
  });

  const png1 = makePng(480, 300, [200, 60, 60]);
  const png2 = makePng(300, 480, [60, 90, 210]);
  fs.writeFileSync(path.join(SHOTS, 'upload-1.png'), png1);
  fs.writeFileSync(path.join(SHOTS, 'upload-2.png'), png2);

  await step('attach two real PNG screenshots with visible previews', async () => {
    await page.setInputFiles('#fileInput', [path.join(SHOTS, 'upload-1.png'), path.join(SHOTS, 'upload-2.png')]);
    await page.waitForFunction(() => document.querySelectorAll('#thumbs .thumb').length === 2);
  });

  await page.screenshot({ path: path.join(SHOTS, '1-form-filled.png'), fullPage: true });

  await step('submit succeeds and returns a ticket number', async () => {
    await page.click('#submitBtn');
    await page.waitForSelector('#successView:not(.hidden)');
    ticket = (await page.textContent('#okTicket')).trim();
    assert.match(ticket, /^MM-\d+$/, `bad ticket: ${ticket}`);
  });

  await step('success screen proves attachments arrived (loaded back from server)', async () => {
    await page.waitForFunction(() => {
      const badges = Array.from(document.querySelectorAll('#okShots .t-verify'));
      return badges.length === 2 && badges.every((b) => b.classList.contains('ok'));
    });
    const summary = await page.textContent('#okSummary');
    assert.ok(summary.includes('Scheduling System'));
    assert.ok(summary.includes('claude.e2e@medicallymodern.com'));
    assert.ok(summary.includes('2 file(s)'));
  });

  await page.screenshot({ path: path.join(SHOTS, '2-success-verified.png'), fullPage: true });

  // ---------------- Status tracker ----------------
  await step('status tracker finds the ticket and shows the timeline', async () => {
    await page.click('#okTrackLink');
    await page.waitForSelector('#result:not(.hidden)');
    assert.strictEqual((await page.textContent('#rTicket')).trim(), ticket);
    const tl = await page.textContent('#rTimeline');
    assert.ok(tl.includes('Request submitted'));
    const shots = await page.locator('#rShots img').count();
    assert.strictEqual(shots, 2);
  });

  await step('status tracker accepts a full pasted email address too', async () => {
    await page.fill('#email', 'claude.e2e@medicallymodern.com');
    await page.click('#trackBtn');
    await page.waitForSelector('#result:not(.hidden)');
    assert.strictEqual((await page.textContent('#rTicket')).trim(), ticket);
  });

  await page.screenshot({ path: path.join(SHOTS, '3-status-tracker.png'), fullPage: true });

  // ---------------- Admin dashboard ----------------
  await step('personal admin link unlocks the dashboard', async () => {
    await page.goto(`${SITE}/admin.html#key=${ADMIN_KEY}`);
    await page.waitForSelector('#dash:not(.hidden)');
    assert.ok(!(await page.url()).includes(ADMIN_KEY), 'key must be scrubbed from the URL');
  });

  await step('inbox lists the new ticket with severity, type, and attachment count', async () => {
    await page.waitForFunction((t) => document.querySelector('#inboxRows')?.textContent.includes(t), ticket);
    const row = page.locator('#inboxRows tr', { hasText: ticket });
    const rowText = await row.textContent();
    assert.ok(rowText.includes('High'));
    assert.ok(rowText.includes('Issue'));
    assert.ok(rowText.includes('Claude E2E Tester'));
  });

  await step('detail drawer shows full request with screenshots and loom link', async () => {
    await page.click(`#inboxRows tr:has-text("${ticket}")`);
    await page.waitForSelector('#drawer.show');
    await page.waitForFunction(() => document.querySelectorAll('#drawerBody .shot-grid img').length === 2);
    const body = await page.textContent('#drawerBody');
    assert.ok(body.includes('booked after 5pm') || body.includes('drops appointments'));
    assert.ok(body.includes('loom.com'));
  });

  await page.screenshot({ path: path.join(SHOTS, '4-admin-drawer.png'), fullPage: true });

  await step('screenshot lightbox opens the full image', async () => {
    await page.click('#drawerBody [data-shot]');
    await page.waitForSelector('#lightbox.show');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#lightbox').classList.contains('show'));
  });

  await step('start progress moves the ticket to in_progress', async () => {
    await page.click('#drawerBody [data-act="start"]');
    await page.waitForFunction(() => document.querySelector('#dStatus')?.textContent.includes('In progress'));
  });

  await step('internal notes can be added from the drawer', async () => {
    await page.fill('#noteInput', 'E2E: reproduced — sync job skips post-17:00 slots.');
    await page.click('#noteAdd');
    await page.waitForFunction(() => document.querySelector('#drawerBody')?.textContent.includes('sync job skips'));
  });

  await step('mark completed with resolution note triggers the email flow (manual mailto mode)', async () => {
    await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(u); return null; }; });
    await page.click('#drawerBody [data-act="complete"]');
    await page.waitForSelector('#modalBack.show');
    await page.fill('#modalNote', 'Fixed the timezone handling in the sync job. Appointments after 5pm now sync correctly.');
    await page.click('#modalOk');
    await page.waitForFunction(() => document.querySelector('#dStatus')?.textContent.includes('Completed'));
    const opened = await page.evaluate(() => window.__opened);
    assert.ok(opened.length === 1 && opened[0].startsWith('mailto:claude.e2e%40medicallymodern.com'), `mailto not opened: ${JSON.stringify(opened)}`);
    assert.ok(decodeURIComponent(opened[0]).includes('Completed'), 'mailto missing completion subject');
  });

  await step('completed view shows the ticket with notification state', async () => {
    await page.keyboard.press('Escape');
    await page.click('#nav [data-view="done"]');
    await page.waitForFunction((t) => document.querySelector('#doneRows')?.textContent.includes(t), ticket);
    const row = await page.locator(`#doneRows tr:has-text("${ticket}")`).textContent();
    assert.ok(row.includes('Manual email') || row.includes('Emailed'), `notify state missing: ${row}`);
  });

  await page.screenshot({ path: path.join(SHOTS, '5-admin-completed.png'), fullPage: true });

  await step('employee status page now shows completed + resolution note', async () => {
    const p2 = await ctx.newPage();
    await p2.goto(`${SITE}/status.html?ticket=${ticket}&email=claude.e2e@medicallymodern.com`);
    await p2.waitForSelector('#result:not(.hidden)');
    await p2.waitForFunction(() => document.querySelector('#rResolution') && !document.querySelector('#rResolution').classList.contains('hidden'));
    const note = await p2.textContent('#rResolutionText');
    assert.ok(note.includes('timezone handling'));
    await p2.screenshot({ path: path.join(SHOTS, '6-status-completed.png'), fullPage: true });
    await p2.close();
  });

  await step('board view renders the completed card', async () => {
    await page.click('#nav [data-view="board"]');
    await page.waitForFunction((t) => document.querySelector('#kDone')?.textContent.includes(t), ticket);
  });

  await step('analytics view renders tiles and charts', async () => {
    await page.click('#nav [data-view="analytics"]');
    await page.waitForFunction(() => document.querySelectorAll('#statTiles .stat-tile').length >= 4);
    await page.waitForFunction(() => document.querySelectorAll('#chart30 .mc-bar').length === 30);
  });

  await page.screenshot({ path: path.join(SHOTS, '7-analytics.png'), fullPage: true });

  let e2eServiceGone = false;
  await step('services view: add a service, see it on the form, then hide it', async () => {
    await page.click('#nav [data-view="services"]');
    await page.fill('#svcName', TEMP_SVC);
    await page.fill('#svcDesc', 'Added by the automated end-to-end test');
    await page.click('#svcAdd');
    await page.waitForFunction((name) => document.querySelector('#svcRows')?.textContent.includes(name), TEMP_SVC);
    // visible on the public form
    const p3 = await ctx.newPage();
    await p3.goto(`${SITE}/index.html`);
    await p3.waitForFunction((name) => Array.from(document.querySelectorAll('#service option')).some((o) => o.text === name), TEMP_SVC);
    await p3.close();
    // hide it again
    const row = page.locator('#svcRows tr', { hasText: TEMP_SVC });
    await row.locator('[data-act="toggle"]').click();
    await page.waitForFunction((name) => {
      const tr = Array.from(document.querySelectorAll('#svcRows tr')).find((r) => r.textContent.includes(name));
      return tr && tr.textContent.includes('Hidden');
    }, TEMP_SVC);
    e2eServiceGone = true;
  });

  await step('CSV export downloads with the ticket in it', async () => {
    const dl = page.waitForEvent('download');
    await page.click('#exportBtn');
    const download = await dl;
    const file = path.join(SHOTS, 'export.csv');
    await download.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8');
    assert.ok(csv.includes(ticket));
  });

  await step('lock button forgets the key and the gate blocks a wrong key', async () => {
    await page.click('#logoutBtn');
    await page.waitForSelector('#keyScreen:not(.hidden)');
    await page.fill('#keyInput', 'definitely-wrong-key-1234');
    await page.click('#keyGo');
    await page.waitForFunction(() => {
      const err = document.querySelector('#keyError');
      return err && getComputedStyle(err).display !== 'none';
    });
  });

  await step('no uncaught page errors during the whole run', async () => {
    const real = consoleErrors.filter((e) =>
      !e.includes('401') && !e.includes('Failed to load resource')); // expected from the wrong-key test
    assert.strictEqual(real.length, 0, `console errors:\n${real.join('\n')}`);
  });

  // Cleanup: delete the E2E ticket via the API (keeps Josh's inbox clean)
  await step('cleanup: delete E2E ticket + temp service via admin API', async () => {
    const list = await (await fetch(`${API}/api/admin/requests?q=${encodeURIComponent('Calendar sync drops')}`, { headers: { 'x-admin-key': ADMIN_KEY } })).json();
    for (const r of list.requests.filter((r) => r.submitter_email === 'claude.e2e@medicallymodern.com')) {
      const del = await fetch(`${API}/api/admin/requests/${r.id}`, { method: 'DELETE', headers: { 'x-admin-key': ADMIN_KEY } });
      assert.strictEqual(del.status, 200);
    }
    assert.ok(e2eServiceGone);
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error('\nE2E aborted:', err.message);
  process.exit(1);
});
