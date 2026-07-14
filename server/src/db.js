'use strict';

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set');
  process.exit(1);
}

// Railway internal hostnames don't use TLS; public endpoints do.
function needsSsl(url) {
  try {
    const host = new URL(url).hostname;
    return !(host.endsWith('.railway.internal') || host === 'localhost' || host === '127.0.0.1');
  } catch {
    return true;
  }
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected idle client error:', err.message);
});

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1001;

CREATE TABLE IF NOT EXISTS requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket VARCHAR(24) NOT NULL UNIQUE,
  service_id UUID NOT NULL REFERENCES services(id),
  type TEXT NOT NULL CHECK (type IN ('issue', 'change_request')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT NOT NULL DEFAULT '',
  video_links JSONB NOT NULL DEFAULT '[]',
  submitter_name TEXT NOT NULL,
  submitter_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'declined')),
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  notify_status TEXT NOT NULL DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);
CREATE INDEX IF NOT EXISTS idx_requests_service ON requests (service_id);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at DESC);

CREATE TABLE IF NOT EXISTS screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_screenshots_request ON screenshots (request_id);

CREATE TABLE IF NOT EXISTS activity (
  id BIGSERIAL PRIMARY KEY,
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL DEFAULT 'system',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_request ON activity (request_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  kind TEXT NOT NULL DEFAULT 'note',
  from_addr TEXT NOT NULL DEFAULT '',
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  in_reply_to TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_request ON messages (request_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_message_id ON messages (message_id) WHERE message_id IS NOT NULL;
`;

// [name, description, sort_order]
const PATIENT_ISSUE = ['Patient Issue', 'General patient issues and concerns', 15];

const DEFAULT_SERVICES = [
  ['Patient Portal', 'Patient-facing portal and account tools', 10],
  PATIENT_ISSUE,
  ['Scheduling System', 'Appointment booking and calendar tools', 20],
  ['Billing & Claims', 'Invoicing, claims, and payment tools', 30],
  ['Provider Dashboard', 'Internal provider-facing dashboard', 40],
  ['Company Website', 'Public medicallymodern.com website', 50],
  ['Internal Tools', 'Automations, scripts, and internal utilities', 60],
  ['Other / Not Listed', 'Anything that does not fit an existing service', 999],
];

// Services that must exist on EVERY deploy, not only on a brand-new database.
// The seed loop above runs only when the services table is empty, so an
// already-seeded (production) database would never pick up a newly added
// service without this. Applied idempotently on every startup.
const ENSURED_SERVICES = [PATIENT_ISSUE];

async function connectWithRetry(attempts = 30, delayMs = 2000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (err) {
      console.log(`DB connect attempt ${i}/${attempts} failed: ${err.message}`);
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function migrate() {
  await connectWithRetry();
  await pool.query(MIGRATIONS);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM services');
  if (rows[0].n === 0) {
    for (const [name, description, sort] of DEFAULT_SERVICES) {
      await pool.query(
        'INSERT INTO services (name, description, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
        [name, description, sort]
      );
    }
    console.log(`Seeded ${DEFAULT_SERVICES.length} starter services (editable in the admin dashboard)`);
  }

  // Ensure required services exist even when the table was already seeded on an
  // earlier deploy. ON CONFLICT (name) DO NOTHING makes this safe to run every
  // startup: it never duplicates a row and never un-hides a service the admin
  // has intentionally hidden or renamed.
  for (const [name, description, sort] of ENSURED_SERVICES) {
    await pool.query(
      'INSERT INTO services (name, description, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
      [name, description, sort]
    );
  }

  console.log('Database migrated and ready');
}

// Accepts the transaction's client so a held connection never has to wait
// on a second one from the same pool (deadlock risk under submission bursts).
async function nextTicket(q = pool) {
  const { rows } = await q.query("SELECT nextval('ticket_seq') AS n");
  return `MM-${rows[0].n}`;
}

module.exports = { pool, migrate, nextTicket };
