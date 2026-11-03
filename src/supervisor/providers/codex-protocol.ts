/**
 * The protocol gate (AGEN-87, D18). Whether a Codex binary's approval protocol is one this supervisor
 * knows how to answer is decided by the shape of the approval-relevant schema it generates, not by its
 * version string, so a Codex update that leaves those shapes alone doesn't turn approvals off. A shape
 * we haven't recorded, a version under the floor or on the blocked list, a version that can't be read, a
 * generator that fails, or a server reached over plain http from another machine all give "not
 * supported", and the runtime then declines every approval locally.
 */
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSupervisorConfig } from "../config.js";
import { credentialRejectionMayConfirm } from "../services/report-resilience.js";

export type ApprovalsVerdict = "supported" | "unsupported" | "insecure_transport";

/** `reason` is a fixed code, never text that came from the binary. */
export type Verdict = { verdict: ApprovalsVerdict; reason: string };

/** Which binary a verdict is about. */
export type CodexBinary = {
	path: string;
	version: string | null;
	size: number | null;
	mtimeMs: number | null;
};

/** Shapes read from a generated schema directory, ready to hash. */
export type ShapeInputs = {
	roots: Record<string, unknown>;
	fileChangeItem: unknown;
};

export type ShapeGenerator = (binary: CodexBinary) => Promise<ShapeInputs>;

export type CodexShape = { hash: string; measuredVersion: string };

/** Oldest Codex this supervisor will answer approvals for (the measured 0.163). */
export const CODEX_VERSION_FLOOR = { major: 0, minor: 163 } as const;
/** Versions known to misbehave on approvals, whatever their shape. One line to add to. */
export const BLOCKED_CODEX_VERSIONS: readonly string[] = [];
/**
 * Approval-protocol shapes recorded from a real Codex. The first is Codex 0.163.0, derived from the
 * schema subset committed under `__fixtures__/codex-0.163/schema` (`shape-hashes.json`'s `combined`).
 */
export const SUPPORTED_CODEX_SHAPES: readonly CodexShape[] = [
	{
		hash: "8db87f9d829f7aeac4c70d830d17566804d36963b74c2ce01a38da0441b2aafa",
		measuredVersion: "0.163.0",
	},
];

export const SCHEMA_GENERATOR_TIMEOUT_MS = 15_000;

export const SHAPE_ROOTS = [
	"CommandExecutionRequestApprovalParams.json",
	"CommandExecutionRequestApprovalResponse.json",
	"FileChangeRequestApprovalParams.json",
	"FileChangeRequestApprovalResponse.json",
	"v2/ServerRequestResolvedNotification.json",
	"v2/FileChangePatchUpdatedNotification.json",
] as const;

// ---- the one resolver ----

/**
 * The executable, its version and the server URL, read once from the supervisor's config. The spawn, the
 * generator and the verdict all use this, so they can't disagree about which binary they mean.
 */
export async function resolveCodex(): Promise<{ binary: CodexBinary; serverUrl: string }> {
	const config = await loadSupervisorConfig();
	const entry = config.capabilities.executables?.codex;
	const path = entry?.resolvedPath || config.codexCommand || "codex";
	let size: number | null = null;
	let mtimeMs: number | null = null;
	try {
		const info = await stat(path);
		size = info.size;
		mtimeMs = info.mtimeMs;
	} catch {
		// A bare command name or a missing file: the identity just has no size.
	}
	return {
		binary: { path, version: entry?.binaryVersion ?? null, size, mtimeMs },
		serverUrl: config.serverUrl,
	};
}

// ---- shape hashing ----

