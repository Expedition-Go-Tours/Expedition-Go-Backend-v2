# Backup and restore drills

## What runs automatically

Two host cron jobs, both independent of the application deploy pipeline:

| Schedule | Script | What it does |
| --- | --- | --- |
| Daily 02:00 UTC | `/root/backup-db.sh` | `pg_dump -Fc` of `travio` → `/var/backups/travio/travio-YYYY-MM-DD.dump`; rsync to the off-site Storage Box; checksum verification; Better Stack heartbeat; Discord alert on failure; 14-day retention |
| Sunday 03:30 UTC | `/root/test-restore.sh` | restores the newest dump into the scratch database `travio_restore_test`, validates it, drops the scratch database |

The restore drill checks, in order:

1. `pg_restore` completes.
2. PostgreSQL extensions match production exactly (including PostGIS).
3. The public table list matches production.
4. Every table's row count is **less than or equal to** production. The dump is
   point-in-time, so restored rows may lag live writes; they must never exceed
   production.
5. Foreign-key count, index count and FK orphan integrity match.

A failure posts to the incidents channel and leaves the scratch database for
inspection. A pass logs the exact counts.

## Evidence

**Automated drill, 2026-11-15 03:30 UTC** (`/var/log/travio-backup.log`):

```
pg_restore OK
Extensions match (incl. postgis)
INFO drift AuditLog: prod=52593 restore=52592 (live writes since dump)
INFO drift Event: prod=34726 restore=34641 (live writes since dump)
Row counts: 90 exact, 2 drifted (expected live churn), 0 over-restore
FK constraints match (129)
Index count matches (455)
FK integrity: 0 orphans across 129 FKs
RESTORE DRILL COMPLETE: 92 tables (90 exact), 129 FKs, 455 indexes, 0 orphans, 0 over-restore
```

**Manual drill, 2026-11-16 15:26 UTC**, restoring
`/var/backups/travio-20261116-1158.dump` into a fresh scratch database:

| Check | Result |
| --- | --- |
| Relations in `public` | 94 (92 tables + 2 PostGIS views) |
| PostGIS | 3.6.2 |
| `_prisma_migrations` | 131, matching the live database |
| `User` / `Tour` / `Booking` | 167 / 38 / 126 |
| `StayProperty` / `StayBooking` | 2 / 0 |
| Active tours | 34 |
| Scratch database | dropped, temporary copy removed |

## Manual procedure

The daily dumps are `0600 root:root`. The `postgres` user cannot read them
directly, so copy the dump to a postgres-readable path first. Never leave the
copy behind.

```bash
STAMP=$(date +%Y%m%d%H%M)
DB="travio_restore_check_${STAMP}"
DUMP="/var/backups/travio/travio-$(date +%F).dump"
TMP="/var/lib/postgresql/travio-restore-${STAMP}.dump"

install -o postgres -g postgres -m 0600 "$DUMP" "$TMP"
sudo -u postgres createdb "$DB"
sudo -u postgres pg_restore --dbname="$DB" --no-owner --no-privileges "$TMP"

# Validate: table/view count, PostGIS, migration history, key tables.
sudo -u postgres psql -d "$DB" -tAc \
  "select count(*) from information_schema.tables where table_schema='public'"
sudo -u postgres psql -d "$DB" -tAc \
  "select extversion from pg_extension where extname='postgis'"
sudo -u postgres psql -d "$DB" -tAc 'select count(*) from "_prisma_migrations"'

sudo -u postgres dropdb "$DB"
rm -f "$TMP"
```

Use a unique scratch name. Never restore over `travio`; never run `prisma db push`.

## Limits

- The drill runs on the same host as production. It proves the **backup is
  restorable and internally consistent**, not that the service can be rebuilt
  after losing the host. An off-site restore should be exercised on staging.
- The dumps contain personal data. They stay `0600`, are never committed, and
  are never copied into the application image.
- The weekly drill uses the newest local dump. If the daily upload or local
  retention fails, the heartbeat/alert path is what surfaces it; the drill is
  not a substitute for checking the backup log.
