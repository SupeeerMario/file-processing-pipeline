# Project 3 — Bulk Data Import Pipeline

Replaces the "upgrade your OCR" version of Project 3 in `core5_build_map.md`.
Same skeleton (upload → queue → worker → status, retries, DLQ, graceful shutdown);
different payload. Payload is now: **ingest a large Excel/CSV file into Postgres
without losing rows, duplicating rows, or dying on bad input.**

---

## How Claude works on this repo

This is a **learning project**. Khaled writes every line of code. Claude is a
senior instructor and debugger, not an implementer.

**Claude must NOT:**
- Create, edit, or delete any source file (`.py`, `.sql`, `.yml`, `Dockerfile`, config, tests).
  The only exception is this `CLAUDE.md` and other planning/notes docs, when asked.
- Paste implementation code to copy in. No full functions, no full classes, no full
  files, no "here's the fixed version" blocks.
- Solve a step before Khaled has attempted it.

**Claude MAY:**
- Run the code, run tests, run `curl`, query the database, read logs, inspect output,
  and report what actually happened.
- Read any file in the repo to understand current state.
- Point at the exact line or concept that is wrong, and explain *why* it is wrong.
- Show API signatures, library names, error messages, and short illustrative snippets
  (≤3 lines) of *syntax*, not of the solution.
- Explain a concept with pseudocode or a diagram.
- Ask leading questions to get Khaled to the answer.
- Review finished code, name specific problems, and suggest what to change — in words.

**Debugging protocol** — when Khaled is stuck:
1. Reproduce it. Run the thing. Quote the shortest decisive line of the error.
2. Say which layer the bug is in (parser / transaction / queue / worker lifecycle / config).
3. Give a hypothesis and a way to test it, not a patch.
4. Only if Khaled asks twice, or is blocked >30 min, escalate to a precise description
   of the fix — still in words, still not a paste-in block.

**Review protocol** — when a phase is done:
- Run the "Done when" check for that phase. Report pass or fail with evidence.
- Then review the code for correctness, and for the tradeoffs a senior would ask about
  in an interview.

---

## Goal

Accept an Excel/CSV upload, reply instantly with a job ID, ingest the rows in a
background worker, and survive: bad rows, worker crashes, duplicate deliveries, and
unparseable files. The user can always see progress and download a report of what
failed and why.

The interview line at the end: *"I upload 500,000 rows, kill the worker halfway, and
the final table has exactly 500,000 correct rows plus an error report for the bad
ones. Here is why."*

## Stack

| Piece | Choice | Note |
|---|---|---|
| API | Python — FastAPI or DRF | DRF if you want to reuse Project 1 muscle memory; FastAPI if you want async upload handling. Decide in Phase 0. |
| DB | PostgreSQL | Local via Docker Compose, Neon in prod. |
| Queue | RabbitMQ locally | Upstash (Redis) in prod. |
| Object storage | Cloudflare R2 or Supabase Storage | Local dev can use MinIO or the filesystem. |
| Worker | Standalone Python process | Not Celery at first — write the consume loop by hand so you actually learn the lifecycle. Celery hides the exact thing this project is about. |
| Parsing | `openpyxl` (read_only mode) for xlsx, stdlib `csv` for CSV | Streaming, never `pandas.read_excel` on the whole file. |
| Tests | pytest | |
| Load/scale test | generate a 500k-row file with a script you write | |

---

## Phase 0 — Decisions and skeleton

Write the answers down in `docs/decisions.md` before writing code.

- [ ] Pick API framework (FastAPI vs DRF) and write one sentence of why.
- [ ] Decide the target of the import. Simplest good choice: a generic `records` table
      plus a per-import mapping, OR one concrete domain table (e.g. `customers`).
      Pick one; do not build a generic ETL engine.
- [ ] Decide the natural key that makes an upsert idempotent (e.g. `email`, or
      `(import_id, row_number)`). Write down which and why.
- [ ] Decide chunk size (start at 1000 rows) and write down what it trades off.
- [ ] Docker Compose up: API + Postgres + RabbitMQ + storage.
- [ ] Repo scaffolding: `api/`, `worker/`, `tests/`, `docker-compose.yml`, `README.md`.

**Done when:** `docker compose up` starts all four services, and you can open a psql
shell into the database and see the RabbitMQ management UI.

---

## Phase 1 — Upload and job tracking

- [ ] Tables: `import_jobs` (id, filename, storage_key, status, total_rows,
      rows_ok, rows_failed, last_committed_chunk, created_at, updated_at, error).
- [ ] Status is an enum: `pending`, `processing`, `done`, `failed`, `dead_lettered`.
      Write the allowed transitions down. Nothing should be able to go `done` → `processing`.
- [ ] `POST /imports` — accept multipart upload, stream the bytes to object storage
      (do not read the file into memory), insert an `import_jobs` row as `pending`,
      return `{"job_id": ...}` with HTTP 202.
- [ ] Reject early: file size cap (start 20MB), extension allowlist (`.csv`, `.xlsx`),
      and content sniff — do not trust the extension.
- [ ] `GET /imports/{id}` — return status and the counters.
- [ ] Write a script that generates test files: 100 rows, 500k rows, and one file
      with deliberately broken rows.

**Done when:** Uploading a 500k-row file returns a job ID in under a second, the file
is in object storage, and `GET /imports/{id}` shows `pending`.

---

## Phase 2 — The worker and streaming ingest

- [ ] On job creation, publish `{job_id}` to the queue. Publish the ID only — never
      the file contents.
- [ ] Worker: a long-running process that consumes one message at a time, sets the
      job to `processing`, and downloads the file from storage as a stream.