/** Sorted keys; descriptions dropped except inside a decision enum definition. */
function canonicalShape(node: unknown, inDecision = false, key = ""): unknown {
	if (Array.isArray(node)) return node.map((n) => canonicalShape(n, inDecision));
	if (!node || typeof node !== "object") return node;
	const record = node as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const k of Object.keys(record).sort()) {
		if (k === "description" && typeof record[k] === "string" && !inDecision) continue;
		out[k] = canonicalShape(
			record[k],
			inDecision || (/ApprovalDecision$/.test(k) && key === "definitions"),
			k,
		);
	}
	return out;
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** The combined fingerprint of the approval-relevant schema. */
export function shapeHash(inputs: ShapeInputs): string {
	const entries: Array<[string, string]> = [];
	for (const name of SHAPE_ROOTS) {
		if (!(name in inputs.roots)) throw new Error(`schema file missing: ${name}`);
		entries.push([name, sha256(JSON.stringify(canonicalShape(inputs.roots[name])))]);
	}
	entries.push([
		"FileChangeThreadItem",
		sha256(JSON.stringify(canonicalShape(inputs.fileChangeItem))),
	]);
	return sha256(JSON.stringify(entries));
}

/** The fileChange thread item and the definitions it reaches, cut from the v2 bundle. */
function cutFileChangeItem(bundle: any): unknown {
	const defs = bundle.definitions as Record<string, any>;
	const variant = defs.ThreadItem.oneOf.find(
		(v: any) => v.properties?.type?.enum?.[0] === "fileChange",
	);
	if (!variant) throw new Error("the schema has no fileChange thread item");
	const needed: Record<string, unknown> = {};
	const visit = (node: unknown) => {
		if (Array.isArray(node)) return node.forEach(visit);
		if (!node || typeof node !== "object") return;
		for (const [k, v] of Object.entries(node)) {
			if (k === "$ref" && typeof v === "string" && v.startsWith("#/definitions/")) {
				const name = v.slice("#/definitions/".length);
				if (!needed[name]) {
					needed[name] = defs[name];
					visit(defs[name]);
				}
			} else visit(v);
		}
	};
	visit(variant);
	return { ...variant, definitions: needed };
}

async function readRoots(dir: string): Promise<Record<string, unknown>> {
	const roots: Record<string, unknown> = {};
	for (const name of SHAPE_ROOTS) roots[name] = JSON.parse(await readFile(join(dir, name), "utf8"));
	return roots;
}

/** Inputs from the output of `codex app-server generate-json-schema --experimental`. */
export async function inputsFromGeneratedDir(dir: string): Promise<ShapeInputs> {
	const bundle = JSON.parse(
		await readFile(join(dir, "codex_app_server_protocol.v2.schemas.json"), "utf8"),
	);
	return { roots: await readRoots(dir), fileChangeItem: cutFileChangeItem(bundle) };
}

/** Inputs from the subset committed under `__fixtures__` (the fileChange item is already cut). */
export async function inputsFromCommittedSubset(dir: string): Promise<ShapeInputs> {
	return {
		roots: await readRoots(dir),
		fileChangeItem: JSON.parse(await readFile(join(dir, "FileChangeThreadItem.json"), "utf8")),
	};
}

/** Runs the real generator into a private temp directory. Needs no auth and no network (S18). */
export const runSchemaGenerator: ShapeGenerator = async (binary) => {
	const root = await mkdtemp(join(tmpdir(), "agentpulse-codex-schema-"));
	const out = join(root, "out");
	const home = join(root, "home");
	try {
		await mkdir(out);
		await mkdir(home);
		const proc = Bun.spawn({
			cmd: [binary.path, "app-server", "generate-json-schema", "--experimental", "--out", out],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			// Nothing of the user's: an empty home for both, so the generator reads and writes nothing of theirs.
			env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
		});
		const timer = setTimeout(() => proc.kill("SIGKILL"), SCHEMA_GENERATOR_TIMEOUT_MS);
		try {
			if ((await proc.exited) !== 0) throw new Error("schema generator failed");
		} finally {
			clearTimeout(timer);
		}
		return await inputsFromGeneratedDir(out);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

// ---- the verdict ----

export type VerdictDeps = {
	generator?: ShapeGenerator;
	generatorTimeoutMs?: number;
	blockedVersions?: readonly string[];
	supportedShapes?: readonly CodexShape[];
};

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)/;

function belowFloor(version: string): boolean {
	const match = VERSION_PATTERN.exec(version);
	if (!match) return true;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return (
		major < CODEX_VERSION_FLOOR.major ||
		(major === CODEX_VERSION_FLOOR.major && minor < CODEX_VERSION_FLOOR.minor)
	);
}

const identityKey = (b: CodexBinary) => `${b.path}|${b.version}|${b.size}|${b.mtimeMs}`;

/** The computed shape hash per binary identity; a failure is never remembered. */
const shapeCache = new Map<string, Promise<string>>();

/** Test hook: forget every computed shape. */
export function _resetProtocolCacheForTest(): void {
	shapeCache.clear();
}

async function shapeOf(
	binary: CodexBinary,
	generator: ShapeGenerator,
	timeoutMs: number,
): Promise<string> {
	const key = identityKey(binary);
	const cached = shapeCache.get(key);
	if (cached) return await cached;
	const computing = (async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("schema generator timed out")), timeoutMs);
		});
		try {
			return shapeHash(await Promise.race([generator(binary), timeout]));
		} finally {
			clearTimeout(timer);
		}
	})();
	shapeCache.set(key, computing);
	try {
		return await computing;
	} catch (error) {
		shapeCache.delete(key);
		throw error;
	}
}

