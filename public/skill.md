---
name: wasmer-daily-ai-site
description: Build and deploy a fully autonomous AI-generated daily-content website on Wasmer Edge, end to end — Node/npm app, managed Postgres, S3-backed volume as a zero-redeploy CMS, and an OpenAI agent run by a daily execute cronjob directly on Edge (no HTTP trigger, no auth). Use when asked to create a "daily quotes machine", scheduled AI content generator, or agent-produced website, or when debugging that stack (pg TLS errors, secrets not applying, volume lag, exec job setup).
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
- **Recommend scoped, short-lived credentials**, revoked at handover, and a
  spend limit on the OpenAI key.

## Architecture

```
┌──────────────────┐  cron 0 0 * * *  ┌───────────────────────┐
│ execute cronjob  │ ───────────────▶ │  agent runs ON EDGE   │
│ (app.yaml —      │  command: start  │  scout: web search    │
│  config-sourced) │  cli_args: [...] │  gpt-image-1 render   │
└──────────────────┘                  └───────────┬───────────┘
                                                  │ png + manifest
                                                  ▼
┌──────────────┐                      ┌───────────────────────┐
│   browser    │ ◀─── serves live ─── │  volume /data/content │
│              │                      │  s3-backed, mounted   │
└──────┬───────┘                      └───────────────────────┘
       │  /api/visit
       ▼
┌──────────────┐
│   postgres   │  visit counters
│  (managed)   │
└──────────────┘
```

The cronjob does not go through HTTP at all: the `execute` action starts an
instance of the app package on Edge and runs the agent script directly. That
instance gets the app's volumes AND all app secrets as env vars (verified
empirically) — so there is no trigger endpoint, no auth token, and nothing
secret in the job definition. It can live in app.yaml, versioned.

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
`DB_*` env vars on deploy), a volume mounted somewhere like `/data/content`,
and the daily execute job (see cron section). Nothing in it is secret.

**server** — express (or anything): static frontend, the volume dir served
statically, and a visit-counter endpoint backed by pg. No trigger endpoint —
generation is not reachable over HTTP at all. pg pool MUST set
`ssl: { rejectUnauthorized: false }` — the managed Postgres refuses non-TLS.
Reference: `server/`.

**agent** — OpenAI Agents SDK scout with `webSearchTool()` and a zod
`outputType`, then `gpt-image-1` for rendering; write image + appended
manifest straight to the volume dir. Give it a small unconditional entry
script (`agent/run.js`: import, run, `process.exit`) — that is what the
cronjob executes. Quality rules learned the hard way: randomize creative
seeds (mood, subject, art style, text placement) per run — a fixed prompt
converges on near-identical output within days; pass recent history with an
explicit "do not repeat"; tell the image model the text must be spelled
exactly, fully readable, uncropped. Reference: `agent/`.

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

# 3. secrets — human runs this (env-var reference, never a literal).
#    Values as ARGUMENTS: piping stores the literal "/dev/stdin" as the value!
wasmer app secret create OPENAI_API_KEY "$OPENAI_API_KEY" --app <owner>/<app>

# 4. migrate (app-db creds, not personal secrets — handle, don't print)
export PGHOST=$(wasmer app secret reveal DB_HOST --app <owner>/<app>)   # etc.
PGSSLMODE=require psql -v ON_ERROR_STOP=1 -f db/migrations/0001_init.sql

# 5. redeploy — secrets only reach the app on the NEXT deploy
wasmer deploy --owner <owner> --non-interactive --build-remote
```

`git push` only becomes the deploy AFTER the repo is linked to the app —
import it at [wasmer.io/new](https://wasmer.io/new) or connect it from the
app dashboard. Until then, pushing does nothing to the app; keep using
`wasmer deploy`.

## The daily cron job (execute on Edge — the preferred pattern)

Use an **execute** job, not a fetch job. It starts an instance of the app
package on Edge and runs a command directly — with the app's volumes mounted
and ALL app secrets present as env vars (verified empirically). No endpoint,
no auth token, nothing secret in the job definition, so it belongs in
app.yaml — config-sourced and versioned:

```yaml
jobs:
  - name: daily-generation
    trigger: '0 0 * * *'
    action:
      execute:
        command: start        # the workload command (the only one anybuild maps)
        cli_args:
          - agent/run.js      # replaces the script the JS runtime executes
