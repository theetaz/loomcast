# Object storage

Production keeps files in [Garage](https://garagehq.deuxfleurs.fr/), a self-hosted S3-compatible
store, on a Hetzner Cloud server in Nuremberg (NBG1). The api reaches it through its S3 API at
`https://s3.prabhavalabs.com`, behind nginx. Locally, SeaweedFS plays the same role
([local-development.md](../local-development.md)).

Earlier versions of these docs described Cloudflare R2. Production does not use R2: the
Cloudflare account has no R2 buckets.

| Bucket | Access | Holds | Expiry |
|---|---|---|---|
| `loomcast-media` | Private | Drafts, voice takes, renders, posters, frames, reference media and composed-post media | None: the app deletes what it no longer needs |
| `loomcast-public` | Public read at `https://loomcast-media.prabhavalabs.com` | Final renders, copied by the publisher at publish time under an unguessable key, for the platforms to fetch | 14 days is enough (see [Lifecycle](#lifecycle)) |
| `loomcast-backups` | Private | Nightly database backups (`daily/`, `weekly/`) | 90 days |

Bytes never pass through the api: clients upload with presigned `PUT` URLs straight to
`s3.prabhavalabs.com`, and read private files with presigned `GET` URLs. Only the api holds
storage keys.

Keys and secrets never go into this repository, a chat, an issue or shell history.

## Not yet confirmed

These were not checked when this page was corrected (2026-11-24). Confirm them on the storage
server and update this page:

- [ ] **Where backups go.** `BACKUP_S3_ENDPOINT` in `/opt/loomcast/env/backup.env` names the
  store. If it is the same Garage server, or the same machine as the database, the backups are
  not off-site: losing that server loses both. Keep them on a second machine or provider.
- [ ] Whether `loomcast-public` and `loomcast-backups` have the expiry rules below.
- [ ] The CORS rule on `loomcast-media`.
- [ ] Disk use: `garage bucket info <bucket>` for each bucket and `df -h` for the data disk.
- [ ] How Garage runs (systemd or Docker) and where `garage.toml` lives, so the commands below
  can be prefixed correctly.

## Api settings

In `/opt/loomcast/env/api.env`:

| Setting | Value |
|---|---|
| `S3_ENDPOINT` | `https://s3.prabhavalabs.com` |
| `S3_REGION` | Garage's `s3_region` from `garage.toml`: `garage` in production (Garage names it in its error replies) |
| `S3_FORCE_PATH_STYLE` | `true` |
| `S3_BUCKET`, `S3_PUBLIC_BUCKET` | `loomcast-media`, `loomcast-public` |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | The app key (below) |
| `PUBLIC_BASE_URL` | `https://loomcast-media.prabhavalabs.com` |

Restart the api after a change: `dc up -d --force-recreate --wait api`.

## Inspecting the store

Run on the storage server (prefix with `docker exec <container>` if Garage runs in Docker):

```bash
garage status                        # nodes and their state
garage bucket list
garage bucket info loomcast-media    # size, object count, keys allowed
garage bucket info loomcast-public
garage key list
```

## Keys

Two keys, each limited to the buckets it needs:

| Key | Buckets | Used by |
|---|---|---|
| `loomcast-app` | read and write on `loomcast-media` and `loomcast-public` | the api (`api.env`) |
| `loomcast-backup` | read and write on `loomcast-backups` | the backup service (`backup.env`) |

```bash
garage key create loomcast-app       # prints the key ID and secret once
garage bucket allow --read --write loomcast-media --key loomcast-app
garage bucket allow --read --write loomcast-public --key loomcast-app
```

Read access is needed for restores and for the size check after each backup upload.

## Public bucket

The platforms download published renders from `https://loomcast-media.prabhavalabs.com`, served
from `loomcast-public` without signing. In Garage that is the bucket's website access
(`garage bucket website --allow loomcast-public`) behind nginx, which terminates TLS for the
hostname. Only that bucket may be anonymously readable.

## CORS on `loomcast-media`

Browsers upload reference media with presigned `PUT` requests and preview files with presigned
`GET` requests, so `loomcast-media` must allow the app's origin. The rule is in
[`infra/storage/cors.media.json`](../../infra/storage/cors.media.json):

- `AllowedOrigins`: `https://loomcast.prabhavalabs.com` only.
- `AllowedMethods`: `GET`, `HEAD`, `PUT`.
- `AllowedHeaders`: the content type and the checksum headers a presigned upload carries.
- `ExposeHeaders`: `ETag` (the upload's hash) and the length and type.
- `MaxAgeSeconds`: 3600, so browsers cache the preflight for an hour.

Garage takes CORS through the S3 API (with the `s3` helper from [Verify](#verify)):

```bash
s3 s3api put-bucket-cors --bucket loomcast-media --cors-configuration file://cors.media.json
```

`loomcast-public` and `loomcast-backups` need no CORS: the platforms fetch public media from their
servers, and backups are never read from a browser. If the app's origin ever changes, update the
file and the rule together.

## Lifecycle

- `loomcast-public`: delete objects 14 days after upload. The publisher copies a render there
  only when the post is published, and the platforms fetch it within minutes.
- `loomcast-backups`: delete objects 90 days after upload. That covers the backup rotation, which
  keeps 14 daily and 8 weekly copies on the database server as well.
- All buckets: abort incomplete multipart uploads after 7 days.

Garage takes lifecycle rules through the S3 API (`s3api put-bucket-lifecycle-configuration`).

## Verify

Run on a machine with Docker, with the `loomcast-app` keys read without echoing them. The two
checksum settings keep the CLI's newer default integrity headers out of the requests.

```bash
read -rs -p 'Access key ID: ' AWS_ACCESS_KEY_ID; echo
read -rs -p 'Secret access key: ' AWS_SECRET_ACCESS_KEY; echo
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
S3=https://s3.prabhavalabs.com
s3() {
  docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION=garage \
    -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
    -e AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    -v "$PWD:/work" -w /work amazon/aws-cli:2.31.0 --endpoint-url "$S3" "$@"
}

printf 'probe\n' >probe.txt
s3 s3 cp probe.txt s3://loomcast-public/probe/probe.txt
curl -sS https://loomcast-media.prabhavalabs.com/probe/probe.txt     # prints probe
s3 s3 cp probe.txt s3://loomcast-media/probe/probe.txt
curl -sS -o /dev/null -w '%{http_code}\n' "$S3/loomcast-media/probe/probe.txt"   # 403: private
s3 s3 ls s3://loomcast-backups/                                   # AccessDenied: wrong key, as intended

# CORS preflight for a browser upload
curl -sS -o /dev/null -D - -X OPTIONS "$S3/loomcast-media/probe/probe.txt" \
  -H 'Origin: https://loomcast.prabhavalabs.com' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type,x-amz-checksum-sha256' |
  grep -i '^access-control-allow'

s3 s3 rm s3://loomcast-public/probe/probe.txt
s3 s3 rm s3://loomcast-media/probe/probe.txt
rm probe.txt
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

Repeat the copy, list and delete with the `loomcast-backup` key against `loomcast-backups`, and
confirm it is refused on the other two buckets.

## Rotating or revoking a key

1. `garage key create <name>-new` and allow it on the same buckets.
2. Put its ID and secret into the env file and restart the service that uses it.
3. Check the service works (the api's `/readyz`, or a manual backup run).
4. `garage key delete <old key id> --yes`.

Presigned URLs already handed out stop working when their key is deleted; uploads in progress are
retried by the web app or the studio agent. If a key may have leaked, delete it first and accept
the short outage.

## Before browser uploads go live

The app's Content Security Policy currently allows connections and media only from its own
origin. Browser uploads to the storage endpoint and previews from it need `connect-src` and
`media-src` (and `img-src` for posters) to include `https://s3.prabhavalabs.com`; showing
published renders from the public bucket needs `https://loomcast-media.prabhavalabs.com`. That is
a change to the api's headers, made together with the storage feature, not part of this runbook.
