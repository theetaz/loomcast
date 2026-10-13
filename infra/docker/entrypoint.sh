#!/bin/sh
# Entry point of the Loomcast production image.
#
#   start (default)  apply pending migrations under an advisory lock, then serve
#   migrate          apply pending migrations and exit
#   serve            serve without migrating
#   admin <args>     the admin CLI, for example `admin create --email ... --role owner`
#
# Any other first argument runs as a command, for example `id -u`.
set -eu

cd /app

command=${1:-start}
[ "$#" -gt 0 ] && shift

case "$command" in
  start) exec node dist/cli/migrate-and-start.mjs "$@" ;;
  migrate) exec node dist/cli/migrate-and-start.mjs --migrate-only ;;
  serve) exec node dist/server.mjs ;;
  admin) exec node dist/cli/admin.mjs "$@" ;;
  *) exec "$command" "$@" ;;
esac
