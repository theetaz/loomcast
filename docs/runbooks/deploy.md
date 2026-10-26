# Deploy and rollback

Every commit on `main` that passes `ci` becomes a release image, and each release is deployed to
the production server after the owner approves it. This runbook covers the one-time GitHub
settings (checkpoint **C3**), the first-time server bootstrap (part of **C5**), everyday
deploys, and rolling back by hand.

## Ground rules for the shared host

The server runs other production applications. The deploy path is built so that it cannot touch
them:

- The deploy user is **not** in the `docker` group. Its SSH key runs one forced command, and
  sudo lets it run exactly one script as root, with no arguments.
- That script, `/opt/loomcast/bin/deploy.sh`, accepts only `deploy sha-<hex>`, `rollback` and
  `status`. Every compose command it runs is scoped to `-p loomcast`.
- Clean-up removes only old tags of `ghcr.io/theetaz/loomcast` and
  `ghcr.io/theetaz/loomcast-backup`, keeping the newest five plus the current and previous
  release. It never runs `docker system prune`, `docker image prune` or anything else global.
- The server's address, SSH port, user names of other applications and keys never go into this
  repository. Commands below use placeholders such as `<vps-ipv4>` and `<ssh-port>`.

## How it fits together

```text
push to main
  -> ci (lint, typecheck, test, build)
  -> release: builds ghcr.io/theetaz/loomcast:sha-<12 hex> and
              ghcr.io/theetaz/loomcast-backup:sha-<12 hex> (plus :main), with provenance
  -> deploy:  waits for approval on the `production` environment, then
              ssh <deploy user>@<host> "deploy sha-<12 hex>"
                -> forced command: sudo -n /opt/loomcast/bin/deploy.sh
                     1. pull both images (skipped when already on the server)
                     2. extract /app/infra/compose from the app image into releases/<tag>/
                     3. docker compose -p loomcast ... up -d --wait   (LOOMCAST_TAG=<tag>)
                     4. poll http://127.0.0.1:$LOOMCAST_HTTP_PORT/readyz for 60 s
                     ok   -> record current and previous, clean up old tags
                     fail -> start the previous release again, exit 1
  -> deploy:  checks ${APP_URL}/readyz from outside
```

| Piece | In the repository | On the server or in GitHub |
|---|---|---|
| Release workflow | `.github/workflows/release.yml` | runs after `ci` on `main`; pushes to GHCR |
| Deploy workflow | `.github/workflows/deploy.yml` | `production` environment, its secrets |
| Deploy script | `infra/deploy/deploy.sh` | `/opt/loomcast/bin/deploy.sh` (root, 0755) |
| Forced command | `infra/deploy/authorized_keys.example` | `/home/loomcast-deploy/.ssh/authorized_keys` (root, 0644) |
| sudo rule | `infra/deploy/sudoers.example` | `/etc/sudoers.d/loomcast-deploy` (root, 0440) |
| Lint and tests | `.github/workflows/infra-lint.yml`, `infra/deploy/test/deploy.test.sh` | pull requests touching `infra/**` or `.github/**` |

Release tags are `sha-` followed by the first 12 characters of the commit
(`git rev-parse --short=12 <commit>`). The script accepts 7 to 40 lowercase hex characters, so a
tag from an older naming still works. Both images of a release always carry the same tag, which
is what `compose.prod.yml` expects.

## Owner checkpoints

Only the orchestrator runs commands on the server, and only after the owner's go-ahead for the
checkpoint concerned.

