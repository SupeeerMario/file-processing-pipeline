# Bulk Data Import Pipeline

A Node service that ingests very large spreadsheet uploads into MongoDB. The API answers immediately with a job id, the bytes stream straight to object storage, and a separate worker parses, validates and writes the rows in the background — **without loading the file into memory, losing rows, or duplicating them when a worker dies mid-import.**

The headline: *upload 500,000 rows, kill the worker halfway, and the collection ends with exactly the rows the file described, plus a downloadable report of the ones that were rejected and why.*

## Features

- **Streaming end to end.** The upload is piped request → S3 without buffering, and the worker parses the object as a stream. 500,000 rows / 30.2MB imports with resident memory flat between 120 and 131MB.
- **Instant response.** `POST /upload` returns `202 {jobId}` as soon as the bytes are safely in storage; all parsing happens in the worker.
- **Resumable imports.** Rows are written in 1000-row chunks, and each chunk's `bulkWrite` and its checkpoint commit inside **one MongoDB transaction** — so the checkpoint can never be ahead of the data. A restarted worker resumes at `lastCommittedChunk + 1`.
- **Idempotent writes.** Every row upserts on a unique index (`{importId, row}`), so redelivering the same message — or resuming the same job four times — converges on the same collection state.
- **Bad rows never kill the file.** Malformed records and validation failures are recorded per row and skipped; the job still finishes `done` with `rowsOk` / `rowsFailed` counters.
- **Streamed error report.** `GET /file/:id/errors.csv` streams one line per rejected row, with the row number, the reason, and the raw record.
- **Retries and a dead-letter stream.** Failures are classified transient or permanent; permanent ones dead-letter immediately, transient ones are retried by the reaper and dead-letter at 5 deliveries.
- **Graceful shutdown.** `SIGTERM` releases the in-flight job at row granularity without acking it, exits 0 in under a second, and another worker finishes the import from the last checkpoint.

## Architecture

```mermaid
flowchart LR
    client([Client]) -->|"POST /upload"| web

    subgraph compose["docker compose"]
        web["web<br/>Express 5"]
        worker["worker<br/>Node process"]
        minio[("MinIO<br/>object storage")]
        redis[("Redis 8<br/>Streams")]
        mongo[("MongoDB 7<br/>replica set rs0")]
    end

    web -->|"pipe file bytes"| minio
    web -->|"Job document"| mongo
    web -->|"XADD jobId"| redis

    redis -->|"XREADGROUP / XAUTOCLAIM"| worker
    worker -->|"GetObject stream"| minio
    worker -->|"chunk + checkpoint<br/>in one transaction"| mongo
    worker -->|"XACK when done"| redis
    worker -.->|"XADD after 5 deliveries"| dead[("dead stream")]

    client -->|"GET /file/:id"| web
    client -->|"GET /file/:id/errors.csv"| web
    web -->|"cursor stream"| mongo
```

The queue carries **only the job id** — never the file contents. Everything the worker needs it reads from the `Job` document and from object storage.

Three modules own their boundary and nothing else in the repo crosses it: `storage.js` is the only file that knows S3 exists, `queue.js` is the only file that issues Redis commands, and `connectDB.js` owns the Mongo connection. Swapping MinIO for Cloudflare R2, or local Redis for Upstash, is a one-file change.

### The import loop

```
claim job (pending → processing)      atomic, in the query filter — two workers cannot both win
  ↓
GetObject → csv-parse (streaming)
  ↓
per row: zod safeParse
  ├─ pass → result_pass[]  ──┐
  └─ fail → result_fail[]  ──┤
                             │  at 1000 rows:
                             ├─ bulkWrite upserts + lastCommittedChunk  ← one transaction
                             └─ error rows upserted into rowerrors
  ↓
transition → done (counters written with the status)
  ↓
XACK        ← last, so a crash in between can always be redelivered
```

## Quick start

Requires Docker and Docker Compose.

```bash
git clone git@github.com:SupeeerMario/bulk-data-import-pipeline.git
cd bulk-data-import-pipeline
# create a .env at the repo root — keys are listed under Configuration
openssl rand -base64 756 > mongo-keyfile && chmod 400 mongo-keyfile && sudo chown 999:999 mongo-keyfile
docker compose up -d --build
docker compose exec mongodb mongosh -u "$DB_USERNAME" -p "$DB_PASSWORD" \
  --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"mongodb:27017"}]})'
```

