# Cloudflare for loomcast.prabhavalabs.com

The `prabhavalabs.com` zone serves other production applications. Everything Loomcast needs is
scoped to the hostname `loomcast.prabhavalabs.com` (and, for media, the public bucket's hostname in
[r2.md](r2.md)):

- **Never change zone-wide settings for Loomcast**: not the SSL/TLS encryption mode, Always Use
  HTTPS, the minimum TLS version, WAF or bot settings. Where Loomcast needs something different,
  a rule matching its hostname sets it.
- A zone-wide toggle is changed only where this runbook says so, and only with the owner's
  explicit approval in C2.
- Account IDs, zone IDs, tokens and the server's address never go into this repository.

The server side is in [nginx-and-tls.md](nginx-and-tls.md). Steps marked C5 are part of the
go-live and run only after the owner's go-ahead.

## Owner decisions (C2)

> **Owner checkpoint C2.** Decide or confirm each row before go-live. Only reading settings
> happens before then.

| Decision | Options | Recommendation |
|---|---|---|
| The zone's current SSL/TLS mode (SSL/TLS → Overview) | Off, Flexible, Full, Full (strict) | Record it and leave it unchanged |
| A Configuration Rule for `loomcast.prabhavalabs.com` setting SSL to Full (strict) and Rocket Loader and Email Obfuscation off | Approve or not | Approve: it changes nothing for other hostnames |
| A Cache Rule bypassing the cache for the api, MCP and bridge paths of this hostname | Approve or not | Approve |
| WebSockets (Network → WebSockets) | Already on, or turn on | Usually already on (the default). Turning it on is zone-wide but only allows upgrades; it changes nothing for other sites |
| Authenticated origin pulls | None, per-hostname (own certificate), global (Cloudflare's shared certificate, zone-wide toggle) | Start with none; add per-hostname later if wanted |
| First certificate | HTTP-01 with the record DNS only, then proxied; or DNS-01 with a scoped API token | HTTP-01: no Cloudflare token on the server |
| Bot Fight Mode (Security → Bots), if on for the zone | Leave, or accept that it may challenge the studio agent and MCP clients | Read the current state; see [Bots](#bots-and-non-browser-clients) |

The public media hostname is decided in [r2.md](r2.md#owner-decisions-c4).

## 1. Read the current settings (C2)

Note, without changing anything:

- SSL/TLS → Overview: the encryption mode.
- SSL/TLS → Edge Certificates: Always Use HTTPS, minimum TLS version, and that the Universal
  certificate covers `*.prabhavalabs.com` (it covers `loomcast.prabhavalabs.com`).
- Network: WebSockets.
- Rules → Configuration Rules and Caching → Cache Rules: existing rules and their order, so the
  new ones do not conflict.
- Security → Bots: Bot Fight Mode.

## 2. DNS record (C5)

DNS → Records → Add record:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `loomcast` |
| IPv4 address | `<vps-ipv4>` |
| Proxy status | **DNS only** (grey cloud) until the first certificate is issued |
| TTL | Auto |

No `AAAA` record: the origin is reached over IPv4, and Cloudflare serves IPv6 to visitors itself
once the record is proxied.

## 3. First certificate (C5)

Issue the certificate with HTTP-01 while the record is DNS only:
[nginx-and-tls.md, sections 4 to 6](nginx-and-tls.md#4-bootstrap-site-port-80-only).

## 4. Configuration Rule (C5)

Create this **before** the record is proxied. Otherwise, if the zone's mode is Flexible, the first
proxied requests reach the origin over plain HTTP, which redirects them back to HTTPS in a loop.

Rules → Configuration Rules → Create rule:

- **Rule name:** `loomcast: full strict, no script rewriting`
- **When incoming requests match:** custom filter expression, field Hostname, operator equals,
  value `loomcast.prabhavalabs.com`:

  ```text
  (http.host eq "loomcast.prabhavalabs.com")
  ```

- **Then the settings are:**
  - SSL → **Full (strict)** (`strict`)
  - Rocket Loader → **Off**: it rewrites script tags, which the app's Content Security Policy
    blocks.
  - Email Obfuscation → **Off**: it injects a script into HTML for the same reason.
- **Deploy.**

The rule overrides the zone's settings for this hostname only.

## 5. Cache Rule (C5)

Caching → Cache Rules → Create rule:

- **Rule name:** `loomcast: bypass dynamic paths`
- **Expression:**

  ```text
  (http.host eq "loomcast.prabhavalabs.com" and (http.request.uri.path wildcard "/api/*" or http.request.uri.path eq "/mcp" or http.request.uri.path wildcard "/mcp/*" or http.request.uri.path wildcard "/bridge/*" or http.request.uri.path in {"/healthz" "/readyz"}))
  ```

  If the editor does not offer `wildcard`, use `starts_with(http.request.uri.path, "/api/")` and
  likewise for the other prefixes.
- **Cache eligibility:** Bypass cache.
- **Deploy.**

Cloudflare does not cache JSON or event streams by default; the rule makes sure no later zone
setting changes that. The web app's hashed files under `/assets/` are sent with
`Cache-Control: public, max-age=31536000, immutable` and may be cached; `index.html` is sent with
`no-cache`.

## 6. WebSockets (C2, C5)

Network → WebSockets must be **On** for the studio agent bridge. It is on by default. If it is
off, turning it on is a zone-wide change and needs the owner's approval in C2.

## 7. Switch to proxied (C5)

DNS → Records → `loomcast` → Edit → Proxy status **Proxied** → Save. Then run the checks in
[nginx-and-tls.md, section 8](nginx-and-tls.md#8-verify-through-cloudflare).

## 8. Authenticated origin pulls (optional, C2)

Origin pulls make nginx accept HTTPS connections only from Cloudflare presenting a client
certificate, so the origin cannot be reached around Cloudflare. Configure Cloudflare first, then
the origin; the other way round, every request fails with `400`.

### Per-hostname, with your own certificate (recommended)

This applies to `loomcast.prabhavalabs.com` only. On the owner's machine, not in the repository,
create a small private CA and a client certificate signed by it:

```bash
umask 077
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
  -subj "/CN=Loomcast origin pull CA" -keyout aop-ca.key -out aop-ca.pem
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=loomcast.prabhavalabs.com origin pull" -keyout aop-client.key -out aop-client.csr
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' >aop-client.ext
openssl x509 -req -in aop-client.csr -CA aop-ca.pem -CAkey aop-ca.key -CAcreateserial \
  -days 825 -extfile aop-client.ext -out aop-client.pem
```

1. SSL/TLS → Origin Server → Authenticated Origin Pulls → **Per-hostname** → Upload certificate:
   paste `aop-client.pem` and `aop-client.key`, then associate `loomcast.prabhavalabs.com`.
2. On the server, install the CA certificate (public, not secret) and render with origin pulls:

   ```bash
   install -m 0644 aop-ca.pem /etc/nginx/loomcast/origin-pull-ca.pem
   ```

   Then follow [nginx-and-tls.md, section 6](nginx-and-tls.md#6-full-site) with
   `LOOMCAST_ORIGIN_PULLS=1` in front of the render command.
3. Check: through Cloudflare, `https://loomcast.prabhavalabs.com/readyz` still answers; on the
   server, `curl -sS --resolve loomcast.prabhavalabs.com:443:127.0.0.1
   https://loomcast.prabhavalabs.com/healthz` now returns `400`.
4. Store `aop-ca.key` in the password manager (it signs the next client certificate) and delete
   the local key files. Renew the client certificate before its 825 days run out.

### Global, with Cloudflare's shared certificate

Download Cloudflare's CA from
`https://developers.cloudflare.com/ssl/static/authenticated_origin_pull_ca.pem`, install it as
`/etc/nginx/loomcast/origin-pull-ca.pem`, turn on SSL/TLS → Origin Server → Authenticated Origin
Pulls → **Global**, then render with `LOOMCAST_ORIGIN_PULLS=1`. Two caveats, which is why it needs
the owner's approval:

- The toggle is zone-wide. Cloudflare then offers its client certificate to every proxied origin
  in the zone. Origins that do not ask for one are unaffected, but it is still a zone change.
- The certificate is shared by all Cloudflare customers, so it proves only that the request came
  through Cloudflare, not through this zone.

## DNS-01 alternative

DNS-01 issues and renews the certificate while the record stays proxied, with no DNS-only window,
at the cost of a Cloudflare API token stored on the server. A DNS token cannot be limited to one
record: it can edit every record in the zone, so treat it as a high-value secret.

1. **Token (owner).** My Profile → API Tokens → Create Token → template **Edit zone DNS**:
   - Permissions: Zone → DNS → Edit.
   - Zone Resources: Include → Specific zone → `prabhavalabs.com`.
   - Client IP Address Filtering: Is in → `<vps-ipv4>`.
   - TTL: optional end date (renew the token before it).
2. **Plugin.** The certbot DNS plugin for Cloudflare, installed the same way as certbot itself
   (the C1 survey tells which): the `python3-certbot-dns-cloudflare` package, or for the snap,
   `snap install certbot-dns-cloudflare` after `snap set certbot trust-plugin-with-root=ok`.
   Installing it is part of the C5 go-ahead.
3. **Credentials file**, root-only:

   ```bash
   install -m 0600 /dev/null /etc/letsencrypt/loomcast-cloudflare.ini
   ${EDITOR:-nano} /etc/letsencrypt/loomcast-cloudflare.ini
   # one line:  dns_cloudflare_api_token = <your-token>
   ```

4. **Issue:**

   ```bash
   certbot certonly --dns-cloudflare \
     --dns-cloudflare-credentials /etc/letsencrypt/loomcast-cloudflare.ini \
     --dns-cloudflare-propagation-seconds 30 \
     -d loomcast.prabhavalabs.com --deploy-hook 'systemctl reload nginx'
   ```

   Renewals reuse these settings from the certificate's renewal file. Then continue with
   [nginx-and-tls.md, section 6](nginx-and-tls.md#6-full-site); the bootstrap site is still
   useful for the redirect but no longer needed for the challenge.

## Bots and non-browser clients

The studio agent (WebSocket on `/bridge/v1`) and MCP clients (`/mcp`) are not browsers. If Bot
Fight Mode or a challenge rule applies to the zone, Cloudflare may answer them with a challenge
page (`403` or `503` with a `cf-mitigated: challenge` header) and they cannot connect. On plans
where Bot Fight Mode cannot be skipped per path, the owner decides between leaving it on and
accepting the risk, or turning it off for the zone (C2). Custom WAF challenge rules can exclude
`/bridge/*` and `/mcp` for this hostname.

## Limits worth knowing

- **100 seconds** without a response byte ends a proxied request with `524`. The event stream
  sends a heartbeat every 15 s and the bridge pings its WebSocket, so both stay open; a single MCP
  call that takes longer than 100 s fails.
- **Request bodies** are limited per plan (100 MB on Free), but file uploads never pass through
  this hostname: clients send them straight to object storage with presigned URLs.

## Rollback

- Switch the `loomcast` record to DNS only, or delete it.
- Delete the `loomcast:` Configuration Rule and Cache Rule.
- Remove the per-hostname origin-pull association and certificate, and delete the DNS token if one
  was created.

None of this affects other hostnames in the zone.
