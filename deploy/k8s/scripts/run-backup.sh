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
# AGENTPULSE_BACKUP_SRC, AGENTPULSE_BACKUP_DIR, and AGENTPULSE_RETENTION_SCRIPT
# are overridable via env for tests against a temp DB/dir; the backup-sidecar
# container never sets them and gets the hardcoded production paths below.
#
# Exit codes:
#   0 — success
#   1 — source DB missing
#   2 — cannot open source DB
#   3 — insufficient free space for the VACUUM INTO snapshot
#   4 — unsafe backup path (embeds a single quote; refused)
#   5 — VACUUM INTO command failed
#   6 — integrity_check failed (corrupt backup; tmp file removed)
#   7 — promotion rename (mv tmp -> final name) failed
# 143 — interrupted by SIGINT/SIGTERM (128 + 15); tmp file removed
set -eu
umask 077

TS=$(date -u +%Y%m%dT%H%M%SZ)
SRC="${AGENTPULSE_BACKUP_SRC:-/data/agentpulse.db}"
BACKUP_DIR="${AGENTPULSE_BACKUP_DIR:-/backups}"
RETENTION_SCRIPT="${AGENTPULSE_RETENTION_SCRIPT:-/usr/local/bin/retention.sh}"
OUT="${BACKUP_DIR}/agentpulse-${TS}.db"
OUT_TMP="${OUT}.tmp"

# Belt-and-suspenders cleanup: a SIGINT/SIGTERM (e.g. a graceful pod
# termination) must not leave a partial agentpulse-<TS>.db.tmp behind —
# retention.sh only globs agentpulse-*.db (no .tmp), so a leaked tmp file
# would sit on the backups PVC forever. cleanup_tmp is idempotent and
# disarmed (OUT_TMP cleared) once the promotion rename below succeeds, so
# it is a no-op for the rest of the script's lifetime after that point.
# A SIGKILL cannot be trapped at all — the startup sweep below is what
# catches that case, on the next run.
cleanup_tmp() {
	if [ -n "${OUT_TMP:-}" ]; then
		rm -f "$OUT_TMP" 2>/dev/null || true
	fi
}
trap cleanup_tmp EXIT
trap 'cleanup_tmp; echo "[backup] ERROR: interrupted by signal; tmp file removed"; exit 143' INT TERM

echo "[backup] starting: $TS"
echo "[backup] $(sqlite3 -version)"

# Startup sweep: a prior run killed with SIGKILL (which cannot be trapped)
# can leave agentpulse-*.db.tmp behind indefinitely — retention.sh only
# globs agentpulse-*.db (no .tmp) and would never remove it. Clear anything
# older than 60 minutes before starting a new backup.
if [ -d "$BACKUP_DIR" ]; then
	SWEPT=$(find "$BACKUP_DIR" -maxdepth 1 -name 'agentpulse-*.db.tmp' -mmin +60 -print -delete 2>/dev/null || true)
	if [ -n "$SWEPT" ]; then
		echo "[backup] swept stale tmp file(s) older than 60m:"
		echo "$SWEPT"
	fi
fi

# Preflight: source must exist.
if [ ! -f "$SRC" ]; then
	echo "[backup] ERROR: source db missing at $SRC"
	exit 1
fi

# Informational: log -wal/-shm presence (not fatal — SQLite creates them on
# open if writable; absence is normal after a clean checkpoint).
ls -la "$SRC" "${SRC}-wal" "${SRC}-shm" 2>&1 || true

# Probe: can we open the source?
if ! sqlite3 "$SRC" "SELECT sqlite_version();" >/dev/null 2>&1; then
	echo "[backup] ERROR: cannot open source db (sqlite3 probe failed)"
	exit 2
fi

# VACUUM INTO takes its output path as a SQL string literal, not a shell
# argument — an embedded single quote would terminate the literal early and
# corrupt the statement. Neither $BACKUP_DIR nor $TS should ever produce one,
# but refuse outright rather than guess if one shows up.
case "$OUT_TMP" in
*\'*)
	echo "[backup] ERROR: refusing unsafe backup path containing a single quote: $OUT_TMP"
	exit 4
	;;
esac

