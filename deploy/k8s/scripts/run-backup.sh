#!/bin/sh
# run-backup.sh — one-shot SQLite online backup.
#
# Called by the backup-sidecar schedule loop or by an operator via:
#   kubectl exec -n <agentpulse-namespace> deploy/agentpulse -c backup-sidecar \
#     -- /usr/local/bin/run-backup.sh
#
# Produces:
#   /backups/agentpulse-<TS>.db           — backup file
#   /backups/agentpulse-<TS>.db.counts.txt — row counts for verification
#   /backups/agentpulse-<TS>.db.sha256    — checksum
#
# Exit codes:
#   0 — success
#   1 — source DB missing
#   2 — cannot open source DB
#   3 — .backup command failed
#   4 — integrity_check failed (corrupt backup; backup file removed)
set -eu
umask 077

TS=$(date -u +%Y%m%dT%H%M%SZ)
SRC=/data/agentpulse.db
OUT=/backups/agentpulse-${TS}.db
OUT_TMP="${OUT}.tmp"

echo "[backup] starting: $TS"

# Preflight: source must exist.
if [ ! -f "$SRC" ]; then
	echo "[backup] ERROR: source db missing at $SRC"
	exit 1
fi

# Informational: log -wal/-shm presence (not fatal — SQLite creates them on
# open if writable; absence is normal after a clean checkpoint).
ls -la /data/agentpulse.db /data/agentpulse.db-wal /data/agentpulse.db-shm 2>&1 || true

# Probe: can we open the source?
if ! sqlite3 "$SRC" "SELECT sqlite_version();" >/dev/null 2>&1; then
	echo "[backup] ERROR: cannot open source db (sqlite3 probe failed)"
	exit 2
fi

# Online backup — sqlite3's .backup command is concurrent-safe with the
# app's writers. It uses the SQLite backup API which copies page-by-page
# and re-reads any page that changed during the copy, producing a
# consistent snapshot without exclusive locking the source.
# Write to a .tmp file first so a mid-copy SIGKILL never leaves a partial
# .db file that retention.sh would treat as valid (it only globs *.db).
sqlite3 "$SRC" ".backup '${OUT_TMP}'" || {
	echo "[backup] ERROR: .backup command failed"
	rm -f "$OUT_TMP"
	exit 3
}

# Verify the backup is not corrupt before we declare success.
if ! sqlite3 "$OUT_TMP" "PRAGMA integrity_check;" | grep -qx ok; then
	echo "[backup] ERROR: integrity_check failed on $OUT_TMP"
	rm -f "$OUT_TMP"
	exit 4
fi

# Atomic promotion: rename into final name only after a clean integrity check.
mv "$OUT_TMP" "$OUT"
chmod 600 "$OUT"

# Capture row counts as a quick sanity reference for restore verification.
# Non-fatal: schema changes may cause this to fail; log and continue.
sqlite3 "$OUT" "SELECT count(*) FROM sessions; SELECT count(*) FROM events;" >"${OUT}.counts.txt" || {
	echo "[backup] WARN: counts query failed (schema mismatch?); continuing"
	true
}
chmod 600 "${OUT}.counts.txt"
sha256sum "$OUT" >"${OUT}.sha256"
chmod 600 "${OUT}.sha256"

echo "[backup] ok: $OUT"
cat "${OUT}.counts.txt"

# Apply retention (non-fatal — a retention failure must not prevent the
# backup itself from being reported successful).
/usr/local/bin/retention.sh || echo "[retention] non-fatal failure; backup still ok"
