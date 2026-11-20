import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inWindowAt } from "../updater/updater.js";
import {
	UPDATE_CONSENT_FILE,
	UPDATE_DRAIN_FILE,
	UPDATE_STATE_FILE,
	WINDOW_NEVER,
	readConsent,
	readDrainRequest,
	readSupervisorStatus,
	readUpdateState,
} from "./update-files.js";

let home: string;
let dir: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-uf-"));
	dir = join(home, ".agentpulse");
	mkdirSync(dir, { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const put = (name: string, body: unknown, mode = 0o600) => {
	writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), { mode });
	chmodSync(join(dir, name), mode);
};

describe("readConsent", () => {
	const OFF = { on: false, allowMigrations: false, window: null };
	test("missing, unparseable, wrong schema, no app section, app off: all off", () => {
		expect(readConsent(home)).toEqual(OFF);
		put(UPDATE_CONSENT_FILE, "{nope");
		expect(readConsent(home)).toEqual(OFF);
		put(UPDATE_CONSENT_FILE, { schema: 2, app: { on: true } });
		expect(readConsent(home)).toEqual(OFF);
		put(UPDATE_CONSENT_FILE, { schema: 1, clients: { on: true } });
		expect(readConsent(home)).toEqual(OFF);
		put(UPDATE_CONSENT_FILE, { schema: 1, app: { on: "true" } });
		expect(readConsent(home)).toEqual(OFF);
	});
	test("a file others can read, or a symlink, is off", () => {
		put(UPDATE_CONSENT_FILE, { schema: 1, app: { on: true } }, 0o644);
		expect(readConsent(home)).toEqual(OFF);
		rmSync(join(dir, UPDATE_CONSENT_FILE));
		writeFileSync(join(home, "elsewhere.json"), JSON.stringify({ schema: 1, app: { on: true } }), {
			mode: 0o600,
		});
		symlinkSync(join(home, "elsewhere.json"), join(dir, UPDATE_CONSENT_FILE));
		expect(readConsent(home)).toEqual(OFF);
	});
	test("a world-writable directory makes it off", () => {
		put(UPDATE_CONSENT_FILE, { schema: 1, app: { on: true } });
		chmodSync(dir, 0o777);
		expect(readConsent(home)).toEqual(OFF);
		chmodSync(dir, 0o700);
	});
	test("on, with migrations and a window", () => {
		put(UPDATE_CONSENT_FILE, {
			schema: 1,
			app: { on: true, allowMigrations: true, window: "02:00-05:00" },
		});
		expect(readConsent(home)).toEqual({ on: true, allowMigrations: true, window: "02:00-05:00" });
		// no window is any time; a window that is there but malformed is never (fail closed), not any time
		put(UPDATE_CONSENT_FILE, { schema: 1, app: { on: true } });
		expect(readConsent(home).window).toBeNull();
		for (const window of ["25:00-05:00", "2:00-5:00", "02:00", 7, "", "02:00-05:00;x"]) {
			put(UPDATE_CONSENT_FILE, { schema: 1, app: { on: true, window } });
			expect({ window, got: readConsent(home) }).toEqual({
				window,
				got: { on: true, allowMigrations: false, window: WINDOW_NEVER },
			});
		}
		// and the window it reads as holds no minute of the day
		for (const minute of [0, 1, 719, 720, 1439])
			expect(inWindowAt(WINDOW_NEVER, minute)).toBe(false);
	});
});

describe("readUpdateState", () => {
	test("an unreadable file is the empty state", () => {
		expect(readUpdateState(home)).toEqual({ last: null, revoked: [], refused: {} });
		put(UPDATE_STATE_FILE, "[]");
		expect(readUpdateState(home)).toEqual({ last: null, revoked: [], refused: {} });
	});
	test("keeps only allowlisted codes, ids and times", () => {
		put(UPDATE_STATE_FILE, {
			schema: 1,
			last: { seq: 4, issuedAt: "2026-11-19T11:00:00.000Z", fingerprint: "a".repeat(64) },
			revoked: ["k-abc", "bad id", 7],
			refused: { "0.12.1": "rolled_back", "0.12.2": "not_a_code", "../x": "rolled_back" },
			lastOutcome: "updated",
			lastTarget: "0.12.0",
			at: "2026-11-19T12:00:00.000Z",
			extra: "ignored",
		});
		expect(readUpdateState(home)).toEqual({
			last: { seq: 4, issuedAt: "2026-11-19T11:00:00.000Z", fingerprint: "a".repeat(64) },
			revoked: ["k-abc"],
			refused: { "0.12.1": "rolled_back" },
			lastOutcome: "updated",
			lastTarget: "0.12.0",
			at: "2026-11-19T12:00:00.000Z",
		});
	});
	test("a bad `last` reads as none", () => {
		put(UPDATE_STATE_FILE, { schema: 1, last: { seq: -1, issuedAt: "x", fingerprint: "y" } });
		expect(readUpdateState(home).last).toBeNull();
	});
});

describe("readSupervisorStatus and readDrainRequest", () => {
	const status = {
		version: "0.12.0",
		pid: 42,
		processStartedAt: "Mon Nov 17 10:02:11 2026",
		writtenAt: 1000,
		registered: true,
		idleSince: 500,
		inFlight: 0,
		draining: false,
		drained: false,
	};
	test("a well-formed status parses; anything malformed is null", () => {
		put("supervisor-status.json", { schema: 1, ...status });
		expect(readSupervisorStatus(home)).toEqual(status);
		put("supervisor-status.json", { ...status, pid: "42" });
		expect(readSupervisorStatus(home)).toBeNull();
		put("supervisor-status.json", { ...status, idleSince: "soon" });
		expect(readSupervisorStatus(home)).toBeNull();
		put("supervisor-status.json", { ...status, version: "../../x" });
		expect(readSupervisorStatus(home)).toBeNull();
		put("supervisor-status.json", { ...status }, 0o644);
		expect(readSupervisorStatus(home)).toBeNull();
	});
	test("a drain request", () => {
		expect(readDrainRequest(home)).toBeNull();
		put(UPDATE_DRAIN_FILE, { schema: 1, requestedAt: 10, expiresAt: 20 });
		expect(readDrainRequest(home)).toEqual({ requestedAt: 10, expiresAt: 20 });
		put(UPDATE_DRAIN_FILE, { schema: 1, requestedAt: "10", expiresAt: 20 });
		expect(readDrainRequest(home)).toBeNull();
	});
});
