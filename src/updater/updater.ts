/**
 * `runUpdate`: the ordered, journaled update of a local install, and the recovery and rollback that go with it.
 *
 * It owns the order (see the plan's `src/updater/` interface): recover first, lock, refuse the wrong install,
 * consent, verify the signed manifest, choose the target, gate migrations, preflight, stage, smoke-boot a
 * copy, drain the supervisor, stop, snapshot, swap, start, health-check, commit. Every step that changes the
 * machine is journaled before and after, so a crash or a failed start puts the previous copy back, and the
 * same code runs both ways. Nothing here signals a process it didn't start; the service manager is the only
 * thing that stops or starts a service.
 *
 * Everything outside the filesystem is injected (`UpdaterDeps`): the service manager, the clock, git and bun,
 * the network, the process table. The CLI builds the real ones; tests build fakes.
 */
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { CappedFetchOptions } from "../shared/capped-fetch.js";
import {
	type InstallComponent,
	type InstallKind,
	type InstallRecord,
	readInstallRecord,
} from "../shared/install-record.js";
import { writePrivateFileAtomicNoFollow } from "../shared/private-file.js";
import { isCanonicalRepoUrl } from "../shared/release-feed.js";
import type { ReleaseKey } from "../shared/release-keys.js";
import { type Manifest, verifyManifest } from "../shared/release-manifest.js";
import {
	type SupervisorStatus,
	type UpdaterState,
	readConsent,
	readSupervisorStatus,
} from "../shared/update-files.js";
import type { UpdateOutcomeCode } from "../shared/update-status.js";
import { parseReleaseVersion } from "../shared/version.js";
import { backoffActive, isWaiting, nextBackoff } from "./auto-apply.js";
import { type LocalEndpoint, isLoopbackProbeHost, localEndpoint } from "./endpoint.js";
import { type RunFn, gitEnv } from "./exec.js";
import { type FetchText, type HealthInfo, probeHealth } from "./health.js";
import {
	type Journal,
	type JournalRead,
	needsRecovery,
	readJournal,
	writeJournal,
} from "./journal.js";
import { acquireLock } from "./lock.js";
import type { UpdaterLog } from "./log.js";
import { appSiblings, updaterPaths } from "./paths.js";
import type { ServiceManager, UnitName } from "./service-manager.js";
import type { SmokeInput, SmokeResult } from "./smoke.js";
import { SnapshotError, pruneSnapshots, restoreSnapshot, takeSnapshot } from "./snapshot.js";
import {
	type StageDeps,
	buildStaged,
	bundleUpdater,
	checkTreeClean,
	fetchTarget,
} from "./stage.js";
import { loadState, recordOutcome, recordVerified, saveBackoff } from "./state.js";
import {
	carryEnvFiles,
	executeSwap,
	flipCurrent,
	installBundle,
	irregularEnvEntries,
	isOlderThan,
	listSiblings,
	planSwap,
	removeTree,
	undoSwap,
} from "./swap.js";
import { chooseTarget } from "./target.js";

/** Thrown by a test's `afterStep` to model the process dying: nothing is cleaned up and the lock stays. */
export class UpdaterCrash extends Error {}

export interface UpdaterTiming {
	idleHoldMs: number;
	idleWaitAutoMs: number;
	idleWaitManualMs: number;
	idleWaitLongMs: number;
	drainMs: number;
	stopMs: number;
	serverHealthMs: number;
	supervisorHealthMs: number;
	statusFreshMs: number;
	smokeMs: number;
	pollMs: number;
}

export const DEFAULT_TIMING: UpdaterTiming = {
	idleHoldMs: 60_000,
	idleWaitAutoMs: 30 * 60_000,
	idleWaitManualMs: 10 * 60_000,
	idleWaitLongMs: 2 * 3_600_000,
	drainMs: 2 * 60_000,
	// systemd's TimeoutStopSec defaults to 90 s: a stop may legitimately take that long.
	stopMs: 120_000,
	serverHealthMs: 90_000,
	supervisorHealthMs: 60_000,
	statusFreshMs: 45_000,
	smokeMs: 90_000,
	pollMs: 2_000,
};

const FAILED_TREE_MAX_AGE_MS = 7 * 86_400_000;
const PAGES_MANIFEST_MAX_BYTES = 32 * 1024;
const PAGES_DEADLINE_MS = 10_000;
const DRAIN_FILE_WINDOW_MS = 3 * 60_000;

export interface UpdaterDeps {
	home: string;
	cwd: string;
	env: Record<string, string | undefined>;
	platform: NodeJS.Platform;
	pid: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	run: RunFn;
	fetchText: FetchText;
	serviceManager: ServiceManager;
	keys: readonly ReleaseKey[];
	canonicalRepoUrl: string;
	manifestUrl: string;
	/** What kind of install this process runs inside (`detectInstallKind`: Kubernetes, then a container, then local). */
	detectKind: (env: Record<string, string | undefined>, cwd: string, home: string) => InstallKind;
	identityOf: (pid: number) => string | null;
	bootTimeMs: () => number | null;
	/** Free bytes on the volume holding `path`, or null when unknown (the disk check is then skipped). */
	freeBytes: (path: string) => number | null;
	usageBytes: (path: string) => number;
	/** The Bun running the updater: used to bundle and to rewrite a shim whose recorded Bun is gone. */
	bunBin: string;
	/** The staged server's entry, relative to the staged tree. */
	smokeEntry: string;
	smokeBoot: (input: SmokeInput) => Promise<SmokeResult>;
	log: UpdaterLog;
	timing: UpdaterTiming;
	/** Test only: called after each journaled step. Anything it throws is the process dying. */
	afterStep?: (step: string) => void;
}

export interface UpdateOptions {
	mode: "manual" | "auto";
	/** A version to move to, without the leading `v`. */
	to?: string;
	allowDowngrade?: boolean;
	wait?: boolean;
}

export interface UpdateResult {
	code: UpdateOutcomeCode;
	from?: string;
	to?: string;
	/** For `rolled_back`: why the new version failed. */
	reason?: UpdateOutcomeCode;
	/** For `rollback_failed`: the snapshot to restore by hand, when there is one. */
	snapshotPath?: string;
	/** For `updated`: the update changed the database, so `update rollback` restores a snapshot and loses what was written since. */
	migrated?: boolean;
}

