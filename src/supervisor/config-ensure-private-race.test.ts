/**
 * AGEN-21 (xander, Medium): ensureSupervisorConfigPrivate must never throw.
 * tightenPrivateFilePermissionsSync throws when it loses the TOCTOU race
 * (the file at `path` changed identity between the initial lstat and the
 * verifying fstat on the opened handle) — a real but vanishingly narrow
 * window, not reliably reproducible by racing two real processes in a
 * test. ensureSupervisorConfigPrivate's optional `tighten` parameter
 * (default: the real tightenPrivateFilePermissionsSync) is a plain
 * dependency-injection seam for exactly this: passing a function that
 * throws on demand forces the race deterministically without touching
 * module resolution (mock.module was tried first and rejected — see
 * config.ts's doc comment on ensureSupervisorConfigPrivate — it replaces
 * ../shared/private-file.js process-wide and was observed to leak into
 * config.test.ts's/private-file.test.ts's real-implementation coverage
 * when both run in the same `bun test` invocation).
 */
import { describe, expect, spyOn, test } from "bun:test";
import { ensureSupervisorConfigPrivate } from "./config.js";

const RACE_ERROR_MESSAGE = "file changed while opening: /fake/home/.agentpulse/supervisor.json";

function throwingTighten(): never {
	throw new Error(RACE_ERROR_MESSAGE);
}

describe("ensureSupervisorConfigPrivate never throws (AGEN-21)", () => {
	test("a lost TOCTOU race is caught, logged, and does not propagate", () => {
		const errorSpy = spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(() => ensureSupervisorConfigPrivate(throwingTighten)).not.toThrow();
			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0]?.join(" ")).toContain(RACE_ERROR_MESSAGE);
		} finally {
			errorSpy.mockRestore();
		}
	});
});
