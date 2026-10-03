/**
 * A launch for a directory this host won't start anything in is refused before
 * anything else happens: no "launching" status, no prelaunch action, no provider.
 * The one status it posts is byte for byte the one a launch outside the trusted
 * roots gets, so the server (and anyone watching it) cannot tell the two apart,
 * and nothing in it says "excluded". The reason goes to the host's own log.
 *
 * Everything runs against recorders: no server, no provider, no agent process.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../shared/types.js";
import { type LaunchProviders, createLaunchDispatcher } from "./launch-dispatch.js";
import { PrelaunchError } from "./services/prelaunch-actions.js";
import { LAUNCH_REFUSED_MESSAGE, createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const BASE = `/supervisors/${SUPERVISOR_ID}`;
const GENERIC_BODY = {
	status: "failed",
	error: "This host doesn't allow launches in that directory.",
	providerLaunchMetadata: {
		prelaunchError: {
			code: "path_outside_trusted_roots",
			message: "This host doesn't allow launches in that directory.",
		},
	},
};

let home: string;
let trusted: string;
let work: string;
let outside: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-launch-exclude-")));
	trusted = join(home, "trusted");
	work = join(trusted, "secret-project");
	outside = join(home, "elsewhere", "project");
	for (const dir of [work, outside]) mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const removeRules = () => rmSync(join(home, ".agentpulse", "exclude"), { force: true });

let rulesVersion = 0;
function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++rulesVersion * 1000);
	utimesSync(file, at, at);
}

type Call = { path: string; body: unknown };
type Harness = ReturnType<typeof harness>;

/** A dispatcher wired to recorders: what was posted, what the host logged, which providers and prelaunch actions ran. */
function harness(
	opts: { prelaunch?: (actions: unknown[]) => Promise<void>; maxTrackedSessions?: number } = {},
) {
	// Every harness is a supervisor process that has just started: nothing remembered from another one in this test.
	rmSync(join(home, ".agentpulse", "supervisor-gate-state.json"), { force: true });
	const calls: Call[] = [];
	const logs: string[] = [];
	const ran: string[] = [];
	const request = async (path: string, options?: RequestInit) => {
		calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
		return { session: { displayName: "from-server" }, managedSession: {}, events: [] };
	};
	const gate = createReportGate({
		request,
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: (line) => logs.push(line),
		maxTrackedSessions: opts.maxTrackedSessions,
	});
	const providers = {
		launchManagedCodex: async (_launch: LaunchRequest, callbacks: unknown) => {
			ran.push("codex");
			lastCallbacks = callbacks as Callbacks;
			return { pid: 111, metadata: { mode: "managed_codex" }, runtime: {} };
		},
		launchClaudeHeadless: async (
			_launch: LaunchRequest,
			reportProgress: (u: unknown) => Promise<void>,
			callbacks: unknown,
		) => {
			ran.push("headless");
			lastCallbacks = callbacks as Callbacks;
			await reportProgress({
				status: "running",
				pid: 222,
				providerLaunchMetadata: { mode: "headless" },
			});
			return { pid: 222, metadata: { mode: "headless" }, monitor: Promise.resolve() };
		},
		launchClaudeInteractive: async (_launch: LaunchRequest, callbacks: unknown) => {
			ran.push("interactive");
			lastCallbacks = callbacks as Callbacks;
			return { pid: 333, metadata: { mode: "interactive_terminal" } };
		},
	} as unknown as LaunchProviders;
	const dispatch = createLaunchDispatcher({
		gate,
		trustedRoots: [trusted],
		providers,
		executePrelaunchActions: (async (actions: unknown[]) => {
			ran.push("prelaunch");
			await opts.prelaunch?.(actions);
		}) as never,
		log: (line) => logs.push(line),
		warn: (line) => logs.push(line),
	});
	return { calls, logs, ran, gate, dispatch, callbacks: () => lastCallbacks };
}

type Callbacks = {
	reportState: (body: Record<string, unknown>) => Promise<unknown>;
	reportEvents: (events: unknown[]) => Promise<void>;
};
let lastCallbacks: Callbacks | undefined;

const MODES = [
	{ label: "headless Claude", agentType: "claude_code", mode: "headless" },
	{ label: "interactive Claude", agentType: "claude_code", mode: "interactive_terminal" },
	{ label: "managed Codex", agentType: "codex_cli", mode: "managed_codex" },
] as const;

