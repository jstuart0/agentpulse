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
import { heartbeatBody } from "./services/report-gate.js";

const SOURCE = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");

describe("what the heartbeat carries", () => {
	test("invalid is the only state that is said", () => {
		expect(heartbeatBody("invalid")).toBe('{"excludeRulesState":"invalid"}');
	});

	test("none and ok send no body at all", () => {
		expect(heartbeatBody("none")).toBeUndefined();
		expect(heartbeatBody("ok")).toBeUndefined();
	});
});

describe("src/supervisor/index.ts heartbeat", () => {
	const at = SOURCE.indexOf("/heartbeat`");
	const call = SOURCE.slice(at, SOURCE.indexOf("lastHeartbeatOkAt = Date.now()", at));

	test("posts the gate's rules state through heartbeatBody, and nothing else rides along", () => {
		expect(call).toContain('method: "POST"');
		expect(call).toContain("body: heartbeatBody(gate.rulesState())");
		expect(call).not.toContain("JSON.stringify(");
		expect(call).not.toContain("cwd");
		expect(call).not.toContain("trustedRoots");
	});

	test("a failing heartbeat is still only logged: the field cannot make the supervisor exit by itself", () => {
		const after = SOURCE.slice(at, at + 800);
		expect(after).toContain('console.error("[supervisor] heartbeat failed", error)');
	});
});
