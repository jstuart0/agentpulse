/**
 * Automatic runs: what gates them and how failures hold the next attempt back. The pure policy first, then
 * `runUpdate({mode: "auto"})` end to end in a throwaway HOME on an injected clock (the fixture's).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readUpdateState } from "../shared/update-files.js";
import { UPDATE_OUTCOME_CODES, type UpdateOutcomeCode } from "../shared/update-status.js";
import { BACKOFF_MS, backoffActive, isAutoFailure, isWaiting, nextBackoff } from "./auto-apply.js";
import { runCli } from "./cli.js";
import {
	type Fixture,
	createFixture,
	expectUntouched,
	makeLockStale,
} from "./test-utils/fixture.js";
import {
	DEFAULT_TIMING,
	UpdaterCrash,
	inWindow,
	inWindowAt,
	runRecovery,
	runUpdate,
} from "./updater.js";

const HOUR = 3_600_000;
const TIMEOUT = 120_000;
let fx: Fixture | null = null;
afterEach(async () => {
	await fx?.cleanup();
	fx = null;
});

describe("the backoff policy", () => {
	test("a failure holds back 1 h, then 6 h, then 24 h and stays at 24 h", () => {
		expect([...BACKOFF_MS]).toEqual([HOUR, 6 * HOUR, 24 * HOUR]);
		let current: ReturnType<typeof nextBackoff> = null;
		const waits: number[] = [];
		for (let i = 0; i < 5; i++) {
			const at = 1_000_000 * (i + 1);
			current = nextBackoff(current ?? undefined, "health_failed", at);
			waits.push(Date.parse(current?.notBefore ?? "") - at);
			expect(current?.failures).toBe(i + 1);
		}
		expect(waits).toEqual([HOUR, 6 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
	});

	test("the hold ends exactly at notBefore on an injected clock", () => {
		const base = Date.parse("2026-11-19T10:00:00.000Z");
		const held = nextBackoff(undefined, "rolled_back", base);
		expect(backoffActive({ backoff: held ?? undefined }, base)).toBe(true);
		expect(backoffActive({ backoff: held ?? undefined }, base + HOUR - 1)).toBe(true);
		expect(backoffActive({ backoff: held ?? undefined }, base + HOUR)).toBe(false);
		expect(backoffActive({}, base)).toBe(false);
		expect(backoffActive({ backoff: { failures: 1, notBefore: "garbage" } }, base)).toBe(false);
	});

	test("an update or nothing-to-do clears the run; a not-yet changes nothing", () => {
		const held = nextBackoff(undefined, "build_failed", 0);
		expect(nextBackoff(held ?? undefined, "updated", 5)).toBeNull();
		expect(nextBackoff(held ?? undefined, "up_to_date", 5)).toBeNull();
		for (const code of ["supervisor_busy", "outside_window", "canary_wait"] as const) {
			expect(nextBackoff(held ?? undefined, code, 5)).toEqual(held ?? null);
			expect(nextBackoff(undefined, code, 5)).toBeNull();
			expect(isAutoFailure(code)).toBe(false);
			expect(isWaiting(code)).toBe(true);
		}
	});

	test("every outcome code is exactly one of: failure, waiting, or neither (never both)", () => {
		for (const code of UPDATE_OUTCOME_CODES as readonly UpdateOutcomeCode[]) {
			expect(isAutoFailure(code) && isWaiting(code)).toBe(false);
		}
		for (const code of ["rolled_back", "rollback_failed", "stop_failed", "unverified"] as const) {
			expect(isAutoFailure(code)).toBe(true);
		}
		for (const code of [
			"updated",
			"up_to_date",
			"no_consent",
			"pulled",
			"refused_before",
		] as const) {
			expect(isAutoFailure(code)).toBe(false);
		}
	});
});

function consent(
	f: Fixture,
	app: Record<string, unknown> = { on: true, allowMigrations: false, window: null },
) {
	writeFileSync(join(f.dir, "update-consent.json"), `${JSON.stringify({ schema: 1, app })}\n`, {
		mode: 0o600,
	});
}
const iso = (ms: number) => new Date(ms).toISOString();
const version = (dir: string) =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version;

describe("auto gates", () => {
	test(
		"a pre-release is never applied: the stable release is the target, however new the pre-release",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.addRelease("0.13.0-rc.1", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			// latest can't be a pre-release (the manifest refuses it), so a pre-release can only be asked for by name:
			// auto strips that, and ends on the stable release.
			f.publish({ latest: "0.12.0" });
			const result = await runUpdate(f.deps(), { mode: "auto", to: "0.13.0-rc.1" });
			expect(result).toMatchObject({ code: "updated", to: "0.12.0" });
			expect(version(f.app)).toBe("0.12.0");
			f.rebaseline();
			// and with the stable release installed and only the pre-release ahead, there is nothing to do
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("up_to_date");
			expectUntouched(f);
		},
		TIMEOUT,
	);

	test(
		"a release under 24 hours old waits (canary_wait) unless it is a security fix, and waiting isn't a failure",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 23 * HOUR) });
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("canary_wait");
			expectUntouched(f);
			let state = readUpdateState(f.home);
			expect(state.lastOutcome).toBe("canary_wait");
			expect(state.backoff).toBeUndefined();
			const since = state.waitingSince;
			expect(since).toBeDefined();
			// still waiting an hour later: waitingSince is when it began, not reset
			f.clock.t += 30 * 60_000;
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("canary_wait");
			state = readUpdateState(f.home);
			expect(state.waitingSince).toBe(since);
			// a security fix at the same age goes through
			const release = f.releases.get("0.12.0");
			if (release) release.severity = "security";
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("updated");
			expect(readUpdateState(f.home).waitingSince).toBeUndefined();
		},
		TIMEOUT,
	);

	test(
		"outside the window nothing runs, and that isn't a failure either",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			const hour = new Date(f.clock.t).getHours();
			const other = String((hour + 5) % 24).padStart(2, "0");
			consent(f, { on: true, allowMigrations: false, window: `${other}:00-${other}:30` });
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("outside_window");
			expectUntouched(f);
			const state = readUpdateState(f.home);
			expect(state.backoff).toBeUndefined();
			expect(state.waitingSince).toBeDefined();
		},
		TIMEOUT,
	);

	test(
		"a pulled release is skipped, and a version this machine rolled back from is never tried again",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.addRelease("0.12.1", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			// 0.12.1 is latest and was rolled back from here before: nothing is applied, 0.12.0 (pulled) least of all
			f.publish({ pulled: ["0.12.0"], latest: "0.12.1" });
			writeFileSync(
				join(f.dir, "update-state.json"),
				`${JSON.stringify({ schema: 1, refused: { "0.12.1": "health_failed" } })}\n`,
				{ mode: 0o600 },
			);
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("refused_before");
			expectUntouched(f);
			expect(version(f.app)).toBe("0.11.0");
			// control: without the refusal the same manifest updates to 0.12.1, not to the pulled 0.12.0
			writeFileSync(join(f.dir, "update-state.json"), `${JSON.stringify({ schema: 1 })}\n`, {
				mode: 0o600,
			});
			expect(await runUpdate(f.deps(), { mode: "auto" })).toMatchObject({
				code: "updated",
				to: "0.12.1",
			});
		},
		TIMEOUT,
	);

	test(
		"a migration without allowMigrations in the consent is migration_needs_consent",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR), migration: "0001_b" });
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("migration_needs_consent");
			expectUntouched(f);
		},
		TIMEOUT,
	);

	test(
		"a server-side 'auto' setting with no local consent applies nothing (rule 4)",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			// The only thing a server could say: its own health body carrying an auto flag. The updater reads none of it.
			const deps = f.deps();
			const base = deps.fetchText;
			deps.fetchText = async (url, options) => {
				const result = await base(url, options);
				return result.ok ? { ...result, body: result.body } : result;
			};
			expect((await runUpdate(deps, { mode: "auto" })).code).toBe("no_consent");
			expect(existsSync(join(f.dir, "update-consent.json"))).toBe(false);
			expectUntouched(f);
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"the flags a person uses are ignored in a scheduled run: --to, --allow-downgrade, --wait",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish({ latest: "0.11.0" });
			const result = await runUpdate(f.deps(), {
				mode: "auto",
				to: "0.12.0",
				allowDowngrade: true,
				wait: true,
			});
			// latest is what is installed, so there is nothing to do: the named version was not taken
			expect(result.code).toBe("up_to_date");
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"a busy supervisor is supervisor_busy: not a failure, no backoff, retried on the next tick",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			if (f.sim) {
				f.sim.busyUntil = f.clock.t + 6 * HOUR;
				f.sim.idleSince = null;
			}
			const slow = { timing: { ...DEFAULT_TIMING, pollMs: 120_000 } };
			expect((await runUpdate(f.deps(slow), { mode: "auto" })).code).toBe("supervisor_busy");
			expect(f.fake.calls.filter((c) => /^(stop|start):/.test(c))).toEqual([]);
			const state = readUpdateState(f.home);
			expect(state.lastOutcome).toBe("supervisor_busy");
			expect(state.backoff).toBeUndefined();
			// the next tick isn't held back: it runs, and (the host idle now) updates
			if (f.sim) f.sim.busyUntil = 0;
			// (the coarse polling was for the long wait; starting the new copy needs the normal one)
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("updated");
		},
		TIMEOUT,
	);
});

describe("backoff end to end", () => {
	test(
		"failures hold the next run back 1 h, 6 h, 24 h; a skipped run changes nothing; a success clears it",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			// A tracked file edited by hand: the update stops at the dirty-tree check, every time, before touching anything.
			appendFileSync(join(f.app, "package.json"), " \n");
			const run = async () => (await runUpdate(f.deps(), { mode: "auto" })).code;
			const fetches = () => f.fetched.length;

			expect(await run()).toBe("dirty_tree");
			let state = readUpdateState(f.home);
			expect(state.backoff?.failures).toBe(1);
			expect(Date.parse(state.backoff?.notBefore ?? "") - f.clock.t).toBe(HOUR);

			// inside the hold: skipped, nothing fetched, the state is exactly what it was
			const before = readFileSync(join(f.dir, "update-state.json"), "utf-8");
			const fetched = fetches();
			f.clock.t += HOUR - 1_000;
			expect(await run()).toBe("backoff");
			expect(fetches()).toBe(fetched);
			expect(readFileSync(join(f.dir, "update-state.json"), "utf-8")).toBe(before);
			expect(readUpdateState(f.home).lastOutcome).toBe("dirty_tree");

			// past it: tried again, fails again, held for 6 h
			f.clock.t += 2_000;
			expect(await run()).toBe("dirty_tree");
			state = readUpdateState(f.home);
			expect(state.backoff?.failures).toBe(2);
			expect(Date.parse(state.backoff?.notBefore ?? "") - f.clock.t).toBe(6 * HOUR);
			f.clock.t += 6 * HOUR - 1_000;
			expect(await run()).toBe("backoff");
			f.clock.t += 2_000;
			expect(await run()).toBe("dirty_tree");
			expect(Date.parse(readUpdateState(f.home).backoff?.notBefore ?? "") - f.clock.t).toBe(
				24 * HOUR,
			);

			// the tree is put right; still held until the time passes, then it updates and the hold is gone
			f.git("-C", f.app, "checkout", "--", ".");
			f.clock.t += 24 * HOUR - 1_000;
			expect(await run()).toBe("backoff");
			f.clock.t += 2_000;
			expect(await run()).toBe("updated");
			expect(readUpdateState(f.home).backoff).toBeUndefined();
			expect(version(f.app)).toBe("0.12.0");
		},
		TIMEOUT,
	);

	test(
		"a manual run is never held back by the backoff",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			appendFileSync(join(f.app, "package.json"), " \n");
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("dirty_tree");
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("backoff");
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("dirty_tree");
		},
		TIMEOUT,
	);
});

const stateFile = (f: Fixture) => join(f.dir, "update-state.json");
const writeState = (f: Fixture, body: Record<string, unknown>) =>
	writeFileSync(stateFile(f), `${JSON.stringify({ schema: 1, ...body })}\n`, { mode: 0o600 });
const moves = (f: Fixture) => f.fake.calls.filter((c) => /^(stop|start):/.test(c));

describe("the window", () => {
	test("inWindowAt: a window that wraps midnight, one that doesn't, and the edges (start in, end out)", () => {
		const at = (h: number, m = 0) => h * 60 + m;
		expect(inWindowAt("22:00-04:00", at(23, 30))).toBe(true);
		expect(inWindowAt("22:00-04:00", at(3, 59))).toBe(true);
		expect(inWindowAt("22:00-04:00", at(4, 0))).toBe(false);
		expect(inWindowAt("22:00-04:00", at(12, 0))).toBe(false);
		expect(inWindowAt("22:00-04:00", at(22, 0))).toBe(true);
		expect(inWindowAt("22:00-04:00", at(21, 59))).toBe(false);
		expect(inWindowAt("02:00-04:30", at(2, 0))).toBe(true);
		expect(inWindowAt("02:00-04:30", at(4, 29))).toBe(true);
		expect(inWindowAt("02:00-04:30", at(4, 30))).toBe(false);
		expect(inWindowAt("02:00-04:30", at(1, 59))).toBe(false);
		expect(inWindowAt(null, at(13, 0))).toBe(true);
	});

	test("inWindow reads the machine's local clock, whatever TZ the test runs in", () => {
		// built from local components, so the answer is the same in every zone
		const local = (h: number, m: number) => new Date(2026, 10, 19, h, m).getTime();
		expect(inWindow("02:00-04:30", local(2, 0))).toBe(true);
		expect(inWindow("02:00-04:30", local(4, 30))).toBe(false);
		expect(inWindow("22:00-04:00", local(23, 30))).toBe(true);
		expect(inWindow("22:00-04:00", local(12, 0))).toBe(false);
	});

	test(
		"inside the window an aged release is applied",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			const hour = new Date(f.clock.t).getHours();
			const before = String((hour + 23) % 24).padStart(2, "0");
			const after = String((hour + 1) % 24).padStart(2, "0");
			consent(f, { on: true, allowMigrations: false, window: `${before}:00-${after}:00` });
			expect(inWindow(`${before}:00-${after}:00`, f.clock.t)).toBe(true);
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("updated");
		},
		TIMEOUT,
	);

	test(
		"a window the file holds malformed is never: nothing is applied",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			consent(f, { on: true, allowMigrations: false, window: "later" });
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("outside_window");
			expectUntouched(f);
		},
		TIMEOUT,
	);
});

describe("the exit code of a scheduled run", () => {
	const lines = () => ({ out: () => {}, err: () => {} });
	test(
		"a failure exits 1; canary_wait, supervisor_busy and nothing to do exit 0",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 23 * HOUR) });
			f.publish();
			expect(await runCli(["update", "--auto"], lines(), f.deps())).toBe(0);
			expect(readUpdateState(f.home).lastOutcome).toBe("canary_wait");
			// the same machine with a failure
			const release = f.releases.get("0.12.0");
			if (release) release.publishedAt = iso(f.clock.t - 72 * HOUR);
			f.publish();
			appendFileSync(join(f.app, "package.json"), " \n");
			expect(await runCli(["update", "--auto"], lines(), f.deps())).toBe(1);
			expect(readUpdateState(f.home).lastOutcome).toBe("dirty_tree");
			// skipped by the backoff is not a failure
			expect(await runCli(["update", "--auto"], lines(), f.deps())).toBe(0);
		},
		TIMEOUT,
	);

	test(
		"supervisor_busy exits 0",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			if (f.sim) {
				f.sim.busyUntil = f.clock.t + 6 * HOUR;
				f.sim.idleSince = null;
			}
			const slow = f.deps({ timing: { ...DEFAULT_TIMING, pollMs: 120_000 } });
			expect(await runCli(["update", "--auto"], lines(), slow)).toBe(0);
			expect(readUpdateState(f.home).lastOutcome).toBe("supervisor_busy");
		},
		TIMEOUT,
	);
});

describe("what a refusal does to the failure count", () => {
	test(
		"refused_before and migration_needs_consent leave the run of failures as it was",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR), migration: "0001_b" });
			f.publish();
			const held = { failures: 2, notBefore: iso(f.clock.t - 1_000) };
			writeState(f, { backoff: held });
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("migration_needs_consent");
			expect(readUpdateState(f.home).backoff).toEqual(held);
			writeState(f, { backoff: held, refused: { "0.12.0": "health_failed" } });
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("refused_before");
			expect(readUpdateState(f.home).backoff).toEqual(held);
			expectUntouched(f);
		},
		TIMEOUT,
	);
});

describe("fail, refused, backoff over, still not tried again", () => {
	test(
		"a version that rolled back is never attempted again once the backoff has run out",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", {
				files: { BAD_IN_SERVICE: "1\n" },
				publishedAt: iso(f.clock.t - 72 * HOUR),
			});
			f.publish();
			const first = await runUpdate(f.deps(), { mode: "auto" });
			expect(first.code).toBe("rolled_back");
			f.rebaseline();
			let state = readUpdateState(f.home);
			expect(state.refused["0.12.0"]).toBe("rolled_back");
			expect(state.backoff?.failures).toBe(1);
			const callsAfterFailure = moves(f).length;
			// the hold runs out
			f.clock.t += HOUR + 1_000;
			expect(backoffActive(state, f.clock.t)).toBe(false);
			const second = await runUpdate(f.deps(), { mode: "auto" });
			expect(second.code).toBe("refused_before");
			expect(moves(f)).toHaveLength(callsAfterFailure);
			expect(version(f.app)).toBe("0.11.0");
			state = readUpdateState(f.home);
			expect(state.backoff?.failures).toBe(1);
		},
		TIMEOUT,
	);
});

describe("a failure after the services stopped", () => {
	test(
		"stop_failed refuses the version, and so does snapshot_failed",
		async () => {
			fx = await createFixture();
			let f = fx;
			f.addRelease("0.12.0");
			f.publish();
			let stops = 0;
			const origStop = f.fake.stop;
			f.fake.goneOverride = async (unit) => !f.fake.active.has(unit) || stops > 1;
			f.fake.stop = async (unit) => {
				stops++;
				if (stops === 1) {
					f.fake.calls.push(`stop:${unit}`);
					return;
				}
				await origStop(unit);
			};
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("stop_failed");
			expect(readUpdateState(f.home).refused["0.12.0"]).toBe("stop_failed");
			f.fake.stop = origStop;
			f.fake.goneOverride = undefined;
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("refused_before");
			await f.cleanup();

			fx = await createFixture();
			f = fx;
			f.addRelease("0.12.0", { migration: "0001_b" });
			f.publish();
			// a file where the snapshot directory goes: the snapshot can't be taken, after the services have stopped
			writeFileSync(join(f.dir, "update-snapshots"), "in the way");
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result.code).toBe("snapshot_failed");
			expect(readUpdateState(f.home).refused["0.12.0"]).toBe("snapshot_failed");
			expect(version(f.app)).toBe("0.11.0");
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("refused_before");
		},
		TIMEOUT * 2,
	);

	test(
		"an update cut short after the services were stopped refuses its version when recovery puts the install back",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			await expect(
				runUpdate(
					f.deps({
						afterStep: (step) => {
							if (step === "stopped") throw new UpdaterCrash("stopped");
						},
					}),
					{ mode: "manual" },
				),
			).rejects.toBeInstanceOf(UpdaterCrash);
			await makeLockStale(f);
			expect(await runRecovery(f.deps())).toBeNull();
			expect(version(f.app)).toBe("0.11.0");
			expect(readUpdateState(f.home).refused["0.12.0"]).toBe("rolled_back");
			f.rebaseline();
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("refused_before");
		},
		TIMEOUT,
	);

	test(
		"a scheduled run that dies after stopping leaves its backoff behind, so the next one doesn't loop",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			await expect(
				runUpdate(
					f.deps({
						afterStep: (step) => {
							if (step === "stopped") throw new UpdaterCrash("stopped");
						},
					}),
					{ mode: "auto" },
				),
			).rejects.toBeInstanceOf(UpdaterCrash);
			const armed = readUpdateState(f.home).backoff;
			expect(armed?.failures).toBe(1);
			await makeLockStale(f);
			// recovery puts the install back first, then the held-back run does nothing more
			const next = await runUpdate(f.deps(), { mode: "auto" });
			expect(next.code).toBe("backoff");
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"when the backoff can't be written a scheduled run doesn't go on to stop anything",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			const deps = f.deps({
				afterStep: (step) => {
					// the state file becomes unwritable (a directory sits where it goes) just before the risky phase
					if (step === "smoked") {
						rmSync(stateFile(f), { force: true });
						mkdirSync(stateFile(f));
					}
				},
			});
			const result = await runUpdate(deps, { mode: "auto" });
			expect(result.code).toBe("install_failed");
			expect(moves(f)).toEqual([]);
			expect(version(f.app)).toBe("0.11.0");
			expect(await Bun.file(join(f.app, "package.json")).exists()).toBe(true);
		},
		TIMEOUT,
	);
});

describe("consent is looked at again before anything is stopped", () => {
	test(
		"consent withdrawn while the run staged ends it as no_consent with nothing stopped",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			const result = await runUpdate(
				f.deps({
					afterStep: (step) => {
						if (step === "smoked") rmSync(join(f.dir, "update-consent.json"));
					},
				}),
				{ mode: "auto" },
			);
			expect(result.code).toBe("no_consent");
			expect(moves(f)).toEqual([]);
			expect(version(f.app)).toBe("0.11.0");
			expectUntouched(f);
		},
		TIMEOUT,
	);
});

describe("the staged tree's own migrations", () => {
	test(
		"a manifest that says no migration for a tree that has one is refused, and the version is not offered again",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR), migration: "0001_b" });
			// the manifest lists the old migration: it understates
			f.publish({ migrationOverride: { "0.12.0": "0000_a" } });
			const result = await runUpdate(f.deps(), { mode: "auto" });
			expect(result.code).toBe("migration_needs_consent");
			expect(moves(f)).toEqual([]);
			expect(version(f.app)).toBe("0.11.0");
			expect(readUpdateState(f.home).refused["0.12.0"]).toBe("migration_needs_consent");
			expectUntouched(f);
			// manual mode is held to it too
			const manual = await runUpdate(f.deps(), { mode: "manual" });
			expect(manual.code).toBe("refused_before");
		},
		TIMEOUT,
	);

	test(
		"the same lie in the other direction (the manifest says migration, the tree has none) is refused too",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish({ migrationOverride: { "0.12.0": "0001_b" } });
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("migration_needs_consent");
			expectUntouched(f);
		},
		TIMEOUT,
	);

	test(
		"a manifest that agrees with the tree is untouched by the check (consent given, migration crossed)",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f, { on: true, allowMigrations: true, window: null });
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR), migration: "0001_b" });
			f.publish();
			expect(await runUpdate(f.deps(), { mode: "auto" })).toMatchObject({
				code: "updated",
				migrated: true,
			});
		},
		TIMEOUT,
	);
});

describe("what a person's own run does to the scheduled run's state", () => {
	test(
		"a successful manual run ends the wait and the failure streak; a failed one leaves them",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: iso(f.clock.t - 72 * HOUR) });
			f.publish();
			writeState(f, {
				waitingSince: iso(f.clock.t - 5 * HOUR),
				backoff: { failures: 2, notBefore: iso(f.clock.t + 3 * HOUR) },
			});
			appendFileSync(join(f.app, "package.json"), " \n");
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("dirty_tree");
			let state = readUpdateState(f.home);
			expect(state.backoff?.failures).toBe(2);
			expect(state.waitingSince).toBeDefined();
			f.git("-C", f.app, "checkout", "--", ".");
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			state = readUpdateState(f.home);
			expect(state.backoff).toBeUndefined();
			expect(state.waitingSince).toBeUndefined();
		},
		TIMEOUT,
	);

	test(
		"up_to_date from a manual run clears them too",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.publish({ latest: "0.11.0" });
			writeState(f, {
				waitingSince: iso(f.clock.t - 5 * HOUR),
				backoff: { failures: 1, notBefore: iso(f.clock.t + HOUR) },
			});
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("up_to_date");
			const state = readUpdateState(f.home);
			expect(state.backoff).toBeUndefined();
			expect(state.waitingSince).toBeUndefined();
		},
		TIMEOUT,
	);
});

describe("the state is written inside the lock", () => {
	test(
		"the last thing the run does under the lock is write its outcome",
		async () => {
			fx = await createFixture();
			const f = fx;
			consent(f);
			f.publish({ latest: "0.11.0" });
			const lock = join(f.dir, "update.lock");
			const heldAt: boolean[] = [];
			const deps = f.deps();
			const clock = deps.now;
			deps.now = () => {
				heldAt.push(existsSync(lock));
				return clock();
			};
			expect((await runUpdate(deps, { mode: "auto" })).code).toBe("up_to_date");
			// settle() reads the clock for `at` and for the backoff, under the lock; only the log line's timing read comes after it
			expect(heldAt.at(-1)).toBe(false);
			expect(heldAt.at(-2)).toBe(true);
			expect(heldAt.at(-3)).toBe(true);
			expect(readUpdateState(f.home).lastOutcome).toBe("up_to_date");
		},
		TIMEOUT,
	);
});
