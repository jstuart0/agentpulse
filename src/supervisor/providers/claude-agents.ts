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

/** One conversation Claude Code has open: the process holding it and the session id. A missing pid is `null`. */
export type AgentEntry = { pid: number | null; sessionId: string };

export type AgentEntriesListing =
	| { ok: true; entries: readonly AgentEntry[] }
	| { ok: false; why: string };

function agentsList(stdout: string): unknown[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	return Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object" && Array.isArray((parsed as { agents?: unknown }).agents)
			? ((parsed as { agents: unknown[] }).agents as unknown[])
			: null;
}

/** The conversation ids in one `agents --json` answer, or null when the answer isn't a list of agents. */
export function parseAgentsListing(stdout: string): ReadonlySet<string> | null {
	const list = agentsList(stdout);
	if (list === null) return null;
	const ids = new Set<string>();
	for (const entry of list) {
		const id = (entry as { sessionId?: unknown } | null)?.sessionId;
		if (typeof id === "string" && id) ids.add(id);
	}
	return ids;
}

/**
 * The entries of one `agents --json` answer, each with the process that holds the conversation, or null
 * when the answer isn't a list. An entry with no usable `sessionId` is a failure to read, not an entry
 * for no one: a takeover must not take "can't tell" for "nobody has it".
 */
export function parseAgentEntries(stdout: string): readonly AgentEntry[] | null {
	const list = agentsList(stdout);
	if (list === null) return null;
	const entries: AgentEntry[] = [];
	for (const raw of list) {
		const record =
			raw && typeof raw === "object" ? (raw as { sessionId?: unknown; pid?: unknown }) : null;
		if (!record || typeof record.sessionId !== "string" || !record.sessionId) return null;
		entries.push({
			sessionId: record.sessionId,
			pid: typeof record.pid === "number" && Number.isInteger(record.pid) ? record.pid : null,
		});
	}
	return entries;
}

async function runAgents(options: {
	executable: string;
	cwd: string;
	env: Record<string, string | undefined>;
	timeoutMs?: number;
}): Promise<{ ok: true; stdout: string } | { ok: false; why: string }> {
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
		return { ok: true, stdout };
	} catch {
		return { ok: false, why: "it couldn't be read" };
	} finally {
		clearTimeout(timer);
	}
}

type AgentsOptions = Parameters<typeof runAgents>[0];

export async function listClaudeAgents(options: AgentsOptions): Promise<AgentsListing> {
	const ran = await runAgents(options);
	if (!ran.ok) return ran;
	const ids = parseAgentsListing(ran.stdout);
	return ids ? { ok: true, sessionIds: ids } : { ok: false, why: "its answer wasn't a list" };
}

/** Like `listClaudeAgents`, with the process behind each entry (a takeover's own-id and second-writer checks). */
export async function listClaudeAgentEntries(options: AgentsOptions): Promise<AgentEntriesListing> {
	const ran = await runAgents(options);
	if (!ran.ok) return ran;
	const entries = parseAgentEntries(ran.stdout);
	return entries ? { ok: true, entries } : { ok: false, why: "its answer wasn't a list" };
}
