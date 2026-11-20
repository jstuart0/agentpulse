import { Database } from "bun:sqlite";
/**
 * The crash table: the updater is made to die (UpdaterCrash, so nothing is cleaned up and the lock stays)
 * after every journaled step of an update that crosses a migration with a supervisor, then a fresh process
 * runs recovery. Every row must end with a working install: either the old version back (and its database
 * as it was) or, from the point the new one was verified, the new version committed. Then the same again
 * with a second crash in the middle of the recovery itself.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readUpdateState } from "../shared/update-files.js";
import { type Fixture, createFixture, makeLockStale } from "./test-utils/fixture.js";
import { UpdaterCrash, runRecovery, runUpdate } from "./updater.js";

const TIMEOUT = 120_000;
/** The full matrix (every step, then every recovery step) is `bun run test:slow`, which CI runs; the default suite keeps a representative subset. */
const FULL = process.env.AGENTPULSE_SLOW_TESTS === "1";
const REPRESENTATIVE = new Set([
	"started",
	"stopped",
	"snapshot",
	"rename_done_1",
	"started_services",
	"verified",
	"current_flipped",
]);
let fx: Fixture | null = null;
afterEach(async () => {
	await fx?.cleanup();
	fx = null;
});

/**
 * A machine on 0.12.0 (so the swap has all three renames: retire, move aside, move in) with 0.13.0, which adds a
 * migration, to update to. `first` skips the earlier update (two renames) to keep the second table quick.
 */
async function setup(options: { priorUpdate?: boolean } = {}): Promise<Fixture> {
	const f = await createFixture({ units: ["server", "supervisor"] });
	if (options.priorUpdate !== false) {
		f.addRelease("0.12.0");
		f.publish();
		const prior = await runUpdate(f.deps(), { mode: "manual" });
		if (prior.code !== "updated") throw new Error(`setup update failed: ${prior.code}`);
	}
	f.addRelease("0.13.0", { migration: "0001_b" });
	f.publish();
	return f;
}

function crashAt(step: string, hit = 1) {
	let seen = 0;
	return (name: string) => {
		if (name === step && ++seen === hit) throw new UpdaterCrash(step);
	};
}

function stepsOf(log: string[]): string[] {
	return [...new Set(log)];
}

async function version(f: Fixture): Promise<string> {
	return JSON.parse(readFileSync(join(f.app, "package.json"), "utf-8")).version;
}

