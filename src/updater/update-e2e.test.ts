import { Database } from "bun:sqlite";
/**
 * The updater end to end in a throwaway HOME: a local bare repo with tagged releases, a signed manifest made
 * with the test key, a fake service manager and a fixture "server" script that answers /health with its own
 * version and database fingerprint. This is the ordering test (stop, swap, start, verify, roll back); the
 * real server's own boot is `update-real-boot.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readUpdateState } from "../shared/update-files.js";
import { type Fixture, createFixture, expectUntouched } from "./test-utils/fixture.js";
import { DEFAULT_TIMING } from "./updater.js";

/** Long fake waits (a busy host) poll coarsely, so they cost milliseconds of real time. */
const SLOW_POLL = { timing: { ...DEFAULT_TIMING, pollMs: 20_000 } };
import {
	type UpdateOptions,
	type UpdaterDeps,
	runRecovery,
	runRollback,
	runUpdate as runUpdateRaw,
} from "./updater.js";

const TIMEOUT = 90_000;
let fx: Fixture | null = null;

/**
 * Every run in this file goes through here: a run that ended in a refusal must have left the machine exactly as
 * it was (`expectUntouched`); one that changed it on purpose (an update, a rollback) moves the baseline.
 * `stop_failed` is exempt (it stopped a service on purpose and put it back) and so is `locked` (the lock is a rival's).
 */
async function runUpdate(deps: UpdaterDeps, options: UpdateOptions) {
	const result = await runUpdateRaw(deps, options);
	if (fx) {
		if (result.code === "updated" || result.code === "rolled_back") fx.rebaseline();
		else if (result.code !== "stop_failed" && result.code !== "locked") expectUntouched(fx);
	}
	return result;
}
afterEach(async () => {
	await fx?.cleanup();
	fx = null;
});

function version(dir: string): string {
	return JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")).version;
}
async function healthVersion(f: Fixture): Promise<string | null> {
	try {
		const res = await fetch(`http://127.0.0.1:${f.port}/api/v1/health`);
		return ((await res.json()) as { version: string }).version;
	} catch {
		return null;
	}
}
function rule18Files(f: Fixture): Record<string, string> {
	const files: Record<string, string> = {
		exclude: "/work/secret\n",
		"hook-auth-header": "Authorization: Bearer ap_xxx\n",
		"claude-fork-mcp.json": '{"mcpServers":{}}\n',
		"supervisor-gate-state.json": "{}\n",
		"supervisor.json": '{"serverUrl":"x"}\n',
	};
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(f.dir, name), text, { mode: 0o600 });
	}
	return files;
}
function writeConsent(f: Fixture, app: Record<string, unknown>) {
	writeFileSync(join(f.dir, "update-consent.json"), `${JSON.stringify({ schema: 1, app })}\n`, {
		mode: 0o600,
	});
}
const FORBIDDEN = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"TELEGRAM_BOT_TOKEN",
	"FORWARDAUTH_TRUST_SECRET",
	"AGENTPULSE_SECRETS_KEY",
];
function leakyEnv(f: Fixture): Record<string, string | undefined> {
	return {
		PATH: process.env.PATH,
		HOME: f.home,
		ANTHROPIC_API_KEY: "leak",
		CLAUDE_CODE_OAUTH_TOKEN: "leak",
		TELEGRAM_BOT_TOKEN: "leak",
		FORWARDAUTH_TRUST_SECRET: "leak",
		AGENTPULSE_SECRETS_KEY: "leak",
	};
}

