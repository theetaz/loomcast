# Incident response

What to do when Loomcast may be compromised, is leaking data, or is publishing what it should
not: how incidents show up, how to contain each kind, how to recover, and the write-up afterwards.
Routine procedures (rotation, restore, lost Mac) are in [owner-runbook.md](owner-runbook.md),
whose `dc` helper and conventions this page uses.

The host is shared with other production apps. Containment acts on the `loomcast` compose
project, `/opt/loomcast`, the Loomcast nginx site, the Loomcast Cloudflare records and Loomcast's
own credentials only. If the host itself looks compromised, tell the owners of the other stacks
at once.

## Severity

| Level | Examples | Respond |
|---|---|---|
| **SEV1** | Unwanted or wrong posts going out on a channel; a leaked encryption key, database dump or server access; an account taken over | At once: contain first, then investigate |
| **SEV2** | A leaked MCP, device or app secret without signs of use; a lost Mac; repeated `auth.login.failed` on the owner's email | Same day |
| **SEV3** | A suspicious log line, an advisory in a dependency, a failed backup | Next working day |

When unsure, treat it as the higher level.

## Detection

| Source | What it shows | Where |
|---|---|---|
| Alert webhook | Failed or dead publishes, `channel.reauth:<id>`, stale or failed backups | Your ntfy, Slack or Discord channel ([monitoring.md](monitoring.md)) |
| Uptime workflow | An `incident` issue while `/readyz` is red from outside | GitHub notifications |
| Audit log | Sign-ins (and failures with the reason), password changes and links, tokens created and revoked, devices paired and revoked, users invited and disabled, MCP tool calls | `audit_log` table (queries below) |
| api logs | Every request with status, user and request id; 401, 403 and 429 bursts | `dc logs --since 1h api` |
| nginx logs | Client addresses (from Cloudflare) and paths | `/var/log/nginx/loomcast.access.log` |
| Platforms | Posts you did not schedule, security emails from Meta | The Page, Instagram or Threads profile; Meta's *Business integrations* and app alerts |
| CI | The `audit` job failing on a new advisory | GitHub Actions |
| Cloudflare | Traffic spikes, WAF events | The Cloudflare dashboard for the zone |

### Useful queries (**server**)

```bash
q() { dc exec -T postgres psql -U loomcast -d loomcast -c "$1"; }

# The last day of security events, newest first.
q "select created_at, action, actor_kind, actor_id, target_type, target_id, ip, data
   from audit_log where created_at > now() - interval '1 day' order by id desc limit 200"

# Failed sign-ins per address and reason.
q "select ip, data->>'reason' as reason, count(*) from audit_log
   where action = 'auth.login.failed' and created_at > now() - interval '1 day'
   group by 1, 2 order by 3 desc"

# Live sessions, tokens and devices.
q "select user_id, ip, user_agent, last_seen_at, expires_at from sessions order by last_seen_at desc"
q "select id, user_id, kind, name, prefix, last_used_at, expires_at from api_tokens
   where revoked_at is null and kind <> 'job' order by last_used_at desc nulls last"
q "select id, name, platform, created_by, last_seen_at from devices where revoked_at is null"

# Posts sent in the last day.
q "select id, channel_id, status, dry_run, published_at, permalink from scheduled_posts
   where published_at > now() - interval '1 day' order by published_at desc"
```

Column and table names follow `packages/db/src/schema/`; check there if a query fails after a
migration.

## First 15 minutes

1. **Write down the time** and what you saw. Keep notes as you go; they become the write-up.
2. **Preserve evidence** before restarting anything: container logs are lost when a container is
   recreated.

   ```bash
   mkdir -p /root/incident-$(date -u +%Y%m%dT%H%MZ) && cd "$_"
   dc logs --no-log-prefix --timestamps api > api.log
   cp /var/log/nginx/loomcast.access.log /var/log/nginx/loomcast.error.log .
   dc exec -T postgres pg_dump -U loomcast -d loomcast -t audit_log -Fc > audit_log.dump
   chmod -R go= .
   ```

3. **Contain** with the matching playbook below. Prefer the web app and the api (they publish the
   events that close sockets) over SQL.
4. **Tell** the people affected: members, and the owners of other stacks if the host is involved.

## Containment playbooks

### Unwanted posts are going out

