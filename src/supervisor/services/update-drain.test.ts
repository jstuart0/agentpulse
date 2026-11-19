import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_DRAIN_FILE, readSupervisorStatus } from "../../shared/update-files.js";
import {
	type IdleCounts,
	createUpdateDrain,
	drainIsFresh,
	isUpdateIdle,
	refuseUnderDrain,
	routeClaimed,
	shouldClaimNormally,
} from "./update-drain.js";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const idle: IdleCounts = { codex: 0, headless: 0, bridges: 0, approvals: 0, inFlight: 0 };

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-drain-"));
	mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeDrain(body: unknown) {
	writeFileSync(join(home, ".agentpulse", UPDATE_DRAIN_FILE), JSON.stringify(body), {
		mode: 0o600,
	});
}

describe("isUpdateIdle", () => {
	test("idle only when every count is zero and the bridge count was learned", () => {
		expect(isUpdateIdle(idle)).toBe(true);
		expect(isUpdateIdle({ ...idle, codex: 1 })).toBe(false);
		expect(isUpdateIdle({ ...idle, headless: 1 })).toBe(false);
		expect(isUpdateIdle({ ...idle, approvals: 1 })).toBe(false);
		expect(isUpdateIdle({ ...idle, inFlight: 1 })).toBe(false);
		expect(isUpdateIdle({ ...idle, bridges: 1 })).toBe(false);
		// bridges === null: could not be counted, so something may be running.
		expect(isUpdateIdle({ ...idle, bridges: null })).toBe(false);
	});
});

describe("drain freshness", () => {
	test("a request inside its window is fresh", () => {
		expect(drainIsFresh({ requestedAt: NOW - MIN, expiresAt: NOW + 2 * MIN }, NOW)).toBe(true);
	});
	test("an expiry far in the future is ignored", () => {
		expect(drainIsFresh({ requestedAt: NOW, expiresAt: Date.UTC(2999, 0, 1) }, NOW)).toBe(false);
		expect(drainIsFresh({ requestedAt: NOW, expiresAt: NOW + 15 * MIN + 1 }, NOW)).toBe(false);
	});
	test("a request older than 15 minutes, an expired one and a missing one are ignored", () => {
		expect(drainIsFresh({ requestedAt: NOW - 16 * MIN, expiresAt: NOW + MIN }, NOW)).toBe(false);
		expect(drainIsFresh({ requestedAt: NOW - MIN, expiresAt: NOW }, NOW)).toBe(false);
		expect(drainIsFresh(null, NOW)).toBe(false);
	});
	test("shouldClaimNormally is the negation", () => {
		expect(shouldClaimNormally(null, NOW)).toBe(true);
		expect(shouldClaimNormally({ requestedAt: NOW, expiresAt: NOW + MIN }, NOW)).toBe(false);
	});
});

describe("refuseUnderDrain", () => {
	test("new work is refused; stop, interrupt, rename and cleanup are not", () => {
		for (const kind of ["launch", "prompt", "resume", "retry", "fork"]) {
			expect(refuseUnderDrain(kind)).toBe(true);
		}
		for (const kind of ["stop", "interrupt", "rename", "cleanup_workarea"]) {
			expect(refuseUnderDrain(kind)).toBe(false);
		}
		// A kind this build doesn't know is not new work to start during an update.
		expect(refuseUnderDrain("something_new")).toBe(true);
	});
});

describe("routeClaimed", () => {
	function harness(counts: Omit<IdleCounts, "inFlight"> = idle) {
		const drain = createUpdateDrain({
			home,
			version: "0.12.0",
			now: () => NOW,
			counts: async () => counts,
		});
		const calls: string[] = [];
		const run = (kind: string) =>
			routeClaimed({
				drain,
				kind,
				now: () => NOW,
				handle: async () => void calls.push(`handled:${kind}`),
				refuse: async () => void calls.push(`refused:${kind}`),
			});
		return { calls, run };
	}

	test("with no drain every kind is handled", async () => {
		const { calls, run } = harness();
		await run("launch");
		await run("stop");
		expect(calls).toEqual(["handled:launch", "handled:stop"]);
	});

	test("under a fresh drain stop and interrupt are handled and launch, prompt, resume are refused", async () => {
		writeDrain({ schema: 1, requestedAt: NOW - MIN, expiresAt: NOW + 2 * MIN });
		const { calls, run } = harness();
		for (const kind of ["stop", "interrupt", "launch", "prompt", "resume", "retry", "fork"])
			await run(kind);
		expect(calls).toEqual([
			"handled:stop",
			"handled:interrupt",
			"refused:launch",
			"refused:prompt",
			"refused:resume",
			"refused:retry",
			"refused:fork",
		]);
	});

	test("a drain with an expiry in the year 2999 is ignored", async () => {
		writeDrain({ schema: 1, requestedAt: NOW, expiresAt: Date.UTC(2999, 0, 1) });
		const { calls, run } = harness();
		await run("launch");
		expect(calls).toEqual(["handled:launch"]);
	});

	test("an unparseable drain file is ignored", async () => {
		writeFileSync(join(home, ".agentpulse", UPDATE_DRAIN_FILE), "{nope", { mode: 0o600 });
		const { calls, run } = harness();
		await run("prompt");
		expect(calls).toEqual(["handled:prompt"]);
	});
});

