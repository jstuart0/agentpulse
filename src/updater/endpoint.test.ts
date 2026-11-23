import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstallRecord } from "../shared/install-record.js";
import { isLoopbackProbeHost, localEndpoint, parseEnvText, probeHost } from "./endpoint.js";

let app: string;
beforeEach(() => {
	app = mkdtempSync(join(tmpdir(), "ap-endpoint-"));
});
afterEach(() => rmSync(app, { recursive: true, force: true }));

const record = (over: Partial<InstallRecord> = {}): InstallRecord => ({
	schema: 1,
	kind: "local",
	components: ["server"],
	repoUrl: "https://example.invalid/a.git",
	track: "release",
	ref: "v0.12.0",
	installDir: app,
	dataDir: "/d",
	sqlitePath: "/d/a.db",
	dialect: "sqlite",
	service: "launchd",
	serverUrl: "https://agentpulse.example.invalid",
	serverTransport: "https",
	port: 3000,
	host: "0.0.0.0",
	bunBin: "/bun",
	...over,
});

describe("probeHost", () => {
	test("wildcards and empty mean loopback of the same family; a specific address is itself", () => {
		expect(probeHost("0.0.0.0")).toBe("127.0.0.1");
		expect(probeHost("")).toBe("127.0.0.1");
		expect(probeHost(null)).toBe("127.0.0.1");
		expect(probeHost("::")).toBe("[::1]");
		expect(probeHost("[::]")).toBe("[::1]");
		expect(probeHost("192.0.2.7")).toBe("192.0.2.7");
		expect(probeHost("fd00::7")).toBe("[fd00::7]");
		expect(probeHost("bad host;rm")).toBe("127.0.0.1");
		expect(isLoopbackProbeHost("[::1]")).toBe(true);
		expect(isLoopbackProbeHost("192.0.2.7")).toBe(false);
	});
});

describe("localEndpoint", () => {
	test("the effective PORT and HOST in .env.local win over the record, then .env, then the record", () => {
		expect(localEndpoint(record(), app)).toEqual({ host: "127.0.0.1", port: 3000 });
		writeFileSync(join(app, ".env"), "PORT=4000\nHOST=192.0.2.7\n");
		expect(localEndpoint(record(), app)).toEqual({ host: "192.0.2.7", port: 4000 });
		writeFileSync(join(app, ".env.local"), 'PORT=5000\nHOST="::"\n');
		expect(localEndpoint(record(), app)).toEqual({ host: "[::1]", port: 5000 });
	});
	test("a record's own bind host is used when no env file says otherwise", () => {
		expect(localEndpoint(record({ host: "192.0.2.9" }), app)).toEqual({
			host: "192.0.2.9",
			port: 3000,
		});
	});
	test("an old record with no port gives no endpoint when its server URL is public, and never falls back to it", () => {
		expect(localEndpoint(record({ port: null, host: null }), app).port).toBeNull();
		expect(
			localEndpoint(
				record({
					port: null,
					host: null,
					serverUrl: "http://192.0.2.10:3000",
					serverTransport: "http",
				}),
				app,
			).port,
		).toBeNull();
		expect(
			localEndpoint(
				record({
					port: null,
					host: null,
					serverUrl: "http://localhost:3456",
					serverTransport: "loopback",
				}),
				app,
			),
		).toEqual({ host: "127.0.0.1", port: 3456 });
	});
	test("a bad port in an env file is ignored, and an env symlink is never followed", () => {
		writeFileSync(join(app, ".env.local"), "PORT=99999\n");
		expect(localEndpoint(record(), app).port).toBe(3000);
		writeFileSync(join(tmpdir(), "ap-endpoint-target"), "PORT=7777\n");
		rmSync(join(app, ".env.local"));
		symlinkSync(join(tmpdir(), "ap-endpoint-target"), join(app, ".env.local"));
		expect(localEndpoint(record(), app).port).toBe(3000);
		rmSync(join(tmpdir(), "ap-endpoint-target"));
	});
	test("env text: comments, quotes and blank lines", () => {
		expect(parseEnvText("# c\n\nA=1\nB='two'\nC = 3\nbad\n")).toEqual({ A: "1", B: "two", C: "3" });
	});
});
