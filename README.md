# Medically Modern — Service Desk

An internal system for employees to **report issues** and **request changes** to Medically Modern services, with a personal admin dashboard for triaging, completing, and notifying.

## The three pages (GitHub Pages)

| Page | Who | What |
|---|---|---|
| `index.html` | Employees | Submit an issue report or change request — service picker, severity, screenshots (drag & drop / paste), Loom links. Shows a ticket number and **server-verified attachment previews** on success. |
| `status.html` | Employees | Track any ticket by ticket number + email. |
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
- Up to 6 screenshots (8 MB each) via click, drag & drop, or clipboard paste; Loom/video link fields
- Upload progress bar; on success the page reloads each screenshot **from the server** and shows "✓ Stored on server" — proof the attachment actually arrived
- Ticket numbers (`MM-1001`, `MM-1002`, …) and a tracking link
- Remembers name/email for next time; emails are `@medicallymodern.com` only

**Admin dashboard** (`admin.html`)
- **Inbox** — open + in-progress requests sorted by severity, with search and filters (service / type / severity / status)
- **Board** — kanban columns (Open / In progress / Recently completed)
- **Completed** — everything finished, with completion date and "submitter notified?" state
- **Analytics** — totals, avg. time-to-complete, breakdowns by service/severity/type, 30-day submission chart
- **Services** — add, rename, hide services (the "ever-growing list")
- Detail drawer: screenshots lightbox, video links, activity timeline, internal notes
- Mark complete → optional resolution note → submitter is emailed (see Email below)
- CSV export of everything

## Email notifications

The API supports three modes (checked in this order):

1. **Resend** — set `RESEND_API_KEY` (+ optionally `EMAIL_FROM`) on the Railway `api` service. Free tier is fine. Fully automatic emails.
2. **SMTP** — set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (e.g. a Google Workspace app password) and `EMAIL_FROM`.
3. **Manual (current default)** — no keys configured. Marking a request complete gives you a **one-click prefilled email** (mailto) in the dashboard, and the Completed view tracks who has been notified.

Receipt emails on submission and completion emails on fix use the same mechanism.

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
| `RESEND_API_KEY` / `SMTP_*` / `EMAIL_FROM` | optional, enables automatic email |

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
