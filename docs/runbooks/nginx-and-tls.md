# Host nginx and TLS

This runbook puts `https://loomcast.prabhavalabs.com` in front of the production api. The host's
existing nginx terminates TLS with a Let's Encrypt certificate and forwards everything to the api
container on `127.0.0.1:${LOOMCAST_HTTP_PORT}`, which serves the REST api, the event stream
(`/api/stream`), MCP (`/mcp`), the studio agent bridge (`/bridge/v1`) and the web app on one port.
Cloudflare proxies the hostname; its side is in [cloudflare.md](cloudflare.md), object storage in
[r2.md](r2.md).

## Ground rules for the shared host

The server runs other production applications behind the same nginx and certbot. Everything in
this runbook is additive and scoped to Loomcast:

- It adds one site file, one directory (`/etc/nginx/loomcast`), one ACME webroot
  (`/var/www/loomcast-acme`), one certificate and one cron file. It never edits `nginx.conf`,
  `conf.d`, other sites, or other certificates' renewal settings.
- It uses `certbot certonly --webroot`, which never rewrites nginx files. Never run
  `certbot --nginx` for this site.
- nginx is only ever **reloaded**, and only after `nginx -t` passes. Never restart or stop it.
- Names in nginx's shared http context carry a `loomcast` prefix (`upstream loomcast_api`,
  `$loomcast_connection_upgrade`, the `loomcast_tls` session cache), and the site sets no listen
  socket options (`default_server`, `reuseport`, `backlog`), so it cannot change other sites.
- The server's address, SSH details, tokens and account IDs never go into this repository.
  Commands below use placeholders such as `<vps-ipv4>`.

## Owner checkpoints

Only the orchestrator runs commands on the server, and only after the owner's go-ahead for the
checkpoint concerned.

