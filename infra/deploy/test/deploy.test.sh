#!/usr/bin/env bash
# Tests for infra/deploy/deploy.sh. Needs no Docker and no network: a fake `docker` and a fake
# `curl` come first on PATH and act on a scratch state directory.
#
#   bash infra/deploy/test/deploy.test.sh
#
# Covers command validation (nothing reaches Docker for a rejected command), the success path,
# the previous-release record, rollback when compose fails or /readyz stays red, the rollback
# command, the lock, and image clean-up limited to the two Loomcast repositories.
# Some cases pass shell syntax as literal text on purpose, to prove it is never run.
# shellcheck disable=SC2016
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY=$HERE/../deploy.sh
WORK=$(mktemp -d "${TMPDIR:-/tmp}/loomcast-deploy-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

APP=ghcr.io/theetaz/loomcast
BACKUP=ghcr.io/theetaz/loomcast-backup
PORT=18790
PASSED=0
FAILED=0

# ---------------------------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------------------------

BIN=$WORK/bin
mkdir -p "$BIN"

# Fake docker. State in $FAKE_STATE:
#   calls      every invocation, prefixed with the LOOMCAST_TAG it saw
#   images     local images, newest first, one repo:tag per line
#   running    tag that the last successful `compose up` started
#   pull-fail, up-fail   refs or tags for which that step fails
cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -eu
S=${FAKE_STATE:?}
printf 'LOOMCAST_TAG=%s docker %s\n' "${LOOMCAST_TAG:-}" "$*" >>"$S/calls"
listed() { [ -f "$S/$1" ] && grep -qxF -- "$2" "$S/$1"; }
case "$1" in
  pull)
    ref=${*: -1}
    if listed pull-fail "$ref"; then echo "fake: pull failed" >&2; exit 1; fi
    { echo "$ref"; grep -vxF -- "$ref" "$S/images" || true; } >"$S/images.new"
    mv "$S/images.new" "$S/images"
    echo "$ref"
    ;;
  image)
    case "$2" in
      inspect) grep -qxF -- "$3" "$S/images" ;;
      ls)
        repo=$3
        while IFS= read -r ref; do
          [ "${ref%:*}" = "$repo" ] && echo "${ref##*:}"
        done <"$S/images"
        ;;
      rm)
        grep -qxF -- "$3" "$S/images" || exit 1
        grep -vxF -- "$3" "$S/images" >"$S/images.new" || true
        mv "$S/images.new" "$S/images"
        ;;
      *) echo "fake docker: unexpected: $*" >&2; exit 97 ;;
    esac
    ;;
  create)
    ref=${*: -1}
    grep -qxF -- "$ref" "$S/images" || { echo "fake: no such image" >&2; exit 1; }
    cid=cid$RANDOM
    echo "$ref" >"$S/$cid"
    echo "$cid"
    ;;
  cp)
    cid=${2%%:*}
    [ "${2#*:}" = /app/infra/compose/. ] || exit 96
    mkdir -p "$3"
    printf '# compose project from %s\n' "$(cat "$S/$cid")" >"$3/compose.prod.yml"
    ;;
  rm) rm -f "$S/$2" ;;
  compose)
    shift
    project=
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) project=$2; shift 2 ;;
        -f | --env-file | --project-directory) shift 2 ;;
        *) break ;;
      esac
    done
    [ "$project" = loomcast ] || { echo "fake: compose without -p loomcast" >&2; exit 95; }
    case "$1" in
      up)
        if listed up-fail "$LOOMCAST_TAG"; then echo "fake: container unhealthy" >&2; exit 1; fi
        echo "$LOOMCAST_TAG" >"$S/running"
        ;;
      ps) echo "SERVICE STATUS" ;;
      *) echo "fake docker: unexpected compose: $*" >&2; exit 97 ;;
    esac
    ;;
  *) echo "fake docker: unexpected: $*" >&2; exit 97 ;;
esac
FAKE

# Fake curl: /readyz is green unless the running tag is listed in `unhealthy`.
cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
S=${FAKE_STATE:?}
printf 'curl %s\n' "$*" >>"$S/calls"
[ "${*: -1}" = "http://127.0.0.1:${FAKE_PORT:?}/readyz" ] || exit 98
tag=$(cat "$S/running" 2>/dev/null || true)
[ -n "$tag" ] || exit 7
if [ -f "$S/unhealthy" ] && grep -qxF -- "$tag" "$S/unhealthy"; then exit 22; fi
exit 0
FAKE
chmod +x "$BIN/docker" "$BIN/curl"

# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------

CASE=
ROOT=
STATE=
OUT=
STATUS=