- [ ] Stream-parse. `openpyxl` in `read_only=True` mode, or the `csv` module reading a
      file object. Prove to yourself it is streaming: run it and watch RSS stay flat
      on the 500k-row file.
- [ ] Accumulate rows into chunks of N. For each chunk:
      validate each row → split good and bad → batch-insert the good rows →
      insert the bad rows into `import_errors`.
- [ ] `import_errors` table: (import_id, row_number, column_name, raw_value, reason).
- [ ] Update counters and set status `done` at the end.
- [ ] `GET /imports/{id}/errors.csv` — stream the error report back as a download.

**Done when:** Upload the 500k-row file → status goes `pending` → `processing` → `done`,
the rows are in Postgres, and worker memory stays flat during the run (show the number).

---

## Phase 3 — The hero feature: failure friendliness

Four separate mechanisms. Build them one at a time, each with its own test.

### 3a — A bad row never kills the file
- [ ] Row-level validation errors are recorded and skipped, never raised to the top.
- [ ] Distinguish *row* errors (bad email, missing required field, unparseable date)
      from *file* errors (missing header, wrong encoding, corrupt zip) — only file
      errors fail the job.
- [ ] Decide and document: is there a failure-rate threshold that aborts the whole
      import (e.g. >50% of rows bad = probably the wrong file)?

**Done when:** A file with 100 rows where 7 are bad ends `done` with rows_ok=93,
rows_failed=7, and the error CSV names all 7 row numbers with reasons.

### 3b — A crash never loses or repeats progress
- [ ] The chunk's row inserts and the `last_committed_chunk` update happen in **one
      database transaction**. Understand why this is the whole trick.
- [ ] On pickup, the worker resumes from `last_committed_chunk + 1`, skipping already
      committed rows in the stream.

**Done when:** `docker kill` the worker at ~50% of a 500k-row import; a second worker
finishes it; `SELECT count(*)` is exactly 500000 and no row is duplicated.

### 3c — Redelivery never duplicates
- [ ] Make the whole job idempotent: processing the same `job_id` message twice
      produces the same final table state.
- [ ] Use `INSERT ... ON CONFLICT` on the natural key chosen in Phase 0.
- [ ] Think about the case where the same *file* is uploaded twice as two different
      jobs. Is that a duplicate or a legitimate re-import? Write down the answer.

**Done when:** Manually publishing the same job_id message three times leaves the row
count unchanged, and a test proves it.

### 3d — Retries, dead-letter, graceful shutdown
- [ ] Retry with exponential backoff on transient failures (storage timeout, DB
      connection drop). Distinguish transient from permanent — do not retry a corrupt file.
- [ ] After N attempts, route the job to a dead-letter queue and set status
      `dead_lettered`. Record the last error on the job row.
- [ ] Handle SIGTERM: stop taking new chunks, finish or roll back the current chunk
      cleanly, nack the message so it is redelivered, then exit.
- [ ] Add a heartbeat or visibility timeout so a job whose worker vanished without
      SIGTERM (SIGKILL, OOM) is eventually re-queued rather than stuck in `processing`
      forever.

**Done when:** A corrupt xlsx lands in the DLQ after its retries instead of blocking
the queue, and `docker stop` (SIGTERM) on a busy worker results in the job completing
on another worker with no duplicated rows.

---

## Phase 4 — Depth (pick at least two)

- [ ] **Dry-run mode** — `POST /imports?dry_run=true` validates the entire file and
      produces the error report without writing a single row.
- [ ] **Column mapping** — caller supplies `{"Full Name": "name", "E-Mail": "email"}`
      so the schema is not hardcoded. Reject a file whose headers do not satisfy the mapping.
- [ ] **Backpressure** — cap concurrent chunk work so one huge import cannot exhaust
      the Postgres connection pool. Measure what happens without the cap first.
- [ ] **Progress percentage** — requires knowing total rows; for xlsx that means a
      cheap counting pass or an estimate. Decide and justify.
- [ ] **Cancellation** — `DELETE /imports/{id}` stops an in-flight import. Decide:
      does it roll back committed chunks or leave them?

**Done when:** Two of these work and each has a line in the README explaining the tradeoff.

---

## Phase 5 — Tests, CI, deploy, package

- [ ] Tests, at minimum:
      happy path · partial-failure path (3a) · resume-after-crash path (3b) ·
      duplicate-delivery path (3c) · dead-letter path (3d) · file-too-large rejection.
- [ ] The crash test must be real: start the worker, kill it, start another. If the
      test cannot kill a process, it is not testing 3b.
- [ ] GitHub Actions: lint + tests, matrix build of the API image and the worker image.
- [ ] Deploy: API on Render, worker on an Oracle free VM or a Render worker, Postgres
      on Neon, queue on Upstash, storage on R2.
- [ ] README, using the template at the end of `core5_build_map.md`:
      architecture diagram (upload → storage → queue → worker → Postgres),
      the kill-the-worker demo with the exact commands and the row count,
      a screenshot or paste of the error report,
      and the decisions from Phase 0 written as tradeoffs.

**Done when:** A live URL accepts a real xlsx end to end, CI is green, and the README
shows the 500k-rows-survive-a-kill proof.

**Time:** ~1.5–2 weeks.

---

## Concepts to be able to explain out loud

Track these; they are what the interview actually tests.

- At-least-once delivery, and why it forces idempotent consumers.
- Why the chunk insert and the checkpoint must share one transaction.
- Transient vs permanent failure, and why retrying a permanent failure is a bug.
- What a dead-letter queue is for (head-of-line blocking).
- SIGTERM vs SIGKILL, and why you need a visibility timeout even with graceful shutdown.
- Streaming vs buffering, and the memory number that proves which one you built.
- Partial success as a product decision, not just a technical one.
