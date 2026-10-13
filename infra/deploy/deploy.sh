#!/usr/bin/env bash
# Server-side deploy, rollback and status for the Loomcast compose project.
#
# Installed as /opt/loomcast/bin/deploy.sh (owner root, mode 0755). The deploy user reaches it
# only through an SSH forced command and a sudoers rule that allows exactly this script with no
# arguments (see authorized_keys.example and sudoers.example next to this file). That user is
# not in the docker group, so this script is the only thing it can do on the server.
#
# The command comes from SSH_ORIGINAL_COMMAND (kept by the sudoers rule), or from the
# arguments when root runs the script by hand:
#
#   deploy sha-<7 to 40 hex>   pull that release, start it and wait until it is ready;
#                              on failure start the previous release again
#   rollback                   start the previous release again
#   status                     print the current and previous release and the containers
#
# Anything else is rejected before Docker is touched. Every compose command is scoped to the
# project `loomcast`, and image clean-up only removes old tags of the two Loomcast images; it
# never prunes globally, because the host runs other applications.
#
# Exit codes: 0 done, 1 failed (rolled back when possible), 2 command rejected,
# 3 another deploy is running.
#
# Layout under /opt/loomcast:
#   env/compose.env       interpolation variables, including LOOMCAST_HTTP_PORT (root, 0600)
#   releases/<tag>/       compose project extracted from that release's image
#   current               symlink to the running release directory
#   state/current         tag of the running release
#   state/previous        tag of the release before it
#   state/history         one line per deploy, rollback and failure
set -euo pipefail
umask 022

readonly APP_IMAGE=ghcr.io/theetaz/loomcast
readonly BACKUP_IMAGE=ghcr.io/theetaz/loomcast-backup
readonly PROJECT=loomcast
readonly KEEP_RELEASES=5
readonly TAG_RE='^sha-[0-9a-f]{7,40}$'
readonly COMMAND_RE='^(deploy sha-[0-9a-f]{7,40}|rollback|status)$'

# The tests point these at a scratch directory. sudo resets the environment, so the deploy
# user cannot change them.
ROOT=${LOOMCAST_DEPLOY_ROOT:-/opt/loomcast}
READY_SECONDS=${LOOMCAST_READY_SECONDS:-60}
WAIT_SECONDS=${LOOMCAST_WAIT_SECONDS:-300}
SYSLOG=${LOOMCAST_DEPLOY_SYSLOG:-1}

ENV_FILE=$ROOT/env/compose.env
RELEASES=$ROOT/releases
STATE=$ROOT/state

LOCKED=0
EXTRACT_CID=
EXTRACT_DIR=
PORT=
current=
previous=

log() {
  printf '%s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
  if [ "$SYSLOG" = 1 ] && command -v logger >/dev/null 2>&1; then
    logger -t loomcast-deploy -- "$*" || true
  fi
}

cleanup() {
  if [ -n "$EXTRACT_CID" ]; then
    docker rm "$EXTRACT_CID" >/dev/null 2>&1 || true
  fi
  if [ -n "$EXTRACT_DIR" ]; then
    rm -rf "$EXTRACT_DIR"
  fi
  if [ "$LOCKED" = 1 ]; then
    rm -rf "$STATE/lock"
  fi
}
trap cleanup EXIT

reject() {
  # The rejected text is not echoed back.
  printf 'deploy: rejected command; expected: deploy sha-<hex> | rollback | status\n' >&2
  exit 2
}

# ---------------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------------

read_tag_file() {
  local value=
  if [ -f "$1" ]; then
    value=$(head -n 1 "$1")
  fi
  if [[ $value =~ $TAG_RE ]]; then
    printf '%s' "$value"
  fi
}

read_state() {
  current=$(read_tag_file "$STATE/current")
  previous=$(read_tag_file "$STATE/previous")
}

write_tag_file() {
  printf '%s\n' "$2" >"$1.tmp"
  mv -f "$1.tmp" "$1"
}

record_history() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$STATE/history"
}

