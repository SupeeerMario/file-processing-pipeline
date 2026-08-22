# Project 3 — Bulk Data Import Pipeline (Node + MongoDB)

Skeleton: upload → object storage → queue → worker → MongoDB → status, with
retries, DLQ, and graceful shutdown.

Payload: **ingest a large Excel/CSV file into MongoDB without losing rows,
duplicating rows, or dying on bad input.**

---

## How Claude works on this repo

This is a **learning project**. Khaled writes every line of code. Claude is a
senior instructor and debugger, not an implementer.

**Claude must NOT:**
- Create, edit, or delete any source file (`.js`, `.ts`, `.json`, `.yml`, `Dockerfile`,
  config, tests). The only exception is this `CLAUDE.md` and other planning/notes docs,
  when asked.
- Paste implementation code to copy in. No full functions, no full modules, no full
  files, no "here's the fixed version" blocks.
- Solve a step before Khaled has attempted it.

**Claude MAY:**
- Run the code, run tests, run `curl`, query the database with `mongosh`, read logs,
  inspect output, and report what actually happened.
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
the final collection has exactly 500,000 correct documents plus an error report for the
bad ones. Here is why."*

## Stack

| Piece | Choice | Note |
|---|---|---|
| Runtime | Node 22, CommonJS | Docker image is `node:22-alpine`; mongoose 9 requires `>=20.19.0`. Local Node comes from `.venv` (nodeenv-managed, v26.7.0) and still drifts from the image. App runs in Docker only. |
| API | Express 5 | Already scaffolded (`server.js`). Express 5 auto-forwards async errors to the error middleware — Express 4 did not. |
| DB | MongoDB 7 + Mongoose | Local via Docker Compose, Atlas in prod. **Must run as a replica set locally** — see "MongoDB gotchas". |
| Queue | RabbitMQ locally (`amqplib`) | Upstash Redis in prod. Write the consume loop by hand — no BullMQ at first. BullMQ hides the exact thing this project is about (ack, redelivery, DLQ, shutdown). |
| Object storage | Cloudflare R2 or Supabase Storage (`@aws-sdk/client-s3`) | Local dev: MinIO container, or the filesystem behind one small storage module so swapping is a one-file change. |
| Upload handling | `busboy` (or `multer` with a custom storage engine) | Must pipe the request stream straight to storage. Never `multer` memory storage. |
| Worker | Standalone Node process, own entrypoint (`worker/index.js`) | Separate compose service, same image, different `CMD`. |
| Parsing | `exceljs` streaming `WorkbookReader` for xlsx, `csv-parse` for CSV | Streaming, never `XLSX.readFile` on the whole file — `xlsx`/SheetJS buffers everything. |
| Validation | `zod` per row | One schema, one parse call per row, collect the issue list. |
| Tests | `jest` or node's built-in `node:test` | Pick one in Phase 0. |
| Load test | script that generates a 500k-row file | Write it yourself. |

### MongoDB gotchas that shape this project

Read these before Phase 0 — they change the design, not just the code.

1. **Transactions require a replica set.** A standalone `mongo:7.0` container does
   **not** support multi-document transactions. `session.startTransaction()` fails with
   `Transaction numbers are only allowed on a replica set member or mongos`. Phase 3b is
   built on one transaction, so fix this at the compose level: start mongo with
   `--replSet rs0` and run `rs.initiate()` once. A single-node replica set is fine and
   fully supports transactions.
2. **`bulkWrite` is the batch primitive**, not `insertMany`, once you need upserts.
   `insertMany({ ordered: false })` is faster but cannot upsert.
3. **Idempotency comes from a unique index plus upsert**, not from application checks.
   `updateOne({ filter: naturalKey }, { $set: doc }, { upsert: true })` inside a
   `bulkWrite`. A check-then-insert is a race, always.
4. **`ordered: false`** on `bulkWrite` means one bad op does not abort the rest — but it
   throws a `MongoBulkWriteError` at the end carrying `result` and `writeErrors`. You must
   catch it and read both, not just log it.
5. **Mongoose buffers by default.** If the connection is down, operations queue silently
   instead of failing fast. For a worker that must detect a dead DB and retry, consider
   `bufferCommands: false` and decide the behaviour deliberately.
6. **Documents cap at 16MB** and the whole error report cannot be one document. Errors go
   in their own collection, one document per bad row.

---

## Phase 0 — Decisions and skeleton

Write the answers down in `docs/decisions.md` before writing more code.

**Decisions still open — write these in `docs/decisions.md` before more code:**
- [ ] CJS or ESM. One sentence of why. Currently **CJS** de facto (`require`, no
      `"type": "module"`). Top-level `await` is unavailable; `server.js` uses
      `connectDB().then(...)` because of it. Commit to CJS or switch now — converting once
      the worker and parsers exist is far worse.
