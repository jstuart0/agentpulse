/**
 * Writes what a measurement run found into the repository's fixture directory (AGEN-141, phase 0): the
 * redacted captures, `captured-surface.json`, `manifest.json` and `OBSERVATIONS.md`. Placeholder paths only;
 * `scrub` is also what the hygiene scan in the observations test holds the files to.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { type J, NOISE_EVENTS, type Rec, keyPaths } from "./analyze.js";
import type { CaptureOut, GateResult, GateRow, MeasureOutput } from "./measure-kit.js";

/**
 * Text that must never appear in a committed fixture. Shared with the observations test. The account name is
 * read at run time, so the list itself names nobody.
 */
export function hygienePatterns(): Array<[string, RegExp]> {
	const account = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [
		["a home directory", /\/(Users|home)\/(?!person\b)[A-Za-z0-9._-]+/],
		["a private temp path", /\/private\/(tmp|var)\/|\/var\/folders\/|\/tmp\/claude-/],
		["a private address", /\b(192\.168\.|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.)/],
		["an internal host name", /\b[a-z0-9-]+\.(lan|local|internal|home\.arpa)\b/i],
		["the account name", new RegExp(`\\b${account}\\b`, "i")],
		[
			"an API key shape",
			/\bsk-[A-Za-z0-9_-]{8,}|\bap_[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}/,
		],
	];
}