new_case() {
  CASE=$1
  ROOT=$WORK/case-$PASSED-$FAILED-$RANDOM/opt
  STATE=$ROOT/../fake
  mkdir -p "$ROOT/env" "$STATE"
  printf 'LOOMCAST_TAG=main\nLOOMCAST_HTTP_PORT=%s\n' "$PORT" >"$ROOT/env/compose.env"
  : >"$STATE/images"
  : >"$STATE/calls"
}

# run_ssh "<SSH_ORIGINAL_COMMAND>" or run_args <args...>: runs the script with the environment
# sudo would leave it.
run_with() {
  set +e
  OUT=$(env -i PATH="$BIN:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK" \
    FAKE_STATE="$STATE" FAKE_PORT="$PORT" LOOMCAST_DEPLOY_ROOT="$ROOT" \
    LOOMCAST_DEPLOY_SYSLOG=0 "$@" 2>&1)
  STATUS=$?
  set -e
}
run_ssh() { run_with SSH_ORIGINAL_COMMAND="$1" bash "$DEPLOY"; }
run_args() { run_with bash "$DEPLOY" "$@"; }

pass() {
  PASSED=$((PASSED + 1))
  printf 'PASS  %s\n' "$CASE: $1"
}
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %s\n' "$CASE: $1"
  printf '      exit %s, output:\n' "$STATUS"
  printf '%s\n' "$OUT" | sed 's/^/      | /'
}

expect_status() {
  if [ "$STATUS" = "$1" ]; then pass "exit $1"; else fail "expected exit $1"; fi
}
expect_file() { # file expected-first-line
  local got=
  [ -f "$1" ] && got=$(head -n 1 "$1")
  if [ "$got" = "$2" ]; then pass "${1##*/} is '${2:-<empty>}'"; else fail "${1##*/} is '$got', expected '$2'"; fi
}
expect_no_file() {
  if [ ! -e "$1" ]; then pass "no ${1##*/}"; else fail "${1##*/} should not exist"; fi
}
expect_calls() { # grep -E pattern, description
  if grep -qE -- "$1" "$STATE/calls"; then pass "$2"; else fail "$2 (no call matching $1)"; fi
}
expect_no_calls() {
  if grep -qE -- "$1" "$STATE/calls"; then fail "$2 (found $(grep -E -- "$1" "$STATE/calls" | head -n 1))"; else pass "$2"; fi
}
expect_output() {
  if printf '%s\n' "$OUT" | grep -qE -- "$1"; then pass "$2"; else fail "$2"; fi
}
expect_images() { # repo, expected tags newest first (space separated)
  local got
  got=$(grep -E "^$1:" "$STATE/images" | sed "s#^$1:##" | tr '\n' ' ' | sed 's/ $//')
  if [ "$got" = "$2" ]; then pass "$1 keeps: $2"; else fail "$1 keeps '$got', expected '$2'"; fi
}
expect_scoped() {
  if grep -E 'docker compose' "$STATE/calls" | grep -vqE 'docker compose -p loomcast '; then
    fail "every compose call uses -p loomcast"
  else
    pass "every compose call uses -p loomcast"
  fi
  expect_no_calls 'prune|docker (system|volume|network|container|builder) |docker (stop|kill) |docker rm -f' "no global clean-up"
}

sha() { printf 'sha-%07x\n' "$1"; }
# Deploys a tag that should succeed, quietly, as set-up for a case.
given_deployed() {
  run_ssh "deploy $1"
  if [ "$STATUS" != 0 ]; then fail "set-up deploy of $1"; fi
}

# ---------------------------------------------------------------------------------------------
# Command validation
# ---------------------------------------------------------------------------------------------

new_case "validation"
for cmd in "" "deploy" "deploy " "deploy latest" "deploy main" "deploy sha-abc" \
  "deploy sha-ABCDEF1" "deploy sha-abcdefg" "deploy sha-$(printf 'a%.0s' {1..41})" \
  "deploy sha-abcdef1 extra" " deploy sha-abcdef1" "deploy  sha-abcdef1" \
  "deploy sha-abcdef1;id" 'deploy sha-abcdef1$(id)' "deploy sha-abcdef1 && id" \
  $'deploy sha-abcdef1\nid' $'status\nrollback' "status --all" "rollback sha-abcdef1" \
  "Status" "shell" "sh -c id" "scp -t /tmp" "deploy ../sha-abcdef1" "deploy sha-*"; do
  run_ssh "$cmd"
  if [ "$STATUS" = 2 ]; then pass "rejects $(printf '%q' "$cmd")"; else fail "rejects $(printf '%q' "$cmd")"; fi
done
if [ -s "$STATE/calls" ]; then fail "no docker or curl call for rejected commands"; else pass "no docker or curl call for rejected commands"; fi
expect_no_file "$ROOT/state"

new_case "validation (arguments, as root)"
run_args deploy "sha-abcdef1; id"
expect_status 2
run_args deploy
expect_status 2
if [ -s "$STATE/calls" ]; then fail "no docker call"; else pass "no docker call"; fi