# Free-space preflight: VACUUM INTO writes a full fresh copy of the database,
# so the backup filesystem needs roughly one DB-size worth of headroom.
DB_SIZE_BYTES=$(wc -c <"$SRC" | tr -d ' ')
AVAIL_KB=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
AVAIL_BYTES=$((AVAIL_KB * 1024))
if [ "$AVAIL_BYTES" -lt "$DB_SIZE_BYTES" ]; then
	echo "[backup] ERROR: insufficient free space in $BACKUP_DIR (need ~${DB_SIZE_BYTES} bytes, have ${AVAIL_BYTES} bytes)"
	exit 3
fi

# Snapshot via VACUUM INTO. sqlite3's old .backup command uses the SQLite
# backup API, which copies page-by-page and restarts the copy whenever a
# WAL checkpoint lands mid-copy — under sustained concurrent write load it
# can livelock, restarting forever instead of finishing (AGEN-54: observed
# stalled at a fixed offset for 20+ minutes in production; history showed
# 12-15h completions). VACUUM INTO instead takes a single read transaction
# and writes the whole live-page set in one bounded pass; it is read-only
# against the source, so it is safe to run against the live, actively-
# written DB. Write to a .tmp file first so a mid-copy SIGKILL never leaves
# a partial .db file that retention.sh would treat as valid (it only globs
# *.db).
# busy_timeout guards against a transient SQLITE_BUSY when acquiring the
# read snapshot under write load; VACUUM INTO itself does not block writers
# once it has started.
# Escape any embedded single quote by doubling it (SQL string literal
# escaping) before splicing the path into the statement — the case guard
# above already refuses this case, so this is defense in depth, not the
# primary safeguard.
OUT_TMP_SQL=$(printf '%s' "$OUT_TMP" | sed "s/'/''/g")
sqlite3 "$SRC" "PRAGMA busy_timeout=5000; VACUUM INTO '${OUT_TMP_SQL}';" || {
	echo "[backup] ERROR: VACUUM INTO failed"
	exit 5
}

# Verify the backup is not corrupt before we declare success. Opened
# read-only (mode=ro): if OUT_TMP was removed out from under us (e.g. by
# the signal trap above racing a still-running VACUUM INTO), a read-write
# open would silently create a fresh empty database and integrity_check
# would report "ok" on it — a phantom empty backup. mode=ro instead fails
# to open, which we treat the same as a corrupt/missing backup.
if ! sqlite3 "file:${OUT_TMP}?mode=ro" "PRAGMA integrity_check;" 2>/dev/null | grep -qx ok; then
	echo "[backup] ERROR: integrity_check failed on $OUT_TMP"
	exit 6
fi

# Atomic promotion: rename into final name only after a clean integrity check.
mv "$OUT_TMP" "$OUT" || {
	echo "[backup] ERROR: promotion rename failed"
	rm -f "$OUT_TMP"
	exit 7
}
# Disarm cleanup_tmp: the file at $OUT_TMP no longer exists (renamed to
# $OUT), so there is nothing left for the trap to remove.
OUT_TMP=""
chmod 600 "$OUT"

# Capture row counts as a quick sanity reference for restore verification.
# Non-fatal: schema changes may cause this to fail; log and continue.
sqlite3 "$OUT" "SELECT count(*) FROM sessions; SELECT count(*) FROM events;" >"${OUT}.counts.txt" || {
	echo "[backup] WARN: counts query failed (schema mismatch?); continuing"
	true
}
chmod 600 "${OUT}.counts.txt"

# Checksum the backup. Non-fatal: a checksum hiccup must not make an
# otherwise-good backup look failed or skip retention.
sha256sum "$OUT" >"${OUT}.sha256" || {
	echo "[backup] WARN: sha256sum failed (checksum missing); continuing"
	true
}
chmod 600 "${OUT}.sha256"

echo "[backup] ok: $OUT"
cat "${OUT}.counts.txt"

# Apply retention (non-fatal — a retention failure must not prevent the
# backup itself from being reported successful). Invoked via `sh` rather
# than executed directly so this doesn't depend on the script's execute
# bit — retention.sh ships non-executable in the repo (Dockerfile.backup
# sets +x at image build time) and AGENTPULSE_RETENTION_SCRIPT overrides
# in tests point straight at the repo file.
sh "$RETENTION_SCRIPT" || echo "[retention] non-fatal failure; backup still ok"