1. Pause publishing at once: `PUBLISHING_ENABLED=false` in `api.env`, recreate the api
   ([owner-runbook.md](owner-runbook.md#2-pause-publishing)). For a single channel, its **Dry
   run** switch also works without a restart.
2. Delete the posts on the platform by hand.
3. Find out where they came from: the item and its approval (`audit_log`, the item's history),
   the format's publish mode (`auto` skips approval), and who changed them.
4. If the cause was an account or token, continue with the playbooks below before resuming.

### A member's account or session is compromised

1. **Settings → Members → Disable** the account. This ends its sessions, MCP and job tokens and
   unused links, and revokes the devices it paired (their bridge connections close).
2. For the owner's account, which cannot be disabled: reset the password
   (`dc exec -it api node dist/cli/admin.mjs reset-password --email <owner>`), which ends every
   session, then revoke every MCP token on **Settings → Access tokens**.
3. Review what the account did: `audit_log` where `actor_id` is the user (and their token ids).

### An MCP token leaked

1. **Settings → Access tokens → Revoke**. The next request with it gets 401.
2. Check `audit_log` for `mcp.tool.called` rows whose `actor_id` is that token id, and the api logs
   for `/mcp` requests from unknown addresses.

### A device token leaked or a Mac is lost

Revoke the device on **Settings → Devices** and follow
[owner-runbook.md](owner-runbook.md#7-a-lost-or-stolen-mac).

### A pairing code or set-password link leaked

Pairing codes expire after 10 minutes and are single use: check **Settings → Devices** for a
device you did not pair and revoke it. For a set-password link, issue a new reset link from
**Settings → Members** (the earlier ones stop working) or, if it was used, treat the account as
compromised.

### Platform credentials or app secrets leaked

1. Pause publishing.
2. Reset the app secret(s) ([owner-runbook.md](owner-runbook.md#82-meta-threads-and-x-app-secrets)).
3. In Facebook, remove the app under *Business integrations* for the affected account (this
   revokes its tokens), then **Disconnect** and reconnect each channel in Loomcast.
4. Check the Pages and profiles for posts or changes you did not make.

### The encryption key, an env file or a database dump leaked

Treat every secret in it as leaked.

1. Pause publishing.
2. Rotate, in this order: the encryption key, the platform tokens (disconnect and reconnect every
   channel) and app secrets, the database password, the R2 keys, the alert webhook
   ([owner-runbook.md](owner-runbook.md#8-rotating-secrets)).
3. A database dump also holds password hashes and token hashes: reset every member's password
   and revoke every MCP token and device, then pair the devices again.

### The server or the deploy path is compromised

1. In Cloudflare, block traffic to `loomcast.prabhavalabs.com` (a WAF rule, or pause the
   record's proxy and remove it) so nothing more reaches the api.
2. Remove the deploy key line from `authorized_keys` and the `VPS_SSH_KEY` secret from the GitHub
   `production` environment.
3. Tell the owners of the other stacks and the host's administrator.
4. Rotate everything in section 8 of the owner runbook from a clean machine, and rebuild on a
   clean host from a backup taken before the compromise
   ([backup-and-restore.md](backup-and-restore.md#a-new-server)).

### Abuse or a flood of requests

1. Look at 429s and their addresses in the api logs and the nginx access log.
2. Block the addresses or ranges with a Cloudflare WAF rule (not in the shared nginx).
3. If `/bridge/v1` is the target, consider the nginx `limit_req` zone in
   [../security.md](../security.md#hardening-review-findings) (finding H6).

### Revoking with SQL

Only when the web app and the api are unavailable. Revoking a device or token with SQL does not
close live bridge connections (only the `device.revoked` event does), so restart the api after:

```bash
q "update api_tokens set revoked_at = now() where id = '<token id>'"
q "update devices set revoked_at = now() where id = '<device id>'"
q "delete from sessions where user_id = '<user id>'"     # signs the user out everywhere
dc up -d --force-recreate --wait api
```

## Recovery

1. Fix the cause (a code fix goes through a pull request and a reviewed deploy as usual).
2. Restore data if it was changed: scratch-restore first, then production
   ([backup-and-restore.md](backup-and-restore.md)).
3. Resume publishing only after reviewing the calendar and the approvals inbox.
4. Watch alerts, `/readyz` and the audit log closely for a week.

## Write-up template

Write it within a week, for every SEV1 and SEV2. Keep it blameless and factual. Store it outside
the public repository (it may name addresses, accounts or weaknesses) in the owner's private
notes.

```markdown
# Incident <YYYY-MM-DD>: <short title>

- Severity: SEV1 | SEV2 | SEV3
- Status: resolved | monitoring
- Detected: <UTC time>, by <alert, person, platform email, ...>
- Contained: <UTC time>
- Resolved: <UTC time>
- Written by: <name>, <date>

## Summary
Two or three sentences: what happened, who or what was affected, and how it ended.

## Impact
- Accounts, channels, posts or data affected, and for how long.
- Secrets exposed, and whether they were used.
- Effect on other stacks on the host: none | <details>.

## Timeline (UTC)
| Time | Event |
|---|---|
| | First sign |
| | Detected |
| | Containment step |
| | Recovered |

## Root cause
What made it possible, and why the existing controls did not stop it.

## What went well / what was hard

## Actions
| Action | Owner | Due | Done |
|---|---|---|---|
| Rotate ... | | | |
| Add a test or alert for ... | | | |

## Evidence
Where the preserved logs and dumps are kept, and when they will be deleted.
```