# Records a successful start of $1, which replaced $2 (may be empty).
record_success() {
  local started=$1 replaced=$2
  if [ -n "$replaced" ] && [ "$replaced" != "$started" ]; then
    write_tag_file "$STATE/previous" "$replaced"
    previous=$replaced
  fi
  write_tag_file "$STATE/current" "$started"
  current=$started
  ln -sfn "$RELEASES/$started" "$ROOT/current"
}

acquire_lock() {
  local pid
  if ! mkdir "$STATE/lock" 2>/dev/null; then
    pid=$(cat "$STATE/lock/pid" 2>/dev/null || true)
    if [[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      log "another deploy is running (pid $pid)"
      exit 3
    fi
    log "removing a stale lock"
    rm -rf "$STATE/lock"
    if ! mkdir "$STATE/lock" 2>/dev/null; then
      log "could not take the deploy lock"
      exit 3
    fi
  fi
  LOCKED=1
  printf '%s\n' "$$" >"$STATE/lock/pid"
}

# ---------------------------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------------------------

load_port() {
  if [ ! -r "$ENV_FILE" ]; then
    log "missing $ENV_FILE; see docs/runbooks/deploy.md"
    exit 1
  fi
  PORT=$(sed -n 's/^LOOMCAST_HTTP_PORT=\([0-9][0-9]*\)[[:space:]]*$/\1/p' "$ENV_FILE" | tail -n 1)
  if ! [[ $PORT =~ ^[0-9]{1,5}$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    log "LOOMCAST_HTTP_PORT is not set to a port in $ENV_FILE"
    exit 1
  fi
}

# compose <tag> <args...>: the release's compose file, always as project loomcast.
compose() {
  local tag=$1
  shift
  LOOMCAST_TAG=$tag docker compose -p "$PROJECT" \
    --project-directory "$RELEASES/$tag" \
    -f "$RELEASES/$tag/compose.prod.yml" \
    --env-file "$ENV_FILE" "$@"
}

# Pulls both images of a release unless they are already on the server, so a rollback works
# while the registry is unreachable. Release tags are never reused.
pull_release() {
  local image
  for image in "$APP_IMAGE:$1" "$BACKUP_IMAGE:$1"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      continue
    fi
    log "pulling $image"
    if ! docker pull --quiet "$image" >/dev/null; then
      log "could not pull $image"
      return 1
    fi
  done
}

# Copies /app/infra/compose out of the app image into releases/<tag>.
extract_release() {
  local tag=$1
  mkdir -p "$RELEASES"
  EXTRACT_DIR=$(mktemp -d "$RELEASES/.extract.XXXXXX")
  if ! EXTRACT_CID=$(docker create --pull never --network none "$APP_IMAGE:$tag"); then
    EXTRACT_CID=
    log "could not create a container from $APP_IMAGE:$tag"
    return 1
  fi
  if ! docker cp "$EXTRACT_CID:/app/infra/compose/." "$EXTRACT_DIR/" >/dev/null; then
    log "could not copy the compose project out of $APP_IMAGE:$tag"
    return 1
  fi
  docker rm "$EXTRACT_CID" >/dev/null || true
  EXTRACT_CID=
  if [ ! -f "$EXTRACT_DIR/compose.prod.yml" ]; then
    log "$APP_IMAGE:$tag has no compose.prod.yml"
    return 1
  fi
  rm -rf "${RELEASES:?}/$tag"
  mv "$EXTRACT_DIR" "$RELEASES/$tag"
  EXTRACT_DIR=
}

# Polls /readyz on the loopback port for READY_SECONDS.
wait_ready() {
  curl -fsS -o /dev/null --max-time 5 \
    --retry 30 --retry-delay 2 --retry-max-time "$READY_SECONDS" \
    --retry-all-errors --retry-connrefused \
    "http://127.0.0.1:$PORT/readyz"
}

# Starts an extracted release and waits for it. Returns 1 when it does not become ready.
start_release() {
  local tag=$1
  log "starting $tag"
  if ! compose "$tag" up -d --wait --wait-timeout "$WAIT_SECONDS" --remove-orphans; then
    log "$tag did not start healthy"
    return 1
  fi
  if ! wait_ready; then
    log "$tag was not ready within ${READY_SECONDS}s"
    return 1
  fi
}

# Keeps the newest KEEP_RELEASES tags of each Loomcast image, plus the current and previous
# release, and removes older tags one by one. Never prunes globally.
prune() {
  local repo tag dir kept keep_list=
  for repo in "$APP_IMAGE" "$BACKUP_IMAGE"; do
    kept=0
    while IFS= read -r tag; do
      [[ $tag =~ $TAG_RE ]] || continue
      if [ "$tag" = "$current" ] || [ "$tag" = "$previous" ] || [ "$kept" -lt "$KEEP_RELEASES" ]; then
        kept=$((kept + 1))
        keep_list="$keep_list $tag "
        continue
      fi
      log "removing $repo:$tag"
      docker image rm "$repo:$tag" >/dev/null || log "could not remove $repo:$tag"
    done < <(docker image ls "$repo" --format '{{.Tag}}')
  done
  for dir in "$RELEASES"/sha-*; do
    [ -d "$dir" ] || continue
    tag=${dir##*/}
    case "$keep_list" in
      *" $tag "*) ;;
      *) rm -rf "$dir" ;;
    esac
  done
}

# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------

cmd_deploy() {
  local target=$1 replaced
  read_state
  replaced=$current
  log "deploying $target (running: ${replaced:-none})"

  if ! pull_release "$target" || ! extract_release "$target"; then
    log "nothing was changed"
    record_history "failed $target (not started)"
    return 1
  fi

  if start_release "$target"; then
    record_success "$target" "$replaced"
    record_history "deployed $target"
    prune
    log "deployed $target"
    return 0
  fi

  record_history "failed $target"
  if [ -z "$replaced" ] || [ "$replaced" = "$target" ]; then
    log "no earlier release to roll back to"
    return 1
  fi
  log "rolling back to $replaced"
  if [ ! -f "$RELEASES/$replaced/compose.prod.yml" ] && ! extract_release "$replaced"; then
    log "rollback to $replaced failed: its compose project is missing"
    record_history "rollback to $replaced failed"
    return 1
  fi
  if start_release "$replaced"; then
    log "rolled back to $replaced"
    record_history "rolled back to $replaced"
  else
    log "rollback to $replaced failed; the service needs attention"
    record_history "rollback to $replaced failed"
  fi
  return 1
}

cmd_rollback() {
  read_state
  if [ -z "$previous" ]; then
    log "no previous release is recorded"
    return 1
  fi
  log "rolling back from ${current:-none} to $previous"
  cmd_deploy "$previous"
}

cmd_status() {
  read_state
  printf 'current:  %s\nprevious: %s\n' "${current:-none}" "${previous:-none}"
  if [ -n "$current" ] && [ -f "$RELEASES/$current/compose.prod.yml" ]; then
    compose "$current" ps --format 'table {{.Service}}\t{{.Status}}' || true
  fi
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/readyz"; then
    echo "readyz:   ok"
  else
    echo "readyz:   failing"
    return 1
  fi
}

main() {
  local raw value
  if [ "$#" -gt 0 ]; then
    raw="$*"
  else
    raw=${SSH_ORIGINAL_COMMAND:-}
  fi
  if [ "${#raw}" -gt 64 ] || ! [[ $raw =~ $COMMAND_RE ]]; then
    reject
  fi

  for value in "$READY_SECONDS" "$WAIT_SECONDS"; do
    [[ $value =~ ^[0-9]{1,4}$ ]] || { log "invalid timeout setting"; exit 1; }
  done
  load_port
  mkdir -p "$STATE"

  case "$raw" in
    status) cmd_status ;;
    rollback)
      acquire_lock
      cmd_rollback
      ;;
    deploy\ *)
      acquire_lock
      cmd_deploy "${raw#deploy }"
      ;;
  esac
}

main "$@"
