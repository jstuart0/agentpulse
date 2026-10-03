import { sanitizeReportedHost } from "../../shared/reported-host.js";

/**
 * The name a machine goes by, cleaned the way a reported name is (control and
 * format characters out, whitespace collapsed, 128 characters), so the SQL that
 * groups by it, the query grammar that selects it and the dashboard's own
 * trimming can never disagree about it. Null when nothing is left. Applied
 * wherever a supervisor's host name is written or copied.
 */
export function cleanMachineName(value: string | null | undefined): string | null {
	return sanitizeReportedHost(value);
}
