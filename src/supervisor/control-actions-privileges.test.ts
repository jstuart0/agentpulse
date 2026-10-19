/**
 * A headless prompt (resume) starts a new agent process, so the control action carries the
 * launch's recorded privileges and the supervisor hands them to the provider unchanged.
 * An action that doesn't carry them reaches the provider with them undefined, which the
 * provider refuses (see launch-privileges-spawn.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlAction } from "../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "./control-actions.js";
import { createReportGate } from "./services/report-gate.js";

let home: string;
let work: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-privileges-")));
	work = join(home, "trusted", "project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

async function promptWith(metadata: Record<string, unknown>) {
	const received: Array<Record<string, unknown>> = [];
	const gate = createReportGate({
		request: async () => ({ session: { displayName: "x" }, managedSession: {}, events: [] }),
		supervisorId: "sup-1",
		home,
		now: () => 0,
		log: () => {},
	});
	const providers = {
		stopManagedCodexSession: async () => {},
		promptClaudeHeadlessSession: async (a: Record<string, unknown>) => {
			received.push(a);
			return { pid: 1, metadata: {}, monitor: Promise.resolve() };
		},
		promptClaudeInteractiveSession: async () => ({ metadata: {} }),
	} as unknown as ControlProviders;
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: work })) as never,
		log: () => {},
	});
	await handle({
		id: "act-1",
		sessionId: "sess-1",
		launchRequestId: null,
		actionType: "prompt",
		requestedBy: null,
		status: "claimed",
		error: null,
		metadata: { prompt: "go", cwd: work, managedState: "headless", ...metadata },
	} as unknown as ControlAction);
	return received;
}

describe("headless prompt actions pass the recorded privileges to the provider", () => {
	test("values are passed unchanged", async () => {
		const [action] = await promptWith({ approvalPolicy: "manual", sandboxMode: "read-only" });
		expect(action.approvalPolicy).toBe("manual");
		expect(action.sandboxMode).toBe("read-only");
	});

	test("an explicit null stays null (the recorded agent default), distinct from absent", async () => {
		const [action] = await promptWith({ approvalPolicy: null, sandboxMode: null });
		expect(action.approvalPolicy).toBeNull();
		expect(action.sandboxMode).toBeNull();
	});

	test("absent stays undefined so the provider can refuse it", async () => {
		const [action] = await promptWith({});
		expect(action.approvalPolicy).toBeUndefined();
		expect(action.sandboxMode).toBeUndefined();
	});
});

describe("a headless resume is judged against the host's trusted roots", () => {
	test("a directory outside them is refused and the provider is never asked", async () => {
		const outside = join(home, "elsewhere");
		mkdirSync(outside, { recursive: true });
		const received = await promptWith({ cwd: outside, approvalPolicy: null, sandboxMode: null });
		expect(received).toEqual([]);
	});

	test("a path that climbs out of a trusted root with .. is refused", async () => {
		const received = await promptWith({
			cwd: join(work, "..", "..", "elsewhere"),
			approvalPolicy: null,
			sandboxMode: null,
		});
		expect(received).toEqual([]);
	});

	test("a directory inside them is allowed", async () => {
		const received = await promptWith({ approvalPolicy: null, sandboxMode: null });
		expect(received).toHaveLength(1);
	});
});

describe("a headless resume starts in the real path it checked", () => {
	test("a symlink alias inside a trusted root is resolved, and the provider gets the real path", async () => {
		const { symlinkSync } = await import("node:fs");
		const alias = join(home, "trusted", "alias");
		symlinkSync(work, alias);
		const [received] = await promptWith({ cwd: alias, approvalPolicy: null, sandboxMode: null });
		expect(received.cwd).toBe(work);
	});

	test("a symlink that leaves the root, and '..' after a symlink, are refused and nothing is spawned", async () => {
		const { symlinkSync } = await import("node:fs");
		const outside = join(home, "elsewhere", "deep");
		mkdirSync(outside, { recursive: true });
		const escapeLink = join(home, "trusted", "escape");
		symlinkSync(outside, escapeLink);
		for (const cwd of [escapeLink, `${escapeLink}/..`, `${escapeLink}/../../trusted/project`]) {
			const received = await promptWith({ cwd, approvalPolicy: null, sandboxMode: null });
			expect(received, cwd).toEqual([]);
		}
	});
});