describe("a successful update", () => {
	test(
		"moves app to the target, keeps the previous copy, carries the env files and touches nothing it shouldn't",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			const untouched = rule18Files(f);
			const envBefore = {
				local: readFileSync(join(f.app, ".env.local")),
				env: readFileSync(join(f.app, ".env")),
			};
			const modeLocal = statSync(join(f.app, ".env.local")).mode & 0o777;
			const modeEnv = statSync(join(f.app, ".env")).mode & 0o777;

			const result = await runUpdate(f.deps({ env: leakyEnv(f) }), { mode: "manual" });

			expect(result).toMatchObject({ code: "updated", from: "0.11.0", to: "0.12.0" });
			expect(version(f.app)).toBe("0.12.0");
			expect(version(`${f.app}.previous`)).toBe("0.11.0");
			expect(await healthVersion(f)).toBe("0.12.0");
			// the bundle is installed and current points at it
			expect(readlinkSync(join(f.dir, "updater", "current"))).toBe("0.12.0");
			expect(existsSync(join(f.dir, "updater", "0.12.0", "updater.js"))).toBe(true);
			// .env files byte- and mode-identical
			expect(readFileSync(join(f.app, ".env.local")).equals(envBefore.local)).toBe(true);
			expect(readFileSync(join(f.app, ".env")).equals(envBefore.env)).toBe(true);
			expect(statSync(join(f.app, ".env.local")).mode & 0o777).toBe(modeLocal);
			expect(statSync(join(f.app, ".env")).mode & 0o777).toBe(modeEnv);
			// rule-18 files byte-identical
			for (const [name, text] of Object.entries(untouched)) {
				expect(readFileSync(join(f.dir, name), "utf-8")).toBe(text);
			}
			// the secret is nowhere in what the updater logged, nor on any command line
			expect(f.logLines.join("\n")).not.toContain(f.secret);
			for (const run of f.runs) expect(run.cmd.join(" ")).not.toContain(f.secret);
			// no launchctl / systemctl, ever
			for (const run of f.runs) expect(["git", process.execPath]).toContain(run.cmd[0] as string);
			// child envs: none of the secrets, and git never prompts
			for (const run of f.runs) {
				for (const name of FORBIDDEN) expect(run.env[name]).toBeUndefined();
				if (run.cmd[0] === "git") expect(run.env.GIT_TERMINAL_PROMPT).toBe("0");
			}
			// nothing the updater ran or was given points outside the throwaway machine (it never reached the real home)
			for (const run of f.runs) {
				expect(run.cwd.startsWith(f.root)).toBe(true);
				expect(run.env.HOME?.startsWith(f.root)).toBe(true);
			}
			expect(readUpdateState(f.home).lastOutcome).toBe("updated");
			expect(f.fake.calls.filter((c) => c.startsWith("stop:") || c.startsWith("start:"))).toEqual([
				"stop:server",
				"start:server",
			]);
		},
		TIMEOUT,
	);

	test(
		"two consecutive updates rotate: app.previous then holds the version before",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			f.addRelease("0.12.5");
			f.publish();
			const second = await runUpdate(f.deps(), { mode: "manual" });
			expect(second).toMatchObject({ code: "updated", from: "0.12.0", to: "0.12.5" });
			// named member: app.previous holds 0.12.0 after the second update
			expect(version(`${f.app}.previous`)).toBe("0.12.0");
			expect(version(f.app)).toBe("0.12.5");
			expect(readdirSync(join(f.dir)).filter((n) => n.startsWith("app."))).toEqual([
				"app.previous",
			]);
		},
		TIMEOUT,
	);

	test(
		"crossing a migration takes a snapshot, and says so",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result).toMatchObject({ code: "updated", migrated: true });
			expect(
				readdirSync(join(f.dir, "update-snapshots")).filter((n) => n.endsWith(".db")),
			).toHaveLength(1);
			expect(statSync(join(f.dir, "update-snapshots")).mode & 0o777).toBe(0o700);
		},
		TIMEOUT,
	);
});