- [ ] Decide the target of the import. Simplest good choice: one concrete domain
      collection (e.g. `customers`), OR a generic `records` collection plus a per-import
      mapping. Pick one; do not build a generic ETL engine.
- [ ] Decide the natural key that makes an upsert idempotent (e.g. `email`, or
      `{ importId, rowNumber }`). Write down which and why, and create the **unique index**
      for it. Say what happens to a legitimate duplicate email within one file.
- [ ] Decide chunk size (start at 1000 rows) and write down what it trades off
      (memory - transaction size - restart granularity - round trips).
- [ ] Test runner: `jest` or `node:test`.
- [ ] Startup policy, now that `connectDB()` gates `app.listen`: is fail-fast the final
      answer, or does the API eventually start without Mongo and return `503` until ready?
      Fail-fast is the right default here; revisit in Phase 3d for the worker.

**Infrastructure - done:**
- [x] Docker Compose: API + MongoDB + mongo-express, all on `mongodb_network`.
- [x] `MONGODB_URI` written literally (dotenv does not expand `${...}`), with an explicit
      database and `?authSource=admin`.
- [x] Node pinned to 22 in the image - mongoose 9 requires `>=20.19.0`; `node:18-alpine`
      failed at runtime with `crypto is not defined`.
- [x] `connectDB()` runs before `app.listen`, so the port never opens without a database.
- [x] `connectDB` logs the full error object, not `error.message` - a bare message hid the
      mongoose stack for an entire debugging round.
- [x] `Dockerfile` copies the lockfile and uses `npm ci`.
- [x] `.dockerignore` covers `node_modules/`, `.env`, `.git`; `.gitignore` no longer lists
      itself.

**Infrastructure - remaining:**
- [ ] Add RabbitMQ and storage (MinIO) to Compose. Add a `worker` service.
- [ ] Convert mongo to a **single-node replica set** (`--replSet rs0` + one-time
      `rs.initiate()`), otherwise Phase 3b cannot be built. Do it while the `files` database
      is still empty - retrofitting it later means wiping the volume.
- [ ] `docker-compose.yml` currently hardcodes the Mongo username and password in
      `ME_CONFIG_MONGODB_URL`, and that file is tracked by git. Move it back to
      `${DB_USERNAME}` / `${DB_PASSWORD}` - Compose does interpolate its own file, so this
      works. Rotate the password if it has already been pushed.
- [ ] Repo scaffolding: `api/`, `worker/`, `models/`, `lib/` (storage, queue, parser),
      `scripts/`, `tests/`, `README.md`.
- [ ] Local Node is `.venv`-managed v26.7.0, the image is 22. Pin the intent (`.nvmrc`,
      `engines`) so the two cannot drift apart again.
- [ ] Dev image runs `nodemon` as root. Fine for local, note it for the prod image.
- [ ] Mongo publishes no host port - deliberate, app runs in Docker only. Inspect data with
      `docker compose exec mongodb mongosh`, not a host `mongosh`.

**Done when:** `docker compose up` starts API + MongoDB (replica set) + RabbitMQ +
storage, `docker compose exec mongodb mongosh` connects, and the RabbitMQ management UI
opens.

Current state: API + MongoDB + mongo-express come up clean - `MongoDB Connected: mongodb`
then `Server is running on port 3000`, in that order. `GET /` returns 404 (no routes yet).
Queue, storage, worker, and the replica set are not built.

---

## Phase 1 — Upload and job tracking

- [ ] `ImportJob` model: `filename`, `storageKey`, `status`, `totalRows`, `rowsOk`,
      `rowsFailed`, `lastCommittedChunk`, `attempts`, `error`, timestamps
      (`{ timestamps: true }`).
- [ ] Status is an enum: `pending`, `processing`, `done`, `failed`, `dead_lettered`.
      Write the allowed transitions down. Nothing should be able to go `done` → `processing`.
      Enforce it in the query filter, not in an `if` — the update must be
      `updateOne({ _id, status: 'pending' }, { $set: { status: 'processing' } })` so two
      workers cannot both win.
- [ ] `POST /imports` — accept multipart upload, **stream** the bytes to object storage
      (do not read the file into memory), insert an `ImportJob` as `pending`, return
      `{ "jobId": ... }` with HTTP 202.
- [ ] Reject early: file size cap (start 20MB — enforce it on the stream, do not trust
      `Content-Length`), extension allowlist (`.csv`, `.xlsx`), and content sniff on the
      first bytes — do not trust the extension. An xlsx is a zip: it starts `PK\x03\x04`.
- [ ] `GET /imports/:id` — return status and the counters.
- [ ] Script that generates test files: 100 rows, 500k rows, and one file with
      deliberately broken rows.

