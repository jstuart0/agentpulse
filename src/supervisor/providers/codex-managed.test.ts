import { describe, expect, spyOn, test } from "bun:test";
import { resolveProviderProtocolVersion } from "./codex-managed.js";

describe("resolveProviderProtocolVersion", () => {
	test("returns the reported protocolVersion when it's a string", () => {
		expect(resolveProviderProtocolVersion({ protocolVersion: "2026.1" })).toBe("2026.1");
	});

	test("falls back to app-server without warning when protocolVersion is a well-formed string", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			resolveProviderProtocolVersion({ protocolVersion: "app-server" });
			expect(warnSpy).not.toHaveBeenCalled();
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("falls back to app-server and warns once when protocolVersion is missing", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveProviderProtocolVersion({});
			expect(result).toBe("app-server");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("falls back to app-server and warns once when protocolVersion is not a string", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const result = resolveProviderProtocolVersion({ protocolVersion: 42 });
			expect(result).toBe("app-server");
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("does not throw and falls back to app-server when initResult is null or undefined", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(resolveProviderProtocolVersion(null)).toBe("app-server");
			expect(resolveProviderProtocolVersion(undefined)).toBe("app-server");
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("logs once per distinct bad value, not once globally", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			resolveProviderProtocolVersion({ protocolVersion: 99 });
			resolveProviderProtocolVersion({ protocolVersion: 99 });
			expect(warnSpy).toHaveBeenCalledTimes(1);

			resolveProviderProtocolVersion({ protocolVersion: 13 });
			expect(warnSpy).toHaveBeenCalledTimes(2);
		} finally {
			warnSpy.mockRestore();
		}
	});

	test("is deterministic for the same initResult — pins the persisted providerProtocolVersion and the runtime protocolVersion (both call in launchManagedCodexRequest) to an identical value", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const initResult = { protocolVersion: "2026.3" };
			const persisted = resolveProviderProtocolVersion(initResult);
			const runtime = resolveProviderProtocolVersion(initResult);
			expect(persisted).toBe(runtime);
			expect(persisted).toBe("2026.3");

			const badInitResult = { protocolVersion: 7 };
			const persistedBad = resolveProviderProtocolVersion(badInitResult);
			const runtimeBad = resolveProviderProtocolVersion(badInitResult);
			expect(persistedBad).toBe(runtimeBad);
			expect(persistedBad).toBe("app-server");
		} finally {
			warnSpy.mockRestore();
		}
	});
});