new_case "missing compose.env"
rm "$ROOT/env/compose.env"
run_ssh "deploy $(sha 1)"
expect_status 1
expect_output 'missing .*compose.env' "explains the missing file"
if [ -s "$STATE/calls" ]; then fail "no docker call"; else pass "no docker call"; fi

new_case "compose.env without a port"
printf 'LOOMCAST_TAG=main\nLOOMCAST_HTTP_PORT=$(id)\n' >"$ROOT/env/compose.env"
run_ssh "deploy $(sha 1)"
expect_status 1
if [ -s "$STATE/calls" ]; then fail "no docker call"; else pass "no docker call"; fi

# ---------------------------------------------------------------------------------------------
# Success path
# ---------------------------------------------------------------------------------------------

new_case "first deploy"
run_ssh "deploy $(sha 1)"
expect_status 0
expect_calls "docker pull --quiet $APP:$(sha 1)\$" "pulls the app image"
expect_calls "docker pull --quiet $BACKUP:$(sha 1)\$" "pulls the backup image"
expect_calls "docker create --pull never --network none $APP:$(sha 1)\$" "creates an extraction container"
expect_calls "docker cp cid[0-9]+:/app/infra/compose/\. $ROOT/releases/\.extract\." "extracts the compose project"
expect_calls "^LOOMCAST_TAG=$(sha 1) docker compose -p loomcast --project-directory $ROOT/releases/$(sha 1) -f $ROOT/releases/$(sha 1)/compose.prod.yml --env-file $ROOT/env/compose.env up -d --wait" \
  "starts the release with its own tag"
expect_calls "^curl .*--retry-max-time 60 .*http://127.0.0.1:$PORT/readyz\$" "polls readyz on the loopback port for 60 s"
expect_no_calls "docker rm -f" "never force-removes containers"
expect_file "$ROOT/state/current" "$(sha 1)"
expect_no_file "$ROOT/state/previous"
expect_file "$ROOT/releases/$(sha 1)/compose.prod.yml" "# compose project from $APP:$(sha 1)"
if [ "$(readlink "$ROOT/current")" = "$ROOT/releases/$(sha 1)" ]; then pass "current link"; else fail "current link"; fi
if find "$ROOT/releases" -name ".extract.*" | grep -q .; then fail "no extraction leftovers"; else pass "no extraction leftovers"; fi
if [ ! -e "$ROOT/state/lock" ]; then pass "lock released"; else fail "lock released"; fi
if grep -qE "docker rm cid[0-9]+$" "$STATE/calls"; then pass "removes the extraction container"; else fail "removes the extraction container"; fi
expect_scoped

new_case "second deploy records the previous release"
given_deployed "$(sha 1)"
run_ssh "deploy $(sha 2)"
expect_status 0
expect_file "$ROOT/state/current" "$(sha 2)"
expect_file "$ROOT/state/previous" "$(sha 1)"
expect_file "$STATE/running" "$(sha 2)"
run_ssh "deploy $(sha 2)"
expect_status 0
expect_file "$ROOT/state/previous" "$(sha 1)"

new_case "an image already on the server is not pulled again"
given_deployed "$(sha 1)"
: >"$STATE/calls"
run_args deploy "$(sha 1)"
expect_status 0
expect_no_calls "docker pull" "no pull"

new_case "status"
given_deployed "$(sha 1)"
given_deployed "$(sha 2)"
run_ssh "status"
expect_status 0
expect_output "current: +$(sha 2)" "prints the current release"
expect_output "previous: +$(sha 1)" "prints the previous release"
expect_output "readyz: +ok" "prints readiness"

# ---------------------------------------------------------------------------------------------
# Failures and rollback
# ---------------------------------------------------------------------------------------------

new_case "readyz stays red: roll back"
given_deployed "$(sha 1)"
given_deployed "$(sha 2)"
sha 3 >"$STATE/unhealthy"
run_ssh "deploy $(sha 3)"
expect_status 1
expect_output "not ready within 60s" "reports the failed readiness check"
expect_output "rolled back to $(sha 2)" "reports the rollback"
expect_calls "^LOOMCAST_TAG=$(sha 3) docker compose -p loomcast .* up " "started the new release"
expect_file "$STATE/running" "$(sha 2)"
expect_file "$ROOT/state/current" "$(sha 2)"
expect_file "$ROOT/state/previous" "$(sha 1)"
if grep -q "failed $(sha 3)" "$ROOT/state/history"; then pass "history records the failure"; else fail "history records the failure"; fi
expect_scoped

