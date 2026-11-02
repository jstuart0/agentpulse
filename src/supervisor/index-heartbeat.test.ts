/**
 * The heartbeat says something about the exclude file on this host only when
 * somebody has to act on it: a body is sent when the state is "invalid", and an
 * empty body otherwise, so the wire never says whether a host uses exclusion.
 * main() performs real network calls and cannot be run here, so (like
 * index-startup.test.ts) the wiring is a check on the real source, plus the
 * contract both ends keep: a server that has never heard of the field ignores
 * the body, and a server that knows it clears a stored "invalid" when a
 * heartbeat arrives with no body at all (see
 * src/server/routes/supervisors-heartbeat.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heartbeatBody, heartbeatOutbox } from "./services/report-gate.js";

const SUMMARY = {
	pending: 4,
	oldestPendingAt: "2026-11-01T12:00:00.000Z",
	lastFlushAt: "2026-11-01T13:00:00.000Z",
	lastFlushDelivered: 2,
	lastFlushLost: 1,
};

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

describe("what the heartbeat carries", () => {
	test("invalid is the only state that is said", () => {
		expect(heartbeatBody("invalid")).toBe('{"excludeRulesState":"invalid"}');
	});

	test("none and ok with nothing queued send no body at all", () => {
		expect(heartbeatBody("none")).toBeUndefined();
		expect(heartbeatBody("ok")).toBeUndefined();
	});

	test("with an outbox to report, every state sends a body that says excludeRulesState (none, never ok)", () => {
		for (const state of ["none", "ok", "invalid"] as const) {
			const body = JSON.parse(heartbeatBody(state, SUMMARY) as string) as Record<string, unknown>;
			expect(body.excludeRulesState).toBe(state === "invalid" ? "invalid" : "none");
			expect(body.outbox).toEqual(SUMMARY);
		}
	});

	test("the largest body is no more than 1024 bytes", () => {
		const largest = heartbeatBody("invalid", {
			pending: 10_000_000,
			oldestPendingAt: "2026-11-01T12:00:00.000Z",
			lastFlushAt: "2026-11-01T12:00:00.000Z",
			lastFlushDelivered: 10_000_000,
			lastFlushLost: 10_000_000,
		}) as string;
		expect(Buffer.byteLength(largest)).toBeLessThanOrEqual(1024);
	});
});

describe("when the outbox is reported", () => {
	const NOW = Date.parse("2026-11-02T12:00:00Z");
	const base = { ...SUMMARY, pending: 0, lastFlushAt: null };

	test("while it holds anything", () => {
		expect(heartbeatOutbox({ ...base, pending: 3 }, NOW)).toBeDefined();
	});

	test("within a day of a flush, and not after", () => {
		const at = (ms: number) => new Date(NOW - ms).toISOString();
		expect(heartbeatOutbox({ ...base, lastFlushAt: at(23 * 3_600_000) }, NOW)).toBeDefined();
		expect(heartbeatOutbox({ ...base, lastFlushAt: at(25 * 3_600_000) }, NOW)).toBeUndefined();
	});

	test("never flushed and empty: nothing", () => {
		expect(heartbeatOutbox(base, NOW)).toBeUndefined();
	});
});

describe("src/supervisor/index.ts heartbeat", () => {
	const at = SOURCE.indexOf("/heartbeat`");
	const call = SOURCE.slice(at, SOURCE.indexOf("lastHeartbeatOkAt = Date.now()", at));

	test("posts the gate's rules state through heartbeatBody, and nothing else rides along", () => {
		expect(call).toContain('method: "POST"');
		expect(call).toContain(
			"heartbeatBody(gate.rulesState(), heartbeatOutbox(outbox.summary(), Date.now()))",
		);
		expect(call).not.toContain("JSON.stringify(");
		expect(call).not.toContain("cwd");
		expect(call).not.toContain("trustedRoots");
	});

	test("a failing heartbeat is still only logged: the field cannot make the supervisor exit by itself", () => {
		const after = SOURCE.slice(at, at + 800);
		expect(after).toContain('console.error("[supervisor] heartbeat failed", error)');
	});
});

describe("src/supervisor/index.ts keeps the host alive and offline-aware (AGEN-83 phase 5)", () => {
	const strip = (text: string) =>
		text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const code = strip(SOURCE);

	test("the watchdog's exit is decided by shouldExitOnStaleHeartbeat and nothing else", () => {
		const watchdog = code.slice(
			code.indexOf("const watchdogStaleMs"),
			code.indexOf("let heartbeatInFlight"),
		);
		expect(watchdog).toContain("shouldExitOnStaleHeartbeat({");
		expect(watchdog).toContain("process.exit(1)");
		// the only exit in the watchdog is inside that decision
		const decision = watchdog.indexOf("if (shouldExitOnStaleHeartbeat");
		expect(watchdog.indexOf("process.exit(1)")).toBeGreaterThan(decision);
		expect(watchdog.match(/process\.exit\(/g)?.length).toBe(1);
	});

	test("it counts the agents it started first and looks for terminal bridges only for a stale host with none, bounded in time, an error or a timeout meaning unknown", () => {
		const watchdog = code.slice(
			code.indexOf("const watchdogStaleMs"),
			code.indexOf("let heartbeatInFlight"),
		);
		expect(watchdog).toContain("managedCodexRuntimeCount()");
		expect(watchdog).toContain("headlessRuntimeCount()");
		const stale = watchdog.indexOf("if (staleMs <= watchdogStaleMs) return;");
		expect(stale).toBeGreaterThan(-1);
		const counts = watchdog.indexOf("managedCodexRuntimeCount()");
		const bridges = watchdog.indexOf("liveBridgeCount()");
		expect(stale).toBeLessThan(counts);
		expect(counts).toBeLessThan(bridges);
		expect(watchdog).toMatch(/codex > 0 \|\| headless > 0\s*\?\s*0/);
		expect(watchdog).toMatch(/countBridgesBounded\(\s*\(\) => bridgeSpool\.liveBridgeCount\(\)/);
		expect(watchdog).toContain("BRIDGE_COUNT_TIMEOUT_MS");
	});

	test("when it stays up it says so once per stale period, and a good heartbeat starts a new period", () => {
		expect(code).toContain("keepAliveLine(");
		expect(code).toMatch(/if \(!staleLogged\) \{\s*staleLogged = true;/);
		expect(code).toMatch(/lastHeartbeatOkAt = Date\.now\(\);\s*staleLogged = false;/);
	});

	test("a heartbeat failure on the network marks the host offline; a credential rejection feeds the one tripwire; a success marks it reachable", () => {
		const beat = code.slice(
			code.indexOf("async function sendHeartbeat"),
			code.indexOf("setInterval(() => void sendHeartbeat()"),
		);
		expect(beat).toContain("gate.noteServerReachable()");
		expect(beat).toContain("classifyReportFailure(error)");
		expect(beat).toMatch(/failure === "network"\) \{\s*gate\.noteServerUnreachable\(\)/);
		// any answer, an error status included, shows the server can be reached
		expect(beat).toMatch(/error instanceof SupervisorRequestError\) gate\.noteServerContact\(\)/);
		expect(beat).toMatch(
			/failure === "credential" && credentialTripwire\.record\(\) === "confirmed"/,
		);
		expect(beat).toContain("disposeRuntimesAndExit()");
	});

	test("while the host is offline the heartbeat is also tried every 10 s, and the queue is flushed every 3 s", () => {
		expect(code).toMatch(
			/setInterval\(\(\) => \{\s*if \(gate\.isOffline\(\)\) void sendHeartbeat\(\);\s*\}, OFFLINE_PROBE_MS\)/,
		);
		expect(code).toContain("const OFFLINE_PROBE_MS = 10_000;");
		expect(code).toContain("const OUTBOX_FLUSH_MS = 3_000;");
		expect(code).toMatch(/gate\.flush\(\)\.catch/);
	});

	test("the gate gets the outbox, the one tripwire and disposeRuntimesAndExit; the drain and in-session reporting share that tripwire", () => {
		const gate = code.slice(
			code.indexOf("const gate = createReportGate({"),
			code.indexOf("}));", code.indexOf("const gate = createReportGate({")) + 1 || undefined,
		);
		expect(gate).toContain("outbox,");
		expect(gate).toContain("credentialTripwire,");
		expect(gate).toContain("onCredentialRejected: disposeRuntimesAndExit");
		expect(code).toContain("createBridgeSpoolDrain({ gate, home, credentialTripwire })");
		expect(code).toContain("setSharedCredentialTripwire(credentialTripwire)");
		expect(code.match(/createCredentialTripwire\(/g)?.length, "exactly one tripwire is built").toBe(
			1,
		);
	});

	test("a credential rejection can only end the supervisor when the server is https or local", () => {
		expect(code).toContain("canConfirm: credentialRejectionMayConfirm(config.serverUrl)");
	});
});
