/**
 * Guards around the default (process-wide) update checker: it never reads the developer's real home under
 * `bun test`, the off switch reaches it, nothing but the test factory hands `tls` to the capped fetch, and the
 * server's boot calls it. Source scans strip comments first, so a comment can neither satisfy nor trip them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { installProbeOverride, setInstallProbeForTests } from "./install-probe.js";
import { getUpdateStatus, setUpdateCheckerForTests } from "./update-check.js";

const root = new URL("../../..", import.meta.url).pathname;

/** Source text with `//` and block comments removed (strings containing `//` are left alone well enough here). */
function code(path: string): string {
	return readFileSync(join(root, path), "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(join(root, dir))) {
		const rel = `${dir}/${name}`;
		if (statSync(join(root, rel)).isDirectory()) {
			if (name !== "node_modules" && name !== "dist") sourceFiles(rel, out);
		} else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel);
	}
	return out;
}

afterEach(() => {
	setUpdateCheckerForTests(null);
	// biome-ignore lint/performance/noDelete: restoring an absent variable
	delete process.env.AGENTPULSE_UPDATE_CHECK;
});

describe("the default checker under bun test", () => {
	test("the preload installed a fixed install probe, so the real home is never probed", () => {
		const probe = installProbeOverride();
		expect(probe).not.toBeNull();
		expect(probe?.()).toEqual({ kind: "source", track: null });
	});

	test("its status reports the fixed probe, and a changed HOME with an install record doesn't change it", () => {
		setUpdateCheckerForTests(null);
		expect(getUpdateStatus()).toMatchObject({ installKind: "source", track: null });
	});

	test("the probe seam can be replaced and put back", () => {
		const saved = installProbeOverride();
		setInstallProbeForTests(() => ({ kind: "container", track: null }));
		setUpdateCheckerForTests(null);
		expect(getUpdateStatus().installKind).toBe("container");
		setInstallProbeForTests(saved);
		setUpdateCheckerForTests(null);
		expect(getUpdateStatus().installKind).toBe("source");
	});

	test("AGENTPULSE_UPDATE_CHECK=off makes the default checker report disabled, with no fetch", () => {
		process.env.AGENTPULSE_UPDATE_CHECK = "off";
		setUpdateCheckerForTests(null);
		const status = getUpdateStatus();
		expect(status.state).toBe("disabled");
		expect(status.latest).toBeNull();
	});
});

describe("source guards", () => {
	test("only capped-fetch.ts and the test factory in update-check.ts mention tls", () => {
		const hits = sourceFiles("src")
			.concat(sourceFiles("bin"), sourceFiles("packages/agentpulse-mcp/src"))
			.filter((file) => /\btls\s*:/.test(code(file)));
		expect(hits.sort()).toEqual([
			"src/server/services/update-check.ts",
			"src/shared/capped-fetch.ts",
		]);
		const text = code("src/server/services/update-check.ts");
		const factory = text.slice(text.indexOf("export function createHttpsManifestSourceForTests"));
		const before = text.slice(0, text.indexOf("export function createHttpsManifestSourceForTests"));
		expect(/\btls\s*:/.test(before)).toBe(false);
		expect(/\btls\s*:/.test(factory)).toBe(true);
	});

	test("server boot starts the check", () => {
		expect(code("src/server/index.ts")).toMatch(/\bstartUpdateCheck\s*\(\s*\)/);
	});

	test("the route module spawns nothing and imports nothing from the updater", () => {
		expect(code("src/server/routes/update.ts")).not.toMatch(
			/child_process|Bun\.spawn|spawnSync|updater\//,
		);
	});

	test("the comment stripper ignores a mention in a comment", () => {
		expect(code("src/server/routes/update.ts")).not.toContain("It only calls");
	});
});
