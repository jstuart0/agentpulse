import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstallKind, readInstallRecord } from "./install-record.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ap-install-record-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
const myUid = process.getuid?.() as number;
const posixOnly = process.platform === "win32" ? test.skip : test;
let n = 0;

function record(over: Record<string, unknown> = {}) {
	return {
		schema: 1,
		kind: "local",
		components: ["server", "supervisor"],
		repoUrl: "https://example.invalid/agentpulse.git",
		track: "ref",
		ref: "main",
		installDir: "/placeholder",
		dataDir: "/data",
		sqlitePath: "/data/agentpulse.db",
		dialect: "sqlite",
		service: "launchd",
		serverUrl: "http://localhost:3000",
		serverTransport: "loopback",
		bunBin: "/bun/bin/bun",
		...over,
	};
}

/** A throwaway home holding ~/.agentpulse/install.json (private by default). */
function home(
	rec: unknown,
	opts: { fileMode?: number; dirMode?: number; asText?: string } = {},
): string {
	n += 1;
	const h = join(ROOT, `home-${n}`);
	const dir = join(h, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, opts.dirMode ?? 0o700);
	const file = join(dir, "install.json");
	writeFileSync(file, opts.asText ?? JSON.stringify(rec), { mode: opts.fileMode ?? 0o600 });
	chmodSync(file, opts.fileMode ?? 0o600);
	return h;
}

describe("readInstallRecord", () => {
	test("reads a valid private record", () => {
		const h = home(record());
		const got = readInstallRecord(h);
		expect(got?.kind).toBe("local");
		expect(got?.components).toEqual(["server", "supervisor"]);
		expect(got?.bunBin).toBe("/bun/bin/bun");
		expect(got?.serverTransport).toBe("loopback");
	});

	test("a supervisor-only record may have no database fields", () => {
		const h = home(
			record({ components: ["supervisor"], dataDir: null, sqlitePath: null, dialect: null }),
		);
		expect(readInstallRecord(h)?.components).toEqual(["supervisor"]);
	});

	test("missing, corrupt, wrong-schema or malformed records read as null", () => {
		expect(readInstallRecord(join(ROOT, "nowhere"))).toBeNull();
		expect(readInstallRecord(home(null, { asText: "{not json" }))).toBeNull();
		expect(readInstallRecord(home(record({ schema: 2 })))).toBeNull();
		expect(readInstallRecord(home(record({ kind: "docker" })))).toBeNull();
		expect(readInstallRecord(home(record({ components: [] })))).toBeNull();
		expect(readInstallRecord(home(record({ components: ["server", "relay"] })))).toBeNull();
		expect(readInstallRecord(home(record({ track: "nightly" })))).toBeNull();
		expect(readInstallRecord(home(record({ serverTransport: "ftp" })))).toBeNull();
		expect(readInstallRecord(home(record({ installDir: "relative/dir" })))).toBeNull();
		expect(readInstallRecord(home(record({ bunBin: 7 })))).toBeNull();
		expect(readInstallRecord(home([1, 2]))).toBeNull();
	});

	posixOnly(
		"a world-writable record, a world-writable directory and a wrong owner all read as null",
		() => {
			expect(readInstallRecord(home(record(), { fileMode: 0o666 }))).toBeNull();
			expect(readInstallRecord(home(record(), { dirMode: 0o777 }))).toBeNull();
			const h = home(record());
			expect(readInstallRecord(h)).not.toBeNull();
			expect(readInstallRecord(h, { ownerUid: myUid + 1 })).toBeNull();
		},
	);

	posixOnly("a symlinked record reads as null", () => {
		const h = home(record());
		const real = join(h, ".agentpulse", "install.json");
		const target = join(h, "elsewhere.json");
		writeFileSync(target, JSON.stringify(record()), { mode: 0o600 });
		rmSync(real);
		symlinkSync(target, real);
		expect(readInstallRecord(h)).toBeNull();
	});
});

describe("detectInstallKind", () => {
	const none = () => false;

	test("an install.json whose installDir is the server's cwd is local, even inside a container", () => {
		n += 1;
		const dir = join(ROOT, `app-${n}`);
		mkdirSync(dir);
		const h = home(record({ installDir: dir }));
		const kind = detectInstallKind(
			{ KUBERNETES_SERVICE_HOST: "10.0.0.1", AGENTPULSE_INSTALL_KIND: "container" },
			dir,
			h,
			{ exists: () => true },
		);
		expect(kind).toBe("local");
	});

	test("the match is by realpath, so a symlinked cwd still matches", () => {
		n += 1;
		const dir = join(ROOT, `app-${n}`);
		mkdirSync(dir);
		const alias = join(ROOT, `alias-${n}`);
		symlinkSync(dir, alias);
		const h = home(record({ installDir: dir }));
		expect(detectInstallKind({}, alias, h, { exists: none })).toBe("local");
	});

	test("an install.json for another directory is not local", () => {
		n += 1;
		const dir = join(ROOT, `app-${n}`);
		mkdirSync(dir);
		const h = home(record({ installDir: join(ROOT, "other") }));
		expect(detectInstallKind({}, dir, h, { exists: none })).toBe("source");
	});

	test("an empty KUBERNETES_SERVICE_HOST is not kubernetes", () => {
		expect(detectInstallKind({ KUBERNETES_SERVICE_HOST: "" }, ROOT, ROOT, { exists: none })).toBe(
			"source",
		);
	});

	test("a non-empty KUBERNETES_SERVICE_HOST is kubernetes, and beats the container markers", () => {
		const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1", AGENTPULSE_INSTALL_KIND: "container" };
		expect(detectInstallKind(env, ROOT, ROOT, { exists: () => true })).toBe("kubernetes");
	});

	test("the container markers: the image's variable, /.dockerenv, /run/.containerenv", () => {
		expect(
			detectInstallKind({ AGENTPULSE_INSTALL_KIND: "container" }, ROOT, ROOT, { exists: none }),
		).toBe("container");
		expect(detectInstallKind({}, ROOT, ROOT, { exists: (p) => p === "/.dockerenv" })).toBe(
			"container",
		);
		expect(detectInstallKind({}, ROOT, ROOT, { exists: (p) => p === "/run/.containerenv" })).toBe(
			"container",
		);
		expect(
			detectInstallKind({ AGENTPULSE_INSTALL_KIND: "other" }, ROOT, ROOT, { exists: none }),
		).toBe("source");
	});

	posixOnly("a corrupt, world-writable, symlinked or wrong-owner record gives source", () => {
		n += 1;
		const dir = join(ROOT, `app-${n}`);
		mkdirSync(dir);
		const bad = [
			home(null, { asText: "{nope" }),
			home(record({ installDir: dir }), { fileMode: 0o666 }),
			home(record({ installDir: dir }), { dirMode: 0o777 }),
		];
		for (const h of bad) expect(detectInstallKind({}, dir, h, { exists: none })).toBe("source");
		const good = home(record({ installDir: dir }));
		expect(detectInstallKind({}, dir, good, { exists: none, ownerUid: myUid + 1 })).toBe("source");
		expect(detectInstallKind({}, dir, good, { exists: none })).toBe("local");
	});
});
