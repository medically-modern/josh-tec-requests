'use strict';
/*
 * Full-lifecycle integration test.
 * Usage: API_URL=http://localhost:3000 ADMIN_KEY=xxx node server/test/integration.test.js
 * Exercises: health, services, validation, submission with REAL generated PNG/JPEG-like
 * uploads, byte-exact screenshot retrieval, tracking, admin flows, completion + email
 * result, stats, CSV export, services CRUD, deletion.
 */

const zlib = require('zlib');
const assert = require('assert');

const API = (process.env.API_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (!ADMIN_KEY) { console.error('ADMIN_KEY env var required'); process.exit(1); }

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

// --- Real PNG generator (valid, decodable) ---------------------------------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function makePng(w, h, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (1 + w * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < w; x++) {
      const px = rowStart + 1 + x * 3;
      // gradient so every image is visually distinct and non-trivial
      raw[px] = (r + x * 2) % 256; raw[px + 1] = (g + y * 2) % 256; raw[px + 2] = b;
    }
  }
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function fd(fields, files) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files || []) {
    form.append('screenshots', new Blob([f.buf], { type: f.mime }), f.name);
  }
  return form;
}

const adminHeaders = { 'x-admin-key': ADMIN_KEY };

async function j(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`); }
}

(async () => {
  console.log(`\nIntegration tests against ${API}\n`);

  let serviceId = null;
  let createdIds = [];

  await test('health endpoint is ok with db connected', async () => {
    const res = await fetch(`${API}/api/health`);
    const data = await j(res);
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.db, true);
  });

  await test('services list is non-empty', async () => {
    const res = await fetch(`${API}/api/services`);
    const data = await j(res);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(data.services) && data.services.length > 0, 'no services seeded');
    serviceId = data.services[0].id;
  });

  await test('submission with missing fields is rejected with helpful errors', async () => {
    const res = await fetch(`${API}/api/requests`, { method: 'POST', body: fd({ title: 'x' }) });
    const data = await j(res);
    assert.strictEqual(res.status, 400);
    assert.ok(data.error.length > 10);
  });

  await test('submission with non-company email is rejected', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd({
        service_id: serviceId, type: 'issue', severity: 'high',
        title: 'Email domain test', description: 'This should not be accepted at all.',
        submitter_name: 'Tester', submitter_email: 'someone@gmail.com',
      }),
    });
    assert.strictEqual(res.status, 400);
    assert.ok((await j(res)).error.toLowerCase().includes('medicallymodern'));
  });

  await test('fake image (text bytes named .png) is rejected by magic-byte sniffing', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd(
        {
          service_id: serviceId, type: 'issue', severity: 'high',
          title: 'Sniff test', description: 'Trying to upload a fake image file.',
          submitter_name: 'Tester', submitter_email: 'tester@medicallymodern.com',
        },
        [{ buf: Buffer.from('definitely not a real png image at all'), mime: 'image/png', name: 'fake.png' }]
      ),
    });
    assert.strictEqual(res.status, 400);
    assert.ok((await j(res)).error.includes('valid image'));
  });

  const png1 = makePng(320, 200, [220, 40, 40]);
  const png2 = makePng(200, 320, [40, 80, 220]);
  let created;

  await test('full submission with 2 real PNGs + video links succeeds', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd(
        {
          service_id: serviceId, type: 'issue', severity: 'critical',
          title: '[TEST] Calendar crashes when opening Monday view',
          description: 'Opening the Monday view throws a 500 error every time since this morning.',
          steps: '1. Open scheduling\n2. Click Monday\n3. Error appears',
          video_links: JSON.stringify(['https://www.loom.com/share/abc123def456', 'not-a-url', 'https://youtu.be/xyz']),
          submitter_name: 'Integration Tester',
          submitter_email: 'Integration.Tester@MedicallyModern.com',
        },
        [
          { buf: png1, mime: 'image/png', name: 'error-screen.png' },
          { buf: png2, mime: 'image/png', name: 'console-log.png' },
        ]
      ),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201, JSON.stringify(data));
    created = data.request;
    createdIds.push(created.id);
    assert.match(created.ticket, /^MM-\d+$/);
    assert.strictEqual(created.status, 'open');
    assert.strictEqual(created.submitter_email, 'integration.tester@medicallymodern.com', 'email should be lowercased');
    assert.strictEqual(created.screenshots.length, 2);
    assert.deepStrictEqual(created.video_links, ['https://www.loom.com/share/abc123def456', 'https://youtu.be/xyz'], 'invalid URL should be dropped');
    assert.ok(data.receipt_email && typeof data.receipt_email.mode === 'string');
  });

  await test('uploaded screenshot bytes are stored and served back EXACTLY', async () => {
    const s = created.screenshots.find((x) => x.filename === 'error-screen.png');
    const res = await fetch(`${API}${s.url}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.ok(res.headers.get('content-disposition').startsWith('inline'), 'images should render inline');
    const body = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(body.length, png1.length, 'size mismatch');
    assert.ok(body.equals(png1), 'bytes do not match the uploaded file');
  });

  await test('non-image documents (PDF, CSV) upload and download back byte-exact', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
    const csv = Buffer.from('column_a,column_b\n1,2\n3,4\n');
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd(
        {
          service_id: serviceId, type: 'issue', severity: 'medium',
          title: '[TEST] Claims export produces a corrupted file',
          description: 'Attached the corrupted export and the vendor error report for reference.',
          submitter_name: 'Doc Tester', submitter_email: 'doc.tester@medicallymodern.com',
        },
        [
          { buf: pdf, mime: 'application/pdf', name: 'vendor-error-report.pdf' },
          { buf: csv, mime: 'text/csv', name: 'corrupted-export.csv' },
          { buf: makePng(64, 64, [10, 200, 90]), mime: 'image/png', name: 'error-toast.png' },
        ]
      ),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201, JSON.stringify(data));
    createdIds.push(data.request.id);
    assert.strictEqual(data.request.screenshots.length, 3);

    const pdfMeta = data.request.screenshots.find((x) => x.filename.endsWith('.pdf'));
    const pdfRes = await fetch(`${API}${pdfMeta.url}`);
    assert.strictEqual(pdfRes.status, 200);
    assert.strictEqual(pdfRes.headers.get('content-type'), 'application/pdf');
    assert.ok(pdfRes.headers.get('content-disposition').startsWith('attachment'), 'documents must be download-only');
    assert.ok(Buffer.from(await pdfRes.arrayBuffer()).equals(pdf), 'pdf bytes do not match');

    const csvMeta = data.request.screenshots.find((x) => x.filename.endsWith('.csv'));
    const csvRes = await fetch(`${API}${csvMeta.url}`);
    assert.ok(csvRes.headers.get('content-disposition').startsWith('attachment'), 'csv must be download-only');
    assert.ok(Buffer.from(await csvRes.arrayBuffer()).equals(csv), 'csv bytes do not match');

    const pngMeta = data.request.screenshots.find((x) => x.filename.endsWith('.png'));
    const pngRes = await fetch(`${API}${pngMeta.url}`);
    assert.ok(pngRes.headers.get('content-disposition').startsWith('inline'), 'images should stay inline');
  });

  await test('dangerous or unknown file types are rejected', async () => {
    for (const f of [
      { name: 'evil.html', mime: 'text/html' },
      { name: 'payload.svg', mime: 'image/svg+xml' },
      { name: 'run.exe', mime: 'application/octet-stream' },
      { name: 'noextension', mime: 'application/octet-stream' },
    ]) {
      const res = await fetch(`${API}/api/requests`, {
        method: 'POST',
        body: fd(
          {
            service_id: serviceId, type: 'issue', severity: 'low',
            title: '[TEST] File type rejection', description: 'This upload should be rejected outright.',
            submitter_name: 'Doc Tester', submitter_email: 'doc.tester@medicallymodern.com',
          },
          [{ buf: Buffer.from('<script>alert(1)</script>'), mime: f.mime, name: f.name }]
        ),
      });
      assert.strictEqual(res.status, 400, `${f.name} should have been rejected`);
    }
  });

  await test('a file renamed to .pdf is rejected by its signature', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd(
        {
          service_id: serviceId, type: 'issue', severity: 'low',
          title: '[TEST] Fake PDF rejection', description: 'Not actually a PDF underneath the extension.',
          submitter_name: 'Doc Tester', submitter_email: 'doc.tester@medicallymodern.com',
        },
        [{ buf: Buffer.from('definitely not a pdf'), mime: 'application/pdf', name: 'fake.pdf' }]
      ),
    });
    assert.strictEqual(res.status, 400);
    assert.ok((await j(res)).error.includes('valid PDF'));
  });

  await test('track endpoint returns ticket for correct email, hides it for wrong email', async () => {
    const ok = await fetch(`${API}/api/track?ticket=${created.ticket}&email=integration.tester@medicallymodern.com`);
    const okData = await j(ok);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(okData.request.ticket, created.ticket);
    assert.ok(okData.activity.length >= 1);

    const bad = await fetch(`${API}/api/track?ticket=${created.ticket}&email=wrong@medicallymodern.com`);
    assert.strictEqual(bad.status, 404);
  });

  await test('admin endpoints reject missing/wrong key', async () => {
    const noKey = await fetch(`${API}/api/admin/requests`);
    assert.strictEqual(noKey.status, 401);
    const badKey = await fetch(`${API}/api/admin/requests`, { headers: { 'x-admin-key': 'wrong-key-123456' } });
    assert.strictEqual(badKey.status, 401);
  });

  await test('admin key is NOT accepted via query param (log-leak vector removed)', async () => {
    const res = await fetch(`${API}/api/admin/requests?key=${encodeURIComponent(ADMIN_KEY)}`);
    assert.strictEqual(res.status, 401);
  });

  await test('malformed / non-UUID ids return 404, never 500', async () => {
    for (const url of [
      `${API}/api/screenshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      `${API}/api/screenshots/not-a-uuid`,
    ]) {
      const res = await fetch(url);
      assert.strictEqual(res.status, 404, `${url} -> ${res.status}`);
    }
    for (const path of ['/api/admin/requests/foo', '/api/admin/requests/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
      const res = await fetch(`${API}${path}`, { headers: adminHeaders });
      assert.strictEqual(res.status, 404, `${path} -> ${res.status}`);
    }
    const del = await fetch(`${API}/api/admin/requests/------------------------------------`, { method: 'DELETE', headers: adminHeaders });
    assert.strictEqual(del.status, 404);
  });

  await test('admin list includes the new request with screenshot_count', async () => {
    const res = await fetch(`${API}/api/admin/requests`, { headers: adminHeaders });
    const data = await j(res);
    assert.strictEqual(res.status, 200);
    const row = data.requests.find((r) => r.id === created.id);
    assert.ok(row, 'request missing from admin list');
    assert.strictEqual(row.screenshot_count, 2);
    assert.strictEqual(row.service_name.length > 0, true);
  });

  await test('admin search/filter works', async () => {
    const res = await fetch(`${API}/api/admin/requests?q=Calendar+crashes&severity=critical&type=issue`, { headers: adminHeaders });
    const data = await j(res);
    assert.ok(data.requests.some((r) => r.id === created.id));
    const res2 = await fetch(`${API}/api/admin/requests?severity=low&q=Calendar+crashes`, { headers: adminHeaders });
    const data2 = await j(res2);
    assert.ok(!data2.requests.some((r) => r.id === created.id));
  });

  await test('admin detail returns screenshots + activity', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}`, { headers: adminHeaders });
    const data = await j(res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.request.screenshots.length, 2);
    assert.ok(data.activity.some((a) => a.action === 'created'));
  });

  await test('status can move to in_progress and is logged', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.request.status, 'in_progress');
  });

  await test('internal notes can be added', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}/notes`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Looked into it — the Monday view query is timing out.' }),
    });
    assert.strictEqual(res.status, 201);
    const detail = await j(await fetch(`${API}/api/admin/requests/${created.id}`, { headers: adminHeaders }));
    assert.ok(detail.activity.some((a) => a.action === 'note' && a.detail.includes('timing out')));
  });

  await test('type can be converted (issue ⇄ change request) and is logged', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'change_request' }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.request.type, 'change_request');

    const bad = await fetch(`${API}/api/admin/requests/${created.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'bogus' }),
    });
    assert.strictEqual(bad.status, 400);

    const back = await j(await fetch(`${API}/api/admin/requests/${created.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'issue' }),
    }));
    assert.strictEqual(back.request.type, 'issue');

    const detail = await j(await fetch(`${API}/api/admin/requests/${created.id}`, { headers: adminHeaders }));
    const changes = detail.activity.filter((a) => a.action === 'type_changed');
    assert.strictEqual(changes.length, 2, 'type changes not logged');
    assert.ok(changes[0].detail.includes('Issue') && changes[0].detail.includes('Change request'));
  });

  await test('marking completed sets completed_at and returns an email result', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', resolution_note: 'Fixed the Monday view query — deployed at 2pm.' }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.request.status, 'completed');
    assert.ok(data.request.completed_at, 'completed_at not set');
    assert.ok(data.email, 'email result missing');
    assert.ok(['resend', 'smtp', 'manual'].includes(data.email.mode));
    if (!data.email.sent) {
      assert.ok(data.email.mailto.startsWith('mailto:integration.tester%40medicallymodern.com'), 'mailto fallback missing');
      assert.ok(decodeURIComponent(data.email.mailto).includes(created.ticket));
    }
    assert.ok(['sent', 'manual', 'failed'].includes(data.request.notify_status));
  });

  await test('re-send notification endpoint works on completed request', async () => {
    const res = await fetch(`${API}/api/admin/requests/${created.id}/notify`, { method: 'POST', headers: adminHeaders });
    const data = await j(res);
    assert.strictEqual(res.status, 200);
    assert.ok(data.email.mailto || data.email.sent);
  });

  await test('track endpoint reflects completion + resolution note', async () => {
    const res = await fetch(`${API}/api/track?ticket=${created.ticket}&email=integration.tester@medicallymodern.com`);
    const data = await j(res);
    assert.strictEqual(data.request.status, 'completed');
    assert.ok(data.request.resolution_note.includes('Monday view'));
    assert.ok(data.activity.some((a) => a.action === 'status_changed' && a.detail.includes('completed')));
  });

  await test('stats endpoint aggregates correctly', async () => {
    const res = await fetch(`${API}/api/admin/stats`, { headers: adminHeaders });
    const data = await j(res);
    assert.strictEqual(res.status, 200);
    assert.ok(data.by_status.length >= 1);
    assert.ok(data.by_service.length >= 1);
    assert.ok(typeof data.avg_resolution_hours === 'number');
    assert.ok(['resend', 'smtp', 'manual'].includes(data.email_mode));
  });

  await test('CSV export contains the test request', async () => {
    const res = await fetch(`${API}/api/admin/export.csv`, { headers: adminHeaders });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/csv'));
    const csv = await res.text();
    assert.ok(csv.includes(created.ticket));
    assert.ok(csv.split('\r\n')[0].startsWith('ticket,service,type'));
  });

  await test('CSV export neutralizes spreadsheet formula injection', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd({
        service_id: serviceId, type: 'issue', severity: 'low',
        title: '=HYPERLINK("http://evil.example","click me") formula test',
        description: 'CSV injection regression test for the export endpoint.',
        submitter_name: 'Formula Tester', submitter_email: 'formula@medicallymodern.com',
      }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201);
    createdIds.push(data.request.id);
    const csv = await (await fetch(`${API}/api/admin/export.csv`, { headers: adminHeaders })).text();
    const line = csv.split('\r\n').find((l) => l.includes('formula test'));
    assert.ok(line, 'exported row missing');
    assert.ok(line.includes(`"'=HYPERLINK`), `formula not neutralized: ${line.slice(0, 80)}`);
  });

  let newServiceId;
  await test('admin can add a service (the ever-growing list)', async () => {
    const name = `[TEST] New Service ${Date.now()}`;
    const res = await fetch(`${API}/api/admin/services`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: 'Added by integration test' }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201, JSON.stringify(data));
    newServiceId = data.service.id;
    const pub = await j(await fetch(`${API}/api/services`));
    assert.ok(pub.services.some((s) => s.id === newServiceId), 'new service not visible on public list');
  });

  await test('admin can hide a service (removes it from the public form)', async () => {
    const res = await fetch(`${API}/api/admin/services/${newServiceId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    assert.strictEqual(res.status, 200);
    const pub = await j(await fetch(`${API}/api/services`));
    assert.ok(!pub.services.some((s) => s.id === newServiceId), 'hidden service still on public list');
  });

  let crId;
  await test('change_request submissions work too', async () => {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      body: fd({
        service_id: serviceId, type: 'change_request', severity: 'low',
        title: '[TEST] Add dark mode to the portal',
        description: 'It would be easier on the eyes during night shifts.',
        video_links: '[]',
        submitter_name: 'Night Shift Nurse', submitter_email: 'nurse@medicallymodern.com',
      }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201, JSON.stringify(data));
    assert.strictEqual(data.request.type, 'change_request');
    assert.strictEqual(data.request.screenshots.length, 0);
    crId = data.request.id;
    createdIds.push(crId);
  });

  let folderId;
  await test('admin can create a folder', async () => {
    const name = `[TEST] Folder ${Date.now()}`;
    const res = await fetch(`${API}/api/admin/folders`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 201, JSON.stringify(data));
    folderId = data.folder.id;
    const list = await j(await fetch(`${API}/api/admin/folders`, { headers: adminHeaders }));
    const f = list.folders.find((x) => x.id === folderId);
    assert.ok(f, 'created folder missing from list');
    assert.strictEqual(f.request_count, 0);
  });

  await test('a request can be filed into a folder and pulled back out', async () => {
    const move = await fetch(`${API}/api/admin/requests/${crId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId }),
    });
    const moved = await j(move);
    assert.strictEqual(move.status, 200, JSON.stringify(moved));
    assert.strictEqual(moved.request.folder_id, folderId);

    const list = await j(await fetch(`${API}/api/admin/folders`, { headers: adminHeaders }));
    const f = list.folders.find((x) => x.id === folderId);
    assert.strictEqual(f.request_count, 1, 'folder count did not update');
    assert.strictEqual(f.active_count, 1, 'active count did not update');

    const back = await j(await fetch(`${API}/api/admin/requests/${crId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: null }),
    }));
    assert.strictEqual(back.request.folder_id, null);
  });

  await test('bogus folder ids are rejected', async () => {
    const res = await fetch(`${API}/api/admin/requests/${crId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }),
    });
    assert.strictEqual(res.status, 400);
    const res2 = await fetch(`${API}/api/admin/requests/${crId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: 'not-a-uuid' }),
    });
    assert.strictEqual(res2.status, 400);
  });

  await test('folders can be renamed', async () => {
    const res = await fetch(`${API}/api/admin/folders/${folderId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `[TEST] Renamed ${Date.now()}` }),
    });
    const data = await j(res);
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.ok(data.folder.name.startsWith('[TEST] Renamed'));
  });

  await test('deleting a folder returns its tickets to the inbox', async () => {
    await fetch(`${API}/api/admin/requests/${crId}`, {
      method: 'PATCH', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId }),
    });
    const del = await fetch(`${API}/api/admin/folders/${folderId}`, { method: 'DELETE', headers: adminHeaders });
    assert.strictEqual(del.status, 200);
    const detail = await j(await fetch(`${API}/api/admin/requests/${crId}`, { headers: adminHeaders }));
    assert.strictEqual(detail.request.folder_id, null, 'ticket still points at the deleted folder');
  });

  await test('admin list carries internal notes for the hover preview', async () => {
    const add = await fetch(`${API}/api/admin/requests/${crId}/notes`, {
      method: 'POST', headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'Waiting on vendor — check back Friday.' }),
    });
    assert.strictEqual(add.status, 201);
    const list = await j(await fetch(`${API}/api/admin/requests`, { headers: adminHeaders }));
    const row = list.requests.find((x) => x.id === crId);
    assert.ok(Array.isArray(row.notes), 'notes array missing from admin list');
    assert.ok(row.notes.some((n) => n.detail.includes('vendor')), 'note text missing from admin list');
  });

  await test('inbound replies show as unseen in the list and clear when the ticket is opened', async () => {
    // Inbound replies are only ever created by the IMAP reader, so this test
    // injects one directly and needs DATABASE_URL pointing at the API's db.
    if (!process.env.DATABASE_URL) {
      console.log('    (DATABASE_URL not set — skipping the reply-badge check)');
      return;
    }
    const { Pool } = require('pg');
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await db.query(
        `INSERT INTO messages (request_id, direction, kind, from_addr, to_addr, subject, body, message_id)
         VALUES ($1, 'inbound', 'reply', 'nurse@medicallymodern.com', 'desk@medicallymodern.com',
                 'Re: [TEST]', 'Yes, still happening after the update.', $2)`,
        [crId, `<test-reply-${Date.now()}@medicallymodern.com>`]
      );
      let list = await j(await fetch(`${API}/api/admin/requests`, { headers: adminHeaders }));
      let row = list.requests.find((x) => x.id === crId);
      assert.strictEqual(row.unseen_replies, 1, 'reply not counted as unseen');
      assert.strictEqual(row.reply_count, 1, 'reply_count missing');
      assert.ok(row.last_reply_at, 'last_reply_at missing');

      // Opening the ticket (detail GET) marks it read
      await fetch(`${API}/api/admin/requests/${crId}`, { headers: adminHeaders });
      list = await j(await fetch(`${API}/api/admin/requests`, { headers: adminHeaders }));
      row = list.requests.find((x) => x.id === crId);
      assert.strictEqual(row.unseen_replies, 0, 'viewing did not clear the unseen count');
      assert.strictEqual(row.reply_count, 1, 'reply_count should survive being read');
    } finally {
      await db.end();
    }
  });

  await test('deleting a request cascades (screenshots become 404)', async () => {
    const shotUrl = `${API}${created.screenshots[0].url}`;
    const del = await fetch(`${API}/api/admin/requests/${created.id}`, { method: 'DELETE', headers: adminHeaders });
    assert.strictEqual(del.status, 200);
    createdIds = createdIds.filter((x) => x !== created.id);
    const shot = await fetch(shotUrl);
    assert.strictEqual(shot.status, 404);
    const detail = await fetch(`${API}/api/admin/requests/${created.id}`, { headers: adminHeaders });
    assert.strictEqual(detail.status, 404);
  });

  // Cleanup remaining test data
  for (const id of createdIds) {
    await fetch(`${API}/api/admin/requests/${id}`, { method: 'DELETE', headers: adminHeaders }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    failures.forEach((f) => console.error(`FAILED: ${f.name}\n${f.err.stack}\n`));
    process.exit(1);
  }
})().catch((err) => { console.error(err); process.exit(1); });