function launchFor(
	cwd: string,
	over: {
		id?: string;
		agentType?: string;
		mode?: string;
		actions?: boolean;
		correlationId?: string;
	} = {},
): LaunchRequest {
	return {
		id: over.id ?? "launch-1",
		launchCorrelationId: over.correlationId ?? "corr-1",
		agentType: over.agentType ?? "claude_code",
		requestedLaunchMode: over.mode ?? "headless",
		cwd,
		model: "model-xyz",
		env: {},
		launchSpec: over.actions
			? { prelaunchActions: [{ kind: "scaffold_workarea", path: cwd }] }
			: {},
	} as unknown as LaunchRequest;
}

const statusPath = `${BASE}/launches/launch-1/status`;

const OUTSIDE_PATH = "/private/secret/dir";
async function rootsRefusal(): Promise<void> {
	throw new PrelaunchError(
		"path_outside_trusted_roots",
		`Path ${OUTSIDE_PATH} is not under any trusted root.`,
		OUTSIDE_PATH,
	);
}

describe("a launch in an excluded directory is refused first, with one fixed status", () => {
	for (const m of MODES) {
		for (const actions of [false, true]) {
			test(`${m.label}${actions ? " with" : " without"} prelaunch actions: exactly one status, the generic body; no launching, no prelaunch action, no provider`, async () => {
				const h = harness();
				writeRules([work]);
				await h.dispatch(launchFor(work, { agentType: m.agentType, mode: m.mode, actions }));
				expect(h.calls).toEqual([{ path: statusPath, body: GENERIC_BODY }]);
				expect(h.ran).toEqual([]);
			});
		}
	}

	test("the refusal is the same bytes a prelaunch trusted-roots refusal posts while rules are in place, for every mode: the final status is deep-equal and byte-equal", async () => {
		for (const m of MODES) {
			const excluded = harness();
			writeRules([work]);
			await excluded.dispatch(
				launchFor(work, { agentType: m.agentType, mode: m.mode, actions: true }),
			);

			const rootsRefused = harness({ prelaunch: rootsRefusal });
			writeRules([join(home, "somewhere-else")]);
			await rootsRefused.dispatch(
				launchFor(work, { agentType: m.agentType, mode: m.mode, actions: true }),
			);

			expect(excluded.calls, m.label).toEqual([{ path: statusPath, body: GENERIC_BODY }]);
			expect(rootsRefused.calls.at(-1), m.label).toEqual(excluded.calls[0]);
			expect(JSON.stringify(rootsRefused.calls.at(-1)), m.label).toBe(
				JSON.stringify(excluded.calls[0]),
			);
			expect(excluded.ran, m.label).toEqual([]);
		}
	});

	test("nothing sent says what happened: no 'exclu', no directory, no rule", async () => {
		const h = harness();
		writeRules([work]);
		await h.dispatch(launchFor(work, { actions: true }));
		const serialised = JSON.stringify(h.calls);
		expect(serialised.toLowerCase()).not.toContain("exclu");
		expect(serialised).not.toContain(work);
		expect(serialised).not.toContain("secret-project");
		expect(serialised).not.toContain("rule");
		expect((h.calls[0]?.body as { error: string }).error).toBe(LAUNCH_REFUSED_MESSAGE);
	});

	test("the host's own log says why: cwd_excluded and the directory for a rule, the code and the path for a prelaunch trusted-roots refusal", async () => {
		const excluded = harness();
		writeRules([work]);
		await excluded.dispatch(launchFor(work));
		expect(excluded.logs.some((l) => l.includes("cwd_excluded") && l.includes(work))).toBe(true);

		const roots = harness({ prelaunch: rootsRefusal });
		writeRules([join(home, "somewhere-else")]);
		await roots.dispatch(launchFor(work, { actions: true }));
		expect(
			roots.logs.some((l) => l.includes("path_outside_trusted_roots") && l.includes(OUTSIDE_PATH)),
		).toBe(true);
		expect(roots.logs.some((l) => l.includes("cwd_excluded"))).toBe(false);
	});

	test("the top of a launch checks only the rules: a launch outside the trusted roots (the server judged that when it was requested) is not refused here, with no rules or with unrelated ones", async () => {
		for (const rules of [null, [join(home, "unrelated")]]) {
			const h = harness();
			if (rules) writeRules(rules);
			await h.dispatch(launchFor(outside));
			expect(h.calls.map((c) => (c.body as { status: string }).status)).toEqual([
				"launching",
				"running",
				"running",
			]);
			expect(h.ran).toEqual(["headless"]);
			removeRules();
		}
	});

	test("while the rules are invalid nothing about a launch can be judged, so it is refused the same way, and the log names the rules", async () => {
		const h = harness();
		writeRules(["relative/path"]);
		await h.dispatch(launchFor(outside));
		await h.dispatch(launchFor(work));
		expect(h.calls).toEqual([
			{ path: statusPath, body: GENERIC_BODY },
			{ path: statusPath, body: GENERIC_BODY },
		]);
		expect(h.logs.some((l) => l.includes("rules_invalid"))).toBe(true);
		expect(h.ran).toEqual([]);
	});
});