async function judge(
	binary: CodexBinary,
	serverUrl: string | undefined,
	deps: VerdictDeps,
): Promise<Verdict> {
	if (!credentialRejectionMayConfirm(serverUrl)) {
		return { verdict: "insecure_transport", reason: "plain_http" };
	}
	if (!binary.version || !VERSION_PATTERN.test(binary.version)) {
		return { verdict: "unsupported", reason: "version_unknown" };
	}
	if (belowFloor(binary.version)) return { verdict: "unsupported", reason: "below_floor" };
	if ((deps.blockedVersions ?? BLOCKED_CODEX_VERSIONS).includes(binary.version)) {
		return { verdict: "unsupported", reason: "blocked_version" };
	}
	let hash: string;
	try {
		hash = await shapeOf(
			binary,
			deps.generator ?? runSchemaGenerator,
			deps.generatorTimeoutMs ?? SCHEMA_GENERATOR_TIMEOUT_MS,
		);
	} catch {
		return { verdict: "unsupported", reason: "generator_failed" };
	}
	const known = (deps.supportedShapes ?? SUPPORTED_CODEX_SHAPES).some((s) => s.hash === hash);
	return known
		? { verdict: "supported", reason: "ok" }
		: { verdict: "unsupported", reason: "shape_unknown" };
}

/** Never throws. */
export async function codexProtocolVerdict(
	binary: CodexBinary,
	serverUrl: string | undefined,
	deps: VerdictDeps = {},
): Promise<Verdict> {
	return await judge(binary, serverUrl, deps);
}

/** The version token of an `initialize` `userAgent` (`<client>/<version> (...)`), or null. */
export function userAgentVersion(userAgent: unknown): string | null {
	if (typeof userAgent !== "string") return null;
	const slash = userAgent.indexOf("/");
	if (slash === -1) return null;
	const rest = userAgent.slice(slash + 1);
	const space = rest.indexOf(" ");
	const token = space === -1 ? rest : rest.slice(0, space);
	return VERSION_PATTERN.test(token) && /^[0-9A-Za-z.+-]+$/.test(token) ? token : null;
}

/**
 * Ties a verdict to the process that answered `initialize`. When the version it reports isn't the one the
 * verdict was computed for (the file changed between the check and the spawn), the verdict is recomputed
 * for the reported version (a different identity, so the generator runs again), and that result stands. A version that
 * can't be read from the `userAgent` is never supported.
 */
export async function bindVerdictToUserAgent(
	verdict: Verdict,
	binary: CodexBinary,
	serverUrl: string | undefined,
	userAgent: unknown,
	deps: VerdictDeps = {},
): Promise<Verdict> {
	const reported = userAgentVersion(userAgent);
	if (!reported) return { verdict: "unsupported", reason: "useragent_unparseable" };
	if (reported === binary.version) return verdict;
	return await judge({ ...binary, version: reported }, serverUrl, deps);
}

/** Starts the computation at supervisor startup so it is normally ready by the first launch. */
export function warmCodexProtocolVerdict(deps: VerdictDeps = {}): void {
	void (async () => {
		const { binary, serverUrl } = await resolveCodex();
		await codexProtocolVerdict(binary, serverUrl, deps);
	})().catch(() => {});
}
