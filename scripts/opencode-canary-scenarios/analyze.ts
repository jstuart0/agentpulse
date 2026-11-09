/**
 * Pure analysis of a probe log (AGEN-141, phase 0): what each gate's answer is, computed from the records an
 * OpenCode run wrote, so a gate can be re-judged from the saved logs without running OpenCode again.
 */

// biome-ignore lint/suspicious/noExplicitAny: probe logs are untyped JSON from two OpenCode lines.
export type J = any;

export interface Rec {
	t: number;
	pid: number;
	tag: string;
	kind: string;
	data: J;
}

export const events = (records: readonly Rec[]): Array<{ i: number; rec: Rec; event: J }> =>
	records.flatMap((rec, i) =>
		rec.kind === "event" ? [{ i, rec, event: rec.data.event as J }] : [],
	);

/** Bus events that are catalog or plugin bookkeeping, not session activity. */
export const NOISE_EVENTS = new Set([
	"plugin.added",
	"plugin.updated",
	"catalog.updated",
	"integration.updated",
	"reference.updated",
	"agent.updated",
	"command.updated",
	"model.updated",
	"provider.updated",
	"skill.updated",
	"websearch.updated",
	"project.updated",
	"vcs.branch.updated",
	"file.watcher.updated",
	"session.instructions.updated",
]);

export const distinct = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** V1: every `message.part.updated` for the tool part of `callID`, in arrival order. */
export function v1ToolParts(records: readonly Rec[], callID: string) {
	return events(records).filter(
		(e) =>
			e.event.type === "message.part.updated" &&
			e.event.properties?.part?.type === "tool" &&
			e.event.properties.part.callID === callID,
	);
}

export const hookRecords = (records: readonly Rec[], kind: string, callID?: string) =>
	records
		.map((rec, i) => ({ rec, i }))
		.filter(
			({ rec }) =>
				rec.kind === kind &&
				(callID === undefined || (rec.data.i?.callID ?? rec.data.event?.id) === callID),
		);

export interface V1FailAnalysis {
	afterFires: boolean;
	partStatuses: string[];
	afterExitCode: number | null;
	/** Index of the first terminal part update and of the after hook, in record order. */
	terminalPartIndex: number | null;
	afterIndex: number | null;
	order: "after_then_part" | "part_then_after" | "n/a";
}

export function analyzeV1Call(records: readonly Rec[], callID: string): V1FailAnalysis {
	const parts = v1ToolParts(records, callID);
	const statuses = parts.map((p) => String(p.event.properties.part.state?.status));
	const terminal = parts.find((p) =>
		["completed", "error"].includes(p.event.properties.part.state?.status),
	);
	const after = hookRecords(records, "tool.execute.after", callID)[0];
	const exit = after?.rec.data.o?.metadata?.exit;
	const terminalPartIndex = terminal?.i ?? null;
	const afterIndex = after?.i ?? null;
	return {
		afterFires: Boolean(after),
		partStatuses: statuses,
		afterExitCode: typeof exit === "number" ? exit : null,
		terminalPartIndex,
		afterIndex,
		order:
			terminalPartIndex === null || afterIndex === null
				? "n/a"
				: afterIndex < terminalPartIndex
					? "after_then_part"
					: "part_then_after",
	};
}

/** V2: the `tool.after` hook event for a call (its `id` is the call id) and the tool events naming it. */
export function analyzeV2Call(records: readonly Rec[], callID: string) {
	const after = records.find((r) => r.kind === "tool.after" && r.data.event?.id === callID);
	const toolEvents = events(records)
		.filter((e) => String(e.event.type).startsWith("session.tool.") && e.event.data?.id === callID)
		.map((e) => ({ type: String(e.event.type), data: e.event.data }));
	return {
		afterFires: Boolean(after),
		afterStatus: (after?.data.event?.status as string | undefined) ?? null,
		afterResult: after?.data.event?.result,
		toolEventTypes: toolEvents.map((e) => e.type),
	};
}

/** All string values at any depth, with their paths. */
export function flatten(
	value: J,
	path = "",
	out: Array<[string, string]> = [],
): Array<[string, string]> {
	if (typeof value === "string") out.push([path, value]);
	else if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${path}[${i}]`, out));
	else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
	}
	return out;
}

/** Values that look like an id (a prefix, an underscore and a long tail). */
const ID_LIKE = /^[a-z]{2,6}_[A-Za-z0-9]{8,}$/;

/**
 * G10: is there an id that the prompt, the tool hooks and the turn end all carry (other than the session and
 * the call)? Returns the shared values with where they were seen, or none.
 */
export function sharedTurnId(groups: {
	prompt: readonly J[];
	tool: readonly J[];
	turnEnd: readonly J[];
}): Array<{ value: string; paths: string[] }> {
	const sets = (items: readonly J[]) => {
		const map = new Map<string, Set<string>>();
		for (const item of items) {
			for (const [path, value] of flatten(item)) {
				if (!ID_LIKE.test(value) || value.startsWith("ses_") || value.startsWith("call_")) continue;
				if (/(^|\.)(callID|id)$/.test(path) && value.startsWith("evt_")) continue;
				if (!map.has(value)) map.set(value, new Set());
				map.get(value)?.add(path);
			}
		}
		return map;
	};
	const [p, t, e] = [sets(groups.prompt), sets(groups.tool), sets(groups.turnEnd)];
	return [...p.keys()]
		.filter((v) => t.has(v) && e.has(v))
		.map((value) => ({
			value,
			paths: distinct([...(p.get(value) ?? []), ...(t.get(value) ?? []), ...(e.get(value) ?? [])]),
		}));
}

/** Event names in arrival order after record index `from`, without noise. */
export const eventNamesAfter = (records: readonly Rec[], from: number): string[] =>
	events(records)
		.filter((e) => e.i > from && !NOISE_EVENTS.has(e.event.type))
		.map((e) => String(e.event.type));

/** Every key a value has, recursively, with `[]` for array items (for the captured-surface record). */
export function keyPaths(value: J, prefix = "", out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const item of value) keyPaths(item, `${prefix}[]`, out);
	} else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value)) {
			const path = prefix ? `${prefix}.${k}` : k;
			out.add(path);
			keyPaths(v, path, out);
		}
	}
	return out;
}
