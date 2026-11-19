import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journal } from "./journal.js";
import {
	carryEnvFiles,
	effectiveDone,
	executeSwap,
	flipCurrent,
	installBundle,
	planSwap,
	undoSwap,
} from "./swap.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ap-swap-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dir = (name: string, marker: string) => {
	mkdirSync(join(root, name));
	writeFileSync(join(root, name, "which"), marker);
};
const which = (name: string) =>
	existsSync(join(root, name)) ? readFileSync(join(root, name, "which"), "utf-8") : null;
const layout = () => readdirSync(root).sort();

function journalFor(ops: Journal["ops"]): Journal {
	return {
		schema: 1,
		phase: "swapping",
		step: "x",
		from: "0.12.0",
		to: "0.13.0",
		bundle: null,
		units: [],
		snapshot: null,
		ops,
		done: 0,
		intent: -1,
		stagedBundle: null,
		bundleInstalled: false,
		envCopied: false,
		fingerprint: null,
		app: join(root, "app"),
		startedAt: 0,
	};
}
const paths = () => ({
	app: join(root, "app"),
	previous: join(root, "app.previous"),
	staging: join(root, "app.staging-0.13.0"),
	retired: join(root, "app.retired-1"),
});

describe("planSwap and executeSwap", () => {
	test("with a previous copy: retire it, move app aside, move the staged tree in", () => {
		dir("app", "current");
		dir("app.previous", "older");
		dir("app.staging-0.13.0", "new");
		const ops = planSwap(paths());
		expect(ops).toHaveLength(3);
		const j = journalFor(ops);
		const seen: string[] = [];
		executeSwap(j, (step) => void seen.push(step));
		expect(seen).toEqual([
			"rename_intent_0",
			"rename_done_0",
			"rename_intent_1",
			"rename_done_1",
			"rename_intent_2",
			"rename_done_2",
		]);
		expect(which("app")).toBe("new");
		expect(which("app.previous")).toBe("current");
		expect(which("app.retired-1")).toBe("older");
		expect(j.done).toBe(3);
		expect(j.intent).toBe(-1);
	});

	test("with no previous copy there are two renames", () => {
		dir("app", "current");
		dir("app.staging-0.13.0", "new");
		expect(planSwap(paths())).toHaveLength(2);
	});
});

describe("undoSwap", () => {
	function swapped() {
		dir("app", "current");
		dir("app.previous", "older");
		dir("app.staging-0.13.0", "new");
		const j = journalFor(planSwap(paths()));
		executeSwap(j, () => {});
		return j;
	}
	const original = ["app", "app.previous", "app.staging-0.13.0"];

	test("puts every directory back, last rename first", () => {
		const j = swapped();
		undoSwap(j, () => {});
		expect(layout()).toEqual(original);
		expect(which("app")).toBe("current");
		expect(which("app.previous")).toBe("older");
		expect(which("app.staging-0.13.0")).toBe("new");
	});

	test("can be run again after it was interrupted (each rename is checked first)", () => {
		const j = swapped();
		let n = 0;
		expect(() =>
			undoSwap(j, () => {
				if (++n === 1) throw new Error("crash after the first undo");
			}),
		).toThrow();
		// a fresh process re-reads the journal: it says how far the undo got
		undoSwap(j, () => {});
		expect(layout()).toEqual(original);
		// and a third time is a no-op
		undoSwap(j, () => {});
		expect(layout()).toEqual(original);
	});

	test("a journal that is older than the filesystem (the process died after a rename, before it wrote) is safe to undo from", () => {
		const j = swapped();
		const persisted = structuredClone(j);
		undoSwap(j, () => {});
		expect(layout()).toEqual(original);
		// the journal on disk still says all three renames are done, but they have all been undone already
		undoSwap(persisted, () => {});
		expect(layout()).toEqual(original);
		expect(which("app")).toBe("current");
	});

	test("the rename that was intended and did happen counts as done; one that didn't does not", () => {
		dir("app", "current");
		dir("app.staging-0.13.0", "new");
		const ops = planSwap(paths());
		// the process died between renaming app -> app.previous and writing `done`
		const j = journalFor(ops);
		j.intent = 0;
		renameSync(ops[0]?.src as string, ops[0]?.dst as string);
		expect(effectiveDone(j)).toBe(1);
		undoSwap(j, () => {});
		expect(which("app")).toBe("current");
		expect(layout()).toEqual(["app", "app.staging-0.13.0"]);

		// the intent was written and the process died before the rename
		const k = journalFor(planSwap(paths()));
		k.intent = 0;
		expect(effectiveDone(k)).toBe(0);
		undoSwap(k, () => {});
		expect(layout()).toEqual(["app", "app.staging-0.13.0"]);
	});
});

describe("carryEnvFiles", () => {
	test("copies every .env* file at the root byte for byte with its mode, and nothing else", () => {
		dir("old", "o");
		dir("new", "n");
		writeFileSync(join(root, "old", ".env.local"), "SECRET=abc\n", { mode: 0o600 });
		chmodSync(join(root, "old", ".env.local"), 0o600);
		writeFileSync(join(root, "old", ".env"), "A=1\n");
		chmodSync(join(root, "old", ".env"), 0o640);
		writeFileSync(join(root, "old", "other.txt"), "x");
		mkdirSync(join(root, "old", ".envdir"));
		mkdirSync(join(root, "old", "sub"));
		writeFileSync(join(root, "old", "sub", ".env"), "deep");
		symlinkSync(join(root, "old", "other.txt"), join(root, "old", ".env.link"));
		expect(carryEnvFiles(join(root, "old"), join(root, "new"))).toBe(2);
		expect(readFileSync(join(root, "new", ".env.local"), "utf-8")).toBe("SECRET=abc\n");
		expect(statSync(join(root, "new", ".env.local")).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "new", ".env")).mode & 0o777).toBe(0o640);
		expect(existsSync(join(root, "new", "other.txt"))).toBe(false);
		expect(existsSync(join(root, "new", "sub"))).toBe(false);
		expect(existsSync(join(root, "new", ".env.link"))).toBe(false);
		expect(existsSync(join(root, "new", ".envdir"))).toBe(false);
	});
});

describe("the updater bundle", () => {
	test("installBundle moves the staged directory in, replacing one that was there; flipCurrent replaces the link in one step", () => {
		const updater = join(root, "updater");
		mkdirSync(updater);
		mkdirSync(join(updater, ".staging-0.13.0"));
		writeFileSync(join(updater, ".staging-0.13.0", "updater.js"), "new");
		mkdirSync(join(updater, "0.13.0"));
		writeFileSync(join(updater, "0.13.0", "updater.js"), "stale");
		installBundle(updater, join(updater, ".staging-0.13.0"), "0.13.0");
		expect(readFileSync(join(updater, "0.13.0", "updater.js"), "utf-8")).toBe("new");
		expect(existsSync(join(updater, ".staging-0.13.0"))).toBe(false);

		symlinkSync("0.12.0", join(updater, "current"));
		flipCurrent(updater, "0.13.0");
		expect(readlinkSync(join(updater, "current"))).toBe("0.13.0");
		expect(readdirSync(updater).filter((n) => n.startsWith(".current"))).toEqual([]);
	});
});
