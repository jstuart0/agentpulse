/**
 * `claude agents --json`: which conversations a Claude Code on this machine has open, in a terminal, as a
 * background agent or as a `-p` child, whatever started them (AGEN-117 T12). A headless resume asks it
 * before it starts a second writer on a conversation, and refuses if the conversation is listed.
 *
 * Asking costs about 0.15 s and writes nothing to the conversation. A launched session has no version gate,
 * so a Claude Code without the subcommand must keep working: any failure to ask is reported to the caller as
 * "unavailable", which proceeds and logs.
 */

const AGENTS_TIMEOUT_MS = 5_000;

export type AgentsListing =
	| { ok: true; sessionIds: ReadonlySet<string> }
	| { ok: false; why: string };

/** The conversation ids in one `agents --json` answer, or null when the answer isn't a list of agents. */
export function parseAgentsListing(stdout: string): ReadonlySet<string> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	const list = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { agents?: unknown }).agents)
			? ((parsed as { agents: unknown[] }).agents as unknown[])
			: null;
	if (list === null) return null;
	const ids = new Set<string>();
	for (const entry of list) {
		const id = (entry as { sessionId?: unknown } | null)?.sessionId;
		if (typeof id === "string" && id) ids.add(id);
	}
	return ids;
}

export async function listClaudeAgents(options: {
	executable: string;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
}): Promise<AgentsListing> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn({
			cmd: [options.executable, "agents", "--json"],
			cwd: options.cwd,
			env: options.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch {
		return { ok: false, why: "it couldn't be started" };
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try {
			proc.kill("SIGKILL");
		} catch {}
	}, options.timeoutMs ?? AGENTS_TIMEOUT_MS);
	try {
		const [stdout, code] = await Promise.all([
			new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);
		if (timedOut) return { ok: false, why: "it timed out" };
		if (code !== 0) return { ok: false, why: `it exited ${code}` };
		const ids = parseAgentsListing(stdout);
		return ids ? { ok: true, sessionIds: ids } : { ok: false, why: "its answer wasn't a list" };
	} catch {
		return { ok: false, why: "it couldn't be read" };
	} finally {
		clearTimeout(timer);
	}
}
