#!/bin/sh
set -eu
: "RESTORE_DATABASE_URL:?set a NEW isolated disposable database, never the serving database"
: "RESTORE_APPROVED:?set RESTORE_APPROVED=yes after checking target"
[ "$RESTORE_APPROVED" = yes ] || exit 1
[ "$#" -eq 1 ] || { echo 'Usage: restore.sh backup.dump' >&2; exit 1; }
existing_tables=$(psql "$RESTORE_DATABASE_URL" -Atc "select count(*) from pg_tables where schemaname='public'")
[ "$existing_tables" = 0 ] || { echo 'Refusing restore into a nonempty database' >&2; exit 1; }
pg_restore --dbname="$RESTORE_DATABASE_URL" --exit-on-error --single-transaction --no-owner --no-acl "$1"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM app_intents'