// ------------------------------------------------------------------ helpers

function readVersionOf(app: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(app, "package.json"), "utf-8")) as {
			version?: unknown;
		};
		return typeof parsed.version === "string" && parseReleaseVersion(parsed.version)
			? parsed.version
			: null;
	} catch {
		return null;
	}
}

/** The last migration tag of a dialect's journal in `app`, or null when unreadable. */
/** Every migration tag in a dialect's journal under `app`; empty when unreadable. */
function migrationTags(app: string, dialect: "sqlite" | "postgres"): string[] {
	try {
		const raw = JSON.parse(
			readFileSync(join(app, "drizzle", dialect, "meta", "_journal.json"), "utf-8"),
		) as { entries?: { tag?: unknown }[] };
		return (raw.entries ?? []).flatMap((e) => (typeof e.tag === "string" ? [e.tag] : []));
	} catch {
		return [];
	}
}

function lastMigration(app: string, dialect: "sqlite" | "postgres"): string | null {
	try {
		const raw = JSON.parse(
			readFileSync(join(app, "drizzle", dialect, "meta", "_journal.json"), "utf-8"),
		) as {
			entries?: { tag?: unknown }[];
		};
		const tag = raw.entries?.[raw.entries.length - 1]?.tag;
		return typeof tag === "string" ? tag : null;
	} catch {
		return null;
	}
}

function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function dirSize(path: string): number {
	let total = 0;
	const stack = [path];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const full = join(dir, name);
			try {
				const info = lstatSync(full);
				if (info.isDirectory()) stack.push(full);
				else total += info.size;
			} catch {
				// vanished while walking
			}
		}
	}
	return total;
}
export { dirSize as defaultUsageBytes };

function stageDeps(deps: UpdaterDeps): StageDeps {
	return { run: deps.run, env: deps.env, home: deps.home };
}

