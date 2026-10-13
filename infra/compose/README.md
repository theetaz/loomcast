# Production compose project

`compose.prod.yml` runs Loomcast in production as the compose project `loomcast`:

| Service | Image | Notes |
|---|---|---|
| `api` | `ghcr.io/theetaz/loomcast:<tag>` | Serves the API, the bridge WebSocket (`/bridge/v1`), MCP (`/mcp`), the event stream (`/api/stream`) and the built web app on one port. Published on `127.0.0.1:${LOOMCAST_HTTP_PORT}` only; the host's reverse proxy terminates TLS in front of it. |
| `postgres` | `postgres:17-alpine` | No published ports. Data in the `loomcast_pgdata` volume. |
| `backup` | `ghcr.io/theetaz/loomcast-backup:<tag>` | Nightly `pg_dump` with local rotation and an optional encrypted copy to object storage. No published ports; writes only to `${LOOMCAST_BACKUP_DIR}`. See `docs/runbooks/backup-and-restore.md`. |

The host runs other applications, so both services are memory-capped (api `640m` by default,
postgres `512m`), CPU- and process-limited, and run as non-root users with a read-only root
filesystem, a `/tmp` tmpfs, every capability dropped and `no-new-privileges`. Logs use the
`json-file` driver, rotated at 10 MB with 5 files kept. `postgres` sits only on the internal
`backend` network; the api also joins `egress` for outbound calls.

## Environment files

Every real value lives on the server, never in git. The templates in `env/` hold placeholders
only; secrets are left empty in them on purpose.

| File on the server | Template | Used for |
|---|---|---|
| `/opt/loomcast/env/compose.env` | `env/compose.env.example` | Interpolation (`--env-file`): image tag, loopback port, memory caps, where the other files live |
| `/opt/loomcast/env/api.env` | `env/api.env.example` | The api's settings (`env_file`) |
| `/opt/loomcast/env/postgres.env` | `env/postgres.env.example` | The database user, name and password, read when the volume is first initialised |
| `/opt/loomcast/env/backup.env` | `env/backup.env.example` | Backup schedule, rotation, object storage credentials for the backups bucket and the encryption recipient |

Set them up once, as root:

```bash
install -d -m 0700 /opt/loomcast/env
cp compose.env.example /opt/loomcast/env/compose.env   # likewise api.env and postgres.env
chmod 0600 /opt/loomcast/env/*.env
```

Then, in `compose.env`, set `LOOMCAST_ENV_DIR=/opt/loomcast/env`, empty `LOOMCAST_ENV_SUFFIX`
and choose a free `LOOMCAST_HTTP_PORT`. In `postgres.env`, generate `POSTGRES_PASSWORD` on the
server (`openssl rand -hex 32`). In `api.env`, build `DATABASE_URL` from the same user, password
and database with host `postgres` and port `5432`, and fill in `PUBLIC_BASE_URL`.

Notes:

- Values in the env files are taken literally: one `KEY=value` per line, no quotes, no comments
  after a value.
- `NODE_ENV`, `API_PORT` and `NODE_OPTIONS` are fixed by `compose.prod.yml`; `WEB_DIST_DIR`
  and `MIGRATIONS_DIR` by the image. Leave `API_HOST` unset so the api listens on every
  interface of the container. `TRUST_PROXY=true` is required behind the reverse proxy.
- Settings for features that have not shipped yet are listed in `api.env.example` as commented
  lines. Uncomment and fill them in as those features are deployed.
- `docker compose config` prints the resolved environment, secrets included. Do not paste its
  output anywhere.

## Commands

```bash
cd /opt/loomcast/releases/<tag>
dc() { docker compose -p loomcast -f compose.prod.yml --env-file /opt/loomcast/env/compose.env "$@"; }

dc up -d --wait                        # start or update; waits for both health checks
dc ps
dc logs -f --tail=200 api
dc exec api loomcast-entrypoint admin create --email owner@example.com --name Owner --role owner
dc down                                # stop; add -v only to delete the database volume
```

The deploy script sets `LOOMCAST_TAG` in its environment, which takes precedence over
`compose.env`.

## The image

`infra/docker/app.Dockerfile` builds the image from the repository root. It contains the api
bundle, the web app (`/app/web`), the SQL migrations (`/app/migrations`) and this directory
(`/app/infra/compose`), so a release can be deployed from the image alone:

```bash
docker create --name extract ghcr.io/theetaz/loomcast:<tag>
docker cp extract:/app/infra/compose/. /opt/loomcast/releases/<tag>/
docker rm extract
```

The entry point takes one command:

| Command | Does |
|---|---|
| `start` (default) | Applies pending migrations while holding a Postgres advisory lock, then serves. Containers starting together queue on the lock. |
| `migrate` | Applies pending migrations and exits |
| `serve` | Serves without migrating |
| `admin <args>` | Runs the admin CLI |
| anything else | Runs as a command, for example `id -u` |

The image runs as `node` (uid 1000), holds no secrets, and reports health with a `fetch` to
`/healthz`. `/readyz` also checks the database. Build it locally with:

```bash
docker build -f infra/docker/app.Dockerfile --build-arg LOOMCAST_GIT_SHA=$(git rev-parse HEAD) -t loomcast:local .
```
