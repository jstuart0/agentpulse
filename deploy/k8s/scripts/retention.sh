#!/bin/sh
# retention.sh — keep last 30 daily backups + 12 monthly survivors.
#
# Monthly survivor: the first-seen backup for each calendar month
# (YYYY-MM) is preserved regardless of age. Up to 12 monthly survivors
# are kept; the oldest monthly is removed once the 13th month appears.
#
# Called by run-backup.sh after a successful backup. Safe to call
# manually from the backup-sidecar container.
set -eu

cd /backups

# Build a sorted list (newest first) of backup db files.
# ls -1t = sort by mtime descending. Only .db files (not .sha256 / .counts.txt).
FILES=$(ls -1t agentpulse-*.db 2>/dev/null || true)

if [ -z "$FILES" ]; then
	echo "[retention] no backup files found; nothing to do"
	exit 0
fi

TOTAL=$(echo "$FILES" | wc -l | tr -d ' ')
echo "[retention] found $TOTAL backup file(s)"

# ── Pass 1: collect monthly survivors ───────────────────────────────────────
# Walk files newest-first; for each calendar month (YYYY-MM), keep the
# first file encountered (= the most-recent backup for that month).
# Build a space-separated list of survivor filenames.
MONTHLY_SURVIVORS=""
MONTHLY_COUNT=0
MAX_MONTHLY=12

for f in $FILES; do
	# Extract YYYYMM from the filename timestamp (agentpulse-20260101T041500Z.db).
	month=$(echo "$f" | sed 's/agentpulse-\([0-9]\{6\}\).*/\1/')
	# month is now YYYYMM (6 chars, no hyphen). Reformat to YYYY-MM for the key.
	yr=$(echo "$month" | cut -c1-4)
	mo=$(echo "$month" | cut -c5-6)
	key="${yr}-${mo}"

	# Check if this month is already represented.
	if ! echo "$MONTHLY_SURVIVORS" | grep -qw "$key"; then
		if [ "$MONTHLY_COUNT" -lt "$MAX_MONTHLY" ]; then
			MONTHLY_SURVIVORS="$MONTHLY_SURVIVORS $key:$f"
			MONTHLY_COUNT=$((MONTHLY_COUNT + 1))
		fi
		# Beyond 12 months: not added — those will be eligible for deletion.
	fi
done

echo "[retention] monthly survivors: $MONTHLY_COUNT"

# ── Pass 2: apply retention ──────────────────────────────────────────────────
# Walk files newest-first. Keep unconditionally for the first 30.
# Beyond position 30: delete unless it's a monthly survivor.
RANK=0
for f in $FILES; do
	RANK=$((RANK + 1))

	if [ "$RANK" -le 30 ]; then
		# Always keep the 30 most-recent dailies.
		continue
	fi

	# Check if this file is a monthly survivor.
	if echo "$MONTHLY_SURVIVORS" | grep -qF ":$f"; then
		echo "[retention] keeping monthly survivor: $f"
		continue
	fi

	# Delete the backup and its sidecar files.
	echo "[retention] removing: $f (rank $RANK)"
	rm -f "$f" "${f}.counts.txt" "${f}.sha256"
done

echo "[retention] done"
