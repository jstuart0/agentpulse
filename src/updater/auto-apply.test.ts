/**
 * Automatic runs: what gates them and how failures hold the next attempt back. The pure policy first, then
 * `runUpdate({mode: "auto"})` end to end in a throwaway HOME on an injected clock (the fixture's).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readUpdateState } from "../shared/update-files.js";
import { UPDATE_OUTCOME_CODES, type UpdateOutcomeCode } from "../shared/update-status.js";
import { BACKOFF_MS, backoffActive, isAutoFailure, isWaiting, nextBackoff } from "./auto-apply.js";
import { type Fixture, createFixture, expectUntouched } from "./test-utils/fixture.js";
import { DEFAULT_TIMING, runUpdate } from "./updater.js";

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
			expect((await runUpdate(f.deps(slow), { mode: "auto" })).code).toBe("updated");
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
