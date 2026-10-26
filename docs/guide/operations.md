# Deploying and running the server

This page is for the owner, who runs the server. It explains how a change gets from a pull request to the live server, and how to check, restart, roll back, back up and restore it. Each section links to the runbook with the exact commands.

## How it fits together

Loomcast's server runs on a Linux server with Docker Compose: the api (which also serves the web app), a Postgres database and a nightly backup service. Videos and other media live in object storage. Rendering does not happen on the server; it happens on your Mac through the [studio agent](studio-agent.md).

The server only ever runs container images built by GitHub Actions from the `main` branch. Nobody builds or copies code on the server by hand.

## From a change to the live server

### 1. Pull requests

All changes go through pull requests:

1. Work happens on a branch named `feature/<short-description>` or `bugfix/<short-description>`, created from `main`. Nobody commits to `main` directly.
2. Before opening the pull request, lint and tests run on the workstation (`pnpm -r lint` and `pnpm -r test`).
3. On the pull request, GitHub runs quick checks: the title and every commit message must follow the Conventional Commits format, and changes to infrastructure or workflow files are linted.
4. The pull request is merged with **squash merge**, so `main` gets one commit per change.

The full build does not run on pull requests. It runs once, after the merge.

### 2. After the merge: ci, release, deploy

| Workflow | Runs when | What it does |
|---|---|---|
| `ci` | After a push to `main` (not for Markdown-only changes), weekly, or by hand | Audits dependencies, lints, type-checks, tests and builds |
| `release` | After `ci` passes on `main` | Builds the container images, tagged `sha-` plus the first 12 characters of the commit, and pushes them to the registry |
| `deploy` | After `release` succeeds, or by hand with a tag | Waits for your approval, then deploys that release |
| `e2e` | Only by hand | The end-to-end smoke test in a clean environment |
| `uptime` | Every 10 minutes, once switched on | Checks the server from outside and opens an `incident` issue while it is down |

### 3. Approving a deploy

The `deploy` run waits in the GitHub `production` environment until you approve it:

1. Open **Actions** on GitHub (or the notification) and find the `deploy` run marked **Waiting for review**.
2. Review and approve it.
3. The server pulls the new images and restarts the stack with Docker Compose, then checks that it is ready.
   - Ready within 60 seconds: the release is recorded as current.
   - Not ready: the server starts the previous release again by itself, and the run fails with the reason in its log.
4. The workflow then checks the server from outside.

A newer run waiting for approval replaces an older one that has not started. A running deploy is never cancelled.

Database migrations run when the api starts. They are not undone by a rollback, so they are written to stay compatible with the release before them.

The end-to-end smoke test does not run automatically. Start it from **Actions → e2e → Run workflow** before a release that changes the main user flows, or run `pnpm test:e2e` on your workstation.

Details: [Deploy and rollback runbook](../runbooks/deploy.md).

## Checking that it works

| Check | Where | Healthy answer |
|---|---|---|
| Readiness | `https://loomcast.example.com/readyz` | `{"status":"ok","checks":{"database":"ok","storage":"ok","scheduler":"ok"}}` |
| Ops status | `https://loomcast.example.com/api/ops/status`, in a browser where you are signed in as the owner | The version and commit, readiness details, scheduler, last backup and alert settings |
| Deploy status | On the server: the deploy script's `status` command | The current and previous release, containers and readiness |
| Uptime | GitHub issues labelled `incident` | None open |

A `503` from `/readyz` names the failing check: `database` (Postgres down or busy), `storage` (object storage unreachable or its key refused) or `scheduler` (the task loop stalled, usually because of the database). The ops status gives the detail.

Alerts (failed or dead publishing tasks, channels that need reconnecting, stale backups) are sent to the webhook you configured, at most once an hour per alert.

Details: [Monitoring, logs and alerting](../runbooks/monitoring.md).

## Reading logs

On the server, the logs of each container are read with Docker Compose, scoped to the Loomcast Compose project:

```bash
docker compose -p loomcast ps                       # state and health of each container
docker compose -p loomcast logs --since 1h api      # the last hour of the api
docker compose -p loomcast logs -f --tail=100 api   # follow the api
docker compose -p loomcast logs --since 24h backup  # the nightly backup
```

The api writes one JSON line per event; credentials and keys are redacted before a line is written. Container logs are capped in size and are lost when a container is recreated, so copy what you need before redeploying during an incident.

