/**
 * AGEN-121: the MCP half of a fork's tool policy. The person's fork file becomes a private `--mcp-config` of
 * exactly its servers; the first `init` must name exactly those servers; a recovery refuses when the file's
 * servers or their digests are not what the fork was started with. Everything runs in a temporary directory:
 * the person's real `~/.agentpulse` is never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Harness, createHarness } from "../test-utils/claude-stream-harness.js";
import { CLAUDE_FIXTURE_DIR_2_1_319, outLines } from "./__fixtures__/claude-frames.js";
import { forkArgv, probeArgv } from "./claude-argv.js";
import { parseForkMcpText } from "./claude-fork-mcp-file.js";
import { ForkOptionsRefusal, configureForkMcp, mcpToolKind } from "./claude-fork-mcp.js";
import {
	claudeToolKind,
	forkToolPolicy,
	isAppliedMcpTool,
	prepareForkOptions,
} from "./claude-fork-tools.js";
import { _resetClaudeStreamForTest, disposeAllClaudeStreamRuntimes } from "./claude-stream.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const FORK = "22222222-2222-4222-8222-222222222222";
const VERSION = "2.1.319";

let home: string;
let dotDir: string;
const harnesses: Harness[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "fork-mcp-"));
	dotDir = join(home, ".agentpulse");
	mkdirSync(dotDir, { recursive: true });
	configureForkMcp({ agentpulseDir: dotDir });
});
afterEach(async () => {
	configureForkMcp(null);
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) h.cleanup();
	rmSync(home, { recursive: true, force: true });
});

const PROBE = { command: "node", args: ["probe.js"], env: { TOKEN: "secret-value" } };
const OTHER = { type: "http", url: "https://mcp.example.com/x" };

function writeFile(servers: Record<string, unknown>, mode = 0o600): string {
	const path = join(dotDir, "claude-fork-mcp.json");
	rmSync(path, { force: true });
	writeFileSync(path, JSON.stringify({ mcpServers: servers }), { mode });
	chmodSync(path, mode);
	return path;
}
const copies = () => {
	try {
		return readdirSync(join(dotDir, "claude-fork-mcp"));
	} catch {
		return [];
	}
};

describe("taking over with MCP", () => {
	test("applies exactly the file's servers: names and digests, a private 0600 copy in a 0700 directory, --strict-mcp-config kept", async () => {
		writeFile({ probe: PROBE, other: OTHER });
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });

		expect(prepared.applied.mcpServers.map((s) => s.name)).toEqual(["probe", "other"]);
		for (const server of prepared.applied.mcpServers)
			expect(server.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(prepared.applied.claudeVersion).toBe(VERSION);

		const path = prepared.policy.mcpConfigPath;
		expect(path).not.toBeNull();
		expect(path?.startsWith(join(dotDir, "claude-fork-mcp"))).toBe(true);
		expect(statSync(path as string).mode & 0o777).toBe(0o600);
		expect(statSync(join(dotDir, "claude-fork-mcp")).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(path as string, "utf8"))).toEqual({
			mcpServers: { probe: { type: "stdio", ...PROBE }, other: OTHER },
		});

		const argv = forkArgv({ source: SOURCE, fork: FORK, mode: "ask", policy: prepared.policy });
		expect(argv).toContain("--strict-mcp-config");
		expect(argv[argv.indexOf("--mcp-config") + 1]).toBe(path as string);
		await prepared.cleanup();
	});

	test("the login probe never gets --mcp-config, so no user server starts during a probe", async () => {
		writeFile({ probe: PROBE });
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		const probe = probeArgv({ mode: "ask", policy: prepared.policy });
		expect(probe).toContain("--strict-mcp-config");
		expect(probe).not.toContain("--mcp-config");
		await prepared.cleanup();
	});

	test("the cleanup removes the copy, and does so once", async () => {
		writeFile({ probe: PROBE });
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		expect(copies()).toHaveLength(1);
		await prepared.cleanup();
		expect(copies()).toEqual([]);
		await prepared.cleanup();
	});

	test("two forks hold two copies, and ending one leaves the other", async () => {
		writeFile({ probe: PROBE });
		const a = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		const b = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		expect(a.policy.mcpConfigPath).not.toBe(b.policy.mcpConfigPath);
		await a.cleanup();
		expect(existsSync(b.policy.mcpConfigPath as string)).toBe(true);
		await b.cleanup();
		expect(copies()).toEqual([]);
	});

	test("nothing is asked for, nothing is applied: no read, no copy", async () => {
		writeFile({ probe: PROBE });
		for (const asked of [undefined, {}, { mcp: false }, { subagents: true }]) {
			const prepared = await prepareForkOptions(asked, { claudeVersion: VERSION });
			expect(prepared.applied.mcpServers).toEqual([]);
			expect(prepared.policy.mcpConfigPath).toBeNull();
		}
		expect(copies()).toEqual([]);
	});

	test("an unmeasured Claude Code version applies nothing and writes nothing", async () => {
		writeFile({ probe: PROBE });
		for (const claudeVersion of ["2.1.318", "2.2.0", "", null]) {
			const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion });
			expect(prepared.applied.mcpServers, String(claudeVersion)).toEqual([]);
		}
		expect(copies()).toEqual([]);
	});

	test("a missing, unsafe or invalid file applies nothing, and the log carries a fixed word, never the file", async () => {
		const lines: string[] = [];
		const asked = () =>
			prepareForkOptions({ mcp: true }, { claudeVersion: VERSION, log: (l) => lines.push(l) });

		expect((await asked()).applied.mcpServers).toEqual([]);
		writeFile({ probe: PROBE }, 0o644);
		expect((await asked()).applied.mcpServers).toEqual([]);
		writeFile({ bad_name: PROBE });
		expect((await asked()).applied.mcpServers).toEqual([]);
		writeFile({ good: PROBE, bad: { command: "" } });
		expect((await asked()).applied.mcpServers).toEqual([]);
		writeFile({});
		expect((await asked()).applied.mcpServers).toEqual([]);

		expect(copies()).toEqual([]);
		expect(lines.length).toBeGreaterThanOrEqual(4);
		expect(lines.join("\n")).not.toContain("secret-value");
		expect(lines.join("\n")).not.toContain("probe.js");
	});

	test("a host that was never told where the file is applies nothing", async () => {
		writeFile({ probe: PROBE });
		configureForkMcp(null);
		expect(
			(await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION })).applied.mcpServers,
		).toEqual([]);
	});

	test("a copy left by a crash is swept after a day; a recent one and one this process holds are not", async () => {
		writeFile({ probe: PROBE });
		const live = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		const dir = join(dotDir, "claude-fork-mcp");
		const old = join(dir, "old.json");
		const recent = join(dir, "recent.json");
		writeFileSync(old, "{}", { mode: 0o600 });
		writeFileSync(recent, "{}", { mode: 0o600 });
		const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
		utimesSync(old, twoDaysAgo, twoDaysAgo);
		utimesSync(live.policy.mcpConfigPath as string, twoDaysAgo, twoDaysAgo);

		const next = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		expect(existsSync(old)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(live.policy.mcpConfigPath as string)).toBe(true);
		await live.cleanup();
		await next.cleanup();
	});
});

describe("recovering a fork that was started with MCP", () => {
	const stored = (names: Record<string, unknown>) => {
		const parsed = parseForkMcpText(JSON.stringify({ mcpServers: names }));
		if (!parsed.ok) throw new Error("fixture file is invalid");
		return {
			mcpServers: parsed.servers.map((s) => ({ name: s.name, digest: s.digest })),
			subagents: false,
			claudeVersion: VERSION,
		};
	};
	const recover = (applied: ReturnType<typeof stored>) =>
		prepareForkOptions({ mcp: true }, { claudeVersion: VERSION, stored: applied });

	test("the same file starts the same servers again", async () => {
		writeFile({ probe: PROBE, other: OTHER });
		const again = await recover(stored({ probe: PROBE, other: OTHER }));
		expect(again.applied.mcpServers.map((s) => s.name).sort()).toEqual(["other", "probe"]);
		expect(again.policy.mcpConfigPath).not.toBeNull();
		await again.cleanup();
	});

	test("the same servers in another order, spelled another way, are the same servers", async () => {
		writeFile({
			other: OTHER,
			probe: { type: "stdio", env: PROBE.env, args: PROBE.args, command: "node" },
		});
		const again = await recover(stored({ probe: PROBE, other: OTHER }));
		expect(again.applied.mcpServers).toHaveLength(2);
		await again.cleanup();
	});

	for (const [what, change] of [
		["a server's command was edited", () => writeFile({ probe: { ...PROBE, command: "evil" } })],
		[
			"a server's argument was edited",
			() => writeFile({ probe: { ...PROBE, args: ["other.js"] } }),
		],
		["a server's env was edited", () => writeFile({ probe: { ...PROBE, env: { TOKEN: "x" } } })],
		["a server was added", () => writeFile({ probe: PROBE, extra: OTHER })],
		["a server was removed", () => writeFile({})],
		["one server was replaced by another", () => writeFile({ renamed: PROBE })],
		["the file was deleted", () => rmSync(join(dotDir, "claude-fork-mcp.json"))],
		["the file's mode was loosened", () => writeFile({ probe: PROBE }, 0o644)],
		[
			"the file was broken",
			() => writeFileSync(join(dotDir, "claude-fork-mcp.json"), "{", { mode: 0o600 }),
		],
	] as const) {
		test(`${what}: refused mcp_servers_changed, nothing written`, async () => {
			writeFile({ probe: PROBE });
			const applied = stored({ probe: PROBE });
			change();
			await expect(recover(applied)).rejects.toBeInstanceOf(ForkOptionsRefusal);
			await expect(recover(applied)).rejects.toMatchObject({ kind: "mcp_servers_changed" });
			expect(copies()).toEqual([]);
		});
	}

	test("a host that doesn't know where the file is refuses too: it can't prove the servers are unchanged", async () => {
		writeFile({ probe: PROBE });
		const applied = stored({ probe: PROBE });
		configureForkMcp(null);
		await expect(recover(applied)).rejects.toBeInstanceOf(ForkOptionsRefusal);
	});

	test("a fork started without MCP recovers without reading the file", async () => {
		writeFile({ probe: PROBE }, 0o644);
		const prepared = await prepareForkOptions(
			{},
			{
				claudeVersion: VERSION,
				stored: { mcpServers: [], subagents: false, claudeVersion: VERSION },
			},
		);
		expect(prepared.applied.mcpServers).toEqual([]);
	});

	test("the error says nothing of the file's contents", async () => {
		writeFile({ probe: PROBE });
		const applied = stored({ probe: PROBE });
		writeFile({ probe: { ...PROBE, command: "secret-command" } });
		const error = await recover(applied).catch((e: Error) => e);
		expect(String((error as Error).message)).not.toContain("secret-command");
		expect(String((error as Error).message)).not.toContain("secret-value");
	});
});

describe("the first init must match what was applied", () => {
	const recorded = () => {
		const init = outLines("m1-base-key", CLAUDE_FIXTURE_DIR_2_1_319).find(
			(m) => m.type === "system" && m.subtype === "init",
		);
		if (!init) throw new Error("fixture has no init");
		return init as Record<string, unknown>;
	};
	const applied = (...names: string[]) => ({
		mcpServers: names.map((name) => ({ name, digest: "a".repeat(64) })),
		subagents: false,
		claudeVersion: VERSION,
	});

	const policyFor = async (...names: string[]) => {
		writeFile(Object.fromEntries(names.map((n) => [n, PROBE])));
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		return prepared;
	};

	test("the recorded init of a fork with the `probe` server passes the MCP policy, and fails the policy without options", async () => {
		const prepared = await policyFor("probe");
		expect(prepared.policy.initToolsProblem(recorded())).toBeNull();
		expect(forkToolPolicy().initToolsProblem(recorded())).not.toBeNull();
		await prepared.cleanup();
	});

	test("a server that failed to connect is fine, with or without its tools listed", async () => {
		const prepared = await policyFor("probe");
		const init = recorded();
		const failed = {
			...init,
			mcp_servers: [{ name: "probe", status: "failed", source: "dynamic" }],
			tools: (init.tools as string[]).filter((t) => !t.startsWith("mcp__")),
		};
		expect(prepared.policy.initToolsProblem(failed)).toBeNull();
		await prepared.cleanup();
	});

	test("a server that wasn't applied (a plugin, a synced connector, a user-scope server) kills the fork", async () => {
		const prepared = await policyFor("probe");
		const init = recorded();
		for (const extra of [
			{ name: "plugin:p:srv", status: "connected", source: "plugin" },
			{ name: "claude.ai Gmail", status: "connected", source: "claudeai" },
			{ name: "userscope", status: "connected", source: "user" },
		]) {
			const problem = prepared.policy.initToolsProblem({
				...init,
				mcp_servers: [...(init.mcp_servers as unknown[]), extra],
			});
			expect(problem, extra.name).toBe("mcp_servers");
		}
		await prepared.cleanup();
	});

	test("an applied server that is missing from init, or init with no list at all, kills the fork", async () => {
		const prepared = await policyFor("probe", "second");
		const init = recorded();
		expect(prepared.policy.initToolsProblem(init)).toBe("mcp_servers");
		expect(prepared.policy.initToolsProblem({ ...init, mcp_servers: undefined })).toBe(
			"mcp_servers",
		);
		expect(prepared.policy.initToolsProblem({ ...init, mcp_servers: "probe" })).toBe("mcp_servers");
		await prepared.cleanup();
	});

	test("an mcp__ tool of a server that wasn't applied, a malformed one, or a duplicate kills the fork", async () => {
		const prepared = await policyFor("probe");
		const init = recorded();
		const tools = init.tools as string[];
		for (const bad of [
			"mcp__other__echo",
			"mcp__probe_echo",
			"mcp__probe__",
			`mcp__probe__${"x".repeat(60)}`,
			tools.find((t) => t.startsWith("mcp__")),
		]) {
			expect(
				prepared.policy.initToolsProblem({ ...init, tools: [...tools, bad] }),
				String(bad),
			).toBe("mcp_servers");
		}
		await prepared.cleanup();
	});

	test("the six built-in tools are still exactly the six: an extra or a missing one is a tools problem", async () => {
		const prepared = await policyFor("probe");
		const init = recorded();
		const tools = init.tools as string[];
		expect(prepared.policy.initToolsProblem({ ...init, tools: [...tools, "Agent"] })).toBe("tools");
		expect(
			prepared.policy.initToolsProblem({ ...init, tools: tools.filter((t) => t !== "Bash") }),
		).toBe("tools");
		expect(prepared.policy.initToolsProblem({ ...init, tools: "Bash" })).toBe("tools");
		await prepared.cleanup();
	});

	test("with no MCP the policy is the one shipped before: an mcp__ tool in init is a problem", () => {
		const init = recorded();
		expect(forkToolPolicy().initToolsProblem({ ...init, mcp_servers: [] })).toBe("tools");
		expect(applied().mcpServers).toEqual([]);
	});

	test("a fork whose Claude names no server is ended at its first prompt (the stream applies the policy)", async () => {
		writeFile({ probe: PROBE });
		const prepared = await prepareForkOptions({ mcp: true }, { claudeVersion: VERSION });
		const h = createHarness({ turns: [[{ say: { type: "system", subtype: "init" } }]] });
		harnesses.push(h);
		const rt = await h.start({ policy: prepared.policy, cleanup: prepared.cleanup });
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "a0");
		const outcome = await sent.done;
		expect(outcome.ok).toBe(false);
		await rt.dispose({ interruptMs: 0, stdinCloseMs: 300, termMs: 300, killMs: 300 });
		// The copy goes when the fork does.
		expect(copies()).toEqual([]);
	});
});

describe("which tool names are MCP tools", () => {
	const applied = {
		mcpServers: [
			{ name: "probe", digest: "a".repeat(64) },
			{ name: "a-b", digest: "b".repeat(64) },
		],
		subagents: false,
		claudeVersion: VERSION,
	};

	test("only mcp__<applied server>__<tool>", () => {
		for (const name of ["mcp__probe__echo", "mcp__a-b__x_y-z", "mcp__probe___lead"]) {
			expect(mcpToolKind(name, applied), name).toBe("mcp");
			expect(claudeToolKind(name, applied), name).toBe("mcp");
		}
		for (const name of [
			"mcp__other__echo",
			"mcp__pro__be__echo",
			"mcp__probe__",
			"mcp__probe",
			"mcp__probe__has space",
			"mcp__probe__é",
			"MCP__probe__x",
			`mcp__probe__${"x".repeat(60)}`,
			"Bash__probe__x",
		]) {
			expect(mcpToolKind(name, applied), name).toBeNull();
		}
	});

	test("without applied servers nothing is an MCP tool, and the six are still the six", () => {
		expect(claudeToolKind("mcp__probe__echo")).toBeNull();
		expect(claudeToolKind("Bash")).toBe("Bash");
		expect(isAppliedMcpTool("mcp__probe__echo", { ...applied, mcpServers: [] })).toBe(false);
	});
});
