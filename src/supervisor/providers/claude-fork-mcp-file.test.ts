/**
 * AGEN-121: the person's fork MCP file. Each trust rule and each shape rule is a refusal of the whole file; the
 * digests don't depend on how the person spelled a server. Every test runs in a temporary directory: the
 * person's real `~/.agentpulse` is never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	canonicalJson,
	parseForkMcpText,
	privateConfigText,
	readForkMcpFile,
	serverDigest,
} from "./claude-fork-mcp-file.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fork-mcp-file-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const STDIO = { command: "node", args: ["server.js"], env: { TOKEN: "x" } };
const file = (mcpServers: unknown) => JSON.stringify({ mcpServers });

function write(text: string, mode = 0o600): string {
	const path = join(dir, "claude-fork-mcp.json");
	rmSync(path, { force: true });
	writeFileSync(path, text, { mode });
	chmodSync(path, mode);
	return path;
}

describe("the trust checks", () => {
	test("a plain 0600 file owned by this account is read", () => {
		const result = readForkMcpFile(write(file({ probe: STDIO })));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.servers.map((s) => s.name)).toEqual(["probe"]);
			expect(result.servers[0]?.config).toEqual({ type: "stdio", ...STDIO });
		}
	});

	test("no file is `missing`", () => {
		expect(readForkMcpFile(join(dir, "nope.json"))).toEqual({ ok: false, problem: "missing" });
	});

	test("a link in place of the file is refused, even one that points at a good file", () => {
		const real = join(dir, "real.json");
		writeFileSync(real, file({ probe: STDIO }), { mode: 0o600 });
		const link = join(dir, "link.json");
		symlinkSync(real, link);
		expect(readForkMcpFile(link)).toEqual({ ok: false, problem: "not_plain_file" });
	});

	test("a directory is refused", () => {
		const sub = join(dir, "d");
		mkdirSync(sub);
		expect(readForkMcpFile(sub).ok).toBe(false);
	});

	test("any mode but 0600 is refused: group- or world-readable, and also read-only", () => {
		for (const mode of [0o644, 0o640, 0o660, 0o666, 0o400, 0o700]) {
			expect(readForkMcpFile(write(file({ probe: STDIO }), mode)), mode.toString(8)).toEqual({
				ok: false,
				problem: "bad_mode",
			});
		}
	});

	test("a file owned by another account is refused", () => {
		const path = write(file({ probe: STDIO }));
		const mine = process.getuid?.() ?? 0;
		expect(readForkMcpFile(path, { uid: mine + 1 })).toEqual({ ok: false, problem: "not_owned" });
		expect(readForkMcpFile(path, { uid: mine }).ok).toBe(true);
	});

	test("a file over 64 KiB is refused without being parsed", () => {
		const big = file({ probe: { ...STDIO, args: ["x".repeat(70_000)] } });
		expect(readForkMcpFile(write(big))).toEqual({ ok: false, problem: "too_big" });
	});
});

describe("the shape checks: any fault makes the whole file invalid", () => {
	const bad = (text: string, problem: string) =>
		expect(parseForkMcpText(text), text.slice(0, 80)).toEqual({ ok: false, problem } as never);

	test("not JSON, or not an object with only mcpServers", () => {
		bad("{", "not_json");
		bad("[]", "bad_shape");
		bad(JSON.stringify({ mcpServers: {}, extra: 1 }), "bad_shape");
		bad(JSON.stringify({ mcpServers: [] }), "bad_shape");
		bad(JSON.stringify({}), "bad_shape");
	});

	test("an empty list is valid and applies nothing", () => {
		expect(parseForkMcpText(file({}))).toEqual({ ok: true, servers: [] });
	});

	test("at most 16 servers", () => {
		const many = (n: number) =>
			Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, STDIO]));
		expect(parseForkMcpText(file(many(16))).ok).toBe(true);
		bad(file(many(17)), "too_many_servers");
	});

	test("names are 1 to 32 of A-Za-z0-9-, with no underscore, so the wire name splits one way", () => {
		for (const name of ["a_b", "has space", "dot.name", "", "x".repeat(33), "é", "a__b"]) {
			bad(file({ [name]: STDIO }), "bad_server_name");
		}
		for (const name of ["a", "a-b", "A1", "x".repeat(32)]) {
			expect(parseForkMcpText(file({ [name]: STDIO })).ok, name).toBe(true);
		}
	});

	test("a stdio server needs a command and takes only command, args, env and type", () => {
		bad(file({ s: {} }), "bad_server");
		bad(file({ s: { command: "" } }), "bad_server");
		bad(file({ s: { command: 1 } }), "bad_server");
		bad(file({ s: { command: "x", cwd: "/" } }), "bad_server");
		bad(file({ s: { command: "x", args: [1] } }), "bad_server");
		bad(file({ s: { command: "x", args: "a" } }), "bad_server");
		bad(file({ s: { command: "x", env: { "bad name": "v" } } }), "bad_server");
		bad(file({ s: { command: "x", env: { A: 1 } } }), "bad_server");
		bad(file({ s: { command: "x", url: "http://x" } }), "bad_server");
	});

	test("http and sse servers need an http(s) url and take only url, headers and type", () => {
		const ok = parseForkMcpText(
			file({
				a: {
					type: "http",
					url: "https://mcp.example.com/x",
					headers: { Authorization: "Bearer t" },
				},
				b: { type: "sse", url: "http://localhost:3000/sse" },
			}),
		);
		expect(ok.ok).toBe(true);
		bad(file({ s: { type: "http" } }), "bad_server");
		bad(file({ s: { type: "http", url: "ftp://x/y" } }), "bad_server");
		bad(file({ s: { type: "http", url: "not a url" } }), "bad_server");
		bad(file({ s: { type: "http", url: "https://x", command: "x" } }), "bad_server");
		bad(
			file({ s: { type: "http", url: "https://x", headers: { "bad header": "v" } } }),
			"bad_server",
		);
		bad(file({ s: { type: "websocket", url: "ws://x" } }), "bad_server");
	});

	test("a prototype key is not a server name", () => {
		bad('{"mcpServers":{"__proto__":{"command":"x"}}}', "bad_server_name");
	});
});

describe("digests", () => {
	test("do not depend on key order or on `type: stdio` being spelled out", () => {
		const a = parseForkMcpText(file({ s: { command: "n", args: ["a"], env: { A: "1", B: "2" } } }));
		const b = parseForkMcpText(
			file({ s: { env: { B: "2", A: "1" }, args: ["a"], type: "stdio", command: "n" } }),
		);
		expect(a.ok && b.ok && a.servers[0]?.digest === b.servers[0]?.digest).toBe(true);
	});

	test("change when anything the server does changes", () => {
		const base = serverDigest({ type: "stdio", command: "n", args: ["a"] });
		for (const other of [
			{ type: "stdio" as const, command: "m", args: ["a"] },
			{ type: "stdio" as const, command: "n", args: ["b"] },
			{ type: "stdio" as const, command: "n", args: ["a"], env: { A: "1" } },
		]) {
			expect(serverDigest(other)).not.toBe(base);
		}
		expect(base).toMatch(/^[0-9a-f]{64}$/);
	});

	test("canonical JSON sorts every level", () => {
		expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
	});
});

describe("the private copy", () => {
	test("holds exactly the validated servers, serialised from what was parsed", () => {
		const parsed = parseForkMcpText(
			file({ a: STDIO, b: { type: "sse", url: "https://x.example/s" } }),
		);
		if (!parsed.ok) throw new Error("expected valid");
		const text = privateConfigText(parsed.servers);
		expect(JSON.parse(text)).toEqual({
			mcpServers: {
				a: { type: "stdio", ...STDIO },
				b: { type: "sse", url: "https://x.example/s" },
			},
		});
		expect(text.endsWith("\n")).toBe(true);
	});
});
