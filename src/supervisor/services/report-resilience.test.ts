/**
 * F31/D7 (2026-09-29-deliver-supervisor-auth-routing): a 401 (credential
 * revoked or rotated) must be fatal — reportInSessionSafely invokes its
 * onFatal callback and stops. A 403 (session_not_owned) or any 5xx must
 * log and continue, exactly like before D7.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
	SupervisorRequestError,
	isCredentialRejected,
	reportInSessionSafely,
} from "./report-resilience.js";

describe("SupervisorRequestError / isCredentialRejected", () => {
	test("401 is a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(401, "Unauthorized"))).toBe(true);
	});

	test("403 is not a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(403, "Forbidden"))).toBe(false);
	});

	test("500 is not a credential rejection", () => {
		expect(isCredentialRejected(new SupervisorRequestError(500, "Internal Server Error"))).toBe(
			false,
		);
	});

	test("a non-SupervisorRequestError is never a credential rejection", () => {
		expect(isCredentialRejected(new Error("network error"))).toBe(false);
		expect(isCredentialRejected("not even an error")).toBe(false);
		expect(isCredentialRejected(undefined)).toBe(false);
	});

	test("carries the status and a human-readable message", () => {
		const error = new SupervisorRequestError(401, "Unauthorized");
		expect(error.status).toBe(401);
		expect(error.message).toBe("Supervisor request failed: 401 Unauthorized");
		expect(error.name).toBe("SupervisorRequestError");
		expect(error).toBeInstanceOf(Error);
	});
});

describe("reportInSessionSafely — 401 is fatal, 403/5xx log-and-continue (F31/D7)", () => {
	test("a 401 invokes onFatal and resolves (doesn't throw)", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-1",
			"reportState",
			async () => {
				throw new SupervisorRequestError(401, "Unauthorized");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(true);
	});

	test("a 403 (session_not_owned) logs and continues — onFatal is not invoked", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-2",
			"reportState",
			async () => {
				throw new SupervisorRequestError(403, "Forbidden");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("a 500 logs and continues — onFatal is not invoked", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-3",
			"reportState",
			async () => {
				throw new SupervisorRequestError(500, "Internal Server Error");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("an unrelated error (e.g. network failure) also logs and continues", async () => {
		let fatalCalled = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-4",
			"reportState",
			async () => {
				throw new Error("fetch failed");
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(fatalCalled).toBe(false);
	});

	test("success never invokes onFatal", async () => {
		let fatalCalled = false;
		let ran = false;
		await reportInSessionSafely(
			"test-scope",
			"sess-5",
			"reportState",
			async () => {
				ran = true;
			},
			() => {
				fatalCalled = true;
			},
		);
		expect(ran).toBe(true);
		expect(fatalCalled).toBe(false);
	});

	test("defaults onFatal to process.exit(1) when the caller doesn't supply one (mocked)", async () => {
		const exitSpy = spyOn(process, "exit").mockImplementation(
			(() => undefined) as unknown as typeof process.exit,
		);
		try {
			await reportInSessionSafely("test-scope", "sess-6", "reportState", async () => {
				throw new SupervisorRequestError(401, "Unauthorized");
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("the default onFatal is NOT invoked for a 403 (mocked process.exit stays uncalled)", async () => {
		const exitSpy = spyOn(process, "exit").mockImplementation(
			(() => undefined) as unknown as typeof process.exit,
		);
		try {
			await reportInSessionSafely("test-scope", "sess-7", "reportState", async () => {
				throw new SupervisorRequestError(403, "Forbidden");
			});
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
		}
	});
});
