# JobRadar

JobRadar reads recruiter emails from your Gmail and tracks your job applications for you: company, stage and deadline, so you don't miss a deadline or lose track of where an application stands.

It's built as a small pipeline rather than a single script. Mail is filtered, queued, extracted, validated and then shown, with retries along the way and a review queue for the cases the system isn't sure about. The two things I cared about most while building it: no email gets silently dropped, and a wrong deadline never shows up on the dashboard.

Built for the "Build at Damco" challenge (Engineers track). I used AI while building it; the [How it works](#how-it-works) section walks through what actually runs.

## Contents

1. [The problem](#the-problem)
2. [What it does](#what-it-does)
3. [Architecture](#architecture)
4. [How it works](#how-it-works)
5. [Tech stack](#tech-stack)
6. [Data model](#data-model)
7. [Repo structure](#repo-structure)
8. [Run it locally](#run-it-locally)
9. [Environment variables](#environment-variables)
10. [Failure modes](#failure-modes)
11. [Tradeoffs](#tradeoffs)
12. [Known limitations and future work](#known-limitations-and-future-work)
13. [Tests](#tests)
14. [Deploy](#deploy)

## The problem

During a job hunt, recruiter emails end up scattered across your inbox. Assessment links, interview invites and rejections arrive in separate threads from different senders. A few things go wrong because of that:

- Deadlines get missed. Some are exact dates, some are relative ("within 48 hours"), some aren't stated at all.
- You lose track of stage. Which application is at assessment? Which company went quiet?
- Manual tracking doesn't last. Copying everything into a spreadsheet works for two weeks, then nobody keeps it up.

Why it's fiddly: every company and ATS (Greenhouse, Lever, Naukri, Workday...) formats its mail differently, one company's emails can come from several threads and senders, and deadlines are inconsistent. Sometimes a deadline is implied but never written out (the Damco invite itself just says "within the given timeline").

What success looks like: no missed deadlines, every application's stage visible in one place, and no manual data entry.

## What it does

Single user, single Gmail account.

1. Google login with read-only Gmail access (`gmail.readonly`, so JobRadar can never send or delete mail).
2. Polls for new mail every 5 minutes and keeps only the job-related emails.
3. Extracts company, role, stage, deadline and links from each email.
4. Dashboard: applications in a pipeline (Applied, Assessment, Interview, Offer, Rejected, Ghosted) plus upcoming deadlines.
5. Reminders: each validated deadline schedules a reminder 24h ahead; a cron sweep handles the due ones and the upcoming deadlines show on the dashboard.
6. A "needs review" queue: when the system isn't confident, you confirm or correct instead of it guessing.
7. Auto-ghosted: an application with no activity for 14 days gets marked Ghosted.

Out of scope for now (future work): Outlook/IMAP, a mobile app, auto-replying to recruiters, multi-user billing, calendar sync.

## Architecture

```
Gmail API ---> Ingestion worker ---> Rule pre-filter ---> Job queue (BullMQ+Redis)
(read-only)    (poll 5 min)          (keywords+ATS)                 |
                                                                    v
 Dashboard <-- REST API <-- SQLite/Postgres <-- Validation <-- LLM extractor (strict JSON)
 (Next.js)   (Express)      (apps, events)         |              |
                                                   |              '-- confidence<0.7 --> Review queue
 Reminders <-- Reminder scheduler <----------------'                                    (you confirm/fix)
 (swept)      (24h before deadline, validated only)
```

The full diagram and the reasoning behind each boundary is in [docs/architecture.md](docs/architecture.md).

## How it works

This is the section to read if you want to understand the system. We follow one email from the inbox to a reminder on your phone, naming the file that does each step.

### Step 0: connect Gmail (once)
`apps/worker/src/routes/auth.ts`

You click "Connect Gmail", go through Google's OAuth consent, and JobRadar gets a refresh token back. We encrypt it (AES-256-GCM, `src/crypto.ts`) before storing it in the `users` table, so a database leak on its own can't be used to read your inbox. Then we do a first backfill of your last 50 emails so the dashboard isn't empty.

### Step 1: ingestion (every 5 minutes)
`apps/worker/src/cron/index.ts` -> `apps/worker/src/gmail/ingest.ts`

A cron loop calls `incrementalSync()`. Instead of re-reading the whole inbox it uses Gmail's History API from a saved cursor (`last_history_id`), so it only fetches what changed. Each fetched message is written to the `emails` table. `gmail_msg_id` is UNIQUE, so if the same message is ever fetched twice the second insert is a no-op. That's what keeps the pipeline idempotent. We store only a short snippet, never the full body; the body is passed forward in memory for extraction and then dropped.

### Step 2: enqueue
`apps/worker/src/queue/index.ts`

New emails are pushed onto a job queue, one job per email, deduped by `gmail_msg_id`. A queue (rather than inline processing) buys us retries with exponential backoff for transient LLM/DB errors and a concurrency cap so at most 5 emails hit the LLM at once. There are two interchangeable backends: BullMQ + Redis when `REDIS_URL` is set, or a built-in in-memory queue when it isn't. Same interface either way.

### Step 3: rule pre-filter
`apps/worker/src/extract/prefilter.ts`

Before spending an LLM call we do a free check: does the email contain job keywords (interview, assessment, offer, regret...) or come from a known ATS domain (greenhouse.io, lever.co, naukri.com...)? If not, it's marked processed and dropped before it reaches the LLM. The filter is deliberately lenient. A false "job-related" just wastes one cheap call, whereas a false "not job-related" would silently drop a real deadline.

### Step 4: LLM extraction (OpenRouter)
`apps/worker/src/extract/llm.ts`

The email is sent to the model (via OpenRouter, OpenAI-compatible) with a forced function call (`record_extraction`) whose parameter schema is strict, so the model can only return the exact JSON shape:

```jsonc
{ company, role, stage, deadline_text, deadline_iso, links[], confidence }
```

No prose, no markdown. The output is re-validated with a Zod schema; if it somehow doesn't match, the call is retried up to 3 times, then the email goes to review. The prompt is explicit that `deadline_text` must be copied straight from the email, never paraphrased.

When Langfuse keys are set, each extraction call is traced (prompt, model output, token usage, latency) so you can debug bad extractions and watch cost. With no keys it's a no-op.

### Step 5: validation
`apps/worker/src/extract/validate.ts`

Three checks, in order:

1. Confidence gate: below `0.7` goes straight to the review queue.
2. Evidence check: the `deadline_text` the model returned has to appear word-for-word in the actual email. If the model made up "by Oct 20" that isn't in the mail, it's caught here and sent to review.
3. Relative-deadline resolution: "within 48 hours", "by Friday", "tomorrow" get turned into a concrete IST datetime anchored to the email's `received_at`. An explicit date ("October 20") is parsed directly.

If there's no deadline at all (the Damco case), we don't invent one. The application is flagged "follow-up suggested" and no reminder is built.

### Step 6: match to an application
`apps/worker/src/match/company.ts`

Which application does this email belong to? We try, most reliable first: same Gmail thread, then same sender domain plus a similar company name, then a fuzzy company-name match ("Acme Corp" vs "Acme"). No match means a new application. Stage only moves forward (Applied -> Assessment -> ...), so an old email processed late can't drag the stage backwards. Rejected can arrive from any stage; Ghosted is only ever set by cron.

### Step 7: write the event and schedule the reminder
`apps/worker/src/pipeline/processEmail.ts` -> `apps/worker/src/reminders/scheduler.ts`

For a validated deadline we create an `events` row (storing the evidence text and confidence) and schedule a reminder row for 24h before the deadline. We don't keep a live timer in memory (those die with the process). Instead we persist a `send_at` and let a cron sweep deliver it.

### Step 8: the reminder sweep
`apps/worker/src/reminders/scheduler.ts`

Every minute a sweep finds reminders whose `send_at` has passed and that haven't been handled yet, logs the due deadline server-side, and marks each one `sent` so it never repeats. Delivery is deliberately one swappable step: the sweep is where you'd plug in email, Slack, or a push channel later. The deadlines themselves are always visible on the dashboard.

### Step 9: you see it
`apps/web/` (Next.js) -> `apps/worker/src/routes/api.ts`

The dashboard reads from the API: a pipeline board grouped by stage, an upcoming-deadlines list (each showing the exact email text it came from so you can check it yourself), and the review queue where you confirm or correct low-confidence emails.

The guarantee the whole flow is built around: every email ends in exactly one of `processed`, `review` or `failed`, it's never silently dropped, and a deadline only shows up if its source text is real.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + TypeScript | web + worker + db in one repo, one language |
| Frontend | Next.js 15 (App Router) + Tailwind, on Vercel | fast dashboard, free hosting |
| Backend (API + worker + cron) | Node.js + Express + TypeScript, on Render | one process, one language across the stack |
| Database | SQLite + Prisma locally | nothing to install; switch the provider to Postgres for deploy |
| Queue | BullMQ + Redis, or a built-in in-memory queue | Redis when `REDIS_URL` is set, otherwise in-memory with the same retry/concurrency behaviour |
| Email | Gmail API (`gmail.readonly`) | read-only, incremental sync via `historyId` |
| LLM | OpenRouter (OpenAI-compatible) with a forced function call | schema-enforced JSON, works with any model slug |
| Reminders | persisted rows + cron sweep | survive restarts; delivery is logged server-side and easy to swap |
| Time/validation | Zod + Luxon | schema validation and IST deadline math |
| Observability | Langfuse (optional) | traces every LLM extraction: prompt, model output, token usage, latency |

The LLM sits behind one file (`apps/worker/src/extract/llm.ts`). Point `LLM_MODEL` at any OpenRouter model (`openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`, ...) without touching the rest. With SQLite and no `REDIS_URL` the whole thing runs with no external services: `pnpm install` and go.

## Data model

Five tables (full schema in [`packages/db/prisma/schema.prisma`](packages/db/prisma/schema.prisma)). We never store the full email body, only the extracted fields and a short snippet.

| Table | Key columns | Notes |
|---|---|---|
| `users` | email, timezone, `refresh_token` (encrypted), `last_history_id`, `needs_reconnect` | default tz Asia/Kolkata |
| `emails` | `gmail_msg_id` (UNIQUE), thread_id, sender, subject, snippet, received_at, status | status: pending/processed/failed/review |
| `applications` | company, role, stage, last_activity_at, sender_domain | stage: Applied/Assessment/Interview/Offer/Rejected/Ghosted |
| `events` | type, due_at, confidence, evidence_text, source_email_id, follow_up_suggested | type: deadline/interview/assessment |
| `reminders` | event_id, send_at, channel, sent | swept by cron; channel records how it was handled |

Stage rules: stage only moves forward; Rejected can come from any stage; Ghosted is set by a cron job.

## Repo structure

```
jobradar/
├── apps/
│   ├── web/                      # Next.js dashboard (Vercel)
│   │   └── app/
│   │       ├── page.tsx          #   pipeline board
│   │       ├── deadlines/        #   upcoming deadlines
│   │       ├── review/           #   confirm/correct queue
│   │       ├── components/       #   Nav, StageBadge, reconnect banner
│   │       └── lib/api.ts        #   typed fetch client
│   └── worker/                   # API + worker + cron (Render)
│       └── src/
│           ├── index.ts          #   entry: API + worker + cron
│           ├── config.ts         #   validated env
│           ├── crypto.ts         #   token encryption (AES-256-GCM)
│           ├── gmail/            #   oauth + incremental ingestion
│           ├── extract/          #   prefilter, llm, validate
│           ├── match/            #   company matching + stage rules
│           ├── pipeline/         #   processEmail, ties it together
│           ├── queue/            #   BullMQ / in-memory queue
│           ├── reminders/        #   scheduler + cron sweep
│           ├── cron/             #   poll, reminder sweep, ghosted
│           ├── observability/    #   langfuse tracing (optional)
│           └── routes/           #   auth + dashboard REST API
├── packages/db/                  # Prisma schema + client (@jobradar/db)
├── tests/fixtures/               # anonymized sample recruiter emails
├── docs/architecture.md          # diagram + rationale
├── render.yaml                   # backend deploy blueprint
└── .env.example                  # all env vars documented
```

## Run it locally

Prerequisites: Node 20+, pnpm 9+, a Google OAuth client, and an OpenRouter API key. No database or Redis to install; SQLite is a local file and the queue falls back to in-memory.

```bash
# 1. install
pnpm install

# 2. configure
cp .env.example .env          # fill in the values (see below)
cp apps/web/.env.example apps/web/.env.local

# 3. database (creates a local SQLite file)
pnpm db:generate              # generate the Prisma client
pnpm db:push                  # create dev.db + tables

# 4. run (two terminals)
pnpm dev:worker               # API + worker + cron on :4000
pnpm dev:web                  # dashboard on :3000

# 5. connect your Gmail
# open http://localhost:4000/auth/google  (or click "Connect Gmail" in the UI)
```

Then open http://localhost:3000. Within a poll cycle the board fills with your applications.

Handy scripts: `pnpm test` (extractor tests), `pnpm typecheck`, `pnpm db:studio` (browse the DB).

## Environment variables

Every variable is documented in [`.env.example`](.env.example). The ones you actually need:

| Var | What |
|---|---|
| `DATABASE_URL` | SQLite file (`file:./dev.db`), or a Postgres URL for deploy |
| `REDIS_URL` | optional; set it to use the BullMQ queue, leave it empty for the in-memory queue |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | Google OAuth (enable the Gmail API, scope `gmail.readonly`) |
| `TOKEN_ENC_KEY` | 32-byte hex key to encrypt refresh tokens: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OPENROUTER_API_KEY` / `OPENROUTER_BASE_URL` / `LLM_MODEL` | OpenRouter extraction (any model slug) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_BASEURL` | optional LLM tracing; leave the keys empty to disable |
| `NEXT_PUBLIC_API_URL` | where the frontend finds the API |

`.env` and tokens are gitignored, so secrets don't go into the repo.

## Failure modes

Any component can fail; the system is built so no mail is lost and no wrong deadline is shown.

| What breaks | What the system does |
|---|---|
| Gmail rate-limited or down | Exponential-backoff retry. The next cycle resumes from `last_history_id`, so no mail is skipped. |
| OAuth token expired/revoked | Try to refresh; if that fails, show a "Reconnect Gmail" banner and pause sync. |
| LLM down or returning bad JSON | Retry 3x, then send the email to the review queue. |
| LLM invents a deadline | The evidence check fails, the email goes to review, and no reminder is created. |
| Duplicate / double-processed mail | `gmail_msg_id` is UNIQUE, so the second pass is a no-op. |
| Timezone confusion | Default IST, and the UI also shows the original deadline text so you can check it. |
| Worker crash | With Redis, jobs persist and pending ones re-run on restart. |

## Tradeoffs

The MVP is one user, so most calls lean towards simplicity. Each row notes when the decision would change.

| Decision | Chosen | Alternative | Changes when |
|---|---|---|---|
| New mail | 5-min polling (via historyId) | Gmail Pub/Sub push | 1000+ users or real-time needed |
| Classification | rules + LLM (hybrid) | LLM only | rules get noisy, or the LLM gets very cheap |
| What we store | extracted fields + snippet | full email body | you want to re-process old mail |
| Job queue | BullMQ + Redis | Postgres-table queue | for one user, Postgres alone would do |
| Mail access | Gmail API | IMAP | you need Outlook/Yahoo support |
| Language | TypeScript everywhere | Python backend | extraction gets ML-heavy |

## Known limitations and future work

- Unverified Google app: with the `gmail.readonly` scope, an unverified app works for about 100 test users. That's fine for a demo; production would need Google verification and a security assessment.
- Single user: the schema is multi-user-ready (every row is scoped to a `user_id`), but there's no auth/session layer yet, so the API resolves "the user" as the only connected one.
- Future work: Outlook/IMAP, a mobile app, calendar sync, multi-user auth, richer event types (interview scheduling), and learning from review-queue corrections to improve the prompt.

## Tests

```bash
pnpm test
```

The edge-case tests (`apps/worker/src/extract/validate.test.ts`) run against anonymized fixtures in `tests/fixtures/` and cover the cases that actually matter:

- a relative deadline ("within 48 hours") resolved to the correct absolute IST instant,
- a Damco-style email with no deadline, flagged "follow-up suggested" with no reminder,
- a hallucinated deadline (text not in the email), caught and routed to review,
- a low-confidence extraction, routed to review,
- the pre-filter passing recruiter mail and rejecting marketing.

## Deploy

Backend (API + worker + cron) on Render: push to GitHub, then New -> Blueprint and point it at [`render.yaml`](render.yaml). Set the secret env vars in the dashboard. The build generates the Prisma client and pushes the schema; the service runs via `tsx`.

Frontend on Vercel: import the repo, set the root directory to `apps/web`, and set `NEXT_PUBLIC_API_URL` to your Render URL.

After deploy, update `GOOGLE_REDIRECT_URI` (and the authorized redirect in the Google console) and `WEB_ORIGIN` to the production URLs.
