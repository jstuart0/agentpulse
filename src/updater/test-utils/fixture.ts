/**
 * A throwaway machine for the updater's tests: a HOME, an install checkout cloned from a local bare repo
 * with tagged "releases", a fixture server script that answers /health with its own version and database
 * fingerprint, a fake service manager that starts that script as a child this fixture owns, a supervisor
 * simulation that writes the status file, a fake clock and a signed manifest. Everything lives under one
 * temp directory; the real ~/.agentpulse, launchd and systemd are never reached. Test-only.
 */
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOW,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
	testRelease,
} from "../../shared/__fixtures__/release-test-signer.js";
import { fetchCapped } from "../../shared/capped-fetch.js";
import { detectInstallKindForTests } from "../../shared/install-record.js";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import { processIdentity } from "../../shared/process-identity.js";
import {
	type DrainRequest,
	SUPERVISOR_STATUS_FILE,
	readDrainRequest,
} from "../../shared/update-files.js";
import { drainIsFresh } from "../../supervisor/services/update-drain.js";
import { type RunFn, defaultRun } from "../exec.js";
import { createFileLog } from "../log.js";
import type { UnitName } from "../service-manager.js";
import { portIsOpen } from "../service-manager.js";
import { smokeBoot } from "../smoke.js";
import { DEFAULT_TIMING, type UpdaterDeps, defaultUsageBytes } from "../updater.js";
import { type FakeServiceManager, createFakeServiceManager } from "./fake-service-manager.js";

const SERVER_TS = `import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = import.meta.dir;
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
if (existsSync(join(dir, "CRASH_ON_START"))) process.exit(1);
let dbPath = process.env.SQLITE_PATH as string;
if (existsSync(join(dir, "OTHER_DB"))) dbPath += ".other";
const db = new Database(dbPath, { create: true });
db.run("PRAGMA journal_mode=WAL");
db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
if (!db.query("SELECT 1 FROM settings WHERE key = 'installation_id'").get()) {
	db.run("INSERT INTO settings VALUES ('installation_id', ?)", [crypto.randomUUID()]);
}
if (existsSync(join(dir, "MIGRATE"))) db.run("CREATE TABLE IF NOT EXISTS migrated_" + pkg.version.replaceAll(".", "_") + " (x)");
const id = (db.query("SELECT value FROM settings WHERE key = 'installation_id'").get() as { value: string }).value;
const fp = createHash("sha256").update("agentpulse-db-fingerprint:" + id).digest("hex").slice(0, 12);
const version = process.env.VERSION_OVERRIDE ?? (existsSync(join(dir, "BAD_VERSION")) || (existsSync(join(dir, "BAD_IN_SERVICE")) && process.env.MANIFEST_FILE) ? "0.0.1" : pkg.version);
Bun.serve({
	port: Number(process.env.PORT),
	hostname: "127.0.0.1",
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/api/v1/health") return new Response("no", { status: 404 });
		const body: Record<string, unknown> = { status: "ok", version, instance: { dbFingerprint: fp, dialect: process.env.DIALECT_OVERRIDE ?? "sqlite" } };
		if (url.searchParams.get("manifest") === "1") {
			const file = process.env.MANIFEST_FILE;
			body.releaseManifest = file && existsSync(file) ? readFileSync(file, "utf-8") : null;
		}
		return Response.json(body);
	},
});
`;

const BUILD_TS = `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/built", "ok");
`;

const UPDATER_CLI_TS = `console.log("fixture updater");\n`;

export interface FixtureRelease {
	version: string;
	commit: string;
	migration: string;
	severity: "normal" | "security";
	publishedAt: string;
}

