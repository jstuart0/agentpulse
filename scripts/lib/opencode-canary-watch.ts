/**
 * What a canary watches around its runs (AGEN-141, phase 0): the person's real directories before and after,
 * the launchd labels, and the sockets of its own pids. Read-only except `bootoutOwnLabels`, which acts only on
 * a label whose plist is inside scratch.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Stats, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { forbiddenPaths } from "./opencode-canary-safety.js";
import { inside } from "./throwaway-home.js";

/** `path -> "type size mtimeMs"` for a tree; a path that doesn't exist maps to nothing (so absence is a state). */
export type TreeSnapshot = Map<string, string>;

function describe(st: Stats): string {
	const type = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f";
	return `${type} ${st.size} ${Math.trunc(st.mtimeMs)}`;
}

/** Entries of the person's live directories that churn on their own (this session, the supervisor, the relay). */
const LIVE_CHURN: Record<string, readonly string[]> = {
	".claude": [
		"projects",
		"shell-snapshots",
		"todos",
		"sessions",
		"session-env",
		"file-history",
		"history.jsonl",
		"statsig",
		"debug",
		"telemetry",
		"plans",
		"tasks",
		"cache",
		"backups",
		"paste-cache",
		"ide",
		"agent-memory",
		"conversations",
		"mozart-overlay",
		"plugins",
		"settings.local.json",
		".credentials.json",
		"stats-cache.json",
		"image-cache",
		"teams",
		"usage-data",
		"remote-agent-tasks",
	],
	".codex": ["sessions", "log", "history.jsonl", "state_5.sqlite", "logs_2.sqlite", "cache", "tmp"],
	".agentpulse": ["hook-queue", "logs", "supervisor-outbox", "supervisor-exclude-state.json"],
};

/**
 * Walks `root` (never following links). `ignore` names top-level entries to leave out. A tree that doesn't
 * exist yields an empty map.
 */
export function snapshotTree(root: string, ignore: readonly string[] = []): TreeSnapshot {
	const out: TreeSnapshot = new Map();
	const walk = (dir: string, depth: number) => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of names) {
			if (depth === 0 && ignore.includes(name)) continue;
			const path = join(dir, name);
			let st: Stats;
			try {
				st = lstatSync(path);
			} catch {
				continue;
			}
			out.set(path, describe(st));
			if (st.isDirectory()) walk(path, depth + 1);
		}
	};
	try {
		// The root's own mtime moves whenever anything inside is renamed into place; only its existence counts.
		out.set(root, lstatSync(root).isDirectory() ? "d" : "f");
	} catch {
		return out;
	}
	walk(root, 0);
	return out;
}

export interface RealStateSnapshot {
	/** The four OpenCode directories, compared whole (they must not exist). */
	opencode: Map<string, TreeSnapshot>;
	/**
	 * The files a canary must never move, hashed: the exclude rules, the gate script, the hook key file, and the
	 * other agents' settings and hook files.
	 */
	pinned: Map<string, string>;
	/** Every entry under the other agents' homes whose own name says opencode: the same set before and after. */
	named: TreeSnapshot;
	/**
	 * The other agents' homes, walked with their own churn left out. A person who runs Claude, Codex and a
	 * supervisor at the same time changes these without us, so a difference here is reported, never a failure.
	 */
	others: Map<string, TreeSnapshot>;
}

const PINNED_FILES = [
	".agentpulse/exclude",
	".agentpulse/exclude.invalid",
	".agentpulse/exclude-check.sh",
	".agentpulse/hook-auth-header",
	".claude/settings.json",
	".codex/config.toml",
	".codex/hooks.json",
];

