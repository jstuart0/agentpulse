// The one server-side normalizer for timestamps read from the events table.
// SQLite stores `datetime('now')` as a bare UTC "YYYY-MM-DD HH:MM:SS"; a
// plain Date.parse reads that as local time, which is wrong on any host not
// running in UTC. Postgres stores CURRENT_TIMESTAMP text with an offset.

const DB_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function parseOffsetMinutes(zone: string | undefined): number | null {
	if (!zone || zone === "Z") return 0;
	const sign = zone.startsWith("-") ? -1 : 1;
	const digits = zone.slice(1).replace(":", "");
	const hours = Number(digits.slice(0, 2));
	const minutes = digits.length > 2 ? Number(digits.slice(2)) : 0;
	if (hours > 23 || minutes > 59) return null;
	return sign * (hours * 60 + minutes);
}

/**
 * Parses a stored event timestamp to epoch ms. Values without a zone are UTC.
 * Accepts SQLite bare, ISO `Z`, and Postgres `+HH`/`+HH:MM` forms, with any
 * number of fractional digits (truncated to ms). Anything else is `null`.
 */
export function parseDbTimestamp(value: string | null | undefined): number | null {
	if (!value) return null;
	const match = DB_TIMESTAMP.exec(value.trim());
	if (!match) return null;
	const [, y, mo, d, h, mi, s, fraction, zone] = match;
	const offsetMinutes = parseOffsetMinutes(zone);
	if (offsetMinutes == null) return null;

	const year = Number(y);
	const month = Number(mo) - 1;
	const day = Number(d);
	const hour = Number(h);
	const minute = Number(mi);
	const second = Number(s);
	const millis = fraction ? Number(fraction.slice(0, 3).padEnd(3, "0")) : 0;

	const wall = new Date(Date.UTC(year, month, day, hour, minute, second, millis));
	if (
		wall.getUTCFullYear() !== year ||
		wall.getUTCMonth() !== month ||
		wall.getUTCDate() !== day ||
		wall.getUTCHours() !== hour ||
		wall.getUTCMinutes() !== minute ||
		wall.getUTCSeconds() !== second
	) {
		return null;
	}
	return wall.getTime() - offsetMinutes * 60_000;
}

/** Formats a Date in the SQLite column format: UTC, truncated to the second. */
export function toDbTimestamp(date: Date): string {
	return date.toISOString().slice(0, 19).replace("T", " ");
}