export class SupervisorSim {
	child: ReturnType<typeof Bun.spawn> | null = null;
	/** Fake time until which the host counts as busy. */
	busyUntil = 0;
	idleSince: number | null = null;
	startedAt = 0;
	registered = true;
	/** A host that never reaches `drained` while draining. */
	stuck = false;
	version = "0";
	identity: string | null = null;
	constructor(
		private readonly home: string,
		private readonly clock: { t: number },
	) {}
	start(version: string) {
		this.child = Bun.spawn(["sleep", "300"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		this.identity = processIdentity(this.child.pid);
		this.version = version;
		this.startedAt = this.clock.t;
		this.idleSince = null;
		this.tick();
	}
	async stop() {
		this.child?.kill();
		await this.child?.exited;
		this.child = null;
	}
	tick() {
		if (!this.child) return;
		const now = this.clock.t;
		const idle = now >= this.busyUntil;
		if (idle) this.idleSince = this.idleSince ?? Math.max(this.startedAt, this.busyUntil);
		else this.idleSince = null;
		const drain: DrainRequest | null = readDrainRequest(this.home);
		const draining = drainIsFresh(drain, now);
		writePrivateFileAtomicNoFollow(
			join(this.home, ".agentpulse", SUPERVISOR_STATUS_FILE),
			`${JSON.stringify({
				schema: 1,
				version: this.version,
				pid: this.child.pid,
				processStartedAt: this.identity,
				writtenAt: now,
				registered: this.registered,
				idleSince: this.idleSince,
				inFlight: 0,
				draining,
				drained: draining && idle && !this.stuck,
			})}\n`,
		);
	}
}

export interface RunLog {
	cmd: string[];
	env: Record<string, string>;
	cwd: string;
}

export interface Fixture {
	root: string;
	home: string;
	dir: string;
	app: string;
	remote: string;
	work: string;
	port: number;
	dbPath: string;
	manifestFile: string;
	clock: { t: number };
	fake: FakeServiceManager;
	sim: SupervisorSim | null;
	releases: Map<string, FixtureRelease>;
	runs: RunLog[];
	logLines: string[];
	fetched: string[];
	pagesBody: string | null;
	secret: string;
	git(...args: string[]): string;
	addRelease(version: string, options?: ReleaseOptions): FixtureRelease;
	publish(options?: PublishOptions): string;
	deps(overrides?: Partial<UpdaterDeps>): UpdaterDeps;
	writeInstallRecord(overrides?: Record<string, unknown>): void;
	serverChild(): ReturnType<typeof Bun.spawn> | null;
	cleanup(): Promise<void>;
}

export interface ReleaseOptions {
	files?: Record<string, string>;
	/** The new last migration of both dialects. */
	migration?: string;
	severity?: "normal" | "security";
	publishedAt?: string;
	/** Commit on a branch that isn't a descendant of main's current tip. */
	diverge?: boolean;
}

export interface PublishOptions {
	latest?: string;
	minSupported?: string;
	pulled?: string[];
	seq?: number;
	only?: string[];
	signer?: "active" | "standby" | "unknown";
	/** Lists this commit for a version instead of the real one. */
	commitOverride?: Record<string, string>;
}

const FIXTURE_GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function journalText(last: string): string {
	return `${JSON.stringify({ version: "7", dialect: "x", entries: [{ idx: 0, tag: "0000_a" }, ...(last === "0000_a" ? [] : [{ idx: 1, tag: last }])] })}\n`;
}

export interface FixtureOptions {
	units?: UnitName[];
	components?: ("server" | "supervisor")[];
	/** Start the fixture server as a remote one (not a unit of this install), reporting this version ("" reports none). */
	remoteServerVersion?: string;
	dialectOverride?: string;
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-updater-fx-")));
	const home = join(root, "home");
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const remote = join(root, "origin.git");
	const work = join(root, "work");
	const app = join(dir, "app");
	const dataDir = join(dir, "data");
	mkdirSync(dataDir, { mode: 0o700 });
	const dbPath = join(dataDir, "agentpulse.db");
	const manifestFile = join(root, "manifest.json");
	const secret = `s3cr3t-${crypto.randomUUID()}`;
	const clock = { t: NOW };
	const units = options.units ?? ["server"];
	const components =
		options.components ?? (units.includes("supervisor") ? ["server", "supervisor"] : ["server"]);

	const git = (cwd: string, ...args: string[]): string => {
		const proc = Bun.spawnSync(["git", ...args], {
			cwd,
			env: { PATH: process.env.PATH ?? "", HOME: root, ...FIXTURE_GIT_ENV },
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0)
			throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
		return proc.stdout.toString().trim();
	};
	mkdirSync(work, { recursive: true });
	git(root, "init", "--bare", "--initial-branch=main", remote);
	git(work, "init", "--initial-branch=main");
	git(work, "remote", "add", "origin", remote);

	const releases = new Map<string, FixtureRelease>();
	const fx: Fixture = {
		root,
		home,
		dir,
		app,
		remote,
		work,
		port: 0,
		dbPath,
		manifestFile,
		clock,
		fake: createFakeServiceManager(units),
		sim: null,
		releases,
		runs: [],
		logLines: [],
		fetched: [],
		pagesBody: null,
		secret,
		git: (...args) => git(work, ...args),
		addRelease(version, opts = {}) {
			const migration = opts.migration ?? [...releases.values()].at(-1)?.migration ?? "0000_a";
			if (opts.diverge) {
				// A history that shares nothing with the installed checkout.
				git(work, "checkout", "-q", "--orphan", `diverge-${version}`);
				git(work, "rm", "-rf", "-q", "--ignore-unmatch", ".");
			}
			const files: Record<string, string> = {
				".gitignore": "node_modules/\ndist/\n.env*\n.DS_Store\n",
				"package.json": `${JSON.stringify({ name: "fixture", version, scripts: { build: "bun run scripts/build.ts" } })}\n`,
				"server.ts": SERVER_TS,
				"scripts/build.ts": BUILD_TS,
				"src/updater/cli.ts": UPDATER_CLI_TS,
				"scripts/lib/shim.sh": readFileSync(
					join(import.meta.dir, "..", "..", "..", "scripts", "lib", "shim.sh"),
					"utf-8",
				),
				"drizzle/sqlite/meta/_journal.json": journalText(migration),
				"drizzle/postgres/meta/_journal.json": journalText(migration),
				...(migration !== "0000_a" ? { MIGRATE: "1\n" } : {}),
				...opts.files,
			};
			for (const [path, text] of Object.entries(files)) {
				const full = join(work, path);
				mkdirSync(join(full, ".."), { recursive: true });
				writeFileSync(full, text);
			}
			git(work, "add", "-A");
			git(work, "commit", "-q", "--allow-empty", "-m", `release ${version}`);
			const commit = git(work, "rev-parse", "HEAD");
			git(work, "tag", "-a", `v${version}`, "-m", `v${version}`, commit);
			git(
				work,
				"push",
				"-q",
				"--force",
				"origin",
				`HEAD:refs/heads/${opts.diverge ? `diverge-${version}` : "main"}`,
				`refs/tags/v${version}`,
			);
			if (opts.diverge) git(work, "checkout", "-q", "main");
			const release: FixtureRelease = {
				version,
				commit,
				migration,
				severity: opts.severity ?? "normal",
				publishedAt: opts.publishedAt ?? "2026-11-01T00:00:00.000Z",
			};
			releases.set(version, release);
			return release;
		},
		publish(opts = {}) {
			const all = [...releases.values()]
				.filter((r) => !opts.only || opts.only.includes(r.version))
				.reverse();
			const latest = opts.latest ?? all[0]?.version ?? "0.11.0";
			const payload = testPayload({
				seq: opts.seq ?? 100 + (fx as unknown as { __seq: number }).__seq++,
				latest,
				minSupported: opts.minSupported ?? "0.11.0",
				issuedAt: "2026-11-19T11:00:00.000Z",
				expiresAt: "2026-11-29T11:00:00.000Z",
				releases: all.map((r) =>
					testRelease(r.version, {
						commit: opts.commitOverride?.[r.version] ?? r.commit,
						severity: r.severity,
						publishedAt: r.publishedAt,
						pulled: opts.pulled?.includes(r.version) ?? false,
						migrations: { sqlite: r.migration, postgres: r.migration },
					}),
				),
			});
			const text = envelopeFor(payload, opts.signer ?? "active");
			writeFileSync(manifestFile, text);
			// The release feed serves the same signed file.
			fx.pagesBody = text;
			return text;
		},
		deps(overrides = {}) {
			const run: RunFn = async (cmd, o) => {
				fx.runs.push({ cmd, env: o.env, cwd: o.cwd });
				return defaultRun(cmd, o);
			};
			const base: UpdaterDeps = {
				home,
				cwd: dir,
				env: { PATH: process.env.PATH, HOME: home },
				platform: "darwin",
				pid: process.pid,
				now: () => clock.t,
				sleep: async (ms) => {
					clock.t += ms;
					await new Promise((r) => setTimeout(r, Math.min(50, ms)));
					fx.sim?.tick();
				},
				run,
				fetchText: async (url, opts) => {
					fx.fetched.push(url);
					if (url.startsWith("http://127.0.0.1")) return fetchCapped(url, opts);
					return fx.pagesBody === null
						? { ok: false, code: "network" }
						: { ok: true, status: 200, body: fx.pagesBody };
				},
				serviceManager: fx.fake,
				keys: TEST_KEY_LIST,
				canonicalRepoUrl: remote,
				manifestUrl: "https://pages.invalid/releases/manifest.json",
				// The container marker files of the machine running the tests (a devcontainer has /.dockerenv) must not decide it.
				detectKind: (env, cwd, h) =>
					detectInstallKindForTests(env, cwd, h, { exists: () => false }),
				identityOf: processIdentity,
				bootTimeMs: () => null,
				freeBytes: () => 10 ** 12,
				usageBytes: defaultUsageBytes,
				bunBin: process.execPath,
				smokeEntry: "server.ts",
				smokeBoot,
				log: {
					line: (event, fields = {}) => void fx.logLines.push(`${event} ${JSON.stringify(fields)}`),
				},
				timing: { ...DEFAULT_TIMING },
			};
			return { ...base, ...overrides };
		},
		writeInstallRecord(overrides = {}) {
			const record = {
				schema: 1,
				kind: "local",
				components,
				repoUrl: remote,
				track: "release",
				ref: "v0.11.0",
				installDir: realpathSync(app),
				dataDir,
				sqlitePath: dbPath,
				dialect: "sqlite",
				service: "launchd",
				serverUrl: `http://127.0.0.1:${fx.port}`,
				port: fx.port,
				bunBin: process.execPath,
				...overrides,
			};
			writePrivateFileAtomicNoFollow(join(dir, "install.json"), `${JSON.stringify(record)}\n`);
		},
		serverChild: () => serverChild,
		async cleanup() {
			await fx.sim?.stop();
			serverChild?.kill();
			await serverChild?.exited;
			rmSync(root, { recursive: true, force: true });
		},
	};
	(fx as unknown as { __seq: number }).__seq = 0;

	// A free port for the installed server.
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	fx.port = probe.port as number;
	probe.stop(true);

	let serverChild: ReturnType<typeof Bun.spawn> | null = null;
	const startServer = async () => {
		serverChild = Bun.spawn([process.execPath, join(app, "server.ts")], {
			cwd: app,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				PORT: String(fx.port),
				SQLITE_PATH: dbPath,
				MANIFEST_FILE: manifestFile,
				...(options.remoteServerVersion !== undefined
					? { VERSION_OVERRIDE: options.remoteServerVersion }
					: {}),
				...(options.dialectOverride ? { DIALECT_OVERRIDE: options.dialectOverride } : {}),
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
	};
	fx.fake.onStart = async (unit) => {
		if (unit === "server") await startServer();
		else {
			fx.sim = fx.sim ?? new SupervisorSim(home, clock);
			const version = JSON.parse(readFileSync(join(app, "package.json"), "utf-8"))
				.version as string;
			fx.sim.start(version);
		}
	};
	fx.fake.onStop = async (unit) => {
		if (unit === "server") {
			serverChild?.kill();
			await serverChild?.exited;
			serverChild = null;
			for (let i = 0; i < 100 && (await portIsOpen(fx.port)); i++)
				await new Promise((r) => setTimeout(r, 20));
		} else {
			await fx.sim?.stop();
		}
	};

	// The first release is the installed one.
	fx.addRelease("0.11.0");
	git(root, "clone", "-q", "--branch", "v0.11.0", remote, app);
	writeFileSync(join(app, ".env.local"), `SECRET_TOKEN=${secret}\n`, { mode: 0o600 });
	chmodSync(join(app, ".env.local"), 0o600);
	writeFileSync(join(app, ".env"), "PORT=3000\n", { mode: 0o640 });
	fx.writeInstallRecord();
	// The server that is "running" before the update, with its database.
	if (units.includes("server") || options.remoteServerVersion !== undefined) await startServer();
	else {
		const db = new Database(dbPath, { create: true });
		db.run("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
		db.run("INSERT INTO settings VALUES ('installation_id', 'fixture-id')");
		db.close();
	}
	if (units.includes("supervisor")) {
		fx.sim = new SupervisorSim(home, clock);
		fx.sim.start("0.11.0");
		fx.sim.idleSince = clock.t - 10 * 60_000;
		fx.sim.tick();
	}
	if (units.includes("server") || options.remoteServerVersion !== undefined) {
		for (let i = 0; i < 200 && !(await portIsOpen(fx.port)); i++)
			await new Promise((r) => setTimeout(r, 25));
	}
	return fx;
}

export { createFileLog };

/** After a simulated crash the lock file still names this (live) test process: rewrite it as a holder that has died. */
export async function makeLockStale(fx: Fixture): Promise<void> {
	const child = Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const identity = processIdentity(child.pid);
	child.kill();
	await child.exited;
	writeFileSync(
		join(fx.dir, "update.lock"),
		`${JSON.stringify({ pid: child.pid, processStartedAt: identity, takenAt: fx.clock.t })}\n`,
		{ mode: 0o600 },
	);
}