async function healthVersion(f: Fixture): Promise<string | null> {
	// Polled against a deadline, not a fixed number of tries: a loaded machine gets the same 15 s as an idle one.
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${f.port}/api/v1/health`);
			return ((await res.json()) as { version: string }).version;
		} catch {
			await new Promise((r) => setTimeout(r, 50));
		}
	}
	return null;
}

function migratedTables(f: Fixture): string[] {
	const db = new Database(f.dbPath, { readonly: true });
	try {
		return (
			db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
		)
			.map((t) => t.name)
			.filter((n) => n.startsWith("migrated_"));
	} finally {
		db.close();
	}
}

async function assertWorking(f: Fixture, expected: "0.11.0" | "0.12.0" | "0.13.0") {
	expect(await version(f)).toBe(expected);
	expect(await healthVersion(f)).toBe(expected);
	expect(f.fake.active.has("server")).toBe(true);
	expect(f.fake.active.has("supervisor")).toBe(true);
	expect(readdirSync(f.dir).filter((n) => n.startsWith("app.staging"))).toEqual([]);
	expect(existsSync(join(f.dir, "update.lock"))).toBe(false);
	expect(existsSync(join(f.dir, "update-drain.json"))).toBe(false);
	const journal = JSON.parse(readFileSync(join(f.dir, "update-journal.json"), "utf-8"));
	expect(["done", "rolled_back"]).toContain(journal.phase);
	if (expected !== "0.13.0") expect(migratedTables(f)).toEqual([]);
	else expect(migratedTables(f)).toEqual(["migrated_0_13_0"]);
}

/** Steps from which recovery moves forward (the new version had passed its health check). */
const FORWARD = new Set(["verified", "current_flipped", "done"]);

describe("a crash after every journaled step", () => {
	test(
		"each row recovers to a working install",
		async () => {
			// First, a clean run to learn the steps.
			fx = await setup();
			const recorded: string[] = [];
			const clean = await runUpdate(fx.deps({ afterStep: (s) => void recorded.push(s) }), {
				mode: "manual",
			});
			expect(clean.code).toBe("updated");
			await fx.cleanup();
			const steps = stepsOf(recorded);
			// the table must cover every phase the plan names
			for (const name of [
				"started",
				"staged",
				"smoked",
				"drained",
				"stopped",
				"snapshot",
				"rename_intent_1",
				"rename_done_2",
				"env_copied",
				"bundle_installed",
				"started_services",
				"verified",
				"current_flipped",
				"done",
			]) {
				expect(steps).toContain(name);
			}

			for (const step of steps.filter((s) => FULL || REPRESENTATIVE.has(s))) {
				fx = await setup();
				const f = fx;
				let crashed = false;
				try {
					await runUpdate(f.deps({ afterStep: crashAt(step) }), { mode: "manual" });
				} catch (error) {
					crashed = error instanceof UpdaterCrash;
					if (!crashed) throw error;
				}
				expect(crashed).toBe(true);
				// "power loss": the lock holder is gone
				await makeLockStale(f);
				const result = await runRecovery(f.deps());
				expect(result).toBeNull();
				await assertWorking(f, FORWARD.has(step) ? "0.13.0" : "0.12.0");
				await f.cleanup();
				fx = null;
			}
		},
		TIMEOUT * 3,
	);

	test(
		"a crash in the middle of recovery recovers on the next run",
		async () => {
			// The steps recovery itself takes, from a crash after the swap and before verification.
			fx = await setup({ priorUpdate: false });
			const dry: string[] = [];
			await expect(
				runUpdate(fx.deps({ afterStep: crashAt("started_services") }), { mode: "manual" }),
			).rejects.toBeInstanceOf(UpdaterCrash);
			await makeLockStale(fx);
			expect(await runRecovery(fx.deps({ afterStep: (s) => void dry.push(s) }))).toBeNull();
			await fx.cleanup();
			const recoverySteps = stepsOf(dry);
			expect(recoverySteps).toContain("rollback_begin");
			expect(recoverySteps).toContain("snapshot_restored");

			let crashedTwice = 0;
			for (const first of FULL
				? ["stopped", "rename_done_1", "started_services"]
				: ["started_services"]) {
				for (const second of FULL ? recoverySteps : ["rollback_begin", "snapshot_restored"]) {
					fx = await setup({ priorUpdate: false });
					const f = fx;
					await expect(
						runUpdate(f.deps({ afterStep: crashAt(first) }), { mode: "manual" }),
					).rejects.toBeInstanceOf(UpdaterCrash);
					await makeLockStale(f);
					try {
						await runRecovery(f.deps({ afterStep: crashAt(second) }));
					} catch (error) {
						if (!(error instanceof UpdaterCrash)) throw error;
						crashedTwice++;
						await makeLockStale(f);
					}
					expect(await runRecovery(f.deps())).toBeNull();
					await assertWorking(f, "0.11.0");
					await f.cleanup();
					fx = null;
				}
			}
			// not vacuous: most combinations really did crash in the middle of recovery
			expect(crashedTwice).toBeGreaterThanOrEqual(FULL ? 8 : 2);
		},
		TIMEOUT * 4,
	);

	test(
		"the next normal run recovers first, and the version that was cut short is not tried again",
		async () => {
			fx = await setup();
			const f = fx;
			await expect(
				runUpdate(f.deps({ afterStep: crashAt("rename_done_1") }), { mode: "manual" }),
			).rejects.toBeInstanceOf(UpdaterCrash);
			await makeLockStale(f);
			// a live process still holds a fresh lock: not stale, so locked
			const result = await runUpdate(f.deps(), { mode: "manual" });
			// recovery put the install back and refused the version that was cut short (an update that dies
			// after the services stopped would otherwise stop them again every time)
			expect(result.code).toBe("refused_before");
			await assertWorking(f, "0.12.0");
			expect(readUpdateState(f.home).refused["0.13.0"]).toBe("rolled_back");
		},
		TIMEOUT,
	);
	test(
		"a crash after a rename happened but before the journal said so recovers to a working install",
		async () => {
			fx = await setup({ priorUpdate: false });
			const f = fx;
			// The journal says "about to rename staging into app" (intent written, not done); the rename then happens
			// and the process dies before it can write `done`: the filesystem is ahead of the journal.
			const hook = (step: string) => {
				if (step !== "rename_intent_1") return;
				const journal = JSON.parse(readFileSync(join(f.dir, "update-journal.json"), "utf-8"));
				const op = journal.ops[journal.intent];
				renameSync(op.src, op.dst);
				throw new UpdaterCrash(step);
			};
			await expect(
				runUpdate(f.deps({ afterStep: hook }), { mode: "manual" }),
			).rejects.toBeInstanceOf(UpdaterCrash);
			const journal = JSON.parse(readFileSync(join(f.dir, "update-journal.json"), "utf-8"));
			expect(journal.done).toBe(1);
			expect(journal.intent).toBe(1);
			expect(JSON.parse(readFileSync(join(f.app, "package.json"), "utf-8")).version).toBe("0.13.0");
			await makeLockStale(f);
			expect(await runRecovery(f.deps())).toBeNull();
			await assertWorking(f, "0.11.0");
		},
		TIMEOUT,
	);
});