**Done when:** Uploading a 500k-row file returns a job ID in under a second, the file is
in object storage, and `GET /imports/:id` shows `pending`.

---

## Phase 2 — The worker and streaming ingest

- [ ] On job creation, publish `{ jobId }` to the queue. Publish the ID only — never the
      file contents.
- [ ] Worker: long-running process, `channel.prefetch(1)`, consumes one message at a time,
      sets the job to `processing`, and downloads the file from storage as a **stream**.
- [ ] Stream-parse. `exceljs` `WorkbookReader` with `{ worksheets: 'emit', sharedStrings:
      'cache' }`, or `csv-parse` piped from the download stream. Prove it is streaming: run
      the 500k-row file and watch RSS stay flat (`process.memoryUsage().rss`, logged every
      N chunks).
- [ ] Accumulate rows into chunks of N. For each chunk:
      validate each row → split good and bad → `bulkWrite` the good rows →
      `insertMany` the bad rows into `import_errors`.
- [ ] **Backpressure**: the parser emits rows faster than Mongo writes them. `for await`
      over an async iterator gives you this for free; an `on('row')` callback does not —
      you must `stream.pause()` / `resume()`. Know which one you built.
- [ ] `ImportError` model: `importId`, `rowNumber`, `columnName`, `rawValue`, `reason`.
      Index on `importId`.
- [ ] Update counters and set status `done` at the end.
- [ ] `GET /imports/:id/errors.csv` — stream the error report back as a download
      (cursor → transform → response, never build the whole CSV in memory).

**Done when:** Upload the 500k-row file → status goes `pending` → `processing` → `done`,
the documents are in MongoDB, and worker RSS stays flat during the run (show the number).

---

## Phase 3 — The hero feature: failure friendliness

Four separate mechanisms. Build them one at a time, each with its own test.

### 3a — A bad row never kills the file
- [ ] Row-level validation errors are recorded and skipped, never raised to the top.
- [ ] Distinguish *row* errors (bad email, missing required field, unparseable date) from
      *file* errors (missing header, wrong encoding, corrupt zip) — only file errors fail
      the job.
- [ ] A `MongoBulkWriteError` with `ordered: false` is a **mixed** result: some ops
      succeeded. Read `err.result.nUpserted` / `nModified` and `err.writeErrors` and count
      both sides correctly. Getting this wrong silently corrupts your counters.
- [ ] Decide and document: is there a failure-rate threshold that aborts the whole import
      (e.g. >50% of rows bad = probably the wrong file)?

**Done when:** A file with 100 rows where 7 are bad ends `done` with `rowsOk=93`,
`rowsFailed=7`, and the error CSV names all 7 row numbers with reasons.

### 3b — A crash never loses or repeats progress
- [ ] The chunk's writes and the `lastCommittedChunk` update happen in **one MongoDB
      transaction** — `session.withTransaction(...)`, every op passing `{ session }`.
      Understand why this is the whole trick. An op that forgets `{ session }` silently
      escapes the transaction; that is the classic bug here.
- [ ] Requires the replica set from Phase 0. Verify with `rs.status()`.
- [ ] `withTransaction` **retries the callback** on transient errors. Your callback must
      therefore be safe to run twice — no counter mutation held outside it.
- [ ] On pickup, the worker resumes from `lastCommittedChunk + 1`, skipping already
      committed rows in the stream. You still parse the skipped rows (streams cannot seek);
      you just do not write them.
- [ ] Note the tradeoff: transactions on large chunks pressure the WiredTiger cache and hit
      the 60-second default transaction lifetime. Measure your chunk time.

**Done when:** `docker kill` the worker at ~50% of a 500k-row import; a second worker
finishes it; `db.customers.countDocuments()` is exactly 500000 and no document is duplicated.

### 3c — Redelivery never duplicates
- [ ] Make the whole job idempotent: processing the same `jobId` message twice produces the
      same final collection state.
- [ ] Use `bulkWrite` with `updateOne` + `upsert: true` on the natural key from Phase 0.
      The unique index is what makes it correct under concurrency; the upsert is what makes
      it not throw.
- [ ] Handle `E11000 duplicate key error` on a concurrent upsert — Mongo can still throw it
      in a race, and the correct response is retry, not fail.
- [ ] Think about the case where the same *file* is uploaded twice as two different jobs. Is
      that a duplicate or a legitimate re-import? Write down the answer. (Content hash of
      the upload is one way to detect it.)

**Done when:** Manually publishing the same jobId message three times leaves the document
count unchanged, and a test proves it.

### 3d — Retries, dead-letter, graceful shutdown
- [ ] Retry with exponential backoff on transient failures (storage timeout, `MongoNetwork
      Error`, connection drop). Distinguish transient from permanent — do not retry a
      corrupt file.