| Checkpoint | The owner provides or approves | Section |
|---|---|---|
| **C1** | A read-only survey of the server; its results stay out of git | [1](#1-survey-the-server-c1) |
| **C2** | The Cloudflare decisions (zone SSL mode, Configuration Rule, origin pulls, certificate method) | [cloudflare.md](cloudflare.md#owner-decisions-c2) |
| **C5** | Go-live: create the DNS record, install the site, issue the certificate, enable the cron refresh, switch the record to proxied | [2](#2-prepare-the-server-c5) to [8](#8-verify-through-cloudflare) |

## Files

| In the repository | On the server |
|---|---|
| `infra/nginx/loomcast.conf.template` | rendered to `/etc/nginx/sites-available/loomcast.conf`, linked from `sites-enabled` |
| `infra/scripts/render-nginx.sh` | `/opt/loomcast/infra/scripts/render-nginx.sh` |
| `infra/nginx/cloudflare-ips.sh` | `/opt/loomcast/infra/nginx/cloudflare-ips.sh`, writes `/etc/nginx/loomcast/cloudflare-ips.conf` |
| `infra/scripts/test-nginx.sh` | not installed; run it locally before every change (`bash infra/scripts/test-nginx.sh`) |

The site template provides:

- **Port 80:** the ACME challenge location (`/.well-known/acme-challenge/`), then a 301 redirect
  to HTTPS.
- **Port 443:** the Let's Encrypt certificate, the client address from `CF-Connecting-IP`
  (trusted only from Cloudflare's ranges), `client_max_body_size 2m` (file uploads go straight to
  object storage), and its own access and error logs (`/var/log/nginx/loomcast.*.log`, rotated by
  the host's existing nginx logrotate rule).
- **`/bridge/`:** HTTP/1.1 WebSocket upgrade with a 120 s read timeout. The api pings the studio
  agent well inside that.
- **`= /api/stream` and `/mcp`:** no proxy buffering or caching, no gzip, 3600 s read timeout and
  `X-Accel-Buffering: no`. The event stream sends a heartbeat every 15 s.
- **`/`:** everything else, with `X-Forwarded-For`, `-Proto`, `-Host` and `-Port`.
  `X-Forwarded-For` carries only the address nginx resolved, which is what the api reads with
  `TRUST_PROXY=true`.
- **Optional:** Cloudflare authenticated origin pulls (`ssl_verify_client`), off by default.

Security headers (HSTS, CSP, frame and referrer policies) come from the api, so nginx adds none.

### Render settings

`render-nginx.sh` writes the site to stdout or, with `-o FILE`, atomically to a file. It only
renders; it never reloads nginx.

| Variable | Default | Meaning |
|---|---|---|
| `LOOMCAST_HTTP_PORT` | none; or `--compose-env /opt/loomcast/env/compose.env` | The api's loopback port |
| `LOOMCAST_NGINX_MODE` | `full` | `bootstrap` renders port 80 only, before a certificate exists |
| `LOOMCAST_NGINX_HTTP2` | `auto` | `on` (`http2 on;`, nginx 1.25.1 or later), `listen` (legacy `listen 443 ssl http2`), `off`. `auto` picks `on` when the local nginx supports it, otherwise `off` |
| `LOOMCAST_ORIGIN_PULLS` | `0` | `1` requires Cloudflare's origin-pull client certificate |
| `LOOMCAST_DOMAIN` | `loomcast.prabhavalabs.com` | Public hostname |
| `LOOMCAST_ACME_ROOT` | `/var/www/loomcast-acme` | ACME webroot |
| `LOOMCAST_CERT_DIR` | `/etc/letsencrypt/live/<domain>` | Certificate directory |
| `LOOMCAST_NGINX_DIR` | `/etc/nginx/loomcast` | Cloudflare include and origin-pull CA |
| `LOOMCAST_LOG_DIR` | `/var/log/nginx` | Log directory |

On nginx older than 1.25.1, HTTP/2 is a property of the listening socket: `listen 443 ssl http2`
in this site would switch HTTP/2 on for every site on port 443. `auto` therefore leaves it off on
older versions. Use `listen` only if the survey shows the other sites already set `http2` on their
443 listeners. Cloudflare talks HTTP/1.1 to origins by default anyway, and always for WebSockets.

## 1. Survey the server (C1)

> **Owner checkpoint C1.** Approve this read-only survey. Nothing is changed. Keep the output out
> of git, issues and pull requests: it describes other applications.

```bash
nginx -v
free -m
ss -ltnp
docker ps --format '{{.Names}}\t{{.Ports}}'
ls -l /etc/nginx/sites-enabled /etc/nginx/conf.d
grep -n 'include' /etc/nginx/nginx.conf
nginx -T 2>/dev/null | grep -nE '^\s*listen|default_server|loomcast|map \$http_upgrade|shared:|real_ip|set_real_ip_from'
certbot certificates
grep -h '^authenticator' /etc/letsencrypt/renewal/*.conf | sort | uniq -c
ls /etc/letsencrypt/renewal-hooks/deploy
systemctl list-timers | grep -iE 'certbot|snap.certbot'
command -v envsubst curl
```

Record, outside git:

1. **A free loopback port** for `LOOMCAST_HTTP_PORT` (nothing in `ss -ltnp` on it). It goes into
   `/opt/loomcast/env/compose.env`.
2. **The nginx version**, which decides the HTTP/2 mode, and **the site layout**:
   `sites-available`/`sites-enabled` (assumed below) or `conf.d` only. With `conf.d` only, write
   the site to `/etc/nginx/conf.d/loomcast.conf` instead and skip the symlink.
3. **The default servers.** If ports 80 and 443 have an explicit `default_server`, nothing else is
   needed. If not, nginx sends requests for unknown names to the first server it loaded for that
   port, in file name order. If `loomcast.conf` would sort before that file, name the link
   `zz-loomcast.conf` so the fallback site stays the same.
4. **No existing `loomcast` names** in the `nginx -T` output.
5. **How certbot runs** (package or snap, its timer, the authenticator other certificates use) and
   whether a deploy hook already reloads nginx.
6. Whether `envsubst` (Debian/Ubuntu package `gettext-base`) and `curl` are installed. Installing
   a missing package is part of the C5 go-ahead.
7. Memory headroom for the compose memory caps (see `infra/compose/README.md`).

## 2. Prepare the server (C5)

> **Owner checkpoint C5 (go-live).** Every step from here to section 8 changes the server or the
> zone. Run them only after the owner's go-ahead.

Copy the three scripts and the template from a checkout of the release being deployed, keeping
the repository layout (the render script finds the template at `../nginx/` from its own
directory). Then, as root:

```bash
install -d -m 0755 /opt/loomcast/infra/nginx /opt/loomcast/infra/scripts
install -m 0644 loomcast.conf.template /opt/loomcast/infra/nginx/
install -m 0755 cloudflare-ips.sh /opt/loomcast/infra/nginx/
install -m 0755 render-nginx.sh /opt/loomcast/infra/scripts/
install -d -m 0755 /etc/nginx/loomcast /var/www/loomcast-acme
```

Confirm that `LOOMCAST_HTTP_PORT` in `/opt/loomcast/env/compose.env` is the port chosen in C1.

## 3. Trusted Cloudflare ranges

```bash
/opt/loomcast/infra/nginx/cloudflare-ips.sh -o /etc/nginx/loomcast/cloudflare-ips.conf
grep -c set_real_ip_from /etc/nginx/loomcast/cloudflare-ips.conf
```

The script fetches `https://www.cloudflare.com/ips-v4/` and `/ips-v6/`, refuses anything that is
not a CIDR range and leaves an existing file untouched on any error.

Refresh it weekly. The cron file reloads nginx only when the list changed and `nginx -t` passes,
and restores the previous file otherwise:

```bash
cat >/etc/cron.d/loomcast-cloudflare-ips <<'EOF'
# Refresh Cloudflare's address ranges for the Loomcast nginx site.
17 4 * * 1 root /opt/loomcast/infra/nginx/cloudflare-ips.sh --reload 2>&1 | logger -t loomcast-cloudflare-ips
EOF
chmod 0644 /etc/cron.d/loomcast-cloudflare-ips
```

## 4. Bootstrap site (port 80 only)

Before the certificate exists, install the site without its HTTPS server:

```bash
cd /opt/loomcast/infra
LOOMCAST_NGINX_MODE=bootstrap ./scripts/render-nginx.sh \
  --compose-env /opt/loomcast/env/compose.env -o /etc/nginx/sites-available/loomcast.conf
ln -s /etc/nginx/sites-available/loomcast.conf /etc/nginx/sites-enabled/loomcast.conf
nginx -t && systemctl reload nginx
```

If `nginx -t` fails, remove the link (`rm /etc/nginx/sites-enabled/loomcast.conf`) and do not
reload. Nothing else has changed.

## 5. First certificate

This uses the HTTP-01 challenge while the DNS record is **DNS only** (grey cloud). For the DNS-01
alternative, which works while the record is proxied, see
[cloudflare.md](cloudflare.md#dns-01-alternative).

1. Create the DNS record as DNS only ([cloudflare.md, step 2](cloudflare.md#2-dns-record-c5)) and
   confirm it resolves to the server, not to Cloudflare:

   ```bash
   dig +short loomcast.prabhavalabs.com   # must print <vps-ipv4>
   ```

2. Check the challenge path end to end:

   ```bash
   install -d /var/www/loomcast-acme/.well-known/acme-challenge
   echo ok >/var/www/loomcast-acme/.well-known/acme-challenge/probe
   curl -s http://loomcast.prabhavalabs.com/.well-known/acme-challenge/probe   # prints ok
   rm /var/www/loomcast-acme/.well-known/acme-challenge/probe
   ```

3. Issue the certificate. `--dry-run` first, against the staging service:

   ```bash
   certbot certonly --webroot -w /var/www/loomcast-acme -d loomcast.prabhavalabs.com --dry-run
   certbot certonly --webroot -w /var/www/loomcast-acme -d loomcast.prabhavalabs.com \
     --deploy-hook 'systemctl reload nginx'
   ```

   The deploy hook is stored only in this certificate's renewal file
   (`/etc/letsencrypt/renewal/loomcast.prabhavalabs.com.conf`). If certbot has no account on this
   server yet, it asks for an email address and the terms; use the owner's address.

## 6. Full site

Render the HTTPS server, keeping the previous file to fall back on:

```bash
cd /opt/loomcast/infra
cp -p /etc/nginx/sites-available/loomcast.conf /etc/nginx/loomcast/loomcast.conf.previous
./scripts/render-nginx.sh --compose-env /opt/loomcast/env/compose.env \
  -o /etc/nginx/sites-available/loomcast.conf
diff -u /etc/nginx/loomcast/loomcast.conf.previous /etc/nginx/sites-available/loomcast.conf
if nginx -t; then
  systemctl reload nginx
else
  cp -p /etc/nginx/loomcast/loomcast.conf.previous /etc/nginx/sites-available/loomcast.conf
fi
```

Use the same pattern for every later change (a new port, origin pulls, a new template). Set
`LOOMCAST_NGINX_HTTP2` or `LOOMCAST_ORIGIN_PULLS` in front of the render command as decided.

Check the origin directly, still before Cloudflare proxies the record:

```bash
curl -sS --resolve loomcast.prabhavalabs.com:443:127.0.0.1 https://loomcast.prabhavalabs.com/healthz
curl -sSI http://loomcast.prabhavalabs.com/   # 301 to https
```

`{"status":"ok"}` means TLS, the site and the api work. A `502` means the api is not running yet
or listens on another port: `curl -s http://127.0.0.1:<port>/healthz` on the server tells which.

## 7. Proxy through Cloudflare

Follow [cloudflare.md](cloudflare.md) steps 4 to 7: the Configuration Rule for Full (strict) and
the cache bypass go in **before** the record is switched to proxied.

## 8. Verify through Cloudflare

From any machine:

```bash
curl -sSI https://loomcast.prabhavalabs.com/ | grep -iE '^(HTTP|server|strict-transport|content-security)'
curl -sS https://loomcast.prabhavalabs.com/readyz
curl -sS -o /dev/null -w '%{http_code}\n' https://loomcast.prabhavalabs.com/api/stream   # 401 without a session
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://loomcast.prabhavalabs.com/mcp  # 401 without a token
curl -sS -o /dev/null -w '%{http_code}\n' --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" \
  https://loomcast.prabhavalabs.com/bridge/v1                                            # 401 without a token
```

A `4xx` from the api proves the route reaches it; a `502`, `520` to `526` or a Cloudflare error
page does not (see [Troubleshooting](#troubleshooting)). Then, end to end:

- Sign in and keep a workspace open: the browser's network panel shows `/api/stream` as an open
  event stream with a heartbeat every 15 s.
- Pair a studio agent against `https://loomcast.prabhavalabs.com`; it shows **Online** and stays
  online for several minutes.
- `tail -n 20 /var/log/nginx/loomcast.access.log` shows client addresses, not Cloudflare's.

## 9. Renewal

The host's existing certbot timer renews the certificate. Renewal keeps using HTTP-01 after the
record is proxied: Let's Encrypt requests `http://loomcast.prabhavalabs.com/.well-known/...`, and
Cloudflare either forwards it to the origin over HTTPS (Full (strict) always connects to port
443) or redirects it to HTTPS first. Both reach the ACME location, which the HTTPS server serves
too, and Let's Encrypt follows the redirect. With origin pulls on, Cloudflare still presents its
client certificate, so nothing changes.

Check it once after go-live:

```bash
certbot renew --cert-name loomcast.prabhavalabs.com --dry-run
```

## 10. Rollback and removal

Take the site offline, leaving everything else in place:

```bash
rm /etc/nginx/sites-enabled/loomcast.conf
nginx -t && systemctl reload nginx
```

Remove it completely (after the owner's go-ahead):

```bash
rm -f /etc/nginx/sites-enabled/loomcast.conf /etc/nginx/sites-available/loomcast.conf
nginx -t && systemctl reload nginx
rm -f /etc/cron.d/loomcast-cloudflare-ips
rm -rf /etc/nginx/loomcast /var/www/loomcast-acme
certbot delete --cert-name loomcast.prabhavalabs.com
```

Then switch the DNS record to DNS only or delete it, and delete the Loomcast rules in Cloudflare
([cloudflare.md](cloudflare.md#rollback)).

## Troubleshooting

| Symptom | Likely cause | Check or fix |
|---|---|---|
| `502 Bad Gateway` from nginx | The api is down or on another port | `docker compose -p loomcast ps`; `curl http://127.0.0.1:<port>/healthz`; compare `LOOMCAST_HTTP_PORT` with the rendered `upstream` |
| Redirect loop | Cloudflare uses Flexible for the hostname | The Configuration Rule is missing or not deployed ([cloudflare.md, step 4](cloudflare.md#4-configuration-rule-c5)) |
| Cloudflare `525` or `526` | No HTTPS server or certificate at the origin | The site is still in bootstrap mode, or the certificate expired: `certbot certificates` |
| `400 No required SSL certificate was sent` | Origin pulls on at nginx but not at Cloudflare | Enable them in Cloudflare, or render with `LOOMCAST_ORIGIN_PULLS=0` |
| Cloudflare `524` | No response byte within 100 s (Cloudflare's limit) | Long MCP calls hit it; the stream and the bridge send heartbeats, so they do not |
| Studio agent reconnects every 100 s or so | Pings are not getting through | Check WebSockets are on in Cloudflare and the `/bridge/` location is in the rendered file |
| The api logs Cloudflare addresses | The trusted ranges are missing or out of date | Re-run `cloudflare-ips.sh --reload`; check the `include` line in the rendered file |
| `nginx -t` fails after a render | A wrong setting, or a name clash found in the survey | The previous file was restored; fix the setting and render again |