/** Whether `minutes` (since local midnight) falls in `HH:MM-HH:MM`; a window that wraps midnight is fine, and start == end is empty. */
export function inWindowAt(window: string | null, minutes: number): boolean {
	if (!window) return true;
	const [start, end] = window.split("-") as [string, string];
	const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
	const a = at(start);
	const b = at(end);
	return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

/** `inWindowAt` for a moment, in the machine's local time. */
export function inWindow(window: string | null, nowMs: number): boolean {
	const date = new Date(nowMs);
	return inWindowAt(window, date.getHours() * 60 + date.getMinutes());
}

// ------------------------------------------------------------------ context

interface Ctx {
	deps: UpdaterDeps;
	paths: ReturnType<typeof updaterPaths>;
	record: InstallRecord;
	/** Realpath of the checkout. */
	app: string;
	sib: ReturnType<typeof appSiblings>;
	components: readonly InstallComponent[];
	serverBase: string | null;
	serverFetchLoose: boolean;
	endpoint: LocalEndpoint;
	journal: Journal | null;
	/** The backoff as this run found it, before it armed a provisional one: what the final bookkeeping counts from. */
	priorBackoff: UpdaterState["backoff"] | null | undefined;
}

function save(ctx: Ctx, step: string): void {
	if (!ctx.journal) return;
	ctx.journal.step = step;
	writeJournal(ctx.paths.dir, ctx.journal);
	ctx.deps.afterStep?.(step);
}

function fail(code: UpdateOutcomeCode, extra: Partial<UpdateResult> = {}): UpdateResult {
	return { code, ...extra };
}

async function pollUntil(
	deps: UpdaterDeps,
	ms: number,
	check: () => Promise<boolean> | boolean,
): Promise<boolean> {
	const deadline = deps.now() + ms;
	for (;;) {
		if (await check()) return true;
		if (deps.now() >= deadline) return false;
		await deps.sleep(deps.timing.pollMs);
	}
}

function serverUrls(
	record: InstallRecord,
	app: string,
): { base: string | null; loose: boolean; endpoint: LocalEndpoint } {
	const endpoint = localEndpoint(record, app);
	if (record.components.includes("server")) {
		// The local server is probed where it listens, never at a public server URL over plain http.
		return {
			base: endpoint.port === null ? null : `http://${endpoint.host}:${endpoint.port}`,
			loose: !isLoopbackProbeHost(endpoint.host),
			endpoint,
		};
	}
	// A supervisor-only install reads its server over the link it was enrolled with; plain http only when the record says so (U7).
	return { base: record.serverUrl, loose: record.serverTransport === "http", endpoint };
}

async function healthOf(ctx: Ctx, manifest = false): Promise<HealthInfo | null> {
	if (!ctx.serverBase) return null;
	return probeHealth(ctx.deps.fetchText, ctx.serverBase, {
		manifest,
		httpsOrLoopbackOnly: !ctx.serverFetchLoose,
	});
}

// ------------------------------------------------------------------ the supervisor

function freshStatus(ctx: Ctx): SupervisorStatus | null {
	const status = readSupervisorStatus(ctx.deps.home);
	if (!status) return null;
	return ctx.deps.now() - status.writtenAt <= ctx.deps.timing.statusFreshMs ? status : null;
}

async function waitForIdle(ctx: Ctx, maxMs: number): Promise<boolean> {
	const { deps } = ctx;
	return pollUntil(deps, maxMs, () => {
		const status = freshStatus(ctx);
		return (
			status?.registered === true &&
			status.idleSince !== null &&
			deps.now() - status.idleSince >= deps.timing.idleHoldMs
		);
	});
}

async function drain(ctx: Ctx): Promise<boolean> {
	const { deps } = ctx;
	const requestedAt = deps.now();
	writePrivateFileAtomicNoFollow(
		ctx.paths.drain,
		`${JSON.stringify({ schema: 1, requestedAt, expiresAt: requestedAt + DRAIN_FILE_WINDOW_MS })}\n`,
	);
	const drained = await pollUntil(deps, deps.timing.drainMs, () => {
		const status = freshStatus(ctx);
		return status?.draining === true && status.drained && status.writtenAt >= requestedAt;
	});
	return drained;
}

function removeDrain(ctx: Ctx): void {
	rmSync(ctx.paths.drain, { force: true });
}

// ------------------------------------------------------------------ stop / start

async function stopUnits(
	ctx: Ctx,
	units: UnitName[],
	ports: { server: number | null; host: string | null; supervisor: StatusId },
): Promise<boolean> {
	const { deps } = ctx;
	// The supervisor first, then the server.
	for (const unit of ["supervisor", "server"] as const) {
		if (!units.includes(unit)) continue;
		try {
			await deps.serviceManager.stop(unit);
		} catch {
			deps.log.line("stop_error", { unit });
			return false;
		}
		const query =
			unit === "server"
				? { pid: null, startedAt: null, port: ports.server, host: ports.host }
				: {
						pid: ports.supervisor.pid,
						startedAt: ports.supervisor.startedAt,
						port: null,
						host: null,
					};
		const gone = await pollUntil(deps, deps.timing.stopMs, () =>
			deps.serviceManager.isGone(unit, query),
		);
		if (!gone) return false;
	}
	return true;
}

type StatusId = { pid: number | null; startedAt: string | null };

async function startAndVerify(
	ctx: Ctx,
	units: UnitName[],
	expect: { version: string; fingerprint: string | null; oldSupervisor: StatusId },
): Promise<"ok" | "health_failed" | "supervisor_failed"> {
	const { deps } = ctx;
	const startedAt = deps.now();
	// The server first, then the supervisor.
	for (const unit of ["server", "supervisor"] as const) {
		if (!units.includes(unit)) continue;
		try {
			await deps.serviceManager.start(unit);
		} catch {
			deps.log.line("start_error", { unit });
			return unit === "server" ? "health_failed" : "supervisor_failed";
		}
	}
	if (units.includes("server")) {
		const ok = await pollUntil(deps, deps.timing.serverHealthMs, async () => {
			const health = await healthOf(ctx);
			return (
				health !== null &&
				health.version === expect.version &&
				(expect.fingerprint === null || health.dbFingerprint === expect.fingerprint)
			);
		});
		if (!ok) return "health_failed";
	}
	if (units.includes("supervisor")) {
		const ok = await pollUntil(deps, deps.timing.supervisorHealthMs, () => {
			const status = freshStatus(ctx);
			if (!status || !status.registered || status.version !== expect.version) return false;
			// A file the previous process wrote before this start can't vouch for the new one.
			if (status.writtenAt < startedAt) return false;
			const sameAsOld =
				status.pid === expect.oldSupervisor.pid &&
				status.processStartedAt === expect.oldSupervisor.startedAt;
			return !sameAsOld;
		});
		if (!ok) return "supervisor_failed";
	}
	return "ok";
}

// ------------------------------------------------------------------ rollback

async function rollbackFromJournal(ctx: Ctx, restartVersion: string): Promise<UpdateResult | null> {
	const { deps } = ctx;
	const journal = ctx.journal as Journal;
	journal.phase = "rolling_back";
	save(ctx, "rollback_begin");
	const status = readSupervisorStatus(deps.home);
	// Stop whatever is running now (the new copy may have started), then put the old one back.
	const running = await deps.serviceManager.activeUnits();
	if (
		!(await stopUnits(ctx, running, {
			server: ctx.endpoint.port,
			host: ctx.endpoint.host,
			supervisor: { pid: status?.pid ?? null, startedAt: status?.processStartedAt ?? null },
		}))
	) {
		return fail("rollback_failed", { snapshotPath: journal.snapshot ?? undefined });
	}
	removeDrain(ctx);
	if (journal.snapshot && existsSync(journal.snapshot) && ctx.record.sqlitePath) {
		if (!restoreSnapshot(journal.snapshot, ctx.record.sqlitePath)) {
			// Services stay stopped: starting on a database that didn't restore could do more harm.
			return fail("rollback_failed", { snapshotPath: journal.snapshot });
		}
		save(ctx, "snapshot_restored");
	}
	undoSwap(journal, (step) => save(ctx, step));
	const stagingDir = ctx.sib.staging(journal.to);
	if (existsSync(stagingDir)) {
		// The failed tree is kept for a look (it holds a copy of the .env files, so it is removed by the next
		// successful update, and by the first run more than 7 days after it was made).
		const failedDir = ctx.sib.failed(journal.to);
		removeTree(failedDir);
		if (journal.envCopied) {
			renameSync(stagingDir, failedDir);
		} else {
			removeTree(stagingDir);
		}
	}
	if (journal.bundleInstalled && ctx.deps.home) {
		const current = safeReadlink(ctx.paths.updaterCurrent);
		if (current !== journal.to) removeTree(join(ctx.paths.updaterRoot, journal.to));
	}
	removeTree(`${ctx.paths.updaterRoot}/.staging-${journal.to}`);
	save(ctx, "rolled_back_files");
	const verdict = await startAndVerify(ctx, journal.units as UnitName[], {
		version: restartVersion,
		fingerprint: journal.fingerprint,
		oldSupervisor: { pid: null, startedAt: null },
	});
	if (verdict !== "ok")
		return fail("rollback_failed", { snapshotPath: journal.snapshot ?? undefined });
	journal.phase = "rolled_back";
	save(ctx, "rolled_back");
	return null;
}

function safeReadlink(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ commit

function commit(ctx: Ctx, version: string): void {
	const { deps } = ctx;
	const journal = ctx.journal as Journal;
	if (journal.bundleInstalled) flipCurrent(ctx.paths.updaterRoot, version);
	save(ctx, "current_flipped");
	for (const prefix of [
		ctx.sib.prefixes.retired,
		ctx.sib.prefixes.failed,
		ctx.sib.prefixes.staging,
	]) {
		for (const path of listSiblings(ctx.sib.parent, prefix)) removeTree(path);
	}
	pruneSnapshots(ctx.paths.snapshots, 2);
	pruneBundles(ctx, version);
	rewriteShimIfBunGone(ctx);
	journal.phase = "done";
	save(ctx, "done");
	deps.log.line("committed", { to: version });
}

function pruneBundles(ctx: Ctx, keepVersion: string): void {
	try {
		const current = safeReadlink(ctx.paths.updaterCurrent);
		const keep = new Set([keepVersion, current, ctx.journal?.from].filter((v): v is string => !!v));
		for (const name of readdirSync(ctx.paths.updaterRoot)) {
			if (name === "current" || keep.has(name)) continue;
			removeTree(join(ctx.paths.updaterRoot, name));
		}
	} catch {
		// nothing to prune
	}
}

/** Rewrites the shim (from the new tree's own renderer) only when the Bun it names no longer exists. */
function rewriteShimIfBunGone(ctx: Ctx): void {
	const { deps } = ctx;
	try {
		const text = readFileSync(ctx.paths.shim, "utf-8");
		const named = /^BUN_BIN='((?:[^']|'\\'')*)'$/m.exec(text)?.[1];
		if (named === undefined) return;
		const bun = named.replaceAll("'\\''", "'");
		if (existsSync(bun)) return;
		const rendered = Bun.spawnSync(
			[
				"bash",
				"-c",
				`source "$1" && ap_render_shim "$2" "$3"`,
				"_",
				join(ctx.app, "scripts", "lib", "shim.sh"),
				deps.bunBin,
				ctx.app,
			],
			{ stdout: "pipe", stderr: "ignore", env: { PATH: deps.env.PATH ?? "/usr/bin:/bin" } },
		);
		if (rendered.exitCode !== 0) return;
		writePrivateFileAtomicNoFollow(ctx.paths.shim, rendered.stdout.toString());
		chmodSync(ctx.paths.shim, 0o700);
	} catch {
		// the shim is a convenience
	}
}

// ------------------------------------------------------------------ recovery

/**
 * A journal is read back from a file only this account can write, but recovery renames and deletes what it names,
 * so it is judged first: versions must parse, every rename must be between the checkout's own sibling names,
 * and the snapshot and staged bundle must sit under the updater's own directories. Anything else is refused,
 * with nothing renamed or removed.
 */
function journalIsSafe(ctx: Ctx, journal: Journal): boolean {
	if (!parseReleaseVersion(journal.to) || !parseReleaseVersion(journal.from)) return false;
	if (journal.app !== ctx.app) return false;
	const allowed = new Set([
		ctx.app,
		ctx.sib.previous,
		ctx.sib.staging(journal.to),
		ctx.sib.failed(journal.to),
		ctx.sib.failed(journal.from),
	]);
	const retired = new RegExp(`^${escapeRegExp(`${ctx.app}.retired-`)}\\d{1,20}$`);
	const ok = (path: string) => allowed.has(path) || retired.test(path);
	if (!journal.ops.every((op) => ok(op.src) && ok(op.dst))) return false;
	const under = (path: string | null, root: string) =>
		path === null || (path.startsWith(`${root}/`) && !path.includes(".."));
	return (
		under(journal.snapshot, ctx.paths.snapshots) &&
		under(journal.stagedBundle, ctx.paths.updaterRoot)
	);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function recover(ctx: Ctx, read: JournalRead): Promise<UpdateResult | null> {
	if (read.kind === "unreadable") return fail("rollback_failed");
	if (read.kind !== "ok") return null;
	const journal = read.journal;
	if (!journalIsSafe(ctx, journal)) {
		ctx.deps.log.line("journal_refused", { phase: journal.phase });
		return fail("rollback_failed");
	}
	ctx.journal = journal;
	ctx.deps.log.line("recover", { phase: journal.phase, step: journal.step, to: journal.to });
	if (journal.phase === "preparing") {
		removeDrain(ctx);
		removeTree(ctx.sib.staging(journal.to));
		removeTree(`${ctx.paths.updaterRoot}/.staging-${journal.to}`);
		journal.phase = "rolled_back";
		save(ctx, "recover_cleaned");
		return null;
	}
	if (journal.phase === "verified") {
		commit(ctx, journal.to);
		return null;
	}
	// swapping / rolling_back: the previous copy goes back.
	const result = await rollbackFromJournal(ctx, journal.from);
	// An update that was cut short after the services were stopped is a failed update: its version is never
	// offered again (a crash loop of stop, swap, die, repeat would be downtime every time).
	recordOutcome(ctx.deps.home, {
		code: result ? result.code : "rolled_back",
		target: journal.to,
		at: ctx.deps.now(),
		refuse: journal.to,
	});
	return result;
}

function cleanupLeftovers(ctx: Ctx): void {
	const { deps } = ctx;
	for (const path of listSiblings(ctx.sib.parent, ctx.sib.prefixes.staging)) removeTree(path);
	for (const path of listSiblings(ctx.sib.parent, ctx.sib.prefixes.failed)) {
		if (isOlderThan(path, FAILED_TREE_MAX_AGE_MS, deps.now())) removeTree(path);
	}
	try {
		for (const name of readdirSync(ctx.paths.updaterRoot)) {
			if (name.startsWith(".staging-")) removeTree(join(ctx.paths.updaterRoot, name));
		}
	} catch {
		// no updater directory yet
	}
}

// ------------------------------------------------------------------ the manifest

async function loadManifest(
	ctx: Ctx,
): Promise<{ ok: true; manifest: Manifest } | { ok: false; code: UpdateOutcomeCode }> {
	const { deps } = ctx;
	const state = loadState(deps.home);
	const candidates: string[] = [];
	const fromServer = await healthOf(ctx, true);
	if (fromServer?.releaseManifest) candidates.push(fromServer.releaseManifest);
	const pages = await deps.fetchText(deps.manifestUrl, {
		deadlineMs: PAGES_DEADLINE_MS,
		maxBytes: PAGES_MANIFEST_MAX_BYTES,
		httpsOrLoopbackOnly: true,
	} satisfies CappedFetchOptions);
	if (pages.ok) candidates.push(pages.body);
	let stale = false;
	for (const text of candidates) {
		const verified = await verifyManifest(text, {
			keys: deps.keys,
			revoked: new Set(state.revoked),
			now: deps.now(),
			last: state.last,
		});
		if (!verified.ok) continue;
		recordVerified(deps.home, verified.next, verified.revoked);
		if (verified.stale) {
			stale = true;
			continue;
		}
		return { ok: true, manifest: verified.manifest };
	}
	return { ok: false, code: stale ? "stale" : "unverified" };
}

// ------------------------------------------------------------------ the update

/** Outcomes whose version is never offered again, besides the ones that roll back: the install was touched. */
const REFUSE_VERSION_CODES: ReadonlySet<UpdateOutcomeCode> = new Set<UpdateOutcomeCode>([
	"stop_failed",
	"snapshot_failed",
	"rollback_failed",
]);

/**
 * Records how a run ended, in one read-modify-write of the state file: the outcome, a version that is never to be
 * tried again, `waitingSince` and the backoff. Called inside the lock (and for the refusals that come before it),
 * so it can't interleave with another run's `recordVerified`. A run skipped by the backoff, one that found another
 * running, and a container or a cluster record nothing.
 */
function settle(
	deps: UpdaterDeps,
	options: UpdateOptions,
	result: UpdateResult,
	priorBackoff: UpdaterState["backoff"] | null | undefined,
): UpdateResult {
	if (["locked", "container", "kubernetes", "backoff"].includes(result.code)) return result;
	try {
		const before = loadState(deps.home);
		const prior = priorBackoff === undefined ? before.backoff : (priorBackoff ?? undefined);
		const success = result.code === "updated" || result.code === "up_to_date";
		const auto = options.mode === "auto";
		recordOutcome(deps.home, {
			code: result.code,
			target: result.to,
			at: deps.now(),
			...(REFUSE_VERSION_CODES.has(result.code) && result.to ? { refuse: result.to } : {}),
			// A scheduled run's "not yet" keeps its first time; anything else ends the wait. A person's own
			// successful run ends the wait and the failure streak too, whatever started them.
			...(auto
				? {
						waitingSince: isWaiting(result.code)
							? (before.waitingSince ?? new Date(deps.now()).toISOString())
							: null,
						backoff: nextBackoff(prior, result.code, deps.now()),
					}
				: success
					? { waitingSince: null, backoff: null }
					: {}),
		});
	} catch {
		// Best effort here: a scheduled run armed its backoff before it did anything risky, so a lost write
		// can't turn into a loop.
	}
	return result;
}

export async function runUpdate(deps: UpdaterDeps, options: UpdateOptions): Promise<UpdateResult> {
	const started = deps.now();
	// A scheduled run only ever takes the latest release forward: the flags that name a version, allow a
	// downgrade or lengthen the wait are a person's, whatever the caller passed.
	const effective: UpdateOptions = options.mode === "auto" ? { mode: "auto" } : options;
	const result = await runUpdateInner(deps, effective);
	deps.log.line("update", {
		code: result.code,
		from: result.from,
		to: result.to,
		reason: result.reason,
		mode: effective.mode,
		ms: deps.now() - started,
	});
	return result;
}

async function runUpdateInner(deps: UpdaterDeps, options: UpdateOptions): Promise<UpdateResult> {
	const paths = updaterPaths(deps.home);
	// What ends before the lock is taken (a wrong install) is recorded here; what ends inside it, inside it.
	const early = (code: UpdateOutcomeCode): UpdateResult =>
		settle(deps, options, fail(code), undefined);
	if (deps.platform === "win32") return early("no_service_manager");
	// What the process runs inside comes first: a container or a pod is never updated by this tool.
	const kind = deps.detectKind(deps.env, deps.cwd, deps.home);
	if (kind === "kubernetes") return early("kubernetes");
	if (kind === "container") return early("container");

	const record = readInstallRecord(deps.home);
	if (!record) return early("no_install_record");
	if (record.service === "none") return early("no_service_manager");
	if (record.track === "ref") return early("tracking_ref");
	if (!isCanonicalRepoUrl(record.repoUrl, deps.canonicalRepoUrl)) return early("fork_install");
	// The recorded path is a realpath. It may be missing right now (a crash between the two renames of a swap
	// leaves no `app`): recovery runs first and puts it back, so only a present path is judged here.
	const app = record.installDir;
	if (existsSync(app) && (isSymlink(app) || realpathSync(app) !== app)) {
		return early("symlinked_install");
	}

	const release = acquireLock(paths.lock, {
		now: deps.now,
		pid: deps.pid,
		identityOf: deps.identityOf,
		bootTimeMs: deps.bootTimeMs,
	});
	if (!release) return fail("locked");
	let crashed = false;
	try {
		const urls = serverUrls(record, app);
		const ctx: Ctx = {
			deps,
			paths,
			record,
			app,
			sib: appSiblings(app),
			components: record.components,
			serverBase: urls.base,
			serverFetchLoose: urls.loose,
			endpoint: urls.endpoint,
			journal: null,
			priorBackoff: undefined,
		};
		const done = (result: UpdateResult) => settle(deps, options, result, ctx.priorBackoff);
		mkdirSync(paths.dir, { recursive: true, mode: 0o700 });

		// 0. Recover first.
		const read = readJournal(paths.dir);
		if (needsRecovery(read)) {
			const recovered = await recover(ctx, read);
			if (recovered) return done(recovered);
		}
		if (!existsSync(app)) return done(fail("no_install_record"));
		cleanupLeftovers(ctx);
		ctx.journal = null;
		return done(await updateLocked(ctx, options));
	} catch (error) {
		if (error instanceof UpdaterCrash) {
			crashed = true;
			throw error;
		}
		throw error;
	} finally {
		if (!crashed) release();
	}
}

async function updateLocked(ctx: Ctx, options: UpdateOptions): Promise<UpdateResult> {
	const { deps, record, app } = ctx;
	const consent = readConsent(deps.home);

	// 3. Consent and window (automatic runs only).
	if (options.mode === "auto") {
		if (!consent.on) return fail("no_consent");
		if (!inWindow(consent.window, deps.now())) return fail("outside_window");
		if (backoffActive(loadState(deps.home), deps.now())) return fail("backoff");
	}

	const from = readVersionOf(app);
	if (!from) return fail("no_install_record");

	// 4. The signed manifest.
	const loaded = await loadManifest(ctx);
	if (!loaded.ok) return fail(loaded.code, { from });
	const { manifest } = loaded;

	// 5. The target.
	const supervisorOnly = !record.components.includes("server");
	let serverVersion: { value: string | null } | null = null;
	if (supervisorOnly) {
		const health = await healthOf(ctx);
		serverVersion = { value: health?.version ?? null };
	}
	const state = loadState(deps.home);
	const chosen = chooseTarget({
		manifest,
		installed: from,
		mode: options.mode,
		to: options.to,
		allowDowngrade: options.allowDowngrade,
		serverVersion,
		refused: state.refused,
		now: deps.now(),
	});
	if (!chosen.ok) return fail(chosen.code, { from });
	const release = chosen.release;
	const to = release.version;

	// 6. Dialect and the migration gate, before anything boots.
	const hasServer = record.components.includes("server");
	const units = (await deps.serviceManager.activeUnits()).filter((u) =>
		record.components.includes(u),
	);
	let health: HealthInfo | null = null;
	let migrates = false;
	let dialect: "sqlite" | "postgres" = "sqlite";
	if (hasServer) {
		if (units.includes("server")) {
			health = await healthOf(ctx);
			if (!health) return fail("health_failed", { from, to });
		}
		dialect = record.dialect === "sqlite" && health?.dialect === "sqlite" ? "sqlite" : "postgres";
		const installedSqlite = lastMigration(app, "sqlite");
		const installedPostgres = lastMigration(app, "postgres");
		migrates =
			dialect === "sqlite"
				? installedSqlite === null || installedSqlite !== release.migrations.sqlite
				: installedPostgres === null ||
					installedSqlite === null ||
					installedPostgres !== release.migrations.postgres ||
					installedSqlite !== release.migrations.sqlite;
		if (migrates && dialect === "postgres") return fail("postgres_migration", { from, to });
		if (migrates && options.mode === "auto" && !consent.allowMigrations) {
			return fail("migration_needs_consent", { from, to });
		}
	}

	// 7. Preflight.
	if (irregularEnvEntries(app).length > 0) return fail("untracked_files", { from, to });
	const clean = await checkTreeClean(stageDeps(deps), app, deps.canonicalRepoUrl);
	if (!clean.ok) return fail(clean.code, { from, to });
	if ((await deps.serviceManager.preflight()) !== "ok")
		return fail("no_service_manager", { from, to });
	{
		const dbBytes =
			record.sqlitePath && existsSync(record.sqlitePath) ? statSync(record.sqlitePath).size : 0;
		// Two trees beside the running one (the staged copy, and the kept previous copy), the failed copy a rollback keeps, and the database twice (smoke copy, snapshot).
		const need = 2 * dbBytes + 2.5 * deps.usageBytes(app);
		const free = deps.freeBytes(dirname(app));
		if (free !== null && free < need) return fail("disk_space", { from, to });
	}

	// The journal begins here: from now on a crash leaves enough to clean up.
	const journal: Journal = {
		schema: 1,
		phase: "preparing",
		step: "started",
		from,
		to,
		bundle: safeReadlink(ctx.paths.updaterCurrent)
			? join(ctx.paths.updaterCurrent, "updater.js")
			: null,
		units,
		snapshot: null,
		ops: [],
		done: 0,
		intent: -1,
		stagedBundle: null,
		bundleInstalled: false,
		envCopied: false,
		fingerprint: health?.dbFingerprint ?? null,
		app,
		startedAt: deps.now(),
	};
	ctx.journal = journal;
	save(ctx, "started");

	// 8. Stage.
	const staging = ctx.sib.staging(to);
	const stage = await fetchTarget(stageDeps(deps), {
		app,
		staging,
		remote: deps.canonicalRepoUrl,
		version: to,
		commit: release.commit,
		bunBin: record.bunBin,
		allowBackward: options.allowDowngrade === true,
	});
	if (!stage.ok) return abort(ctx, stage.code, { from, to }, to);
	// A person's downgrade must not put older code on a database it doesn't understand: the installed copy's
	// newest migration has to be one the target also has.
	if (options.allowDowngrade === true && hasServer) {
		const installedLast = lastMigration(app, "sqlite");
		if (installedLast !== null && !migrationTags(staging, "sqlite").includes(installedLast)) {
			return abort(ctx, "downgrade_schema", { from, to });
		}
	}
	// The manifest said whether this release migrates; the tree that was fetched says it too, and the two must
	// agree. A manifest that understates a migration would otherwise skip the consent gate and the snapshot.
	if (hasServer) {
		const stagedMigrates =
			dialect === "sqlite"
				? lastMigration(app, "sqlite") !== lastMigration(staging, "sqlite")
				: lastMigration(app, "postgres") !== lastMigration(staging, "postgres") ||
					lastMigration(app, "sqlite") !== lastMigration(staging, "sqlite");
		if (stagedMigrates !== migrates) {
			return abort(
				ctx,
				dialect === "postgres" && stagedMigrates ? "postgres_migration" : "migration_needs_consent",
				{ from, to },
				to,
			);
		}
	}
	const built = await buildStaged(stageDeps(deps), { staging, bunBin: record.bunBin });
	if (!built.ok)
		return abort(ctx, built.code, { from, to }, built.code === "build_failed" ? to : undefined);
	let stagedBundle: string | null = null;
	if (stage.hasUpdaterSource) {
		const outDir = join(ctx.paths.updaterRoot, `.staging-${to}`);
		mkdirSync(ctx.paths.updaterRoot, { recursive: true, mode: 0o700 });
		if (await bundleUpdater(stageDeps(deps), { staging, bunBin: record.bunBin, outDir }))
			stagedBundle = outDir;
	}
	journal.stagedBundle = stagedBundle;
	save(ctx, "staged");

	// 9. Smoke boot (SQLite only, and only with a server).
	if (hasServer && dialect === "sqlite" && record.sqlitePath) {
		const smoke = await deps.smokeBoot({
			stagingDir: staging,
			entry: deps.smokeEntry,
			bunBin: record.bunBin,
			sqlitePath: record.sqlitePath,
			targetVersion: to,
			parentEnv: deps.env,
			fetchText: deps.fetchText,
			timeoutMs: deps.timing.smokeMs,
			sleep: deps.sleep,
			now: deps.now,
		});
		if (!smoke.ok) return abort(ctx, "smoke_failed", { from, to }, to);
		save(ctx, "smoked");
	}

	// 10. The supervisor: wait for idle, then a short drain.
	const supervisorActive = units.includes("supervisor");
	let supervisorId: StatusId = { pid: null, startedAt: null };
	if (supervisorActive) {
		const maxWait =
			options.mode === "auto"
				? deps.timing.idleWaitAutoMs
				: options.wait
					? deps.timing.idleWaitLongMs
					: deps.timing.idleWaitManualMs;
		if (!(await waitForIdle(ctx, maxWait))) return abort(ctx, "supervisor_busy", { from, to });
		if (!(await drain(ctx))) {
			removeDrain(ctx);
			return abort(ctx, "drain_timeout", { from, to });
		}
		const status = readSupervisorStatus(deps.home);
		supervisorId = { pid: status?.pid ?? null, startedAt: status?.processStartedAt ?? null };
		save(ctx, "drained");
	}

	// 11. Stop. A scheduled run first looks at its consent once more (it may have been withdrawn while this one
	// staged and waited) and writes the failure it is about to risk: if that write fails it doesn't go on, and if
	// the process dies from here on, the next scheduled run finds the backoff already in place.
	if (options.mode === "auto") {
		if (!readConsent(deps.home).on) return abort(ctx, "no_consent", { from, to });
		const current = loadState(deps.home);
		try {
			saveBackoff(deps.home, nextBackoff(current.backoff, "health_failed", deps.now()));
		} catch {
			return abort(ctx, "install_failed", { from, to });
		}
		ctx.priorBackoff = current.backoff ?? null;
	}
	journal.phase = "swapping";
	save(ctx, "stopping");
	const stopped = await stopUnits(ctx, units, {
		server: ctx.endpoint.port,
		host: ctx.endpoint.host,
		supervisor: supervisorId,
	});
	removeDrain(ctx);
	if (!stopped) {
		const undone = await rollbackFromJournal(ctx, from);
		return undone ?? fail("stop_failed", { from, to });
	}
	save(ctx, "stopped");

	try {
		// 12. Snapshot (SQLite, and the target adds a migration).
		if (hasServer && dialect === "sqlite" && migrates && record.sqlitePath) {
			try {
				journal.snapshot = await takeSnapshot({
					sqlitePath: record.sqlitePath,
					dir: ctx.paths.snapshots,
					version: to,
					now: deps.now(),
					expectedFingerprint: health?.dbFingerprint ?? null,
				});
			} catch (error) {
				const code = error instanceof SnapshotError ? error.code : "snapshot_failed";
				const undone = await rollbackFromJournal(ctx, from);
				return undone ?? fail(code, { from, to });
			}
			save(ctx, "snapshot");
		}

		// 13. Swap.
		journal.ops = planSwap({
			app,
			previous: ctx.sib.previous,
			staging,
			retired: ctx.sib.retired(deps.now()),
		});
		save(ctx, "swap_planned");
		executeSwap(journal, (step) => save(ctx, step));
		const tracked = await deps.run(["git", "-C", app, "ls-files", "--", ".env*"], {
			cwd: app,
			env: gitEnv(deps.env, deps.home),
			timeoutMs: 60_000,
		});
		carryEnvFiles(
			ctx.sib.previous,
			app,
			new Set(tracked.stdout.split("\n").filter((n) => n !== "")),
		);
		journal.envCopied = true;
		save(ctx, "env_copied");
		if (journal.stagedBundle) {
			installBundle(ctx.paths.updaterRoot, journal.stagedBundle, to);
			journal.bundleInstalled = true;
			journal.stagedBundle = null;
			save(ctx, "bundle_installed");
		}

		// 14. Start and verify.
		const verdict = await startAndVerify(ctx, units, {
			version: to,
			fingerprint: health?.dbFingerprint ?? null,
			oldSupervisor: supervisorId,
		});
		save(ctx, "started_services");
		if (verdict !== "ok") {
			const undone = await rollbackFromJournal(ctx, from);
			if (undone) return { ...undone, from, to, reason: verdict };
			recordOutcome(deps.home, { code: "rolled_back", target: to, at: deps.now(), refuse: to });
			return fail("rolled_back", { from, to, reason: verdict });
		}
		journal.phase = "verified";
		save(ctx, "verified");
	} catch (error) {
		if (error instanceof UpdaterCrash) throw error;
		deps.log.line("swap_error", { to, error: error instanceof Error ? error.name : "error" });
		const undone = await rollbackFromJournal(ctx, from);
		if (undone) return { ...undone, from, to };
		recordOutcome(deps.home, { code: "rolled_back", target: to, at: deps.now(), refuse: to });
		return fail("rolled_back", { from, to, reason: "install_failed" });
	}

	// 15. Commit.
	commit(ctx, to);
	return { code: "updated", from, to, migrated: journal.snapshot !== null };
}

/** A failure before anything was stopped: the staged trees go, the journal is closed, a deterministic failure is remembered. */
function abort(
	ctx: Ctx,
	code: UpdateOutcomeCode,
	extra: Partial<UpdateResult>,
	refuseVersion?: string,
): UpdateResult {
	removeDrain(ctx);
	removeTree(ctx.sib.staging(ctx.journal?.to ?? ""));
	if (ctx.journal) {
		removeTree(join(ctx.paths.updaterRoot, `.staging-${ctx.journal.to}`));
		ctx.journal.phase = "rolled_back";
		save(ctx, "aborted");
	}
	if (refuseVersion)
		recordOutcome(ctx.deps.home, {
			code,
			target: refuseVersion,
			at: ctx.deps.now(),
			refuse: refuseVersion,
		});
	return fail(code, extra);
}

/**
 * Recovery on its own: finishes or undoes an update that didn't end (the same step every run starts with).
 * Returns null when there was nothing to do or the install was put back; a result only when it couldn't be.
 */
export async function runRecovery(deps: UpdaterDeps): Promise<UpdateResult | null> {
	const paths = updaterPaths(deps.home);
	const record = readInstallRecord(deps.home);
	if (!record) return fail("no_install_record");
	const app = record.installDir;
	const release = acquireLock(paths.lock, {
		now: deps.now,
		pid: deps.pid,
		identityOf: deps.identityOf,
		bootTimeMs: deps.bootTimeMs,
	});
	if (!release) return fail("locked");
	let crashed = false;
	try {
		const urls = serverUrls(record, app);
		const ctx: Ctx = {
			deps,
			paths,
			record,
			app,
			sib: appSiblings(app),
			components: record.components,
			serverBase: urls.base,
			serverFetchLoose: urls.loose,
			endpoint: urls.endpoint,
			journal: null,
			priorBackoff: undefined,
		};
		const read = readJournal(paths.dir);
		return needsRecovery(read) ? await recover(ctx, read) : null;
	} catch (error) {
		if (error instanceof UpdaterCrash) crashed = true;
		throw error;
	} finally {
		if (!crashed) release();
	}
}

// ------------------------------------------------------------------ rollback by hand

export async function runRollback(deps: UpdaterDeps): Promise<UpdateResult> {
	const paths = updaterPaths(deps.home);
	if (deps.platform === "win32") return fail("no_service_manager");
	const kind = deps.detectKind(deps.env, deps.cwd, deps.home);
	if (kind === "kubernetes") return fail("kubernetes");
	if (kind === "container") return fail("container");
	const record = readInstallRecord(deps.home);
	if (!record) return fail("no_install_record");
	if (record.service === "none") return fail("no_service_manager");
	const app = record.installDir;
	const release = acquireLock(paths.lock, {
		now: deps.now,
		pid: deps.pid,
		identityOf: deps.identityOf,
		bootTimeMs: deps.bootTimeMs,
	});
	if (!release) return fail("locked");
	let crashed = false;
	try {
		const urls = serverUrls(record, app);
		const ctx: Ctx = {
			deps,
			paths,
			record,
			app,
			sib: appSiblings(app),
			components: record.components,
			serverBase: urls.base,
			serverFetchLoose: urls.loose,
			endpoint: urls.endpoint,
			journal: null,
			priorBackoff: undefined,
		};
		const read = readJournal(paths.dir);
		if (needsRecovery(read)) {
			const recovered = await recover(ctx, read);
			if (recovered) return recovered;
		}
		return await rollbackByHand(ctx, read);
	} catch (error) {
		if (error instanceof UpdaterCrash) crashed = true;
		throw error;
	} finally {
		if (!crashed) release();
	}
}

async function rollbackByHand(ctx: Ctx, priorRead: JournalRead): Promise<UpdateResult> {
	const { deps, record, app } = ctx;
	if (!existsSync(ctx.sib.previous)) return fail("nothing_to_roll_back");
	const current = readVersionOf(app);
	const previous = readVersionOf(ctx.sib.previous);
	if (!current || !previous) return fail("nothing_to_roll_back");
	const lastDone = readJournal(ctx.paths.dir);
	const snapshot =
		lastDone.kind === "ok" && lastDone.journal.phase === "done" ? lastDone.journal.snapshot : null;
	const units = (await deps.serviceManager.activeUnits()).filter((u) =>
		record.components.includes(u),
	);
	const health = units.includes("server") ? await healthOf(ctx) : null;
	const status = readSupervisorStatus(deps.home);
	const journal: Journal = {
		schema: 1,
		phase: "swapping",
		step: "rollback_started",
		from: current,
		to: previous,
		bundle: null,
		units,
		snapshot: null,
		ops: [],
		done: 0,
		intent: -1,
		stagedBundle: null,
		bundleInstalled: false,
		envCopied: true,
		fingerprint: health?.dbFingerprint ?? null,
		app,
		startedAt: deps.now(),
	};
	ctx.journal = journal;
	save(ctx, "rollback_started");
	const supervisorId = { pid: status?.pid ?? null, startedAt: status?.processStartedAt ?? null };
	if (
		!(await stopUnits(ctx, units, {
			server: ctx.endpoint.port,
			host: ctx.endpoint.host,
			supervisor: supervisorId,
		}))
	) {
		const undone = await rollbackFromJournal(ctx, current);
		return undone ?? fail("stop_failed", { from: current, to: previous });
	}
	if (snapshot && existsSync(snapshot) && record.sqlitePath) {
		if (!restoreSnapshot(snapshot, record.sqlitePath)) {
			return fail("rollback_failed", { from: current, to: previous, snapshotPath: snapshot });
		}
		save(ctx, "snapshot_restored");
	}
	journal.ops = [
		{ src: app, dst: ctx.sib.failed(current) },
		{ src: ctx.sib.previous, dst: app },
	];
	removeTree(ctx.sib.failed(current));
	save(ctx, "swap_planned");
	executeSwap(journal, (step) => save(ctx, step));
	const verdict = await startAndVerify(ctx, units, {
		version: previous,
		fingerprint: snapshot ? null : (health?.dbFingerprint ?? null),
		oldSupervisor: supervisorId,
	});
	if (verdict !== "ok") return fail("rollback_failed", { from: current, to: previous });
	journal.phase = "done";
	save(ctx, "done");
	recordOutcome(deps.home, {
		code: "rolled_back",
		target: current,
		at: deps.now(),
		refuse: current,
	});
	void priorRead;
	return fail("rolled_back", { from: current, to: previous });
}

// ------------------------------------------------------------------ status

export interface UpdaterStatus {
	installed: string | null;
	track: "release" | "ref" | null;
	service: "launchd" | "systemd" | "none" | null;
	components: readonly InstallComponent[];
	autoOn: boolean;
	lastOutcome: UpdateOutcomeCode | null;
	lastTarget: string | null;
	at: string | null;
	refused: string[];
	/** While a failed automatic run is holding the next one back: not before this time. */
	backoffUntil: string | null;
	journalPhase: string | null;
	hasPrevious: boolean;
	bundle: string | null;
}

export function updaterStatus(deps: Pick<UpdaterDeps, "home" | "now">): UpdaterStatus {
	const paths = updaterPaths(deps.home);
	const record = readInstallRecord(deps.home);
	const state = loadState(deps.home);
	const journal = readJournal(paths.dir);
	return {
		installed: record ? readVersionOf(record.installDir) : null,
		track: record?.track ?? null,
		service: record?.service ?? null,
		components: record?.components ?? [],
		autoOn: readConsent(deps.home).on,
		lastOutcome: state.lastOutcome ?? null,
		lastTarget: state.lastTarget ?? null,
		at: state.at ?? null,
		refused: Object.keys(state.refused),
		backoffUntil:
			state.backoff && Date.parse(state.backoff.notBefore) > deps.now()
				? state.backoff.notBefore
				: null,
		journalPhase:
			journal.kind === "ok"
				? journal.journal.phase
				: journal.kind === "unreadable"
					? "unreadable"
					: null,
		hasPrevious: record ? existsSync(appSiblings(record.installDir).previous) : false,
		bundle: safeReadlink(paths.updaterCurrent),
	};
}
