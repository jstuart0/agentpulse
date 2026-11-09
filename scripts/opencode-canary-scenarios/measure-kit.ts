/**
 * Shared parts of the measurement scenarios of Phase 0 (AGEN-141): types, running and saving a run. Each runs OpenCode (only through the sandboxed spawner) and
 * returns gate rows (G1-G15), captures and raw evidence. `opencode-observe-canary.ts --measure` runs them and
 * `emit.ts` writes the fixtures. The answers are computed by the pure functions in `analyze.ts` from the saved
 * probe logs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeLine } from "../lib/opencode-canary-pins.js";
import { events, type Rec } from "./analyze.js";
import { type Place, type World, makePlace, projectDir, readProbe, runTurn } from "./world.js";

export type GateResult = "pass" | "stop" | `branch-${string}`;

export interface GateRow {
	gate: string;
	question: string;
	answer: string;
	result: GateResult;
	/** Machine-readable outcomes the tests read. */
	tokens: string[];
	command: string;
}

export interface CaptureOut {
	line: OpenCodeLine;
	/** The file name under `captures/<line>/`, without `.json`. */
	name: string;
	scenario: string;
	prompt: string;
	records: Rec[];
}

export interface MeasureOutput {
	id: string;
	gates: GateRow[];
	captures: CaptureOut[];
	evidence: Record<string, unknown>;
}

export interface MeasureContext {
	world: World;
	versions: Record<string, string>;
	noteDataHome(dir: string): void;
}

export interface MeasureScenario {
	needsService?: boolean;
	run(ctx: MeasureContext): Promise<MeasureOutput>;
}

export const LINES = ["v1", "v2"] as const;
export const SESSION_TIMEOUT = 40_000;

// ---------------------------------------------------------------------------------------------------------
// Running and saving

export interface Collected {
	line: OpenCodeLine;
	name: string;
	prompt: string;
	place: Place;
	records: Rec[];
	code: number | null;
	timedOut: boolean;
	ms: number;
	stdout: string;
	stderr: string;
	endedAt: number;
	cwd: string;
}

export function saveRecords(
	ctx: MeasureContext,
	line: OpenCodeLine,
	name: string,
	records: Rec[],
): void {
	const dir = join(ctx.world.root, "records", line);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n"));
}

export interface CollectOptions {
	prompt: string;
	permission?: Record<string, string>;
	extraEnv?: Record<string, string>;
	timeoutMs?: number;
	args?: string[];
	cold?: boolean;
	probe?: boolean;
	label?: string;
}

export async function collect(
	ctx: MeasureContext,
	line: OpenCodeLine,
	name: string,
	options: CollectOptions,
): Promise<Collected> {
	const place = makePlace(ctx.world, line, name, {
		...(options.permission ? { permission: options.permission } : {}),
		...(options.cold ? { warmFrom: "" } : {}),
		...(options.probe === false ? { probe: false } : {}),
	});
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const cwd = projectDir(ctx.world, `${line}-${name}`);
	const r = await runTurn(ctx.world, place, {
		cwd,
		prompt: options.prompt,
		...(options.args ? { args: options.args } : {}),
		timeoutMs: options.timeoutMs ?? SESSION_TIMEOUT,
		...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
		...(options.label ? { label: options.label } : {}),
	});
	const records = readProbe(place);
	saveRecords(ctx, line, name, records);
	return {
		line,
		name,
		prompt: options.prompt,
		place,
		records,
		code: r.code,
		timedOut: r.timedOut,
		ms: Math.round(r.ms),
		stdout: r.stdout,
		stderr: r.stderr,
		endedAt: Date.now(),
		cwd,
	};
}

export const asCapture = (c: Collected, scenario: string, name = c.name): CaptureOut => ({
	line: c.line,
	name,
	scenario,
	prompt: c.prompt,
	records: c.records,
});

export const tally = (items: readonly string[]): Record<string, number> => {
	const out: Record<string, number> = {};
	for (const item of items) out[item] = (out[item] ?? 0) + 1;
	return out;
};

export const row = (
	gate: string,
	question: string,
	answer: string,
	result: GateResult,
	tokens: string[],
	command: string,
): GateRow => ({ gate, question, answer, result, tokens, command });

export const eventTypes = (records: readonly Rec[]): string[] =>
	events(records).map((e) => String(e.event.type));

export const loads = (records: readonly Rec[], tag?: string): Rec[] =>
	records.filter((r) => r.kind === "load" && (tag === undefined || r.tag === tag));

/** Text a person's terminal would show for a `run`: stdout and stderr together. */
export const terminalText = (c: Collected): string => `${c.stdout}\n${c.stderr}`;
export const NOISE_WORDS = /\b(ERROR|WARN)\b|failed to load|must (default )?export|Plugin must/i;

export function logText(place: Place): string {
	const dir = join(place.sandbox.paths.XDG_DATA_HOME, "opencode", "log");
	if (!existsSync(dir)) return "";
	return readdirSync(dir)
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");
}