```

Why `command: start` + `cli_args`: autobuild Node apps run on the edgejs
runtime with the start script as its argument, and the job's `cli_args`
REPLACE that argument (verified live) — so the same runtime executes your
agent entry script instead of the server. A dedicated `agent` package command
would be cleaner, but anybuild currently maps only the `start` script; extra
entries in the commands config are silently ignored.

Facts that will save you debugging time (all verified live):

- **Jobs propagate on deploy, not on creation.** An API-created job sits
  inert until the next deploy — exactly like secrets. Deploy after wiring.
- **Timeout is currently broken for config execute jobs**: `timeout:` in the
  yaml (either placement) is ignored; the job gets the 180s default. A
  generation run takes ~2 minutes, which usually fits — but if runs start
  being killed, recreate the job API-sourced via the `createCronJob` GraphQL
  mutation (`https://registry.wasmer.io/graphql`), which honors
  `timeout: "5m"`. API-sourced jobs are editable via `updateCronJob`;
  config-sourced ones are not ("edit the app config instead").
- **Sources**: `CONFIG` (app.yaml) vs `API` (GraphQL/dashboard). Never define
  the same job in both — it runs twice.
- **Diagnostics are free**: autobuild packages bundle `wasmer/bash` + uutils
  coreutils, so a temporary fast-schedule job with `command: bash,
  cli_args: ["-c", "env | cut -d= -f1; ls /data/content"]` answers "what does
  the exec context contain" without spending anything. (uutils quirks:
  `sort`/`tr` differ or are missing — keep pipelines minimal, print env
  NAMES, never values.)
- **Readback**: status, duration, error, and full stdout of every run are
  queryable: `node(id: "cron_...") { ... on CronJob { invocations(first: 5)
  { nodes { status durationMs errorSummary logs(first: 50) { edges { node {
  message } } } } } } }`.
- Fetch jobs (HTTP + auth headers) remain the right tool for pinging
  *external* systems — but for running your own code, execute is strictly
  simpler and needs no auth story at all.

## Verify end to end (do not skip)

```bash
BASE=https://<app>.wasmer.app        # or the custom domain
curl -s $BASE/api/visit              # ok:true, total increments by exactly 1
curl -s $BASE/content/manifest.json  # (retry ~10s after a run: volume lag)
```

To verify generation without waiting for midnight: create a temporary
API-sourced copy of the execute job on a `*/5 * * * *` schedule, deploy to
propagate it, watch its invocation logs until one reports SUCCESS and the
manifest gains an entry, then `deleteCronJob` it and deploy again. Success =
the site shows the generated entry with no redeploy in between.

## Gotchas (each cost real debugging time)

- **pg TLS**: forget `ssl` and every query fails with
  `no pg_hba.conf entry ... no encryption`. `PGSSLMODE=require` for psql.
- **Secrets timing**: created/updated secrets apply on the _next_ deploy only.
- **Secret values as arguments**: piping into `secret create` stores the
  literal pipe path.
- **Job propagation, sources, and the execute-timeout bug**: see the cron
  section above — these three bite hardest.
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
- [ ] execute cronjob in app.yaml, and one observed SUCCESS invocation with a
      new entry written to the volume (via the temporary fast-schedule copy)
- [ ] generated entry visible on the site without a redeploy
- [ ] no secret value ever appeared in the conversation, your output, or git
- [ ] human told: URL, how to run the agent manually, where secrets live, and
      to revoke or scope down the Wasmer token now that setup is done