describe("a failed start rolls back", () => {
	test(
		"a health failure restores the previous copy, and the version is never tried again",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.1", { files: { BAD_IN_SERVICE: "1\n" } });
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result).toMatchObject({
				code: "rolled_back",
				reason: "health_failed",
				from: "0.11.0",
				to: "0.12.1",
			});
			expect(version(f.app)).toBe("0.11.0");
			expect(await healthVersion(f)).toBe("0.11.0");
			expect(f.fake.active.has("server")).toBe(true);
			expect(readUpdateState(f.home).refused["0.12.1"]).toBeDefined();
			// not tried again
			expect(await runUpdate(f.deps(), { mode: "manual", to: "0.12.1" })).toMatchObject({
				code: "refused_before",
			});
			// the failed tree is kept for a look, and no staging is left
			expect(readdirSync(f.dir).filter((n) => n.startsWith("app.staging"))).toEqual([]);
		},
		TIMEOUT,
	);

	test(
		"across a migration the database is restored from the snapshot",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.14.0", { migration: "0002_c", files: { BAD_IN_SERVICE: "1\n" } });
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result.code).toBe("rolled_back");
			// the failed server had run its migration on the live database; the restore removed it
			const db = new Database(f.dbPath, { readonly: true });
			const tables = (
				db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
			).map((t) => t.name);
			db.close();
			expect(tables.some((n) => n.startsWith("migrated_"))).toBe(false);
			expect(await healthVersion(f)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"a changed database fingerprint rolls back",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.2", { files: { OTHER_DB: "1\n" } });
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result).toMatchObject({ code: "rolled_back", reason: "health_failed" });
			expect(await healthVersion(f)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"a staged server that won't boot is a smoke failure and nothing is stopped",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.3", { files: { CRASH_ON_START: "1\n" } });
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result.code).toBe("smoke_failed");
			expect(f.fake.calls.some((c) => c.startsWith("stop:"))).toBe(false);
			expect(version(f.app)).toBe("0.11.0");
			expect(await healthVersion(f)).toBe("0.11.0");
			expect(readdirSync(f.dir).filter((n) => n.startsWith("app.staging"))).toEqual([]);
		},
		TIMEOUT,
	);

	test(
		"update rollback goes back to the previous copy and restores the snapshot",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			const result = await runRollback(f.deps());
			expect(result).toMatchObject({ code: "rolled_back", from: "0.13.0", to: "0.11.0" });
			expect(version(f.app)).toBe("0.11.0");
			expect(await healthVersion(f)).toBe("0.11.0");
			const db = new Database(f.dbPath, { readonly: true });
			const tables = (
				db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
			).map((t) => t.name);
			db.close();
			expect(tables.some((n) => n.startsWith("migrated_"))).toBe(false);
			// and there is nothing left to roll back to
			expect((await runRollback(f.deps())).code).toBe("nothing_to_roll_back");
		},
		TIMEOUT,
	);
});

