# Picard PostgreSQL Collation Refresh Plan

## Goal
Clear PostgreSQL collation version mismatch warnings (currently `2.40 -> 2.42`) on picard in a safe maintenance window.

## Scope
- Databases with warnings (at least `immich`, possibly `postgres` and others).
- Services writing to those databases (`immich-server`, `paperless-*`).

## Pre-flight
1. Confirm a fresh backup exists (or create one immediately before work).
2. Confirm enough free disk for temporary index rebuild work.
3. Announce a short maintenance window.

## Execution
1. Stop write-heavy app services:
   - `immich-server.service`
   - `paperless-web.service`
   - `paperless-task-queue.service`
   - `paperless-consumer.service`
   - `paperless-scheduler.service`
2. For each affected database:
   - Rebuild collation-sensitive indexes (`REINDEX DATABASE <db>;` in maintenance context).
   - Run `ALTER DATABASE <db> REFRESH COLLATION VERSION;`.
3. Start services again.

## Verification
1. Check logs for absence of collation mismatch warnings:
   - `journalctl -u immich-server.service`
   - `journalctl -u postgresql.service`
2. Verify apps are healthy:
   - `systemctl is-active immich-server.service`
   - `systemctl is-active paperless-web.service`
3. Spot-check in app UIs (Immich search/sort, Paperless list/sort).

## Rollback
If DB behavior looks wrong after refresh:
1. Stop app services.
2. Restore the latest verified PostgreSQL backup.
3. Start services and re-validate availability.