- [ ] RabbitMQ has no native delayed retry. Pick one and write down why: a per-queue TTL +
      dead-letter-exchange "wait queue", or the delayed-message-exchange plugin, or an
      in-worker sleep before nack. Each has a real cost.
- [ ] After N attempts, route the job to a dead-letter queue and set status
      `dead_lettered`. Record the last error on the job document.
- [ ] Handle `SIGTERM`: stop taking new chunks, finish or abort the current transaction
      cleanly, `channel.nack(msg, false, true)` so it is redelivered, close the channel and
      the mongoose connection, then exit. Node does **not** exit on SIGTERM by itself once
      you register a handler — you must call `process.exit()` or drain the event loop.
- [ ] Docker sends SIGTERM only to PID 1. `CMD ["npm", "run", ...]` makes npm PID 1 and it
      does not forward signals. Use exec-form `CMD ["node", "worker/index.js"]` or the
      signal never reaches your handler. Verify this before believing your test.
- [ ] Add a heartbeat field on the job (`lastHeartbeatAt`, touched each chunk) plus a reaper
      that re-queues any job `processing` with a stale heartbeat — so a worker killed by
      SIGKILL or OOM does not leave the job stuck forever. Also raise RabbitMQ's
      `consumer_timeout` (default 30 min) or a long chunked job gets its channel closed
      mid-work.

**Done when:** A corrupt xlsx lands in the DLQ after its retries instead of blocking the
queue, and `docker stop` (SIGTERM) on a busy worker results in the job completing on
another worker with no duplicated documents.

---

## Phase 4 — Depth (pick at least two)

- [ ] **Dry-run mode** — `POST /imports?dryRun=true` validates the entire file and produces
      the error report without writing a single document.
- [ ] **Column mapping** — caller supplies `{"Full Name": "name", "E-Mail": "email"}` so the
      schema is not hardcoded. Reject a file whose headers do not satisfy the mapping.
- [ ] **Backpressure / pool cap** — cap concurrent chunk work so one huge import cannot
      exhaust the Mongo driver connection pool (`maxPoolSize`, default 100). Measure what
      happens without the cap first.
- [ ] **Progress percentage** — requires knowing total rows; for xlsx that means a cheap
      counting pass or reading `dimensions` from the sheet, or an estimate. Decide and
      justify.
- [ ] **Cancellation** — `DELETE /imports/:id` stops an in-flight import. Decide: does it
      roll back committed chunks or leave them? How does the API tell the worker — a flag on
      the job document that the worker checks between chunks is the simple answer; say why
      a second queue would be worse.

**Done when:** Two of these work and each has a line in the README explaining the tradeoff.

---

## Phase 5 — Tests, CI, deploy, package

- [ ] Tests, at minimum:
      happy path · partial-failure path (3a) · resume-after-crash path (3b) ·
      duplicate-delivery path (3c) · dead-letter path (3d) · file-too-large rejection.
- [ ] Integration tests need a real Mongo replica set. Use `mongodb-memory-server` with
      `replSet` enabled, or Testcontainers, or the Compose stack. `mongodb-memory-server`
      in standalone mode cannot run your transaction tests.
- [ ] The crash test must be real: spawn the worker as a child process, `SIGKILL` it, start
      another. If the test cannot kill a process, it is not testing 3b.
- [ ] GitHub Actions: lint (`eslint`) + tests, matrix build of the API image and the worker
      image.
- [ ] Deploy: API on Render, worker as a Render background worker or an Oracle free VM,
      MongoDB on Atlas, queue on Upstash or CloudAMQP, storage on R2.
- [ ] README: architecture diagram (upload → storage → queue → worker → MongoDB), the
      kill-the-worker demo with the exact commands and the document count, a paste of the
      error report, and the Phase 0 decisions written as tradeoffs.

**Done when:** A live URL accepts a real xlsx end to end, CI is green, and the README shows
the 500k-rows-survive-a-kill proof.

**Time:** ~1.5–2 weeks.

---

## Concepts to be able to explain out loud

Track these; they are what the interview actually tests.

- At-least-once delivery, and why it forces idempotent consumers.
- Why the chunk write and the checkpoint must share one transaction — and why MongoDB
  needs a replica set before you can even have that conversation.
- Unique index + upsert as the idempotency mechanism, versus check-then-insert as a race.
- `ordered: false` bulk writes: partial success is the normal case, not the error case.
- Transient vs permanent failure, and why retrying a permanent failure is a bug.
- What a dead-letter queue is for (head-of-line blocking).
- SIGTERM vs SIGKILL, why PID 1 signal forwarding matters in Docker, and why you still need
  a heartbeat/visibility timeout even with graceful shutdown.
- Streaming vs buffering in Node, backpressure, and the RSS number that proves which one you
  built.
- Partial success as a product decision, not just a technical one.