describe("units", () => {
	test(
		"a unit that wasn't active is not started",
		async () => {
			fx = await createFixture({ units: ["supervisor"], components: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result.code).toBe("updated");
			expect(f.fake.calls).not.toContain("start:server");
			expect(f.fake.calls).not.toContain("stop:server");
			expect(f.fake.calls).toContain("start:supervisor");
		},
		TIMEOUT,
	);

	test(
		"an inactive supervisor unit with a stale status file: no wait, no drain, no stop, not started",
		async () => {
			fx = await createFixture({ units: ["server"], components: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			// a status file left by a supervisor that is no longer running: busy, and old
			const stale = `${JSON.stringify({ schema: 1, version: "0.11.0", pid: 1, processStartedAt: null, writtenAt: f.clock.t - 3_600_000, registered: true, idleSince: null, inFlight: 3, draining: false, drained: false })}\n`;
			writeFileSync(join(f.dir, "supervisor-status.json"), stale, { mode: 0o600 });
			let drainSeen = false;
			const deps = f.deps();
			const sleep = deps.sleep;
			deps.sleep = async (ms) => {
				if (existsSync(join(f.dir, "update-drain.json"))) drainSeen = true;
				await sleep(ms);
			};
			const result = await runUpdate(deps, { mode: "manual" });
			expect(result.code).toBe("updated");
			expect(f.fake.calls).not.toContain("stop:supervisor");
			expect(f.fake.calls).not.toContain("start:supervisor");
			// named member: the drain file is never written
			expect(drainSeen).toBe(false);
			expect(existsSync(join(f.dir, "update-drain.json"))).toBe(false);
			expect(readFileSync(join(f.dir, "supervisor-status.json"), "utf-8")).toBe(stale);
		},
		TIMEOUT,
	);

	test(
		"an idle supervisor is drained, then stopped before the server and started after it",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result.code).toBe("updated");
			expect(f.fake.calls.filter((c) => /^(stop|start):/.test(c))).toEqual([
				"stop:supervisor",
				"stop:server",
				"start:server",
				"start:supervisor",
			]);
			expect(existsSync(join(f.dir, "update-drain.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(f.dir, "supervisor-status.json"), "utf-8")).version).toBe(
				"0.12.0",
			);
		},
		TIMEOUT,
	);

	test(
		"a busy supervisor makes a manual update wait, then give up as supervisor_busy without stopping anything",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			if (f.sim) f.sim.busyUntil = f.clock.t + 3_600_000;
			if (f.sim) f.sim.idleSince = null;
			const result = await runUpdate(f.deps(SLOW_POLL), { mode: "manual" });
			expect(result.code).toBe("supervisor_busy");
			expect(f.fake.calls.some((c) => c.startsWith("stop:"))).toBe(false);
			expect(existsSync(join(f.dir, "update-drain.json"))).toBe(false);
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"a host that is busy for a while and then idle is waited for",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			if (f.sim) {
				f.sim.busyUntil = f.clock.t + 4 * 60_000;
				f.sim.idleSince = null;
			}
			const before = f.clock.t;
			const result = await runUpdate(f.deps(SLOW_POLL), { mode: "manual" });
			expect(result.code).toBe("updated");
			// it waited out the busy period and the 60 s hold
			expect(f.clock.t - before).toBeGreaterThanOrEqual(5 * 60_000);
		},
		TIMEOUT,
	);

	test(
		"a supervisor that never reports drained is drain_timeout, and the drain request is removed",
		async () => {
			fx = await createFixture({ units: ["server", "supervisor"] });
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			if (f.sim) f.sim.stuck = true;
			const result = await runUpdate(f.deps(SLOW_POLL), { mode: "manual" });
			expect(result.code).toBe("drain_timeout");
			expect(existsSync(join(f.dir, "update-drain.json"))).toBe(false);
			expect(f.fake.calls.some((c) => c.startsWith("stop:"))).toBe(false);
		},
		TIMEOUT,
	);

	test(
		"a service that doesn't stop is stop_failed and the units come back",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			// the unit reports "not gone" until it has been asked to stop twice (the rollback's stop)
			let asked = 0;
			f.fake.goneOverride = async (unit) => {
				if (unit === "server") asked++;
				return asked > 400 || !f.fake.active.has("server");
			};
			const deps = f.deps();
			const origStop = f.fake.stop;
			let stops = 0;
			f.fake.stop = async (unit) => {
				stops++;
				if (stops === 1) {
					// the first stop does nothing: the unit is still active
					f.fake.calls.push(`stop:${unit}`);
					return;
				}
				await origStop(unit);
			};
			const result = await runUpdate(deps, { mode: "manual" });
			expect(result.code).toBe("stop_failed");
			expect(version(f.app)).toBe("0.11.0");
			expect(await healthVersion(f)).toBe("0.11.0");
		},
		TIMEOUT,
	);
});

describe("refusals", () => {
	async function outcome(f: Fixture, options = { mode: "manual" as const }, overrides = {}) {
		return (await runUpdate(f.deps(overrides), options)).code;
	}

	test(
		"a modified tracked file is dirty_tree; a stray file is untracked_files",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			writeFileSync(join(f.app, "stray.sh"), "echo hi\n");
			expect(await outcome(f)).toBe("untracked_files");
			const { rmSync } = await import("node:fs");
			rmSync(join(f.app, "stray.sh"));
			writeFileSync(
				join(f.app, "package.json"),
				`${readFileSync(join(f.app, "package.json"), "utf-8")} `,
			);
			expect(await outcome(f)).toBe("dirty_tree");
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"benign untracked files don't refuse the update",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			for (const path of [
				".DS_Store",
				".vite/x",
				"scripts/__pycache__/a.pyc",
				"packages/x/node_modules/y",
				".claude/z",
			]) {
				mkdirSync(join(f.app, path, ".."), { recursive: true });
				writeFileSync(join(f.app, path), "x");
			}
			expect(await outcome(f)).toBe("updated");
		},
		TIMEOUT,
	);

	test(
		"an app that is a symlink is refused",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			const { renameSync } = await import("node:fs");
			renameSync(f.app, join(f.dir, "app-real"));
			symlinkSync(join(f.dir, "app-real"), f.app);
			expect(await outcome(f)).toBe("symlinked_install");
		},
		TIMEOUT,
	);

	test(
		"the wrong install kinds and records are refused before anything runs",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			expect(
				await outcome(f, undefined, {
					env: { PATH: process.env.PATH, HOME: f.home, KUBERNETES_SERVICE_HOST: "10.0.0.1" },
				}),
			).toBe("kubernetes");
			expect(
				await outcome(f, undefined, {
					env: { PATH: process.env.PATH, HOME: f.home, AGENTPULSE_INSTALL_KIND: "container" },
				}),
			).toBe("container");
			f.writeInstallRecord({ service: "none" });
			expect(await outcome(f)).toBe("no_service_manager");
			f.writeInstallRecord({ track: "ref" });
			expect(await outcome(f)).toBe("tracking_ref");
			f.writeInstallRecord({ repoUrl: "https://example.invalid/fork/agentpulse.git" });
			expect(await outcome(f)).toBe("fork_install");
			const { rmSync } = await import("node:fs");
			rmSync(join(f.dir, "install.json"));
			expect(await outcome(f)).toBe("no_install_record");
			expect(f.fake.calls).toEqual([]);
			expect(f.runs).toEqual([]);
		},
		TIMEOUT,
	);

	test(
		"manifest problems: unverified, stale, pulled, commit mismatch, not fast-forward",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.addRelease("0.12.6");
			f.publish({ signer: "unknown" });
			expect(await outcome(f)).toBe("unverified");
			f.publish({ pulled: ["0.12.0"], latest: "0.12.6" });
			expect((await runUpdate(f.deps(), { mode: "manual", to: "0.12.0" })).code).toBe("pulled");
			f.publish({
				latest: "0.12.0",
				only: ["0.11.0", "0.12.0"],
				commitOverride: { "0.12.0": f.releases.get("0.11.0")?.commit as string },
			});
			expect(await outcome(f)).toBe("commit_mismatch");
			expect(readdirSync(f.dir).filter((n) => n.startsWith("app.staging"))).toEqual([]);
			f.addRelease("0.12.4", { diverge: true });
			f.publish({ latest: "0.12.4", only: ["0.11.0", "0.12.4"] });
			expect(await outcome(f)).toBe("not_fast_forward");
			f.publish({ latest: "0.12.0", only: ["0.11.0", "0.12.0"] });
			f.clock.t += 30 * 86_400_000;
			expect(await outcome(f)).toBe("stale");
		},
		TIMEOUT,
	);

	test(
		"equal, older and refused versions",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish({ latest: "0.11.0" });
			expect(await outcome(f)).toBe("up_to_date");
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			f.publish();
			expect(await outcome(f)).toBe("up_to_date");
			expect((await runUpdate(f.deps(), { mode: "manual", to: "0.11.0" })).code).toBe("downgrade");
			const down = await runUpdate(f.deps(), {
				mode: "manual",
				to: "0.11.0",
				allowDowngrade: true,
			});
			expect(down).toMatchObject({ code: "updated", to: "0.11.0" });
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"a migration on an unknown or disagreeing dialect is postgres_migration, on sqlite in auto it needs consent",
		async () => {
			fx = await createFixture({ dialectOverride: "postgres" });
			let f = fx;
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			expect(await outcome(f)).toBe("postgres_migration");
			await f.cleanup();
			// the server unit isn't running, so the dialect can't be confirmed
			fx = await createFixture({ units: ["supervisor"], components: ["server", "supervisor"] });
			f = fx;
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			expect(await outcome(f)).toBe("postgres_migration");
			await f.cleanup();
			fx = await createFixture();
			f = fx;
			f.addRelease("0.13.0", { migration: "0001_b", publishedAt: "2026-11-01T00:00:00.000Z" });
			f.publish();
			writeConsent(f, { on: true, allowMigrations: false, window: null });
			expect(await outcome(f, { mode: "auto" as never })).toBe("migration_needs_consent");
			expect(version(f.app)).toBe("0.11.0");
		},
		TIMEOUT,
	);

	test(
		"disk space is checked",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			expect(await outcome(f, undefined, { freeBytes: () => 1 })).toBe("disk_space");
		},
		TIMEOUT,
	);

	test(
		"another updater holds the lock; a stale lock is taken over",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			const { processIdentity } = await import("../shared/process-identity.js");
			writeFileSync(
				join(f.dir, "update.lock"),
				`${JSON.stringify({ pid: process.pid, processStartedAt: processIdentity(process.pid), takenAt: f.clock.t })}\n`,
				{ mode: 0o600 },
			);
			expect(await outcome(f)).toBe("locked");
			// a child the test started and ended: its pid and start time no longer name a live process
			const child = Bun.spawn(["sleep", "30"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const identity = processIdentity(child.pid);
			child.kill();
			await child.exited;
			writeFileSync(
				join(f.dir, "update.lock"),
				`${JSON.stringify({ pid: child.pid, processStartedAt: identity, takenAt: f.clock.t })}\n`,
				{ mode: 0o600 },
			);
			expect(await outcome(f)).toBe("updated");
			expect(existsSync(join(f.dir, "update.lock"))).toBe(false);
		},
		TIMEOUT,
	);
});