| Service | URL |
| --- | --- |
| API | http://localhost:3000 |
| mongo-express | http://localhost:8081 |
| MinIO console | http://localhost:9001 |

MongoDB runs as a **single-node replica set**, which is what makes multi-document transactions available — the chunk write and its checkpoint depend on it. The keyfile and `rs.initiate()` are the two one-time steps a fresh clone needs.

```bash
docker compose logs -f worker      # follow the import
docker compose exec mongodb mongosh    # inspect the data
docker compose down                # keeps the volumes
```

## Configuration

All configuration comes from a `.env` file at the repo root, which Docker Compose reads for `${...}` interpolation.

| Key | Example | Notes |
| --- | --- | --- |
| `SERVER_PORT` | `3000` | Port Express binds |
| `DB_USERNAME` | `root` | MongoDB root user |
| `DB_PASSWORD` | `changeme` | |
| `MONGODB_URI` | `mongodb://root:changeme@mongodb:27017/files?authSource=admin&replicaSet=rs0` | Written literally — dotenv does not expand `${...}`. `replicaSet=rs0` is required or the driver treats the server as standalone |
| `MINIO_ROOT_USER` | `minioadmin` | Also the S3 access key id |
| `MINIO_ROOT_PASSWORD` | `minioadmin` | Also the S3 secret access key |
| `REDIS_HOST` | `redis` | Service name on the Compose network |
| `CONSUMER_NAME` | `worker1` | Redis Streams consumer identity — **stable across restarts, unique per live worker.** A restarted worker recovers its own unfinished message by this name |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Multipart upload. Returns `202 {jobId}` |
| `GET` | `/file/:id` | Job status and counters |
| `GET` | `/file/:id/errors.csv` | Streamed CSV of every rejected row |
| `GET` | `/health` | Liveness for the container healthcheck |

**Upload.** `.csv` and `.xlsx` are accepted, capped at 50MB. The bytes go straight to object storage as `upload/<jobId>.<ext>`, so every object in the bucket names its own job.

```bash
curl -F 'file=@customers.csv' http://localhost:3000/upload
# {"jobId":"6aa10383e5e2c3702ff1c0b1"}
```

**Status.**

```bash
curl http://localhost:3000/file/6aa10383e5e2c3702ff1c0b1
# {"filename":"customers.csv","status":"done",
#  "totalRows":500000,"rowsOk":499997,"rowsFailed":3}
```

Status moves `pending → processing → done`, or `dead_lettered` when a job exhausts its retries, with the last error on the document.

**Error report.** Served with `Transfer-Encoding: chunked` and no `Content-Length` — the server starts sending before it knows the size, because the rows are streamed from a Mongo cursor rather than collected first.

```
row,reason,raw
8,CSV_RECORD_INCONSISTENT_COLUMNS,"[""7"",""User"","" 7"",""user7@example.com"",""CA""]"
24,email: Invalid email address,"{""name"":""User 23"",""email"":""not-an-email"",""country"":""CA""}"
36,name: Too small: expected string to have >=1 characters,...
```

Row numbers are **file line numbers** — the number the user sees in their spreadsheet — so both the parser skips and the validation failures point at the same line.

**Error responses** are always an object, never a stack trace: `400 {"error":"Invalid file id"}`, `400 {"error":"Wrong file format"}`, `404 {"error":"File is not found"}`, `413 {"error":"File is bigger than the cap"}`.

## The kill-the-worker proof

This is the point of the project. A 500,000-row import is killed at ~50%, a second worker picks it up, and the final collection is exact.

```
11:14:02  upload 500k rows, delivered to worker1
11:14:52  docker kill worker1  (SIGKILL, never restarted)
          lastCommittedChunk 241 | rowsOk 241000
          documents written by this job: 241000     ← exact match
~11:17:2x worker2 reaps the stranded entry after the 200s idle window
11:18:31  done | rowsOk 500000 | totalRows 500000 | lastCommittedChunk 500
          db.contents.countDocuments() → 500000     XPENDING → 0
```

**Rows written equalling `lastCommittedChunk × 1000` at the instant of the kill is the atomicity evidence** — the checkpoint was never ahead of its data, and no chunk was half written. That is what the transaction buys.