function hashOf(path: string): string {
	try {
		const st = lstatSync(path);
		if (!st.isFile()) return `not-a-file ${st.isSymbolicLink() ? "link" : "other"}`;
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
}

export function snapshotRealState(realHome: string): RealStateSnapshot {
	const opencode = new Map<string, TreeSnapshot>();
	for (const path of forbiddenPaths(realHome).filter((p) => /opencode$/.test(p))) {
		opencode.set(path, snapshotTree(path));
	}
	const pinned = new Map<string, string>();
	for (const file of PINNED_FILES) pinned.set(join(realHome, file), hashOf(join(realHome, file)));
	const others = new Map<string, TreeSnapshot>();
	const named: TreeSnapshot = new Map();
	for (const [name, ignore] of Object.entries(LIVE_CHURN)) {
		const root = join(realHome, name);
		const tree = snapshotTree(root, ignore);
		others.set(root, tree);
	}
	// An entry whose own name says opencode anywhere in the homes, churn or not (existence only: a transcript
	// directory of this very campaign is named for it and its contents move as the session writes).
	for (const name of Object.keys(LIVE_CHURN)) {
		for (const path of snapshotTree(join(realHome, name)).keys()) {
			if (/opencode/i.test(basename(path))) named.set(path, "exists");
		}
	}
	return { opencode, pinned, named, others };
}

export function diffTrees(before: TreeSnapshot, after: TreeSnapshot): string[] {
	const changes: string[] = [];
	for (const [path, state] of after) {
		const was = before.get(path);
		if (was === undefined) changes.push(`added ${path}`);
		else if (was !== state) changes.push(`changed ${path}: ${was} -> ${state}`);
	}
	for (const path of before.keys()) if (!after.has(path)) changes.push(`removed ${path}`);
	return changes;
}

export interface RealStateDiff {
	/** The run touched what it must never touch: the run fails. */
	failures: string[];
	/** Other agents moved their own files meanwhile: reported, not attributable to this run. */
	informational: string[];
}

export function diffRealState(before: RealStateSnapshot, after: RealStateSnapshot): RealStateDiff {
	const failures: string[] = [];
	for (const [root, was] of before.opencode) {
		failures.push(...diffTrees(was, after.opencode.get(root) ?? new Map()));
	}
	for (const [path, hash] of before.pinned) {
		if (after.pinned.get(path) !== hash) failures.push(`pinned file changed ${path}`);
	}
	failures.push(...diffTrees(before.named, after.named));
	const informational: string[] = [];
	for (const [root, was] of before.others) {
		informational.push(...diffTrees(was, after.others.get(root) ?? new Map()));
	}
	return { failures, informational };
}

export const gui = (): string => `gui/${process.getuid?.() ?? 0}`;

/** Registered launchd labels containing `opencode` (case-insensitive), from `launchctl print gui/<uid>`. */
export function opencodeLaunchdLabels(): string[] {
	const result = spawnSync("launchctl", ["print", gui()], {
		encoding: "utf8",
		maxBuffer: 64 << 20,
	});
	const labels = new Set<string>();
	for (const line of result.stdout.split("\n")) {
		if (!/opencode/i.test(line)) continue;
		// Service lines look like `    12345  0  application.com.example` or `  "label" = ...`.
		for (const token of line.split(/\s+/)) {
			if (/opencode/i.test(token) && !token.startsWith("/")) {
				labels.add(token.replace(/^"|"$|=$/g, ""));
			}
		}
	}
	return [...labels].sort();
}

/** Every label in the `services = { ... }` block of `launchctl print gui/<uid>` (pid, status and label per line). */
export function launchdServiceLabels(): Set<string> {
	const text = spawnSync("launchctl", ["print", gui()], {
		encoding: "utf8",
		maxBuffer: 64 << 20,
	}).stdout;
	const labels = new Set<string>();
	let inside = false;
	for (const line of text.split("\n")) {
		if (/^\tservices = \{/.test(line)) inside = true;
		else if (inside && /^\t\}/.test(line)) break;
		else if (inside) {
			const label = line.trim().split(/\s+/).pop();
			if (label) labels.add(label);
		}
	}
	return labels;
}

/** Labels added and removed between two reads. Other apps start and stop their own, so this is a record, not a verdict. */
export function diffLabels(before: ReadonlySet<string>, after: ReadonlySet<string>) {
	return {
		added: [...after].filter((l) => !before.has(l)).sort(),
		removed: [...before].filter((l) => !after.has(l)).sort(),
	};
}

/** The plist path launchd holds for a label, or null. */
export function plistPathOf(label: string): string | null {
	const r = spawnSync("launchctl", ["print", `${gui()}/${label}`], { encoding: "utf8" });
	const m = /^\s*path = (.+)$/m.exec(r.stdout);
	return m?.[1]?.trim() ?? null;
}

/** Boots out a label only when its plist is inside scratch. Returns what was done, for the record. */
export function bootoutOwnLabels(labels: readonly string[], scratchRoot: string): string[] {
	const report: string[] = [];
	for (const label of labels) {
		const plist = plistPathOf(label);
		if (plist && inside(scratchRoot, plist)) {
			spawnSync("launchctl", ["bootout", `${gui()}/${label}`], { encoding: "utf8" });
			report.push(`booted out ${label}`);
		} else {
			report.push(`left ${label} alone (plist ${plist ?? "unknown"} is not in scratch)`);
		}
	}
	return report;
}

/** TCP sockets of `pids` whose peer is not loopback. `lsof -a -i -nP -p <pids>`. */
export function nonLoopbackPeers(pids: readonly number[]): string[] {
	if (pids.length === 0) return [];
	const r = spawnSync("lsof", ["-a", "-i", "-nP", "-p", pids.join(",")], { encoding: "utf8" });
	const bad: string[] = [];
	for (const line of r.stdout.split("\n").slice(1)) {
		const m = /->([^\s:]+(?::\d+)?)(?:\s|\()/.exec(line) ?? /->(\[[^\]]+\]:\d+)/.exec(line);
		if (!m) continue;
		const host = (m[1] ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") bad.push(line.trim());
	}
	return bad;
}