| Checkpoint | The owner provides or approves | Section |
|---|---|---|
| **C3** | The `production` environment and its reviewer, the deploy secrets, `APP_URL`, GHCR package visibility | [1](#1-github-settings-c3) |
| **C5** | Creating the deploy user, sudo rule and `/opt/loomcast`, the first deploy | [2](#2-first-time-server-bootstrap-c5) |

## 1. GitHub settings (C3)

> **Owner checkpoint C3.** These are settings in the repository on GitHub. Nothing in this
> repository creates them.

### 1.1 The `production` environment

*Settings → Environments → New environment*, name `production`:

1. **Required reviewers:** add yourself. Leave **Prevent self-review** off, because you are the
   only reviewer and also the person who merges.
2. **Deployment branches and tags:** *Selected branches and tags*, add `main`. A manual run from
   any other branch is then refused before it sees a secret.
3. Leave the wait timer at 0.

### 1.2 The deploy key pair

On your own machine, outside any repository:

```bash
ssh-keygen -t ed25519 -N '' -C loomcast-deploy -f ./loomcast_deploy
```

- `loomcast_deploy.pub` goes into the server's `authorized_keys` during C5
  ([2.5](#25-forced-command-and-sudo-rule)).
- The private half `loomcast_deploy` becomes the `VPS_SSH_KEY` secret. Keep a copy in your
  password manager only if you want to run `status` or `rollback` from your machine; otherwise
  delete the local file once the secret is saved.

### 1.3 The server's host key

`VPS_KNOWN_HOSTS` pins the server's SSH host key, so the workflow refuses to talk to anything
else. Take it from your machine and compare it with what the server itself reports:

```bash
# On your machine (one line per key type; ed25519 is enough):
ssh-keyscan -p <ssh-port> -t ed25519 <vps-ipv4> 2>/dev/null | tee known_hosts.loomcast
ssh-keygen -lf known_hosts.loomcast

# On the server, over your usual admin session:
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

The two `SHA256:` fingerprints must match. The content of `known_hosts.loomcast` (the line that
starts with `<vps-ipv4>` or `[<vps-ipv4>]:<ssh-port>`) is the secret's value.

### 1.4 Environment secrets

*Settings → Environments → production → Environment secrets* (environment secrets, not
repository secrets, so only an approved deploy can read them):

| Secret | Value |
|---|---|
| `VPS_HOST` | The server's IPv4 address or SSH host name |
| `VPS_SSH_PORT` | The SSH port. If it is 22, leave this secret out: the workflow defaults to 22, and a secret of `22` would mask every "22" in the logs |
| `VPS_DEPLOY_USER` | `loomcast-deploy` |
| `VPS_SSH_KEY` | The whole private key file from 1.2, including its first and last lines |
| `VPS_KNOWN_HOSTS` | The known_hosts line from 1.3 |

### 1.5 Repository variables

*Settings → Secrets and variables → Actions → Variables* (repository variables, because the
uptime check also reads `APP_URL`):

| Variable | Value |
|---|---|
| `APP_URL` | `https://loomcast.prabhavalabs.com` |
| `RELEASE_PLATFORMS` | Only if the server is not `x86_64`: `linux/arm64` for an `aarch64` server (`uname -m`). Unset means `linux/amd64` |

### 1.6 GHCR packages

The first release creates two packages under the owner's account, `loomcast` and
`loomcast-backup`, linked to this repository through the image label. After that first run:

1. Open each package (*Profile → Packages*) → *Package settings*.
2. **Visibility: public.** The images contain no secrets (`infra/compose/README.md`), and a
   public package lets the server pull without registry credentials.
3. Under *Manage Actions access*, check that `theetaz/loomcast` has the **Write** role, so later
   releases can push.

If you keep the packages private instead, create a classic personal access token with only
`read:packages`, and log the server's root user in once during C5:
`docker login ghcr.io -u theetaz` (paste the token). Rotate it like any other credential.

### 1.7 Check

- *Actions*: the `release` workflow appears after the next merge to `main` and pushes both
  images.
- The `deploy` run after it shows **Waiting for review**. Until C5 is done, reject it.

## 2. First-time server bootstrap (C5)

> **Owner checkpoint C5 (go-live).** Every step here changes the server. Run them only after the
> owner's go-ahead. The order of the whole go-live is: the env files and backup directory
> (`infra/compose/README.md`, [backup-and-restore.md](backup-and-restore.md)), this section up
> to 2.6, the first deploy (2.7), then the nginx site and certificate
> ([nginx-and-tls.md](nginx-and-tls.md)) and Cloudflare ([cloudflare.md](cloudflare.md)), and
> finally the owner account (2.8).

Run the commands as root, from a checkout of `main` (for the files under `infra/deploy/`).

### 2.1 Check the host

```bash
uname -m                      # x86_64 -> RELEASE_PLATFORMS unset; aarch64 -> linux/arm64
docker compose version        # Compose v2 or later
getent passwd loomcast-deploy # must print nothing yet
sshd -T | grep -iE '^(allowusers|allowgroups|denyusers|denygroups|pubkeyauthentication)'
```

If `AllowUsers` or `AllowGroups` is set, the new user has to be added to it (2.6).

### 2.2 The deploy user

```bash
useradd --create-home --shell /bin/sh --user-group loomcast-deploy
passwd -l loomcast-deploy
id loomcast-deploy            # groups: only loomcast-deploy; never docker, sudo or adm
```

The shell must be a real shell, because sshd runs the forced command through it; the forced
command then decides what actually runs.

### 2.3 Directories

```bash
install -d -o root -g root -m 0755 /opt/loomcast /opt/loomcast/bin \
  /opt/loomcast/releases /opt/loomcast/state
install -d -o root -g root -m 0700 /opt/loomcast/env
```

`/opt/loomcast` and `/opt/loomcast/bin` must stay owned by root and writable only by root:
whoever can write there can change what the sudo rule runs. The env files (`compose.env`,
`api.env`, `postgres.env`, `backup.env`) and `/opt/loomcast/backups` are set up as described in
`infra/compose/README.md` and [backup-and-restore.md](backup-and-restore.md). The deploy script
reads `LOOMCAST_HTTP_PORT` from `/opt/loomcast/env/compose.env`.

### 2.4 The deploy script

```bash
install -o root -g root -m 0755 infra/deploy/deploy.sh /opt/loomcast/bin/deploy.sh
```

The script is not updated by deploys. When `infra/deploy/deploy.sh` changes on `main`, install
it again the same way.

### 2.5 Forced command and sudo rule

```bash
# sudo: exactly one script, no arguments, SSH_ORIGINAL_COMMAND kept.
visudo -cf infra/deploy/sudoers.example
install -o root -g root -m 0440 infra/deploy/sudoers.example /etc/sudoers.d/loomcast-deploy
visudo -c
sudo -l -U loomcast-deploy     # (root) NOPASSWD: /opt/loomcast/bin/deploy.sh ""

# SSH: owned by root so the deploy user cannot change it.
install -d -o root -g root -m 0755 /home/loomcast-deploy/.ssh
grep -v '^#' infra/deploy/authorized_keys.example \
  | sed "s#ssh-ed25519 <public-key> loomcast-deploy#$(cat loomcast_deploy.pub)#" \
  >/home/loomcast-deploy/.ssh/authorized_keys
chown root:root /home/loomcast-deploy/.ssh/authorized_keys
chmod 0644 /home/loomcast-deploy/.ssh/authorized_keys
# One line: restrict,command="sudo -n ...",... ssh-ed25519 AAAA... loomcast-deploy
cat /home/loomcast-deploy/.ssh/authorized_keys
```

(`loomcast_deploy.pub` is the public key from 1.2, copied to the server.)

### 2.6 sshd access

Only if 2.1 showed `AllowUsers` or `AllowGroups`: add `loomcast-deploy` to that line in the
same file it comes from, then:

```bash
sshd -t && systemctl reload ssh
```

Never restart sshd from an SSH session, and keep your admin session open until 2.7 works.

### 2.7 Check the path and deploy the first release

From your machine, with the private key from 1.2:

```bash
k=(-i ./loomcast_deploy -p <ssh-port> -o IdentitiesOnly=yes
   -o StrictHostKeyChecking=yes -o UserKnownHostsFile=./known_hosts.loomcast)
ssh "${k[@]}" loomcast-deploy@<vps-ipv4> status   # current: none ... readyz: failing (exit 1)
ssh "${k[@]}" loomcast-deploy@<vps-ipv4> id       # deploy: rejected command (exit 2)
ssh "${k[@]}" -t loomcast-deploy@<vps-ipv4>       # PTY allocation request failed
```

Then deploy: approve the waiting `deploy` run in *Actions*, or start *Actions → deploy → Run
workflow* on `main` with the newest tag (`sha-` plus the first 12 characters of the newest
commit on `main` that has a `release` run). The log shows the pull, the start and
`deployed sha-...`. On the server:

```bash
/opt/loomcast/bin/deploy.sh status
```

### 2.8 Owner account

Once nginx and the certificate are in place, create the owner as described in
`infra/compose/README.md` (*Commands*), from `/opt/loomcast/current`.

## 3. Everyday deploys

Merging to `main` is all it takes: `ci`, then `release`, then a `deploy` run waiting for review.
Approve it in *Actions* (or from the notification). Runs queue in one `deploy` group; a newer
run waiting for approval replaces an older one that has not started, and a running deploy is
never cancelled.

A deploy that fails is rolled back on the server before the workflow reports the failure. The
log shows which step failed: `could not pull` (nothing changed), `did not start healthy` or
`was not ready within 60s` (followed by `rolled back to sha-...`).

### 3.1 The workspaces release (migrations 0017 and 0018)

The release that organises Loomcast by workspace changes the database and the studio agent, so
roll it out in this order:

1. **Deploy the server first.** The migrations run when the api starts: `0017` renames projects
   to workspaces, and `0018` moves every channel into one workspace (the one whose items it
   published most, else the workspace of a series or API client that used it; an Instagram
   account follows its Page; a channel left over gets a new workspace named after it). Series
   links and API client grants that would cross workspaces are removed. Check `/readyz`, sign
   in, and look over each workspace's **Workspace settings → Channels** and **API clients**.
2. **Then rebuild and restart the studio agent on the Mac** (see the
   [studio agent guide](../guide/studio-agent.md#keeping-it-up-to-date)). An agent built before
   the release keeps working against the new server in the meantime: the bridge still sends each
   job's workspace as `projectId`, and the agent's folders stay at
   `~/Loomcast/projects/<workspaceId>`.

Old browser links (`/projects/...`, `/calendar`, `/settings/channels` and the like) redirect to
the same page in a workspace, and outside clients keep the deprecated `project.*` MCP tools and
the `project` field of `/api/v1/me`. A session-end hook configured with `LOOMCAST_PROJECT_ID` or
`.loomcast/project.json` must be switched to the new names ([session-hook.md](../session-hook.md)).

Rolling back past this release needs a database restore: `0017` renames tables, so an older
release cannot read the migrated schema (see [section 4](#4-rolling-back-by-hand)).

## 4. Rolling back by hand

Pick the release to go back to: the `sha-` tag of an earlier commit on `main`
(`git log --format='%h %s' --abbrev=12 main`), or the `previous` line of `status`. The server
keeps the images of the last five releases plus the current and previous one, so these start
without the registry; older tags are pulled again.

Choose one of:

1. **From GitHub (preferred).** *Actions → deploy → Run workflow* on `main`, tag
   `sha-<12 hex>`, then approve it. It runs the same checks and automatic rollback as any deploy.
2. **With the deploy key**, to swap back to the previous release:

   ```bash
   ssh "${k[@]}" loomcast-deploy@<vps-ipv4> rollback
   ```

3. **On the server, as root**, when GitHub is unavailable:

   ```bash
   /opt/loomcast/bin/deploy.sh status
   /opt/loomcast/bin/deploy.sh rollback                 # back to the previous release
   /opt/loomcast/bin/deploy.sh deploy sha-<12 hex>      # or to any release by tag
   ```

**Database migrations are not rolled back.** The api applies migrations on start, and an older
release runs against the newer schema. Migrations are therefore written to stay compatible with
the release before them (add first, remove later). If a release changed data in a way the old
code cannot read, restore the database instead ([backup-and-restore.md](backup-and-restore.md),
*Restore into production*).

## 5. Status, logs and files

```bash
/opt/loomcast/bin/deploy.sh status          # current, previous, containers, readyz
cat /opt/loomcast/state/history             # one line per deploy, failure and rollback
journalctl -t loomcast-deploy --since today # the script's messages, also sent to syslog
docker compose -p loomcast logs --tail=200 api   # logs and ps work by project name alone
```

| Path | Content |
|---|---|
| `/opt/loomcast/bin/deploy.sh` | The deploy script |
| `/opt/loomcast/env/compose.env` | Interpolation variables; `LOOMCAST_TAG` in it is overridden by the script |
| `/opt/loomcast/releases/<tag>/` | The compose project extracted from that release |
| `/opt/loomcast/current` | Link to the running release's directory |
| `/opt/loomcast/state/current`, `previous` | Tags of the running and the previous release |
| `/opt/loomcast/state/lock/` | Present only while a deploy runs |

When running compose by hand with the compose file, pass the running tag, because
`compose.env` still holds the tag of the first setup:

```bash
cd /opt/loomcast/current
LOOMCAST_TAG=$(cat /opt/loomcast/state/current) \
  docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env ps
```

## 6. Rotating the deploy key

1. Create a new key pair (1.2).
2. On the server, add the new public key as a second line in `authorized_keys`, with the same
   options.
3. Replace `VPS_SSH_KEY` in the `production` environment and run `status` through a deploy, or
   with the new key from your machine.
4. Remove the old line from `authorized_keys`.

If the server's host key changes (a reinstall), repeat 1.3 and replace `VPS_KNOWN_HOSTS`.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Host key verification failed` | `VPS_KNOWN_HOSTS` is missing, wrong or for another port | Repeat 1.3; the line must name the same host and port as `VPS_HOST` and `VPS_SSH_PORT` |
| `Permission denied (publickey)` | Wrong key, wrong user, or sshd's `AllowUsers` | Check 1.2, `VPS_DEPLOY_USER` and 2.6 |
| `sudo: a password is required` | The sudo rule is missing, or the forced command passes arguments | Repeat 2.5; the forced command must be exactly `sudo -n /opt/loomcast/bin/deploy.sh` |
| `deploy: rejected command` (exit 2) | Anything other than `deploy sha-<hex>`, `rollback`, `status` | Check the tag format |
| `another deploy is running` (exit 3) | A deploy holds the lock | Wait for it; a lock left by a killed run is taken over automatically |
| `could not pull ...` | The release does not exist, or the packages are private | Check the tag in GHCR; see 1.6 |
| `missing /opt/loomcast/env/compose.env` | The env files are not set up | `infra/compose/README.md` |
| `not ready within 60s`, then rolled back | The new release failed its readiness check | `docker compose -p loomcast logs --tail=200 api`; fix forward |
| `rollback to ... failed` | The previous release is unhealthy too (database, storage) | `status`, the api logs and `/readyz`; usually the database or object storage, not the release |
