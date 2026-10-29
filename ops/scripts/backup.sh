#!/bin/sh
set -eu
: "DATABASE_URL:?dedicated SpreadLock database required"
: "BACKUP_DIRECTORY:?set dedicated encrypted/offsite staging directory"
umask 077
mkdir -p "$BACKUP_DIRECTORY"
backup_path="$BACKUP_DIRECTORY/spreadlock-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$backup_path"
pg_restore --list "$backup_path" >/dev/null
printf '%s\n' "$backup_path"
