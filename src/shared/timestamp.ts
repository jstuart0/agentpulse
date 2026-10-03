/**
 * The one timestamp parser for values read from a `sessions`/`events`
 * column, shared by the server and the browser. SQLite stores
 * `datetime('now')` as a bare UTC "YYYY-MM-DD HH:MM:SS"; a plain
 * `Date.parse`/`new Date(...)` reads that as local time, which is wrong on
 * any host (or browser) not running in UTC. Postgres's text timestamp
 * columns carry an explicit offset instead. A value with no zone is always
 * treated as UTC; everything else keeps its own offset.
 *
 * `src/server/services/util/db-time.ts`'s `parseDbTimestamp` and
 * `src/web/lib/utils.ts`'s `parseDate` both delegate to this so there is
 * exactly one implementation of the parsing rule, not three.
 */

const STORED_TIMESTAMP =
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
 * Parses a stored timestamp to epoch ms. Accepts SQLite bare, ISO `Z`, and
 * Postgres `+HH`/`+HH:MM` forms, with any number of fractional digits
 * (truncated to ms). A zone-less value is UTC. Anything else — including
 * empty/null/undefined input — is `null`.
 */
export function parseStoredTimestamp(value: string | null | undefined): number | null {
	if (!value) return null;
	const match = STORED_TIMESTAMP.exec(value.trim());
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