describe("a prelaunch action that is refused for its own path reports the same generic body", () => {
	test("the action's trusted-roots refusal while rules are in place: launching first (as always), then the generic failure, with no path and no specific message; the specifics are logged locally", async () => {
		const h = harness({ prelaunch: rootsRefusal });
		writeRules([join(home, "unrelated")]);
		await h.dispatch(launchFor(work, { actions: true }));
		expect(h.calls).toEqual([
			{ path: statusPath, body: { status: "launching" } },
			{ path: statusPath, body: GENERIC_BODY },
		]);
		expect(JSON.stringify(h.calls)).not.toContain("/private/secret/dir");
		expect(h.logs.some((l) => l.includes("/private/secret/dir"))).toBe(true);
		expect(h.ran).toEqual(["prelaunch"]);
	});

	test("with no rules file the action's trusted-roots refusal is exactly what it always was: launching, then its own message and details", async () => {
		const h = harness({ prelaunch: rootsRefusal });
		await h.dispatch(launchFor(work, { actions: true }));
		expect(h.calls).toEqual([
			{ path: statusPath, body: { status: "launching" } },
			{
				path: statusPath,
				body: {
					status: "failed",
					error: `Path ${OUTSIDE_PATH} is not under any trusted root.`,
					providerLaunchMetadata: {
						prelaunchError: {
							code: "path_outside_trusted_roots",
							path: OUTSIDE_PATH,
							message: `Path ${OUTSIDE_PATH} is not under any trusted root.`,
						},
					},
				},
			},
		]);
	});

	test("any other prelaunch failure keeps its own message and details (unchanged behaviour)", async () => {
		const h = harness({
			prelaunch: async () => {
				throw new PrelaunchError(
					"path_traversal_rejected",
					"Path may not contain '..' segments: x",
					"x",
				);
			},
		});
		await h.dispatch(launchFor(work, { actions: true }));
		expect(h.calls[1]).toEqual({
			path: statusPath,
			body: {
				status: "failed",
				error: "Path may not contain '..' segments: x",
				providerLaunchMetadata: {
					prelaunchError: {
						code: "path_traversal_rejected",
						path: "x",
						message: "Path may not contain '..' segments: x",
					},
				},
			},
		});
	});
});

