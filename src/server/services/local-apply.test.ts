/**
 * `UpdateStatus.localApply` on the server: what this machine's updater did, from two files read through the
 * shared reader. Codes, versions and times only; a malformed state file is `null`, not a guess. A temporary
 * HOME throughout: the real ~/.agentpulse is never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_OUTCOME_CODES } from "../../shared/update-status.js";
import { readLocalApply, readLocalApplyCached } from "./local-apply.js";

let home: string;
let dir: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-localapply-"));
	dir = join(home, ".agentpulse");
	mkdirSync(dir, { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const put = (name: string, body: unknown, mode = 0o600) => {
	writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), { mode });
	chmodSync(join(dir, name), mode);
};
const consentOn = { schema: 1, app: { on: true, allowMigrations: false, window: null } };

describe("readLocalApply", () => {
	test("a machine whose updater never ran is just its consent", () => {
		expect(readLocalApply(home, "local")).toEqual({ auto: false });
		put("update-consent.json", consentOn);
		expect(readLocalApply(home, "local")).toEqual({ auto: true });
	});

	test("carries the last outcome, target and times, and nothing else the state file holds", () => {
		put("update-consent.json", consentOn);
		put("update-state.json", {
			schema: 1,
			lastOutcome: "supervisor_busy",
			lastTarget: "0.12.0",
			at: "2026-11-19T10:00:00.000Z",
			waitingSince: "2026-11-19T04:00:00.000Z",
			last: { seq: 3, issuedAt: "2026-11-19T10:00:00.000Z", fingerprint: "a".repeat(64) },
			revoked: ["k1"],
			refused: { "0.11.9": "rolled_back" },
			backoff: { failures: 2, notBefore: "2026-11-19T16:00:00.000Z" },
			note: "/Users/someone/secret",
		});
		const apply = readLocalApply(home, "local");
		expect(apply).toEqual({
			auto: true,
			lastOutcome: "supervisor_busy",
			lastTarget: "0.12.0",
			at: "2026-11-19T10:00:00.000Z",
			waitingSince: "2026-11-19T04:00:00.000Z",
		});
		expect(Object.keys(apply ?? {}).sort()).toEqual(
			["at", "auto", "lastOutcome", "lastTarget", "waitingSince"].sort(),
		);
	});

	test("backoffUntil is there only while the hold is still ahead", () => {
		const now = Date.parse("2026-11-19T12:00:00.000Z");
		put("update-state.json", {
			schema: 1,
			lastOutcome: "rolled_back",
			backoff: { failures: 1, notBefore: "2026-11-19T13:00:00.000Z" },
		});
		expect(readLocalApply(home, "local", now)?.backoffUntil).toBe("2026-11-19T13:00:00.000Z");
		expect(readLocalApply(home, "local", now + 3_600_000)?.backoffUntil).toBeUndefined();
		expect("backoffUntil" in (readLocalApply(home, "local", now + 7_200_000) ?? {})).toBe(false);
	});

	test("an outcome that isn't one of the closed codes, a made-up version or time is dropped, not passed on", () => {
		put("update-state.json", {
			schema: 1,
			lastOutcome: "<script>alert(1)</script>",
			lastTarget: "1.2.3; rm -rf /",
			at: "yesterday",
			waitingSince: "/etc/passwd",
		});
		expect(readLocalApply(home, "local")).toEqual({ auto: false });
		for (const code of UPDATE_OUTCOME_CODES) {
			put("update-state.json", { schema: 1, lastOutcome: code });
			expect(readLocalApply(home, "local")?.lastOutcome).toBe(code);
		}
	});

	test("a malformed, untrusted or wrong-schema state file is null", () => {
		put("update-consent.json", consentOn);
		for (const text of [
			"{not json",
			"[]",
			'"x"',
			JSON.stringify({ schema: 2, lastOutcome: "updated" }),
		]) {
			put("update-state.json", text);
			expect(readLocalApply(home, "local")).toBeNull();
		}
		// readable by others
		put("update-state.json", { schema: 1, lastOutcome: "updated" }, 0o644);
		expect(readLocalApply(home, "local")).toBeNull();
		// a link
		rmSync(join(dir, "update-state.json"));
		put("real-state.json", { schema: 1, lastOutcome: "updated" });
		symlinkSync(join(dir, "real-state.json"), join(dir, "update-state.json"));
		expect(readLocalApply(home, "local")).toBeNull();
		// control: the same body in a plain private file is read
		rmSync(join(dir, "update-state.json"));
		put("update-state.json", { schema: 1, lastOutcome: "updated" });
		expect(readLocalApply(home, "local")).toEqual({ auto: true, lastOutcome: "updated" });
	});

	test("only a local install has it", () => {
		put("update-consent.json", consentOn);
		put("update-state.json", { schema: 1, lastOutcome: "updated" });
		for (const kind of ["container", "kubernetes", "source"] as const) {
			expect(readLocalApply(home, kind)).toBeNull();
		}
	});

	test("the cache holds an answer for five seconds, then reads again", () => {
		put("update-state.json", { schema: 1, lastOutcome: "updated" });
		const first = readLocalApplyCached(home, "local", 1_000_000);
		put("update-state.json", { schema: 1, lastOutcome: "rolled_back" });
		expect(readLocalApplyCached(home, "local", 1_004_000)).toEqual(first);
		expect(readLocalApplyCached(home, "local", 1_006_000)?.lastOutcome).toBe("rolled_back");
	});
});