new_case "compose up fails: roll back"
given_deployed "$(sha 1)"
sha 2 >"$STATE/up-fail"
run_ssh "deploy $(sha 2)"
expect_status 1
expect_output "did not start healthy" "reports the failed start"
expect_file "$STATE/running" "$(sha 1)"
expect_file "$ROOT/state/current" "$(sha 1)"
expect_no_file "$ROOT/state/previous"

new_case "pull fails: nothing changes"
given_deployed "$(sha 1)"
: >"$STATE/calls"
echo "$BACKUP:$(sha 2)" >"$STATE/pull-fail"
run_ssh "deploy $(sha 2)"
expect_status 1
expect_output "nothing was changed" "says nothing changed"
expect_no_calls "docker compose" "never runs compose"
expect_file "$STATE/running" "$(sha 1)"
expect_file "$ROOT/state/current" "$(sha 1)"

new_case "first deploy fails: no rollback target"
sha 1 >"$STATE/unhealthy"
run_ssh "deploy $(sha 1)"
expect_status 1
expect_output "no earlier release to roll back to" "says there is nothing to roll back to"
expect_no_file "$ROOT/state/current"

new_case "rollback fails too"
given_deployed "$(sha 1)"
printf '%s\n%s\n' "$(sha 1)" "$(sha 2)" >"$STATE/unhealthy"
run_ssh "deploy $(sha 2)"
expect_status 1
expect_output "rollback to $(sha 1) failed" "reports the failed rollback"
expect_file "$ROOT/state/current" "$(sha 1)"

# ---------------------------------------------------------------------------------------------
# The rollback command
# ---------------------------------------------------------------------------------------------

new_case "rollback"
given_deployed "$(sha 1)"
given_deployed "$(sha 2)"
run_ssh "rollback"
expect_status 0
expect_file "$STATE/running" "$(sha 1)"
expect_file "$ROOT/state/current" "$(sha 1)"
expect_file "$ROOT/state/previous" "$(sha 2)"

new_case "rollback without a previous release"
given_deployed "$(sha 1)"
run_ssh "rollback"
expect_status 1
expect_output "no previous release" "explains why"
expect_file "$STATE/running" "$(sha 1)"

# ---------------------------------------------------------------------------------------------
# Lock
# ---------------------------------------------------------------------------------------------

new_case "a running deploy holds the lock"
mkdir -p "$ROOT/state/lock"
echo "$$" >"$ROOT/state/lock/pid"
run_ssh "deploy $(sha 1)"
expect_status 3
expect_no_calls "docker" "no docker call"
if [ -d "$ROOT/state/lock" ]; then pass "leaves the other deploy's lock"; else fail "leaves the other deploy's lock"; fi

new_case "a stale lock is taken over"
mkdir -p "$ROOT/state/lock"
echo 999999 >"$ROOT/state/lock/pid"
run_ssh "deploy $(sha 1)"
expect_status 0

# ---------------------------------------------------------------------------------------------
# Clean-up
# ---------------------------------------------------------------------------------------------

new_case "keeps the last five releases of each Loomcast image only"
printf '%s\n' "ghcr.io/theetaz/other:sha-0000001" "postgres:17-alpine" >"$STATE/images"
for n in 1 2 3 4 5 6 7; do given_deployed "$(sha "$n")"; done
expect_images "$APP" "$(sha 7) $(sha 6) $(sha 5) $(sha 4) $(sha 3)"
expect_images "$BACKUP" "$(sha 7) $(sha 6) $(sha 5) $(sha 4) $(sha 3)"
expect_images "ghcr.io/theetaz/other" "sha-0000001"
expect_images "postgres" "17-alpine"
expect_calls "docker image rm $APP:$(sha 1)\$" "removes old app tags by name"
expect_calls "docker image rm $BACKUP:$(sha 1)\$" "removes old backup tags by name"
if [ "$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 5 ]; then
  pass "keeps five release directories"
else
  fail "keeps five release directories ($(find "$ROOT/releases" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' '))"
fi
expect_scoped

new_case "never removes the current or previous release"
for n in 1 2 3 4 5 6; do given_deployed "$(sha "$n")"; done
# Roll back to an old release by tag: it becomes current, 6 becomes previous.
given_deployed "$(sha 2)"
for n in 7 8 9 10 11; do echo "$APP:$(sha "$n")"; done >"$STATE/images.newer"
cat "$STATE/images" >>"$STATE/images.newer"
mv "$STATE/images.newer" "$STATE/images"
run_ssh "deploy $(sha 12)"
expect_status 0
if grep -qxF "$APP:$(sha 2)" "$STATE/images"; then pass "keeps the previous release image"; else fail "keeps the previous release image"; fi
if [ -d "$ROOT/releases/$(sha 2)" ]; then pass "keeps the previous release directory"; else fail "keeps the previous release directory"; fi

# ---------------------------------------------------------------------------------------------

printf '\n%s passed, %s failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