describe("with no rules file a launch issues exactly the requests it always did", () => {
	const running = (mode: string, pid: number) => ({
		status: "running",
		pid,
		providerLaunchMetadata: { mode },
	});
	const FIXTURES: Record<string, unknown[]> = {
		"headless Claude": [
			{ status: "launching" },
			{ status: "running", pid: 222, error: null, providerLaunchMetadata: { mode: "headless" } },
			running("headless", 222),
		],
		"interactive Claude": [
			{ status: "launching" },
			{
				status: "awaiting_session",
				pid: 333,
				providerLaunchMetadata: { mode: "interactive_terminal" },
			},
		],
		"managed Codex": [{ status: "launching" }, running("managed_codex", 111)],
	};

	for (const m of MODES) {
		for (const actions of [false, true]) {
			test(`${m.label}${actions ? " with" : " without"} prelaunch actions: the request list equals the recorded one`, async () => {
				const h = harness();
				await h.dispatch(launchFor(work, { agentType: m.agentType, mode: m.mode, actions }));
				expect(h.calls).toEqual(
					(FIXTURES[m.label] as unknown[]).map((body) => ({ path: statusPath, body })),
				);
			});
		}
	}

	const ODD_LAUNCHES: [string, (mode: string) => LaunchRequest][] = [
		[
			"an empty directory",
			(mode) =>
				launchFor("", mode === "managed_codex" ? { agentType: "codex_cli", mode } : { mode }),
		],
		[
			"an over-long correlation id",
			(mode) =>
				launchFor(work, {
					...(mode === "managed_codex" ? { agentType: "codex_cli" } : {}),
					mode,
					correlationId: "c".repeat(1_025),
				}),
		],
	];

	for (const m of MODES) {
		for (const [label, make] of ODD_LAUNCHES) {
			test(`${m.label} with ${label} and no rules file: the request list equals the recorded one and nothing is saved`, async () => {
				const h = harness();
				await h.dispatch(make(m.mode));
				expect(h.calls).toEqual(
					(FIXTURES[m.label] as unknown[]).map((body) => ({ path: statusPath, body })),
				);
				expect(h.ran.length).toBe(1);
				expect(existsSync(join(home, ".agentpulse", "supervisor-gate-state.json"))).toBe(false);
			});

			test(`${m.label} with ${label} while rules exist: refused with the one generic body`, async () => {
				const h = harness();
				writeRules([join(home, "unrelated")]);
				await h.dispatch(make(m.mode));
				expect(h.calls).toEqual([{ path: statusPath, body: GENERIC_BODY }]);
				expect(h.ran).toEqual([]);
			});
		}
	}

	test("a project directory that is a symlink under a trusted root pointing outside it starts as it did before (nothing about roots is checked on the way in)", async () => {
		const { symlinkSync } = await import("node:fs");
		const link = join(trusted, "linked-project");
		symlinkSync(outside, link);
		for (const m of MODES) {
			const h = harness();
			await h.dispatch(launchFor(link, { agentType: m.agentType, mode: m.mode }));
			expect(
				h.calls.map((c) => c.body),
				m.label,
			).toEqual(FIXTURES[m.label] as unknown[]);
			expect(h.ran.length, m.label).toBe(1);
		}
	});
});

