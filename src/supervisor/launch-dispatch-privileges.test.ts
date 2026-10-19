/**
 * A launch whose approval policy or sandbox mode can't be applied to its agent is
 * failed by the dispatcher before anything runs: no "launching" status, no prelaunch
 * action, no provider call. A launch that can be applied still reaches its provider.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../shared/types.js";
import { type LaunchProviders, createLaunchDispatcher } from "./launch-dispatch.js";
import { createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const STATUS_PATH = `/supervisors/${SUPERVISOR_ID}/launches/launch-1/status`;

let home: string;
let work: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-dispatch-privileges-")));
	work = join(home, "trusted", "project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function harness() {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const ran: string[] = [];
	const launched: LaunchRequest[] = [];
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			calls.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	});
	const providers = {
		launchManagedCodex: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("codex");
			return { pid: 1, metadata: {}, runtime: {} };
		},
		launchClaudeHeadless: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("headless");
			return { pid: 2, metadata: {}, monitor: Promise.resolve() };
		},
		launchClaudeInteractive: async (l: LaunchRequest) => {
			launched.push(l);
			ran.push("interactive");
			return { pid: 3, metadata: {} };
		},
	} as unknown as LaunchProviders;
	const dispatch = createLaunchDispatcher({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers,
		executePrelaunchActions: (async () => {
			ran.push("prelaunch");
		}) as never,
		log: () => {},
		warn: () => {},
	});
	return { calls, ran, launched, dispatch };
}

function launch(over: Record<string, unknown>): LaunchRequest {
	return {
		id: "launch-1",
		launchCorrelationId: "corr-1",
		agentType: "claude_code",
		requestedLaunchMode: "headless",
		cwd: work,
		model: "m",
		env: {},
		launchSpec: { prelaunchActions: [{ kind: "scaffold_workarea", path: work }] },
		...over,
	} as unknown as LaunchRequest;
}

const MODES = [
	{ agentType: "claude_code", mode: "headless", provider: "headless" },
	{ agentType: "claude_code", mode: "interactive_terminal", provider: "interactive" },
	{ agentType: "codex_cli", mode: "managed_codex", provider: "codex" },
] as const;

describe("unenforceable launches are failed before anything runs", () => {
	const bad: Array<[string, Record<string, unknown>]> = [
		["approvalPolicy auto", { approvalPolicy: "auto" }],
		["approvalPolicy on-failure", { approvalPolicy: "on-failure" }],
		["an unknown approvalPolicy", { approvalPolicy: "bypassPermissions" }],
		["an unknown sandboxMode", { sandboxMode: "everything" }],
	];
	for (const m of MODES) {
		for (const [label, fields] of bad) {
			test(`${m.agentType}/${m.mode} with ${label}: one failed status, no prelaunch, no provider`, async () => {
				const h = harness();
				await h.dispatch(
					launch({ agentType: m.agentType, requestedLaunchMode: m.mode, ...fields }),
				);
				expect(h.ran).toEqual([]);
				expect(h.calls).toHaveLength(1);
				expect(h.calls[0].path).toBe(STATUS_PATH);
				expect(h.calls[0].body.status).toBe("failed");
				expect(String(h.calls[0].body.error)).toStartWith("Launch not started: ");
			});
		}
	}

	test("Claude Code with a sandbox mode it can't provide is failed (it has no sandbox-mode flag)", async () => {
		for (const sandboxMode of ["read-only", "workspace-write"]) {
			const h = harness();
			await h.dispatch(launch({ sandboxMode }));
			expect(h.ran).toEqual([]);
			expect(String(h.calls[0].body.error)).toContain("no sandbox-mode launch flag");
		}
	});

	test("the failure names the setting and the allowed values", async () => {
		const h = harness();
		await h.dispatch(launch({ approvalPolicy: "yolo" }));
		expect(String(h.calls[0].body.error)).toContain("Approval policy 'yolo' isn't recognised");
		expect(String(h.calls[0].body.error)).toContain(
			"default, suggest, auto, manual, untrusted, on-failure",
		);
	});
});

describe("enforceable launches still run", () => {
	test("each mode reaches its provider with valid settings, and with none", async () => {
		for (const m of MODES) {
			for (const fields of [
				{},
				{ approvalPolicy: null, sandboxMode: null },
				{ approvalPolicy: "manual" },
				...(m.agentType === "codex_cli" ? [{ sandboxMode: "read-only" }] : []),
			]) {
				const h = harness();
				await h.dispatch(
					launch({ agentType: m.agentType, requestedLaunchMode: m.mode, ...fields }),
				);
				expect(h.ran).toEqual(["prelaunch", m.provider]);
				expect(h.calls.some((c) => c.body.status === "failed")).toBe(false);
			}
		}
	});
});

describe("env that could undo the permissions", () => {
	for (const m of MODES) {
		test(`${m.agentType}/${m.mode}: CLAUDE_CONFIG_DIR / CODEX_HOME / HOME fail the launch before anything runs`, async () => {
			for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "NODE_OPTIONS"]) {
				const h = harness();
				await h.dispatch(
					launch({ agentType: m.agentType, requestedLaunchMode: m.mode, env: { [name]: "/x" } }),
				);
				expect(h.ran).toEqual([]);
				expect(String(h.calls[0].body.error)).toContain(name);
			}
		});
	}
});

describe("the prompt, the mapping and the directory are checked before anything runs", () => {
	test("a dash-leading Claude task prompt fails the launch before prelaunch actions; Codex takes its prompt as text and is unaffected", async () => {
		for (const mode of ["headless", "interactive_terminal"] as const) {
			const h = harness();
			await h.dispatch(
				launch({ requestedLaunchMode: mode, taskPrompt: "--permission-mode=bypassPermissions" }),
			);
			expect(h.ran).toEqual([]);
			expect(String(h.calls[0].body.error)).toContain("starts with '-'");
		}
		const codex = harness();
		await codex.dispatch(
			launch({
				agentType: "codex_cli",
				requestedLaunchMode: "managed_codex",
				taskPrompt: "- fix it",
			}),
		);
		expect(codex.ran).toEqual(["prelaunch", "codex"]);
	});

	test("expectedEnforcedArgs that disagree with this supervisor's own mapping fail the launch; matching ones run", async () => {
		const mismatch = harness();
		await mismatch.dispatch(launch({ approvalPolicy: "manual", expectedEnforcedArgs: [] }));
		expect(mismatch.ran).toEqual([]);
		expect(String(mismatch.calls[0].body.error)).toContain("different versions");

		const bypass = harness();
		await bypass.dispatch(
			launch({
				approvalPolicy: "manual",
				expectedEnforcedArgs: ["--permission-mode", "bypassPermissions"],
			}),
		);
		expect(bypass.ran).toEqual([]);

		const ok = harness();
		await ok.dispatch(
			launch({ approvalPolicy: "manual", expectedEnforcedArgs: ["--permission-mode", "default"] }),
		);
		expect(ok.ran).toEqual(["prelaunch", "headless"]);

		const absent = harness();
		await absent.dispatch(launch({ approvalPolicy: "manual" }));
		expect(absent.ran).toEqual(["prelaunch", "headless"]);
	});

	test("the provider is started in the real path that was checked, not the string the launch carried", async () => {
		const { symlinkSync } = await import("node:fs");
		const alias = join(home, "trusted", "alias");
		symlinkSync(work, alias);
		for (const m of MODES) {
			const h = harness();
			await h.dispatch(launch({ agentType: m.agentType, requestedLaunchMode: m.mode, cwd: alias }));
			expect(h.launched, m.mode).toHaveLength(1);
			expect(h.launched[0].cwd, m.mode).toBe(work);
		}
	});

	test("a symlink that points outside the trusted roots, and '..' after one, never reach a provider or a prelaunch action", async () => {
		const { symlinkSync } = await import("node:fs");
		const outside = join(home, "elsewhere");
		mkdirSync(outside, { recursive: true });
		const escapeLink = join(home, "trusted", "escape");
		symlinkSync(outside, escapeLink);
		for (const m of MODES) {
			for (const cwd of [escapeLink, `${escapeLink}/../project`]) {
				const h = harness();
				await h.dispatch(launch({ agentType: m.agentType, requestedLaunchMode: m.mode, cwd }));
				expect(h.ran, `${m.mode} ${cwd}`).toEqual([]);
				expect(h.launched).toEqual([]);
				expect(h.calls[0].body.status).toBe("failed");
			}
		}
	});
});