The same file killed with `SIGTERM` instead exits deliberately:

```
run 1   docker stop at 90,000 rows     0.53s, exit 0
        SIGTERM: releasing job 6aa8f7cf… at chunk 90 — not acked
        job processing | chunk 90 | rowsOk 90000 | documents 90000
        restart → drains its own PEL → resumes at chunk 91
        done | totalRows 500000 | rowsOk 499997 | rowsFailed 3
```

Releasing a message means *not* acking it: the entry stays in Redis's pending-entries list and comes back to whoever claims it next.

**Redelivery changes nothing.** A file whose rows already exist was delivered four times — the stream entry's delivery count went 1 → 2 → 3 → 4 across repeated kills — and the document count never moved:

```
contents 500000 before, 500000 after      rowsOk 200000, rowsFailed 0
```

**Retries and the dead stream.** With object storage stopped, the same job failed transiently five times at 200-second intervals and then left the queue instead of blocking it:

```
11:40:55  consume → transient, delivery 1
11:44:1x  reap → 2      11:47:39  reap → 3
11:51:01  reap → 4      11:54:4x  reap → 5  → dead-lettered

dead stream   jobId 6aa904922d444cc587d00dce
              reason getaddrinfo EAI_AGAIN minio
job           dead_lettered      XPENDING 0
```

## How it works

**At-least-once delivery, idempotent consumer.** Redis Streams consumer groups hand a message out and keep it in a pending-entries list until it is acked. Every step is built around that: the ack is the **last** line of a successful job, the claim is a single atomic `updateOne` with the precondition in the query filter (not an `if`, which is a race), and every write is an upsert on a unique index — so re-running a chunk rewrites the same documents rather than duplicating them.

**Recovery has one owner.** A restarted worker drains its own pending entries by consumer name; anything a *dead* worker was holding is picked up by `XAUTOCLAIM` from the idle branch of the consume loop, after a 200-second minimum idle time. One mechanism, so two processes can never both decide a job is free.

**Failures are classified.** Mongo's own `TransientTransactionError` label, socket errors (`ECONNREFUSED`, `EAI_AGAIN`, …) and timeouts are transient and retried; missing objects, credential errors and programming errors are permanent and dead-letter on the first failure. Retrying a permanent failure forever is head-of-line blocking, which is exactly what the dead stream exists to break.

**Backpressure comes from the loop shape.** The worker reads rows with `for await`, so the next row is not pulled until the current chunk's awaited write finishes — the parser throttles itself against MongoDB, all the way back to the download socket, with no manual `pause()`/`resume()`. The flat RSS across a 30MB file is the evidence.

## Tech stack

| Piece | Choice | Why |
| --- | --- | --- |
| Runtime | Node 22 (CommonJS), Alpine | |
| API | Express 5 | Async errors forward to the error middleware automatically |
| Database | MongoDB 7 + Mongoose, replica set `rs0` | Transactions require a replica set |
| Queue | Redis Streams + consumer groups (`ioredis`) | At-least-once with an inspectable pending list; ack, redelivery and dead-lettering written by hand |
| Object storage | MinIO locally, Cloudflare R2 in production (`@aws-sdk/client-s3`) | Same S3 API behind one module |
| Upload | `busboy` + `@aws-sdk/lib-storage` `Upload` | Multipart streaming with no known content length, so nothing is buffered |
| Parsing | `csv-parse` (streaming), `exceljs` `WorkbookReader` for xlsx | |
| Validation | `zod`, one `safeParse` per row | |

## Generating test files

```bash
node generate-file.js 500000 ./test-500k.csv            # clean file
node generate-file.js 100 ./broken.csv --broken         # plants known defects at fixed rows
node generate-file.js 500000 ./test-500k.xlsx           # writer picked from the extension
```

Rows derive from the index rather than from randomness, so the same command always produces the same file and expected counts never drift between runs. `--broken` plants its defects — an unquoted comma, an invalid email, an empty name — at fixed line numbers, which is what makes the error report checkable against a known answer.

Measured on this machine:

```
500k csv    1.6s    maxRSS  82MB    30.2MB out
500k xlsx   3.9s    maxRSS 208MB     9.0MB out
```