describe("a launch that is allowed goes through as before, and its reports pass the gate", () => {
	test("headless Claude: launching, the provider's own progress, running with the pid", async () => {
		const h = harness();
		writeRules([join(home, "unrelated")]);
		await h.dispatch(launchFor(work, { actions: true }));
		expect(h.calls.map((c) => (c.body as { status?: string }).status)).toEqual([
			"launching",
			"running",
			"running",
		]);
		expect(h.calls[2]?.body).toEqual({
			status: "running",
			pid: 222,
			providerLaunchMetadata: { mode: "headless" },
		});
		expect(h.ran).toEqual(["prelaunch", "headless"]);
	});

	test("interactive Claude ends awaiting_session with the pid and metadata", async () => {
		const h = harness();
		await h.dispatch(launchFor(work, { mode: "interactive_terminal" }));
		expect(h.calls.at(-1)?.body).toEqual({
			status: "awaiting_session",
			pid: 333,
			providerLaunchMetadata: { mode: "interactive_terminal" },
		});
	});

	test("managed Codex ends running with the pid and metadata", async () => {
		const h = harness();
		await h.dispatch(launchFor(work, { agentType: "codex_cli", mode: "managed_codex" }));
		expect(h.calls.at(-1)?.body).toEqual({
			status: "running",
			pid: 111,
			providerLaunchMetadata: { mode: "managed_codex" },
		});
	});

	test("a provider that throws: launching, then failed with its message", async () => {
		const h = harness();
		const failing = createLaunchDispatcher({
			gate: h.gate,
			trustedRoots: [trusted],
			providers: {
				launchClaudeHeadless: async () => {
					throw new Error("claude is not installed");
				},
			} as unknown as LaunchProviders,
			executePrelaunchActions: (async () => {}) as never,
			log: () => {},
		});
		await failing(launchFor(work));
		expect(h.calls.map((c) => c.body)).toEqual([
			{ status: "launching" },
			{ status: "failed", error: "claude is not installed" },
		]);
	});

	test("an agent type this host cannot launch fails without a launching status", async () => {
		const h = harness();
		await h.dispatch(launchFor(work, { agentType: "copilot_cli", mode: "headless" }));
		expect(h.calls).toHaveLength(1);
		expect((h.calls[0]?.body as { status: string }).status).toBe("failed");
	});

	test("with other rules in place, a launch in a clean directory reports as a session of that directory (its directory was noted for both the launch and the session)", async () => {
		const h = harness();
		writeRules([join(home, "unrelated")]);
		await h.dispatch(launchFor(work, { mode: "interactive_terminal" }));
		const callbacks = h.callbacks();
		await callbacks?.reportState({ sessionId: "corr-1", status: "active" });
		await callbacks?.reportEvents([{ eventType: "x", category: "system_event", content: "hello" }]);
		expect(h.calls.map((c) => c.path)).toEqual([
			statusPath,
			statusPath,
			`${BASE}/managed-session-state`,
			`${BASE}/managed-sessions/corr-1/events`,
		]);
	});

	test("the directory is noted for the session at once: provider reports pass while it is clean, and stop after a rule covers it, with one closing report", async () => {
		const h = harness();
		await h.dispatch(launchFor(work, { mode: "interactive_terminal" }));
		const callbacks = h.callbacks();
		await callbacks?.reportState({
			sessionId: "corr-1",
			agentType: "claude_code",
			status: "active",
		});
		await callbacks?.reportEvents([{ eventType: "x", category: "system_event", content: "hello" }]);
		expect(h.calls.map((c) => c.path)).toEqual([
			statusPath,
			statusPath,
			`${BASE}/managed-session-state`,
			`${BASE}/managed-sessions/corr-1/events`,
		]);
		const before = h.calls.length;
		writeRules([work]);
		await callbacks?.reportState({ sessionId: "corr-1", status: "active", cwd: work });
		await callbacks?.reportEvents([
			{ eventType: "x", category: "system_event", content: "secret" },
		]);
		const after = h.calls.slice(before);
		expect(after).toEqual([
			{
				path: `${BASE}/managed-session-state`,
				body: {
					sessionId: "corr-1",
					status: "completed",
					managedState: "stopped",
					providerSyncState: "synced",
				},
			},
		]);
	});
});

describe("capacity: a launch is refused for capacity only when the bound's worth of sessions are really live", () => {
	test("with rules and a bound of 5, five live sessions are accepted and the sixth is refused, with a capacity reason in the log", async () => {
		const h = harness({ maxTrackedSessions: 5 });
		writeRules([work]);
		for (let i = 1; i <= 5; i++) {
			await h.dispatch(
				launchFor(outside, {
					id: `launch-${i}`,
					correlationId: `corr-${i}`,
					mode: "interactive_terminal",
				}),
			);
			await h.callbacks()?.reportState({
				sessionId: `corr-${i}`,
				agentType: "claude_code",
				status: "active",
			});
		}
		expect(h.ran).toEqual([
			"interactive",
			"interactive",
			"interactive",
			"interactive",
			"interactive",
		]);
		expect(h.logs.filter((line) => line.includes("refused"))).toEqual([]);

		const before = h.calls.length;
		await h.dispatch(
			launchFor(outside, { id: "launch-6", correlationId: "corr-6", mode: "interactive_terminal" }),
		);
		const refusal = h.logs.find((line) => line.includes("launch launch-6 refused")) ?? "";
		expect(refusal).toContain("too_many_live_sessions");
		expect(refusal).not.toContain("cwd_excluded");
		expect(h.ran).toHaveLength(5);
		expect(h.calls.slice(before)).toEqual([
			{ path: `${BASE}/launches/launch-6/status`, body: GENERIC_BODY },
		]);
	});

	test("the launch that is accepted keeps reporting: its launch id is still known when its statuses are sent", async () => {
		const h = harness({ maxTrackedSessions: 1 });
		writeRules([work]);
		await h.dispatch(launchFor(outside, { mode: "interactive_terminal" }));
		const statuses = h.calls.filter((c) => c.path === statusPath).map((c) => c.body);
		expect(statuses).toEqual([
			{ status: "launching" },
			{
				status: "awaiting_session",
				pid: 333,
				providerLaunchMetadata: { mode: "interactive_terminal" },
			},
		]);
	});
});