describe("automatic runs", () => {
	test(
		"need consent, a window, and a release that has aged 24 hours unless it is a security fix",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0", { publishedAt: "2026-11-19T06:00:00.000Z" });
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("no_consent");
			const localHour = new Date(f.clock.t).getHours();
			const otherHour = String((localHour + 5) % 24).padStart(2, "0");
			writeConsent(f, {
				on: true,
				allowMigrations: false,
				window: `${otherHour}:00-${otherHour}:30`,
			});
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("outside_window");
			writeConsent(f, { on: true, allowMigrations: false, window: null });
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("canary_wait");
			const release = f.releases.get("0.12.0");
			if (release) release.severity = "security";
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "auto" })).code).toBe("updated");
		},
		TIMEOUT,
	);
});

describe("supervisor-only installs", () => {
	const supervisorOnly = (f: Fixture, serverUrl: string, extra: Record<string, unknown> = {}) =>
		f.writeInstallRecord({
			components: ["supervisor"],
			dataDir: null,
			sqlitePath: null,
			dialect: null,
			port: null,
			serverUrl,
			...extra,
		});

	test(
		"the target is the highest release at or below the server's version",
		async () => {
			fx = await createFixture({
				units: ["supervisor"],
				components: ["supervisor"],
				remoteServerVersion: "0.13.0-rc.1",
			});
			const f = fx;
			f.addRelease("0.12.0");
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			supervisorOnly(f, `http://127.0.0.1:${f.port}`);
			const result = await runUpdate(f.deps(), { mode: "manual" });
			expect(result).toMatchObject({ code: "updated", to: "0.12.0" });
			// no database, so no snapshot and no smoke boot
			expect(existsSync(join(f.dir, "update-snapshots"))).toBe(false);
		},
		TIMEOUT,
	);

	test(
		"a server without a version is server_version_unknown",
		async () => {
			fx = await createFixture({
				units: ["supervisor"],
				components: ["supervisor"],
				remoteServerVersion: "",
			});
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			supervisorOnly(f, `http://127.0.0.1:${f.port}`);
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("server_version_unknown");
		},
		TIMEOUT,
	);

	test(
		"a plain-http LAN server is a source of version data for a supervisor-only install, and not for a server install",
		async () => {
			fx = await createFixture({
				units: ["supervisor"],
				components: ["supervisor"],
				remoteServerVersion: "0.12.0",
			});
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			supervisorOnly(f, `http://192.0.2.10:${f.port}`);
			const asked: boolean[] = [];
			const deps = f.deps();
			const base = deps.fetchText;
			deps.fetchText = async (url, options) => {
				if (url.startsWith("http://192.0.2.10")) {
					asked.push(options.httpsOrLoopbackOnly === true);
					if (options.httpsOrLoopbackOnly !== false) return { ok: false, code: "insecure" };
					return base(url.replace("192.0.2.10", "127.0.0.1"), options);
				}
				return base(url, options);
			};
			const result = await runUpdate(deps, { mode: "manual" });
			expect(result.code).toBe("updated");
			expect(asked.length).toBeGreaterThan(0);
			expect(asked.every((strict) => strict === false)).toBe(true);
			await f.cleanup();

			// the same URL on an install that runs a server here: https or loopback only
			fx = await createFixture();
			const g = fx;
			g.addRelease("0.12.0");
			g.publish();
			g.writeInstallRecord({ serverUrl: `http://192.0.2.10:${g.port}`, port: null });
			const strict: boolean[] = [];
			const gdeps = g.deps();
			gdeps.fetchText = async (url, options) => {
				if (url.startsWith("http://192.0.2.10")) strict.push(options.httpsOrLoopbackOnly === true);
				return { ok: false, code: "insecure" };
			};
			const refused = await runUpdate(gdeps, { mode: "manual" });
			expect(refused.code).not.toBe("updated");
			expect(strict.every(Boolean)).toBe(true);
			expect(g.fake.calls.some((c) => c.startsWith("stop:"))).toBe(false);
		},
		TIMEOUT,
	);
});

