# Medically Modern — Service Desk

An internal system for employees to **report issues** and **request changes** to Medically Modern services, with a personal admin dashboard for triaging, completing, and notifying.

## The four pages (GitHub Pages)

| Page | Who | What |
|---|---|---|
| `index.html` | Employees | Submit an issue report or change request — service picker, severity, screenshots (drag & drop / paste), Loom links. Shows a ticket number and **server-verified attachment previews** on success. |
| `status.html` | Employees | Track any ticket by ticket number + email. |
| `review.html` | Company | Read-only **spreadsheet-style sheet of every unresolved request** (open + in progress), refreshed live on each load — change requests grouped on top, reported issues below. Share the link; no login. Optionally require `?key=…` by setting `REVIEW_KEY` on Railway. Submitter emails are never shown. |
| `admin.html` | Josh | Personal dashboard — Inbox, Board, Completed, Analytics, and Services views. Open it with your personal key link. |

## Architecture

```
GitHub Pages (repo root) ──HTTPS──▶  Railway "handsome-simplicity" project
  index / status / admin              └── service-desk-api  (Node.js + Express)
                                      └── service-desk-db  (requests, screenshots as BYTEA,
                                                     services, activity log)
```

- **Frontend**: static, zero-dependency vanilla JS at the repo root, published automatically by GitHub Pages (deploy-from-branch `main`, `/` root, `.nojekyll`).
- **Backend**: `server/`, deployed on Railway. Screenshots are stored **in Postgres** (not on disk), so deploys/restarts never lose attachments.
- `config.js` points the frontend at the Railway API URL.

## Key features

**Employee form**
- Service dropdown driven by the database (add/hide services from the admin dashboard, no code changes)
- Issue vs. Change Request, with severity/priority descriptions that adapt to the type
- Up to 6 attachments (8 MB each) via click, drag & drop, or clipboard paste — screenshots get inline previews, and any common document (PDF, Word, Excel, CSV, logs, ZIP…) can be attached too and is served download-only; Loom/video link fields
- Upload progress bar; on success the page reloads each screenshot **from the server** and shows "✓ Stored on server" — proof the attachment actually arrived
- Ticket numbers (`MM-1001`, `MM-1002`, …) and a tracking link
- Remembers name/email for next time; emails are `@medicallymodern.com` only

**Admin dashboard** (`admin.html`)
- **Inbox** — open + in-progress requests sorted by severity, with search and filters (service / type / severity / status)
- **Folders** — file tickets into custom folders (e.g. “Waiting on vendor”) to tuck them out of the inbox, and pull them back up with one click on the folder chips; deleting a folder returns its tickets to the inbox
- **Quick notes from the inbox** — add an internal note straight from any row (the ✚ button after Status), and hover the 📝 badge to read all of a ticket's notes enlarged, without opening it
- **New-reply badges** — when a submitter answers a ticket email, the row lights up with “✉ new reply” (and its folder chip shows ✉) until you open the ticket; already-read threads keep a quiet ✉ count
- **Board** — kanban columns (Open / In progress / Recently completed)
- **Completed** — everything finished, with completion date and "submitter notified?" state
- **Analytics** — totals, avg. time-to-complete, breakdowns by service/severity/type, 30-day submission chart
- **Services** — add, rename, hide services (the "ever-growing list")
- **Full-page detail view**: click any ticket to open it over the whole window
- **Two-way email conversation**: send follow-up questions to the submitter as a
  reply in the *same* email thread (no new chains), and their replies are pulled
  back automatically and shown inline as a chat thread (see Email below)
- Detail view: screenshots lightbox, video links, activity timeline, internal notes
- Mark complete → optional resolution note → submitter is emailed (see Email below)
- CSV export of everything

## Email notifications

The API supports three modes (checked in this order):

1. **Resend** — set `RESEND_API_KEY` (+ optionally `EMAIL_FROM`) on the Railway `api` service. Free tier is fine. Fully automatic emails.
2. **SMTP** — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (e.g. a Google Workspace app password) and `EMAIL_FROM`.
3. **Manual (current default)** — no keys configured. Marking a request complete gives you a **one-click prefilled email** (mailto) in the dashboard, and the Completed view tracks who has been notified.

Receipt emails on submission and completion emails on fix use the same mechanism.

### Two-way conversations (SMTP + IMAP)

With the SMTP (Gmail) path configured, the desk also does **threaded, two-way
email**:

- **Send follow-ups** from a ticket's detail view. They go out as a reply in the
  same thread (`In-Reply-To`/`References` headers + a stable `[MM-####]` subject),
  so in the submitter's inbox it's one conversation, not a pile of new emails.
- **Read replies back**: the same Google **app password** that sends via SMTP also
  grants **IMAP** read access. A background poller (every 3 min, plus an on-demand
  sync when you open a ticket or hit "Check for replies") scans the mailbox, matches
  each reply to its ticket by subject/`References`, confirms it's from that ticket's
  submitter, and shows it inline in the dashboard.

IMAP reuses `SMTP_USER`/`SMTP_PASS` and `imap.gmail.com:993` by default — no extra
config. It only requires that **IMAP is enabled** in Gmail (Settings → Forwarding
and POP/IMAP → Enable IMAP; on by default for most Workspace accounts). Override
with `IMAP_HOST`/`IMAP_PORT`/`IMAP_USER`/`IMAP_PASS`, or turn it off with
`IMAP_DISABLED=true`.

**Admin alerts**: with `ADMIN_NOTIFY_EMAIL` set (currently `josh@medicallymodern.com`), every new submission sends an
at-a-glance alert as soon as an email provider is configured:

> 🔴 Critical Issue · Patient Portal — “Calendar won't load” · Sarah (MM-1042)

The alert body contains the full description, attachment counts, video links, and a deep link that opens the ticket
directly in the admin dashboard.

## Railway environment variables (`api` service)

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | injected reference to the Postgres service |
| `ADMIN_KEY` | the admin dashboard key (keep secret) |
| `ALLOWED_ORIGINS` | CORS allowlist, the GitHub Pages origin |
| `PUBLIC_BASE_URL` | Pages URL, used for links inside emails |
| `ADMIN_NOTIFY_EMAIL` | where new-submission alerts go (josh@medicallymodern.com) |
| `REVIEW_KEY` | optional — when set, the company review sheet requires `review.html?key=<REVIEW_KEY>`; when unset, the review link is open |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | Gmail SMTP send (currently configured) |
| `RESEND_API_KEY` | alternative to SMTP for sending |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASS` / `IMAP_DISABLED` | read replies (defaults to the SMTP creds + imap.gmail.com) |

## Local development

```bash
cd server
npm install
DATABASE_URL=postgres://… ADMIN_KEY=devkey node src/index.js
# then open index.html with config.js pointed at http://localhost:3000
```

`server/test/integration.test.js` runs a full lifecycle test (submit with real images → verify stored bytes → admin flows → complete → track):

```bash
API_URL=http://localhost:3000 ADMIN_KEY=devkey node server/test/integration.test.js
```

## Operations

- **Deploy backend**: `railway up --service service-desk-api` from the repo root (project `handsome-simplicity`)
- **Deploy frontend**: push to `main` — GitHub Pages republishes automatically
- **Rotate the admin key**: change `ADMIN_KEY` on Railway, then use the new key link
- **Data**: everything lives in the `service-desk-db` Postgres service in the `handsome-simplicity` project
