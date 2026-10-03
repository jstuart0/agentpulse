/**
 * A control action for a session in an excluded directory is not executed: the
 * provider is never asked, and the only thing reported is the generic failure
 * (the same sentence a refused launch carries), once. While the rules are
 * invalid nothing is executed or reported at all. Actions for sessions that are
 * not covered run exactly as before, and every report they make passes the gate.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlAction } from "../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "./control-actions.js";
import { CleanupError } from "./services/cleanup-workarea.js";
import { LAUNCH_REFUSED_MESSAGE, createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const BASE = `/supervisors/${SUPERVISOR_ID}`;
const GENERIC = { status: "failed", error: LAUNCH_REFUSED_MESSAGE };

let home: string;
let work: string;
let open: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-exclude-")));
	work = join(home, "trusted", "secret-project");
	open = join(home, "trusted", "open-project");
	for (const dir of [work, open]) mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

let rulesVersion = 0;
function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++rulesVersion * 1000);
	utimesSync(file, at, at);
}

type Call = { path: string; body: unknown };

function harness(
	over: {
		stopFails?: boolean;
		monitor?: Promise<void>;
		cleanup?: (cwd: string) => Promise<{ removed: boolean; resolvedPath: string }>;
	} = {},
) {
	// Every harness is a supervisor process that has just started: nothing remembered from another one in this test.
	rmSync(join(home, ".agentpulse", "supervisor-gate-state.json"), { force: true });
	const calls: Call[] = [];
	const ran: string[] = [];
	const logs: string[] = [];
	const request = async (path: string, options?: RequestInit) => {
		calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : undefined });
		return { session: { displayName: "x" }, managedSession: {}, events: [] };
	};
	const gate = createReportGate({
		request,
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	});
	const providers = {
		stopManagedCodexSession: async (id: string) => {
			ran.push(`stop:${id}`);
			if (over.stopFails) throw new Error("runtime gone");
		},
		promptClaudeHeadlessSession: async () => {
			ran.push("prompt-headless");
			return { pid: 1, metadata: { mode: "headless" }, monitor: over.monitor ?? Promise.resolve() };
		},
		promptClaudeInteractiveSession: async () => {
			ran.push("prompt-interactive");
			return { metadata: { delivered: true } };
		},
	} as unknown as ControlProviders;
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers,
		executeCleanupWorkArea: (async ({ cwd }: { cwd: string }) => {
			ran.push(`cleanup:${cwd}`);
			if (over.cleanup) return over.cleanup(cwd);
			return { removed: true, resolvedPath: cwd };
		}) as never,
		log: (line) => logs.push(line),
	});
	return { calls, ran, logs, gate, handle };
}

const action = (
	over: Partial<ControlAction> & { actionType: ControlAction["actionType"] },
): ControlAction =>
	({
		id: "act-1",
		sessionId: "sess-1",
		launchRequestId: null,
		requestedBy: null,
		status: "claimed",
		error: null,
		metadata: null,
		...over,
	}) as unknown as ControlAction;

const statusPath = (id = "act-1") => `${BASE}/control-actions/${id}/status`;

describe("an action for an excluded session is not executed", () => {
	test("stop: the provider is never asked, and the only request is the generic failure", async () => {
		const h = harness();
		h.gate.noteCwd("sess-1", work);
		writeRules([work]);
		await h.handle(action({ actionType: "stop" }));
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});

	test("prompt (headless and interactive): never executed, the generic failure and nothing else", async () => {
		for (const managedState of ["headless", "interactive_terminal"]) {
			const h = harness();
			writeRules([work]);
			await h.handle(
				action({
					actionType: "prompt",
					metadata: { prompt: "do the secret thing", cwd: work, managedState },
				}),
			);
			expect(h.ran, managedState).toEqual([]);
			expect(h.calls, managedState).toEqual([{ path: statusPath(), body: GENERIC }]);
			expect(JSON.stringify(h.calls)).not.toContain("secret thing");
		}
	});

	test("cleanup_workarea: never executed, the generic failure only", async () => {
		const h = harness();
		writeRules([work]);
		await h.handle(
			action({ actionType: "cleanup_workarea", sessionId: null, metadata: { cwd: work } }),
		);
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});

	test("a session whose directory this supervisor never saw is treated as excluded while rules exist", async () => {
		const h = harness();
		writeRules([work]);
		await h.handle(action({ actionType: "stop", sessionId: "unknown-session" }));
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});

	test("invalid rules: nothing is executed and nothing is reported", async () => {
		const h = harness();
		h.gate.noteCwd("sess-1", open);
		writeRules(["relative/path"]);
		await h.handle(action({ actionType: "stop" }));
		await h.handle(
			action({ id: "act-2", actionType: "prompt", metadata: { prompt: "p", cwd: open } }),
		);
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([]);
	});

	test("a prompt that was running when a rule covered its directory ends with the generic failure, not with its output", async () => {
		let finish: () => void = () => {};
		const monitor = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const h = harness({ monitor });
		await h.handle(
			action({
				actionType: "prompt",
				metadata: { prompt: "p", cwd: work, managedState: "headless" },
			}),
		);
		expect(h.ran).toEqual(["prompt-headless"]);
		writeRules([work]);
		finish();
		await new Promise((r) => setTimeout(r, 20));
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});
});

describe("the supervisor's own knowledge of a session wins over the server's", () => {
	const SECRET_PROMPT = "do the secret thing";

	test("a known clean session and a prompt naming another clean directory: refused, never executed, the prompt text is nowhere", async () => {
		const other = join(home, "trusted", "other-project");
		mkdirSync(other, { recursive: true });
		const h = harness();
		h.gate.noteCwd("sess-1", open);
		writeRules([work]);
		await h.handle(
			action({
				actionType: "prompt",
				metadata: { prompt: SECRET_PROMPT, cwd: other, managedState: "interactive_terminal" },
			}),
		);
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
		expect(JSON.stringify([h.calls, h.logs])).not.toContain("secret thing");
		expect(h.logs.join("\n")).not.toContain(other);
	});

	test("launched in a covered directory, no scan yet, and an action that names a clean one: ends excluded, not executed, and stays excluded", async () => {
		const h = harness();
		h.gate.noteCwd("sess-1", work);
		writeRules([work]);
		await h.handle(
			action({
				actionType: "prompt",
				metadata: { prompt: SECRET_PROMPT, cwd: open, managedState: "headless" },
			}),
		);
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
		expect(h.gate.verdict("sess-1")).toBe("excluded");
		await h.handle(action({ id: "act-2", actionType: "stop" }));
		expect(h.ran).toEqual([]);
	});

	test("a clean known session and an action that names a covered directory: excluded, not executed", async () => {
		const h = harness();
		h.gate.noteCwd("sess-1", open);
		writeRules([work]);
		await h.handle(
			action({ actionType: "prompt", metadata: { prompt: SECRET_PROMPT, cwd: work } }),
		);
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});

	test("a session this supervisor never saw, while rules exist: prompt and stop are refused whatever directory they name", async () => {
		const h = harness();
		writeRules([work]);
		await h.handle(
			action({
				actionType: "prompt",
				sessionId: "adopted-1",
				metadata: { prompt: SECRET_PROMPT, cwd: open, managedState: "interactive_terminal" },
			}),
		);
		await h.handle(action({ id: "act-2", actionType: "stop", sessionId: "adopted-1" }));
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([
			{ path: statusPath(), body: GENERIC },
			{ path: statusPath("act-2"), body: GENERIC },
		]);
	});

	test("with no rules file at all a session this supervisor never saw is prompted and stopped as before", async () => {
		const h = harness();
		await h.handle(
			action({
				actionType: "prompt",
				sessionId: "adopted-1",
				metadata: { prompt: "hello", cwd: open, managedState: "interactive_terminal" },
			}),
		);
		await h.handle(action({ id: "act-2", actionType: "stop", sessionId: "adopted-1" }));
		expect(h.ran).toEqual(["prompt-interactive", "stop:adopted-1"]);
		expect(h.calls.map((c) => c.body)).toEqual([
			{ status: "succeeded", metadata: { delivered: true } },
			{
				sessionId: "adopted-1",
				status: "completed",
				managedState: "stopped",
				providerSyncState: "synced",
			},
			{
				events: [
					{
						eventType: "ManagedSessionStopped",
						category: "system_event",
						content: "Managed session stopped by operator.",
					},
				],
			},
			{ status: "succeeded" },
		]);
		expect(h.calls.map((c) => c.path)).toEqual([
			statusPath(),
			`${BASE}/managed-session-state`,
			`${BASE}/managed-sessions/adopted-1/events`,
			statusPath("act-2"),
		]);
	});

	test("an action that is not about a session is judged by the directory it names: covered refused, clean runs, none named refused", async () => {
		const h = harness();
		writeRules([work]);
		await h.handle(
			action({
				id: "a-1",
				actionType: "cleanup_workarea",
				sessionId: null,
				metadata: { cwd: open },
			}),
		);
		await h.handle(
			action({
				id: "a-2",
				actionType: "cleanup_workarea",
				sessionId: null,
				metadata: { cwd: work },
			}),
		);
		expect(h.ran).toEqual([`cleanup:${open}`]);
		expect(h.calls.map((c) => [c.path, (c.body as { status: string }).status])).toEqual([
			[statusPath("a-1"), "succeeded"],
			[statusPath("a-2"), "failed"],
		]);
	});
});

describe("every refusal of cleanup_workarea answers the one generic body while rules exist", () => {
	const CODES = [
		"path_not_absolute",
		"path_traversal_rejected",
		"path_outside_trusted_roots",
		"symlink_rejected",
		"permission_denied",
		"not_a_directory",
	] as const;
	const SECRET_PATH = "/private/secret/area";
	const refuse = (code: (typeof CODES)[number]) => async () => {
		throw new CleanupError(code, `refused ${code} for ${SECRET_PATH}`, SECRET_PATH);
	};
	const cleanup = (cwd: string, id = "act-1") =>
		action({ id, actionType: "cleanup_workarea", sessionId: null, metadata: { cwd } });

	for (const code of CODES) {
		test(`${code}: exactly the generic body, nothing of the path or the code, the specifics only in the local log`, async () => {
			const h = harness({ cleanup: refuse(code) });
			writeRules([work]);
			await h.handle(cleanup(open));
			expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
			expect(JSON.stringify(h.calls)).not.toContain(SECRET_PATH);
			expect(JSON.stringify(h.calls)).not.toContain(code);
			expect(h.logs.some((l) => l.includes(code) && l.includes(SECRET_PATH))).toBe(true);
		});

		test(`${code}: with no rules file the body is what it always was (message and details)`, async () => {
			const h = harness({ cleanup: refuse(code) });
			await h.handle(cleanup(open));
			expect(h.calls).toEqual([
				{
					path: statusPath(),
					body: {
						status: "failed",
						error: `refused ${code} for ${SECRET_PATH}`,
						metadata: {
							cwd: open,
							cleanupError: {
								code,
								path: SECRET_PATH,
								message: `refused ${code} for ${SECRET_PATH}`,
							},
						},
					},
				},
			]);
		});
	}

	test("a failure that is not a CleanupError, and a session action with no directory: generic while rules exist, their own text without", async () => {
		const failing = async () => {
			throw new Error("disk exploded at /private/secret/area");
		};
		const withRules = harness({ cleanup: failing });
		writeRules([work]);
		await withRules.handle(cleanup(open));
		withRules.gate.noteCwd("sess-1", open);
		await withRules.handle(
			action({ id: "act-2", actionType: "cleanup_workarea", sessionId: "sess-1", metadata: {} }),
		);
		expect(withRules.calls).toEqual([
			{ path: statusPath(), body: GENERIC },
			{ path: statusPath("act-2"), body: GENERIC },
		]);

		rmSync(join(home, ".agentpulse", "exclude"));
		const without = harness({ cleanup: failing });
		without.gate.noteCwd("sess-1", open);
		await without.handle(cleanup(open));
		await without.handle(
			action({ id: "act-2", actionType: "cleanup_workarea", sessionId: "sess-1", metadata: {} }),
		);
		expect(without.calls).toEqual([
			{
				path: statusPath(),
				body: {
					status: "failed",
					error: "disk exploded at /private/secret/area",
					metadata: { cwd: open },
				},
			},
			{
				path: statusPath("act-2"),
				body: {
					status: "failed",
					error: "cleanup_workarea action is missing cwd metadata.",
					metadata: {},
				},
			},
		]);
	});

	test("a directory named with ~ is expanded to the home directory before it is judged: an absolute rule covers it", async () => {
		const h = harness();
		writeRules([join(home, "trusted", "secret-project")]);
		await h.handle(cleanup("~/trusted/secret-project"));
		expect(h.ran).toEqual([]);
		expect(h.calls).toEqual([{ path: statusPath(), body: GENERIC }]);
	});

	test("a ~ path no rule covers is not refused by the gate", async () => {
		const h = harness();
		writeRules([join(home, "trusted", "secret-project")]);
		await h.handle(cleanup("~/trusted/open-project"));
		expect(h.ran).toEqual(["cleanup:~/trusted/open-project"]);
	});
});

describe("an action that is allowed runs as before", () => {
	test("stop: the provider stops it, then state, event and result are reported in that order", async () => {
		const h = harness();
		h.gate.noteCwd("sess-1", open);
		writeRules([work]);
		await h.handle(action({ actionType: "stop" }));
		expect(h.ran).toEqual(["stop:sess-1"]);
		expect(h.calls.map((c) => c.path)).toEqual([
			`${BASE}/managed-session-state`,
			`${BASE}/managed-sessions/sess-1/events`,
			statusPath(),
		]);
		expect(h.calls[0]?.body).toEqual({
			sessionId: "sess-1",
			status: "completed",
			managedState: "stopped",
			providerSyncState: "synced",
		});
		expect(h.calls[2]?.body).toEqual({ status: "succeeded" });
	});

	test("stop that fails: the failure message is reported", async () => {
		const h = harness({ stopFails: true });
		h.gate.noteCwd("sess-1", open);
		await h.handle(action({ actionType: "stop" }));
		expect(h.calls.at(-1)).toEqual({
			path: statusPath(),
			body: { status: "failed", error: "runtime gone" },
		});
	});

	test("headless prompt: the result is reported when the run finishes", async () => {
		const h = harness();
		await h.handle(
			action({
				actionType: "prompt",
				metadata: { prompt: "hello", cwd: open, managedState: "headless" },
			}),
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(h.calls).toEqual([
			{ path: statusPath(), body: { status: "succeeded", metadata: { mode: "headless" } } },
		]);
	});

	test("cleanup_workarea in a clean directory runs and reports what was removed", async () => {
		const h = harness();
		writeRules([work]);
		await h.handle(
			action({ actionType: "cleanup_workarea", sessionId: null, metadata: { cwd: open } }),
		);
		expect(h.ran).toEqual([`cleanup:${open}`]);
		expect(h.calls[0]?.body).toEqual({
			status: "succeeded",
			metadata: { cwd: open, cleanup: { removed: true, resolvedPath: open } },
		});
	});

	test("a prompt without a prompt or a directory, and an unknown action type, fail with their own messages", async () => {
		const h = harness();
		await h.handle(action({ actionType: "prompt", metadata: { prompt: "", cwd: "" } }));
		await h.handle(action({ id: "act-2", actionType: "fork" }));
		expect(h.calls).toEqual([
			{
				path: statusPath(),
				body: { status: "failed", error: "Prompt action is missing prompt or working directory." },
			},
			{
				path: statusPath("act-2"),
				body: { status: "failed", error: "Unsupported control action: fork" },
			},
		]);
	});
});