describe("leftovers", () => {
	test(
		"an app.failed tree older than 7 days is removed at the next run, a newer one stays",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish({ latest: "0.11.0" });
			const old = join(f.dir, "app.failed-0.9.9");
			const recent = join(f.dir, "app.failed-0.9.10");
			mkdirSync(old);
			mkdirSync(recent);
			const eight = new Date(f.clock.t - 8 * 86_400_000);
			utimesSync(old, eight, eight);
			const two = new Date(f.clock.t - 2 * 86_400_000);
			utimesSync(recent, two, two);
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("up_to_date");
			expect(existsSync(old)).toBe(false);
			expect(existsSync(recent)).toBe(true);
		},
		TIMEOUT,
	);

	test(
		"a successful update removes every failed tree",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			mkdirSync(join(f.dir, "app.failed-0.9.10"));
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			expect(existsSync(join(f.dir, "app.failed-0.9.10"))).toBe(false);
		},
		TIMEOUT,
	);

	test(
		"the shim is rewritten only when its recorded Bun is gone",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			mkdirSync(join(f.dir, "bin"), { mode: 0o700 });
			const shim = join(f.dir, "bin", "agentpulse");
			const kept = "#!/bin/sh\nBUN_BIN='/definitely/not/here/bun'\n";
			writeFileSync(shim, kept, { mode: 0o700 });
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			const rewritten = readFileSync(shim, "utf-8");
			expect(rewritten).toContain(`BUN_BIN='${process.execPath}'`);
			expect(statSync(shim).mode & 0o777).toBe(0o700);
			// and a shim whose Bun exists is left alone
			f.addRelease("0.12.5");
			f.publish();
			const fine = `#!/bin/sh\nBUN_BIN='${process.execPath}'\n# mine\n`;
			writeFileSync(shim, fine, { mode: 0o700 });
			chmodSync(shim, 0o700);
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			expect(readFileSync(shim, "utf-8")).toBe(fine);
		},
		TIMEOUT,
	);
	test(
		"a tracked .env.example is the release's own: it isn't replaced by the old copy, so the next update isn't dirty",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.addRelease("0.12.5");
			f.publish({ latest: "0.12.0", only: ["0.11.0", "0.12.0"] });
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			expect(readFileSync(join(f.app, ".env.example"), "utf-8")).toBe("EXAMPLE=0.12.0\n");
			expect(readFileSync(join(f.app, ".env.local"), "utf-8")).toContain(f.secret);
			f.publish();
			const second = await runUpdate(f.deps(), { mode: "manual" });
			expect(second.code).toBe("updated");
			expect(readFileSync(join(f.app, ".env.example"), "utf-8")).toBe("EXAMPLE=0.12.5\n");
		},
		TIMEOUT * 2,
	);

	test(
		"an .env* entry that is a link is refused before anything is stopped",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.12.0");
			f.publish();
			writeFileSync(join(f.root, "elsewhere"), "x");
			symlinkSync(join(f.root, "elsewhere"), join(f.app, ".env.extra"));
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("untracked_files");
		},
		TIMEOUT,
	);

	test(
		"--allow-downgrade is refused when the database has a migration the older version doesn't know",
		async () => {
			fx = await createFixture();
			const f = fx;
			f.addRelease("0.13.0", { migration: "0001_b" });
			f.publish();
			expect((await runUpdate(f.deps(), { mode: "manual" })).code).toBe("updated");
			const result = await runUpdate(f.deps(), {
				mode: "manual",
				to: "0.11.0",
				allowDowngrade: true,
			});
			expect(result.code).toBe("downgrade_schema");
		},
		TIMEOUT,
	);

	test(
		"a journal that names paths outside the install's own is refused: nothing is renamed or removed",
		async () => {
			fx = await createFixture();
			const f = fx;
			const { writePrivateFileAtomicNoFollow } = await import("../shared/private-file.js");
			const base = {
				schema: 1,
				phase: "swapping",
				step: "x",
				from: "0.11.0",
				to: "0.12.0",
				bundle: null,
				units: ["server"],
				snapshot: null,
				ops: [] as { src: string; dst: string }[],
				done: 0,
				intent: -1,
				stagedBundle: null,
				bundleInstalled: false,
				envCopied: false,
				fingerprint: null,
				app: f.app,
				startedAt: 0,
			};
			const evil = join(f.root, "evil");
			for (const over of [
				{ ops: [{ src: f.app, dst: evil }], done: 1 },
				{ to: "../../x" },
				{ snapshot: "/etc/passwd" },
				{ app: join(f.root, "other") },
			]) {
				writePrivateFileAtomicNoFollow(
					join(f.dir, "update-journal.json"),
					`${JSON.stringify({ ...base, ...over })}\n`,
				);
				const result = await runRecovery(f.deps());
				expect(result?.code).toBe("rollback_failed");
				expect(existsSync(f.app)).toBe(true);
				expect(existsSync(evil)).toBe(false);
				expect(f.fake.calls.filter((c) => /^(stop|start):/.test(c))).toEqual([]);
			}
		},
		TIMEOUT,
	);
});
