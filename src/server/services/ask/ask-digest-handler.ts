import type { Digest, DigestOptions } from "../ai/digest-service.js";
import { buildDigest } from "../ai/digest-service.js";

// ---- Time window derivation ---------------------------------------------

function windowMsFromMessage(message: string): number {
	if (/\bthis\s+week\b/i.test(message)) return 7 * 24 * 60 * 60 * 1000;
	return 24 * 60 * 60 * 1000; // default: last 24 hours
}

// ---- Formatting ----------------------------------------------------------

function relativeTime(isoTs: string, now: Date): string {
	const diffMs = now.getTime() - new Date(isoTs).getTime();
	const mins = Math.round(diffMs / 60_000);
	if (mins < 2) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	return `${Math.round(hrs / 24)}d ago`;
}

export function formatDigest(digest: Digest, now: Date = new Date()): string {
	const windowHours = Math.round(
		(new Date(digest.windowEnd).getTime() - new Date(digest.windowStart).getTime()) /
			(60 * 60 * 1000),
	);
	const windowLabel = windowHours <= 24 ? "last 24h" : `last ${Math.round(windowHours / 24)}d`;

	const lines: string[] = [`**Session digest (${windowLabel}):**`, ""];

	for (const repo of digest.repos) {
		const parts: string[] = [];
		if (repo.activeCount > 0) parts.push(`${repo.activeCount} active`);
		if (repo.completedToday > 0) parts.push(`${repo.completedToday} completed`);
		if (repo.failedToday > 0) parts.push(`${repo.failedToday} failed`);
		if (repo.blockedCount > 0) parts.push(`${repo.blockedCount} blocked`);
		if (repo.stuckCount > 0) parts.push(`${repo.stuckCount} stuck`);
		const summary = parts.length > 0 ? parts.join(", ") : "no activity";
		lines.push(`• **${repo.projectName}** — ${summary}`);

		// Surface notable failures inline.
		for (const f of repo.notableFailures.slice(0, 2)) {
			const session = repo.sessions.find((s) => s.sessionId === f.sessionId);
			const name = session?.displayName ?? f.sessionId.slice(0, 8);
			const when = relativeTime(f.at, now);
			lines.push(`  ↳ Failed: **${name}** (${when})`);
		}
	}

	const t = digest.totals;
	const totalParts: string[] = [`${t.sessions} sessions`];
	if (t.active > 0) totalParts.push(`${t.active} active`);
	if (t.completedToday > 0) totalParts.push(`${t.completedToday} completed`);
	if (t.blocked > 0) totalParts.push(`${t.blocked} blocked`);
	if (t.stuck > 0) totalParts.push(`${t.stuck} stuck`);

	lines.push("", `**Totals:** ${totalParts.join(", ")}`);
	return lines.join("\n");
}

// ---- Public handler ------------------------------------------------------

// 5s timeout guards against O(n * classifier_latency) serial loop in
// buildDigest() when there are many concurrent live sessions.
const DIGEST_TIMEOUT_MS = 5_000;

const PARTIAL_REPLY =
	"Digest is still computing (too many live sessions to classify quickly) — try again in a moment.";

/**
 * Build a human-readable digest reply from the existing buildDigest() service.
 * Wraps buildDigest() in a 5s timeout; returns a partial message on timeout.
 */
export async function handleDigestQuery(message: string, now: Date = new Date()): Promise<string> {
	const opts: DigestOptions = { windowMs: windowMsFromMessage(message), now };

	const timeout = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error("timeout")), DIGEST_TIMEOUT_MS),
	);

	let digest: Digest;
	try {
		digest = await Promise.race([buildDigest(opts), timeout]);
	} catch {
		return PARTIAL_REPLY;
	}

	return formatDigest(digest, now);
}
