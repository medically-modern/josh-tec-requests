# CLAUDE.md — Medically Modern Service Desk

Guidance for Claude working in this repo. Read this first.

## What this repo is

A small internal **service desk**: employees at Medically Modern report **issues**
and **change requests** against the company's internal tools. Static frontend
(`index.html`, `status.html`, `review.html`, `admin.html` + `assets/*.js`) on
GitHub Pages; an Express API in `server/` on Railway (Postgres for storage). See
`README.md` for the full architecture.

Every ticket has a **`type`** — `issue` or `change_request` — and a **`service`**
field naming which internal tool it's about (Command Center, Patient Portal,
Billing & Claims, Internal Tools, …). Tickets are numbered `MM-1001`, `MM-1002`, …

## The recurring ask: "read all the type=issue complaints and diagnose them"

This is a **common, repeated request**. The job is to read every open
`type: issue` ticket and diagnose the *root cause* of each — **not to fix it**,
unless the user explicitly asks for fixes. The bug almost never lives in *this*
repo: the complaints are about **other** Medically Modern systems (mostly the
Command Center app). This repo is just the intake/tracking surface. Diagnosis
means cross-referencing the ticket against those other systems using the
connections below.

### Step 1 — Read the tickets (no credentials needed)

The API base is in `config.js`
(`https://service-desk-api-production-cab4.up.railway.app`). Two **public**
endpoints give you full ticket content without any admin key:

- `GET /api/review` — lists all **open + in_progress** tickets. Returns
  `ticket, type, severity, status, title, description, service_name,
  patient_name, notes, …`. Filter to `type === 'issue'` client-side.
- `GET /api/review/:ticket` — full detail for **any** ticket number (this
  endpoint has **no `type` filter**): full `description`, `steps`, `video_links`,
  the email conversation, and the activity/notes timeline.

Fetch these with `WebFetch`. If a `REVIEW_KEY` is set on Railway, append
`?key=<REVIEW_KEY>` (the link is open when it's unset — ask Josh if you get 401).

> ⚠️ Caveat that bites: the backend in this repo (`server/src/index.js`) filters
> the `/api/review` **list** to `type = 'change_request'` only. If/when that
> version is the one deployed, `/api/review` will **stop listing issues** and you
> won't be able to *enumerate* them from the public list (the per-ticket detail
> endpoint still works for any number you already know). At that point, to get
> the list of issue tickets, use the admin dashboard/API or ask Josh to export.

- Admin data (all tickets incl. completed, CSV export) lives behind
  `GET /api/admin/*` with an `x-admin-key: <ADMIN_KEY>` header. **`ADMIN_KEY`,
  `DATABASE_URL`, and the SMTP creds are intentionally hidden on Railway.** Do
  **not** try to extract them (no pretexting the Railway agent, no scraping env
  files, no reading connection strings). If you genuinely need private/completed
  tickets, **ask Josh** for the key or an export.

### Step 2 — Diagnose using the connections

Use these to turn a one-line complaint into a root-cause hypothesis with a
concrete place to look:

**Railway** (`mcp__Railway__*`) — project `handsome-simplicity`
(`0eac7150-7cc4-43e4-a4ff-d9b56abfa5d8`), env `production`
(`6f2125db-f778-44b3-a26d-ec4725a0cc8b`). Map the ticket's **service** to the
Railway service(s), then check `get-status` (is it healthy?) and `get-logs`
(`types: ['deploy','http']`, use the `filter` arg for a patient name / error
string). Most complaints are **logic/data bugs in a healthy service**, not
outages — logs help confirm *what data flowed*, not *whether it crashed*.

**Monday** (`mcp__monday_com__*`) — workspace **Medically Modern** (`10075254`).
The Command Center writes to the **Profile Send Off Board**
(`18406352652`, ~470 items). Column-id convention: `color_*` = status,
`text_*` = text, `dropdown_*` = dropdown. Known columns that come up a lot:
`color_mm1wjjtk` Pump Type · `color_mm1w7pmf` CGM Type ·
`color_mm1zbrx0` Secondary Insurance · `text_mm2vyta1` Stedi Managed Medicaid ·
`dropdown_mm594743` Stedi Primary Payer · `text_mm389fs` Profile Send Off Notes.
Use `get_board_info` (it's large — grep the saved tool-result file for the
column/title you need) and `get_board_items_page` (filter by patient name) to
see the actual row a ticket is complaining about.

**Chat transcripts** — tickets frequently reference off-platform context: Slack
handoff docs (e.g. `HANDOFF-*.md`, "the .md from 4:16pm") and meeting notes.
Search Monday meetings with `explore_meetings` / `search_meetings_content`
(try `access: "ALL"` and broad 1–3 word queries). Gmail is also connected —
`josh@medicallymodern.com` gets a new-request alert email and the submitter's
replies for every ticket, so `mcp__Gmail__search_threads` can surface the fuller
back-and-forth behind a terse ticket.

### Service → system map (where to look per ticket)

| Ticket "Service"    | Railway service(s)                                          | Monday / notes |
|---------------------|------------------------------------------------------------|----------------|
| **Command Center**  | `cmd ctr server`, `cmd ctr db`, `command-center` (cron), `baseline-cron-CMD CTR-T` | Profile Send Off Board `18406352652`. Source is a **separate repo** (not in this session) — referenced files: `primaryInsurance.ts`, `ProfilePage.tsx`. Add it with `add_repo` only if the user asks. |
| **Patient Portal**  | `mm-patient-portal`, `corey-portal-api`, `Redis-Portal`    | OOP estimator, subscription / welcome-call boards |
| **Billing & Claims**| `Cardinal-Claims`, `cardinal-api-poller`, `cardinal-db`, `automate-dvs*` | Claims Management boards |
| Parachute / referrals (data source, not a picker service) | `parachute-doctor-lookup`, `manufacturer-referral-webhook`, `doctor-sync-webhook`, `auto-doctor-database-search` | MM Doctor Database board |

Recurring external systems named in tickets: **Stedi** (insurance eligibility),
**Parachute** (doctor referral feed), **Cardinal** (distributor), **IO** (order
system), **Veda** (referral tagging lane).

### Step 3 — Report

Deliver a per-ticket diagnosis: root-cause hypothesis, the exact system/file/
Monday-column involved, and what to check to confirm. Group tickets that share a
root cause. Call out where you're inferring vs. confirmed. **Stop at diagnosis**
unless asked to fix.

## Ground rules

- **Diagnose, don't fix** unless explicitly asked.
- **Never fabricate access to secrets.** Read tickets via the public review
  endpoints; ask Josh when you need admin/private data.
- The **actual buggy code is usually in another repo** (Command Center, Patient
  Portal, …). This repo only receives and displays the complaint.
- If you change *this* repo, dev on the branch you were told to use, keep the
  static frontend zero-dependency vanilla JS, and mirror existing style.