export function scrubber(roots: { work: string; realHome: string }): (text: string) => string {
	const work = roots.work.replace(/\/+$/, "");
	const bare = work.replace(/^\//, "");
	return (text) =>
		text
			.split(work)
			.join("/scratch")
			.split(bare)
			.join("scratch")
			.split(roots.realHome)
			.join("/home/person")
			.replace(/127\.0\.0\.1:\d{2,5}/g, "127.0.0.1:PORT")
			.replace(/localhost:\d{2,5}/g, "localhost:PORT")
			.replace(/\/private\/tmp\/[^"\s]*/g, "/scratch/other")
			.replace(/\/tmp\/claude-501[^"\s]*/g, "/scratch/other");
}

const HOOK_KINDS = new Set([
	"chat.message",
	"chat.params",
	"permission.ask",
	"tool.execute.before",
	"tool.execute.after",
	"shell.env",
	"tool.before",
	"tool.after",
]);

/** The records of a capture: arrival order, noise left out, times relative to the first record, no pids. */
function captureRecords(records: readonly Rec[]): J[] {
	const t0 = records[0]?.t ?? 0;
	return records
		.filter((r) => !(r.kind === "event" && NOISE_EVENTS.has(r.data.event?.type)))
		.filter((r) => r.kind !== "post.done")
		.map((r) => ({ kind: r.kind, t: r.t - t0, tag: r.tag, ...r.data }));
}

export interface EmitInput {
	outputs: MeasureOutput[];
	versions: { v1: string; v2: string };
	outDir: string;
	work: string;
	realHome: string;
	/** Raw probe records per line, every run, for the captured-surface record. */
	allRecords: Record<"v1" | "v2", Rec[]>;
	reducedCtx: string[];
}

export const REQUIRED_CAPTURES: Record<"v1" | "v2", string[]> = {
	v1: [
		"plain",
		"shell-tool",
		"write-tool",
		"failed-tool-exit",
		"failed-tool-error",
		"child-session",
		"assistant-text-parts",
		"permission-reject",
		"permission-accept",
		"forced-400",
		"abort",
	],
	v2: [
		"plain",
		"shell-tool",
		"write-tool",
		"failed-tool-exit",
		"failed-tool-error",
		"child-session",
		"permission-reject",
		"permission-accept",
		"forced-400",
		"abort",
	],
};

const WORST: Record<string, number> = { stop: 2, pass: 0 };
const rank = (r: GateResult) => WORST[r] ?? 1;

/** One row per gate: scenarios may each contribute a part of one. */
export function mergeGates(rows: readonly GateRow[]): GateRow[] {
	const byGate = new Map<string, GateRow>();
	for (const r of rows) {
		const have = byGate.get(r.gate);
		if (!have) {
			byGate.set(r.gate, { ...r });
			continue;
		}
		have.answer = `${have.answer} ${r.answer}`;
		have.tokens = [...have.tokens, ...r.tokens];
		have.command = distinctJoin(have.command, r.command);
		if (rank(r.result) > rank(have.result)) have.result = r.result;
	}
	const g15 = byGate.get("G15");
	if (g15 && !g15.tokens.some((t) => t.startsWith("tool_hook_fanout="))) {
		const any = g15.tokens.some((t) => /\.tool_hook_fanout=yes$/.test(t));
		g15.tokens.push(`tool_hook_fanout=${any ? "yes" : "no"}`);
		if (any) g15.result = "branch-fanout";
	}
	return [...byGate.values()].sort((a, b) => Number(a.gate.slice(1)) - Number(b.gate.slice(1)));
}
const distinctJoin = (a: string, b: string) =>
	[...new Set([...a.split("; "), ...b.split("; ")])].join("; ");

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function observationsMarkdown(
	rows: readonly GateRow[],
	versions: { v1: string; v2: string },
): string {
	const lines = [
		"# OpenCode measurement gates (AGEN-141, phase 0)",
		"",
		`Measured on macOS arm64 against OpenCode ${versions.v1} (1.x) and ${versions.v2} (2.x). Every run went through \`scripts/lib/opencode-canary-spawn.ts\` in a throwaway home, with the network limited to loopback and the model a stub. Raw captures are in \`captures/\`, the surface in \`captured-surface.json\`.`,
		"",
		"Result is `pass`, `stop` or `branch-<X>`. Tokens are the machine-readable outcomes the later phases' tests read.",
		"",
		"| Gate | Question | Answer | Result | Tokens | Version | Command |",
		"|---|---|---|---|---|---|---|",
		...rows.map(
			(r) =>
				`| ${r.gate} | ${cell(r.question)} | ${cell(r.answer)} | ${r.result} | ${cell(r.tokens.map((t) => `\`${t}\``).join(" "))} | ${versions.v1} / ${versions.v2} | \`${cell(r.command)}\` |`,
		),
		"",
	];
	const notes = readFileSync(join(import.meta.dir, "observations-notes.md"), "utf8");
	return `${lines.join("\n")}\n${notes}`;
}

export function emitFixtures(input: EmitInput): { files: string[]; manifest: unknown } {
	const scrub = scrubber({ work: input.work, realHome: input.realHome });
	const write = (path: string, value: unknown) => {
		const text = typeof value === "string" ? value : `${JSON.stringify(value, null, "\t")}\n`;
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, scrub(text));
	};
	const files: string[] = [];
	const captured = new Set<string>();
	for (const line of ["v1", "v2"] as const)
		rmSync(join(input.outDir, "captures", line), { recursive: true, force: true });
	for (const out of input.outputs) {
		for (const c of out.captures as CaptureOut[]) {
			const rel = join("captures", c.line, `${c.name}.json`);
			write(join(input.outDir, rel), {
				line: c.line,
				version: input.versions[c.line],
				scenario: c.scenario,
				prompt: c.prompt,
				records: captureRecords(c.records),
			});
			files.push(rel);
			captured.add(`${c.line}/${c.name}`);
		}
	}
	const surfaceFor = (line: "v1" | "v2") => {
		const records = input.allRecords[line];
		const busEvents = new Set<string>();
		const hooks = new Set<string>();
		const ctxKeys = new Set<string>();
		const eventKeys = new Map<string, Set<string>>();
		for (const r of records) {
			if (r.kind === "event" && r.data.event?.type) {
				busEvents.add(r.data.event.type);
				const set = eventKeys.get(r.data.event.type) ?? new Set<string>();
				for (const k of keyPaths(r.data.event)) set.add(k);
				eventKeys.set(r.data.event.type, set);
			}
			if (HOOK_KINDS.has(r.kind)) hooks.add(r.kind);
			if (r.kind === "load") for (const k of r.data.ctxKeys ?? []) ctxKeys.add(k);
		}
		return {
			busEvents: [...busEvents].sort(),
			hooks: [...hooks].sort(),
			ctxKeys: [...ctxKeys],
			eventKeyPaths: Object.fromEntries([...eventKeys].sort().map(([k, v]) => [k, [...v].sort()])),
		};
	};
	const surface = {
		v1: {
			version: input.versions.v1,
			...surfaceFor("v1"),
			reducedCtxGivenV2File: input.reducedCtx,
		},
		v2: { version: input.versions.v2, ...surfaceFor("v2") },
	};
	write(join(input.outDir, "captured-surface.json"), surface);
	const fixtures = (["v1", "v2"] as const).flatMap((line) =>
		REQUIRED_CAPTURES[line].map((name) =>
			captured.has(`${line}/${name}`)
				? { line, name, status: "captured", file: `captures/${line}/${name}.json` }
				: {
						line,
						name,
						status: "synthetic",
						waiver: `G8: not captured on ${line} (${name}); see OBSERVATIONS.md`,
					},
		),
	);
	const manifest = { fixtures };
	write(join(input.outDir, "manifest.json"), manifest);
	const rows = mergeGates(input.outputs.flatMap((o) => o.gates));
	write(join(input.outDir, "OBSERVATIONS.md"), observationsMarkdown(rows, input.versions));
	return { files, manifest };
}