describe("status file", () => {
	function drainWith(counts: () => Promise<Omit<IdleCounts, "inFlight">>, clock: { t: number }) {
		return createUpdateDrain({
			home,
			version: "0.12.0",
			now: () => clock.t,
			counts,
			pid: 4242,
			processStartedAt: "Mon Nov 17 10:02:11 2026",
		});
	}

	test("is private and carries the idle time across ticks", async () => {
		const clock = { t: NOW };
		const drain = drainWith(async () => idle, clock);
		drain.markRegistered();
		await drain.tick();
		clock.t += 30_000;
		await drain.tick();
		const path = join(home, ".agentpulse", "supervisor-status.json");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const status = readSupervisorStatus(home);
		expect(status).toMatchObject({
			version: "0.12.0",
			pid: 4242,
			registered: true,
			idleSince: NOW,
			writtenAt: NOW + 30_000,
			draining: false,
			drained: false,
			inFlight: 0,
		});
	});

	test("busy clears idleSince and restarts the clock when idle returns", async () => {
		const clock = { t: NOW };
		let codex = 0;
		const drain = drainWith(async () => ({ ...idle, codex }), clock);
		await drain.tick();
		codex = 1;
		clock.t += 10_000;
		await drain.tick();
		expect(readSupervisorStatus(home)?.idleSince).toBeNull();
		codex = 0;
		clock.t += 10_000;
		await drain.tick();
		expect(readSupervisorStatus(home)?.idleSince).toBe(NOW + 20_000);
	});

	test("a handler in flight blocks idle and drained", async () => {
		writeDrain({ schema: 1, requestedAt: NOW, expiresAt: NOW + MIN });
		const clock = { t: NOW };
		const drain = drainWith(async () => idle, clock);
		let release: () => void = () => {};
		const running = drain.track(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await drain.tick();
		expect(readSupervisorStatus(home)).toMatchObject({
			inFlight: 1,
			idleSince: null,
			draining: true,
			drained: false,
		});
		release();
		await running;
		await drain.tick();
		expect(readSupervisorStatus(home)).toMatchObject({
			inFlight: 0,
			draining: true,
			drained: true,
		});
	});

	test("an unknown bridge count blocks idle", async () => {
		const drain = drainWith(async () => ({ ...idle, bridges: null }), { t: NOW });
		await drain.tick();
		expect(readSupervisorStatus(home)?.idleSince).toBeNull();
	});

	test("counts that throw read as busy and the tick doesn't throw", async () => {
		const drain = drainWith(
			async () => {
				throw new Error("boom");
			},
			{ t: NOW },
		);
		await drain.tick();
		expect(readSupervisorStatus(home)?.idleSince).toBeNull();
	});

	test("a stale drain is not draining", async () => {
		writeDrain({ schema: 1, requestedAt: NOW - 20 * MIN, expiresAt: NOW + MIN });
		const drain = drainWith(async () => idle, { t: NOW });
		await drain.tick();
		expect(readSupervisorStatus(home)).toMatchObject({ draining: false, drained: false });
	});

	test("no temp files are left behind", async () => {
		const drain = drainWith(async () => idle, { t: NOW });
		await drain.tick();
		expect(readdirSync(join(home, ".agentpulse"))).toEqual(["supervisor-status.json"]);
	});
});

describe("wiring (source scan)", () => {
	const root = join(import.meta.dir, "..");
	const index = readFileSync(join(root, "index.ts"), "utf-8");
	const drainSource = readFileSync(join(import.meta.dir, "update-drain.ts"), "utf-8");

	test("both claim loops route what they claim through routeClaimed", () => {
		expect(index.match(/routeClaimed\(\{/g)?.length).toBe(2);
		expect(index).toContain('kind: "launch"');
		expect(index).toContain("kind: action.actionType");
	});
	test("routeClaimed asks shouldClaimNormally and refuseUnderDrain", () => {
		const body = drainSource.slice(drainSource.indexOf("export async function routeClaimed"));
		expect(body).toContain("shouldClaimNormally(");
		expect(body).toContain("refuseUnderDrain(");
	});
	test("update-drain.ts sends no signal and runs no process", () => {
		expect(drainSource).not.toMatch(/\bkill\b|process\.kill|SIGTERM|SIGKILL|spawn|exec/i);
	});
	test("the watchdog tick writes the status file", () => {
		expect(index).toMatch(/setInterval\(\(\) => \{\s*void updateDrain\.tick\(\);/);
	});
	test("the supervisor makes no new fetch for the update", () => {
		expect(drainSource).not.toContain("fetch(");
	});
});