The studio agent's log is on the Mac, not the server: see [Troubleshooting](troubleshooting.md#first-checks).

## Restarting and rolling back

- **Restart with the same release:** in **Actions → deploy → Run workflow**, enter the current release tag and approve. This runs the same checks and automatic rollback as any deploy. The [owner runbook](../runbooks/owner-runbook.md#conventions) also shows how to recreate just the api on the server, for example after editing its settings.
- **Roll back (preferred):** in **Actions → deploy → Run workflow** on `main`, enter the tag of the release to go back to (`sha-` plus 12 characters of that commit) and approve.
- **Roll back without GitHub:** on the server, the deploy script's `rollback` command returns to the previous release, and `deploy sha-<tag>` goes to any release.

If an older release cannot read data written by a newer one, restore the database instead of rolling back.

Details: [Deploy and rollback runbook](../runbooks/deploy.md#4-rolling-back-by-hand) and [owner runbook](../runbooks/owner-runbook.md#1-deploy-and-roll-back).

## Pausing publishing

Two switches stop posts going out, without a deploy:

- **One channel:** in the channel's workspace, **Workspace settings → Channels**, turn the channel's **Dry run** on. Its posts record what they would send instead.
- **Everything:** set the publishing settings in the server's api configuration (pause publishing, or switch the whole server to dry-run), then recreate the api.

Pause publishing before restoring an older backup and as the first step of any incident involving a channel.

Details: [owner runbook, sections 2 and 3](../runbooks/owner-runbook.md#2-pause-publishing).

## Backups and restore

- **Every night**, the backup service dumps the database, checks the dump and keeps rotated copies on the server (14 daily and 8 weekly by default).
- **Off-site**, an encrypted copy goes to a private storage bucket and is kept for 90 days.
- A failed backup writes a failure file and sends an alert. The ops status shows the last successful backup and raises an alert when it is older than 26 hours.
- **Restores** always go into a new database first, and never overwrite an existing one by accident. Restoring into production is a separate, deliberate step: stop the api, restore, start it again and check.
- **Drill:** once a month, restore the latest backup into a scratch database to prove it works.

Details: [Backup, restore and drill](../runbooks/backup-and-restore.md).

## Server configuration and secrets

The server's settings live in env files in a private folder on the server, readable only by root. There is one file for the api, one for the database, one for backups and one for Docker Compose itself. Templates with every setting, but no values, are in `infra/compose/env/` in the repository.

- Secrets (database password, storage keys, platform app secrets, the encryption key for stored channel sign-ins, the alert webhook) go only into those env files, the GitHub `production` environment and your password manager. They are never committed to the repository, which is public.
- Edit env files with an editor on the server, not with commands that leave values in shell history. After editing the api's file, recreate the api so it reads the new values.
- Server addresses, SSH details and keys never go into the repository or its docs.

How to rotate each secret is in the [owner runbook](../runbooks/owner-runbook.md#8-rotating-secrets).

## When something goes wrong

| Situation | Go to |
|---|---|
| A deploy failed or rolled back | [Deploy runbook, troubleshooting](../runbooks/deploy.md#7-troubleshooting) |
| `/readyz` is red, or no alerts arrive | [Monitoring, troubleshooting](../runbooks/monitoring.md#troubleshooting) |
| The disk is full | [Owner runbook, disk full](../runbooks/owner-runbook.md#6-disk-full) |
| A channel needs reconnecting | [Owner runbook, reconnect a channel](../runbooks/owner-runbook.md#4-reconnect-a-channel-meta-or-threads-reauthorisation) |
| A Mac was lost or stolen | [Owner runbook, a lost or stolen Mac](../runbooks/owner-runbook.md#7-a-lost-or-stolen-mac) |
| Unwanted posts, a leaked key or a suspected break-in | [Incident response](../runbooks/incident-response.md) |

For an incident, write down the time, save the logs before restarting anything, contain the problem with the matching playbook, then tell the people affected. [Incident response](../runbooks/incident-response.md) has the steps and a write-up template.

### Routine checks

- **Daily:** read any alerts.
- **Weekly:** open the ops status (backup age, dead tasks) and check the `ci` audit job.
- **Monthly:** run the backup drill.
- **Quarterly:** review **Account settings → Members**, **Access tokens** and **Devices**, and revoke what is no longer used.
