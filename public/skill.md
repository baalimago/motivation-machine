---
name: wasmer-daily-ai-site
description: Build and deploy a fully autonomous AI-generated daily-content site on Wasmer Edge end to end — Node/npm app, managed Postgres, S3-backed volume as a zero-redeploy CMS, daily cron job, and an in-process OpenAI agent. Use when asked to set up a "daily quotes machine", scheduled AI content generator, agent-produced website, or any Edge app combining database + volume + jobs + secrets, or when debugging that stack (pg TLS errors, secrets not applying, volume lag, job auth).
---

# Wasmer daily AI content site

Build a website on Wasmer Edge that generates and publishes its own content on
a schedule, with no human in the loop. Reference implementation (working,
deployed): [trash.delivery](https://trash.delivery), source at
[github.com/baalimago/motivational-racoon-and-friends](https://github.com/baalimago/motivational-racoon-and-friends).

An agent can execute this entire flow autonomously. The only two inputs that
must be provided up front are a `WASMER_TOKEN` and an `OPENAI_API_KEY`;
everything else (deploy, secrets, migration, verification) is scriptable with
the wasmer CLI, psql, and curl.

## Architecture

```
┌──────────────┐   cron 0 0 * * *    ┌───────────────────────┐
│   edge job   │ ────── api key ──▶  │  POST /api/trigger    │
│  (app.yaml)  │                     │  express (node.js)    │
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
│   browser    │ ◀─── serves live ── │  volume /data/…       │
│  (sparkles)  │                     │  s3-backed, mounted   │
└──────┬───────┘                     └───────────────────────┘
       │  /api/visit   /api/seen/:id   /api/fame
       ▼
┌──────────────┐
│   postgres   │  visits + blessing_views
│  (managed)   │
└──────────────┘
```

Key insight: the volume doubles as a CMS. The agent writes files to the
mounted volume; the server serves that directory statically; the frontend
merges a volume-hosted manifest with a seed manifest shipped in the package.
New content appears with zero redeploys.

## Prerequisites

- `WASMER_TOKEN` (may arrive as a file containing `WASMER_TOKEN=wap_...` —
  parse the assignment, don't use the raw file content)
- `OPENAI_API_KEY`
- CLI: `wasmer`, `psql`, `curl`, `node` >= 20

## Workflow

### 1. Project layout (plain npm, no Dockerfile)

Wasmer Edge auto-detects Node projects. Contract: `package.json` with a
`start` script that binds `process.env.PORT`. Layout:

```
package.json        # "type": "module", start: node server/index.js
server/index.js     # express: static public/, /api/*, volume dir at a route
server/visits.js    # pg pool + counter handlers
server/trigger.js   # auth-gated endpoint that runs the agent in-process
agent/daily-agent.js# OpenAI Agents SDK scout + image generation
public/             # static frontend + seed content manifest
db/migrations/*.sql # idempotent (CREATE TABLE IF NOT EXISTS ...)
app.yaml            # capabilities, volumes, jobs
```

### 2. app.yaml

```yaml
kind: wasmer.io/App.v0
name: <app-name>
package: .
capabilities:
  database:
    engine: postgres          # managed pg; DB_* env vars injected
volumes:
  - name: content
    mount: /data/content      # agent writes here, server serves it
jobs:
  - name: daily-generation
    trigger: '0 0 * * *'
    action:
      fetch:
        path: /api/trigger
        method: POST
        timeout: 5m           # web search + image gen will not fit in 60s
```

### 3. Authenticate and first deploy

```bash
wasmer login --registry https://registry.wasmer.io/graphql "$WASMER_TOKEN"
wasmer whoami --registry https://registry.wasmer.io/graphql   # verify
wasmer deploy --owner <owner> --non-interactive --build-remote
```

- `--build-remote` is required when `package: .` has no wasmer.toml.
- If the team deploys via GitHub integration, `git push` replaces
  `wasmer deploy` after the repo is connected.

### 4. Secrets

```bash
wasmer app secret create OPENAI_API_KEY "$OPENAI_API_KEY" --app <owner>/<app>
wasmer app secret create TRIGGER_TOKEN "$(openssl rand -hex 24)" --app <owner>/<app>
```

- Pass values as ARGUMENTS. Piping to stdin stores the literal string
  (e.g. `/dev/stdin`) as the secret value.
- Secrets only reach the app on the NEXT deploy. Always redeploy after
  creating or updating secrets.
- The trigger endpoint must fail closed: 503 if `TRIGGER_TOKEN` unset,
  401 unless `Authorization: Bearer <t>` or `X-Api-Key: <t>` matches.

### 5. Database

The managed Postgres injects `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`,
`DB_PASSWORD`. Two hard-won facts:

- **The server requires TLS.** node-postgres does not enable it by default;
  without it every query fails with `no pg_hba.conf entry ... no encryption`.
  Use `ssl: { rejectUnauthorized: false }` in the pool config.
- Migrate remotely by revealing the same creds the app uses:

```bash
export PGHOST=$(wasmer app secret reveal DB_HOST --app <owner>/<app>)
# ...same for PGPORT/PGDATABASE/PGUSER/PGPASSWORD, then:
PGSSLMODE=require psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql
```

Keep migrations idempotent so re-running the full directory is always safe.

### 6. The agent

Use the OpenAI Agents SDK (`@openai/agents`) with a zod `outputType` so the
result is structured, plus `webSearchTool()` so it can find real content
before inventing its own. Render images with `openai.images.generate`
(`gpt-image-1`) and write image + updated manifest straight to the volume dir.

Quality lessons that generalize:

- Inject randomized creative seeds (mood, subject candidates, art style, text
  placement, decoration) into the prompt per run — a fixed prompt converges on
  repetitive output within days.
- Pass the recent history from the manifest and instruct "do not repeat".
- Tell the image model the text must be spelled exactly and be fully readable
  and uncropped; otherwise it crops and typos captions.
- Guard the endpoint with a single-flight lock so overlapping triggers don't
  double-generate.

### 7. Verify end to end (all externally observable)

```bash
BASE=https://<your-domain>
curl -s $BASE/api/visit                  # {"ok":true,...} increments by 1 per hit
curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/api/trigger     # 401
curl -s -X POST -H "X-Api-Key: $TRIGGER_TOKEN" $BASE/api/trigger     # generates
curl -s $BASE/content/manifest.json      # new entry present
```

## Edge cases and gotchas

- **Volume propagation lag**: after the agent writes, another instance may
  serve the old file for ~10s. Retry before diagnosing.
- **App rename**: `wasmer deploy` refuses a changed name ("App name does not
  match the given app ID"). The registry GraphQL `renameApp` mutation renames
  in place (keeps volume/db/secrets), but the default `*.wasmer.app` alias
  does NOT follow the rename and `renameAppAlias` silently returns null. The
  old URL keeps serving. Pick the right name on day one — or attach a custom
  domain and stop caring.
- **Registry**: a dev machine may default to `wasmer.wtf`; pass
  `--registry https://registry.wasmer.io/graphql` explicitly for prod.
- **Job fetch timeout**: agent runs (search + image gen) take minutes; the
  default job timeout will kill them. Set `timeout: 5m`.
- **Fail visible, not fake**: if the frontend has a fallback for a failing
  API, make it look broken (`???????`) rather than plausible — a fake number
  masked a dead counter for hours in the reference implementation.
- **`wasmer app secret list`** needs `--app <owner>/<app>`; `wasmer app
  database list <owner>/<app>` shows host/port and an adminer magic-login URL.

## Validate

- `/api/visit` returns `ok:true` and increments by exactly 1 per request.
- Unauthenticated trigger returns 401; authenticated returns a new entry.
- The new entry's image URL serves 200 from the volume route.
- The frontend shows the new content without any redeploy.
