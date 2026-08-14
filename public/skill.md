---
name: wasmer-daily-ai-site
description: Build and deploy a fully autonomous AI-generated daily-content website on Wasmer Edge, end to end — Node/npm app, managed Postgres, S3-backed volume as a zero-redeploy CMS, daily cron job with auth, and an in-process OpenAI agent. Use when asked to create a "daily quotes machine", scheduled AI content generator, or agent-produced website, or when debugging that stack (pg TLS errors, secrets not applying, volume lag, job auth).
---

# Build an autonomous daily AI content site on Wasmer Edge

You (the agent reading this) can execute this entire flow autonomously. It
produces a website that generates and publishes its own themed content once
per day with no human in the loop.

Reference deployment: [trash.delivery](https://trash.delivery). Reference
source (working code for every file described below):
[github.com/baalimago/motivational-racoon-and-friends](https://github.com/baalimago/motivational-racoon-and-friends).
Read the reference for implementation detail; this skill gives you the
architecture, the sequence, and the traps. Details drift — when this file and
the reference repo disagree, trust the repo; when the repo and the live
platform disagree, trust what you observe.

## What you need from your human

1. A Wasmer account, authenticated via `wasmer login` (see credential rules —
   you never need to see the token itself)
2. An OpenAI API key, available as `$OPENAI_API_KEY` in their shell (same
   rules: you reference it, you never read it)
3. A theme: subject matter and an aesthetic direction. Everything else is
   yours to decide.

Tools required locally: `wasmer` CLI, `psql`, `curl`, `node` >= 20.

## Credential rules (read before anything else)

You are the safety layer. Most users should never paste an API key into a
chat with an agent — conversation logs persist and outlive the session.

- **Never ask the user to paste a token or key into the conversation.** If
  they try, stop them and give them the safe alternative.
- **Wasmer auth**: the human runs `wasmer login` in their own terminal
  (browser flow; the CLI stores the token, you never see it). Headless
  fallback: they export `WASMER_TOKEN` themselves; you reference
  `"$WASMER_TOKEN"` without ever printing it.
- **OpenAI key**: the human exports `OPENAI_API_KEY` or runs the
  `wasmer app secret create` command themselves. You print commands with
  env-var references, never literals; never `echo` a secret to check it.
- **Never echo, log, or commit secret values.** `.gitignore` any `.env` or
  token files before anything else. If a secret leaks into your output or a
  commit, say so immediately and instruct rotation.
- The `TRIGGER_TOKEN` you generate yourself (below) is yours to handle — but
  the same no-echo, no-commit rules apply.
- **Recommend scoped, short-lived credentials**, revoked at handover, and a
  spend limit on the OpenAI key.

## Architecture

```
┌──────────────┐   cron 0 0 * * *    ┌───────────────────────┐
│ cronjob      │ ────── api key ──▶  │  POST /api/trigger    │
│ (API-sourced)│                     │  express (node.js)    │
└──────────────┘                     └───────────┬───────────┘
                                                 │ in-process
                                                 ▼
                                     ┌───────────────────────┐
                                     │  openai agents sdk    │
                                     │  scout: web search    │
                                     │  gpt-image-1 render   │
                                     └───────────┬───────────┘
                                                 │ png + manifest
                                                 ▼
┌──────────────┐                     ┌───────────────────────┐
│   browser    │ ◀─── serves live ── │  volume /data/content │
│              │                     │  s3-backed, mounted   │
└──────┬───────┘                     └───────────────────────┘
       │  /api/visit
       ▼
┌──────────────┐
│   postgres   │  visit counters
│  (managed)   │
└──────────────┘
```

The load-bearing idea: **the volume is the CMS**. The agent writes an image
and a JSON manifest to the mounted volume; the server serves that directory
statically; the frontend merges the volume manifest with a seed manifest
shipped in the package. New content appears with zero redeploys.

## Component guidelines

Docs: [app configuration](https://docs.wasmer.io/edge/configuration/) ·
[jobs](https://docs.wasmer.io/edge/configuration/jobs/) ·
[volumes](https://docs.wasmer.io/edge/learn/volumes) ·
[OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)

**npm project** — plain `package.json` with a `start` script binding
`process.env.PORT`. No Dockerfile, no wasmer.toml; Wasmer auto-detects Node
and builds remotely. Reference: `package.json`, `server/index.js`.

**app.yaml** — declare `capabilities.database.engine: postgres` (injects
`DB_*` env vars on deploy) and a volume mounted somewhere like
`/data/content`. **Do not declare the daily job here** — see cron section:
config-sourced jobs can't carry an auth header without committing the token.

**server** — express (or anything): static frontend, the volume dir served
statically, a visit-counter endpoint backed by pg, and the trigger endpoint.
The trigger must fail closed (503 if `TRIGGER_TOKEN` unset, 401 on bad
`Authorization: Bearer` / `X-Api-Key`) and hold a single-flight lock so
overlapping triggers can't double-generate. pg pool MUST set
`ssl: { rejectUnauthorized: false }` — the managed Postgres refuses non-TLS.
Reference: `server/`.

**agent** — OpenAI Agents SDK scout with `webSearchTool()` and a zod
`outputType`, then `gpt-image-1` for rendering; write image + appended
manifest straight to the volume dir. Quality rules learned the hard way:
randomize creative seeds (mood, subject, art style, text placement) per run —
a fixed prompt converges on near-identical output within days; pass recent
history with an explicit "do not repeat"; tell the image model the text must
be spelled exactly, fully readable, uncropped. Reference: `agent/daily-agent.js`.

**frontend** — design it yourself to the human's aesthetic. Mechanics: merge
seed + volume manifests (dedupe by id); deterministic daily pick,
`entries[(epochDay * 2654435761 >>> 0) % entries.length]`, so everyone sees
the same entry all day; if an API fails, render something visibly broken
(`???????`) — never a plausible fake, which masks real outages. Optional:
hash deep-links, a gallery, view-count ranking. Reference: `public/`.

**migrations** — idempotent SQL (`CREATE TABLE IF NOT EXISTS`), applied with
psql over TLS using the same credentials the app gets (revealable via
`wasmer app secret reveal DB_HOST ...`). Reference: `db/migrations/`.

## Deployment sequence

```bash
# 1. auth — HUMAN runs this (browser flow). Dev machines may default to the
#    wasmer.wtf registry; be explicit:
wasmer login --registry https://registry.wasmer.io/graphql
wasmer whoami --registry https://registry.wasmer.io/graphql   # must show the user

# 2. first deploy (remote build)
wasmer deploy --owner <owner> --non-interactive --build-remote

# 3. secrets — human runs the first (env-var reference, never a literal).
#    Values as ARGUMENTS: piping stores the literal "/dev/stdin" as the value!
wasmer app secret create OPENAI_API_KEY "$OPENAI_API_KEY" --app <owner>/<app>
wasmer app secret create TRIGGER_TOKEN "$(openssl rand -hex 24)" --app <owner>/<app>

# 4. migrate (app-db creds, not personal secrets — handle, don't print)
export PGHOST=$(wasmer app secret reveal DB_HOST --app <owner>/<app>)   # etc.
PGSSLMODE=require psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql

# 5. redeploy — secrets only reach the app on the NEXT deploy
wasmer deploy --owner <owner> --non-interactive --build-remote
```

If the human connects the GitHub repo to the app, `git push` becomes the
deploy from then on.

## The daily cron job (auth done right)

Wasmer cron jobs have a **source**: `CONFIG` (defined in app.yaml) or `API`
(created via GraphQL/dashboard). Two facts drive the design (verified against
the backend and live):

1. Config-sourced jobs cannot be edited via the API — the backend rejects
   with "config-sourced cronjobs cannot be edited via the API; edit the app
   config instead".
2. A config-sourced job's headers live in app.yaml — i.e. in the repo. In a
   public repo that publishes your trigger token.

So: **keep the job out of app.yaml** and create it API-sourced with the
header attached. Two ways:

**Dashboard (guide the human)**: app page → Jobs → create a job with the
trigger path, `POST`, schedule, generous timeout (5m+ — generation takes
minutes), and a header `X-Api-Key: <the TRIGGER_TOKEN value>` (the human can
read it with `wasmer app secret reveal TRIGGER_TOKEN --app <owner>/<app>`).

**GraphQL (do it yourself)** — you generated `TRIGGER_TOKEN`, so you may
wire it without ever printing it. Endpoint `https://registry.wasmer.io/graphql`,
authenticated with the CLI's stored token:

```graphql
mutation ($i: CreateCronJobInput!) {
  createCronJob(input: $i) {
    cronJob {
      id
      source
    }
  }
}
# variables: { "i": {
#   "appId": "<da_... from `wasmer app get`>",
#   "name": "daily-generation", "schedule": "0 0 * * *", "timeout": "5m",
#   "fetch": { "path": "/api/trigger", "method": "POST",
#              "headers": { "X-Api-Key": "<TRIGGER_TOKEN>" },
#              "expectStatusCodes": [200] } } }
```

`updateCronJob` edits it later (same `fetch` shape; providing `fetch`
replaces the whole target, so always re-send path/method/headers/expect).
Note: this API is currently undocumented — the official jobs docs only cover
app.yaml. Verify behavior empirically after wiring.

## Verify end to end (all externally observable — do not skip)

```bash
BASE=https://<app>.wasmer.app        # or the custom domain
curl -s $BASE/api/visit              # ok:true, total increments by exactly 1
curl -s -o /dev/null -w '%{http_code}\n' -X POST $BASE/api/trigger   # 401
curl -s -X POST -H "X-Api-Key: $(wasmer app secret reveal TRIGGER_TOKEN --app <owner>/<app>)" \
  $BASE/api/trigger                  # generates an entry
curl -s $BASE/content/manifest.json  # entry present (retry ~10s: volume lag)
```

Success = the site shows the generated entry with no redeploy.

## Gotchas (each cost real debugging time)

- **pg TLS**: forget `ssl` and every query fails with
  `no pg_hba.conf entry ... no encryption`. `PGSSLMODE=require` for psql.
- **Secrets timing**: created/updated secrets apply on the _next_ deploy only.
- **Secret values as arguments**: piping into `secret create` stores the
  literal pipe path.
- **Job source**: config-sourced jobs are API-immutable; API-sourced jobs are
  invisible to app.yaml. Don't define the same job in both places — it will
  run twice.
- **Job timeout**: the 180s default kills multi-minute agent runs. Set 5m+.
- **Volume propagation**: other instances may serve stale files for ~10s
  after a write. Retry before diagnosing.
- **App rename**: `wasmer deploy` rejects a changed name; GraphQL `renameApp`
  renames in place but the `*.wasmer.app` alias does not follow. Pick the
  name once, or attach a custom domain and stop caring. If the app is renamed
  in the dashboard, update `name:` in app.yaml to match or deploys fail with
  "App name does not match the given app ID".
- **Prompt convergence & image text**: see agent guidelines above.

## Definition of done

- [ ] site serves at its URL with the human's aesthetic
- [ ] visit counter backed by real Postgres rows
- [ ] unauthenticated trigger → 401; authenticated → new entry on the volume
- [ ] API-sourced cron job exists with the auth header (verify by querying it
      back, redacting the header value if you print anything)
- [ ] generated entry visible on the site without a redeploy
- [ ] no secret value ever appeared in the conversation, your output, or git
- [ ] human told: URL, how to trigger manually, where secrets live, and to
      revoke or scope down the Wasmer token now that setup is done
