import { describe, expect, test } from "bun:test";
import { MANAGED_STATES, type ManagedState } from "../../shared/types.js";
import { getSessionMode } from "./utils.js";

// Slice TYPE-2b: getSessionMode used to read managedState as a plain
// `string` and silently fall through `default: "observed"` for any
// unknown value. The promotion to a typed Record<ManagedState, …> means
// adding a new state to MANAGED_STATES forces a compile error in
// utils.ts; this test guards the runtime side — every member of the
// union must produce a defined SessionModeStyle without falling into
// `undefined` (which would happen if the Record were partial).
describe("getSessionMode", () => {
	test("returns observed style when no managedSession is present", () => {
		const style = getSessionMode({ managedSession: null });
		expect(style.mode).toBe("observed");
		expect(style.label).toBe("observed");
	});

	test("returns observed style when managedSession is undefined", () => {
		const style = getSessionMode({});
		expect(style.mode).toBe("observed");
	});

	test("every ManagedState member maps to a defined style", () => {
		for (const state of MANAGED_STATES) {
			const style = getSessionMode({ managedSession: { managedState: state } });
			expect(style).toBeDefined();
			expect(style.mode).toBeDefined();
			expect(style.label).toBeDefined();
			expect(style.barClass).toBeDefined();
			expect(style.chipClass).toBeDefined();
		}
	});

	test("interactive_terminal maps to interactive mode", () => {
		const style = getSessionMode({ managedSession: { managedState: "interactive_terminal" } });
		expect(style.mode).toBe("interactive");
	});

	test("headless maps to headless mode", () => {
		const style = getSessionMode({ managedSession: { managedState: "headless" } });
		expect(style.mode).toBe("headless");
	});

	test("managed and degraded both map to managed mode", () => {
		expect(getSessionMode({ managedSession: { managedState: "managed" } }).mode).toBe("managed");
		expect(getSessionMode({ managedSession: { managedState: "degraded" } }).mode).toBe("managed");
	});

	test("terminal lifecycle states (stopped/completed/failed) collapse to observed style", () => {
		// These previously hit the `default:` branch. Locked down so future
		// reshuffles can't accidentally promote them.
		for (const state of [
			"stopped",
			"completed",
			"failed",
			"pending",
			"linked",
		] satisfies ManagedState[]) {
			const style = getSessionMode({ managedSession: { managedState: state } });
			expect(style.mode).toBe("observed");
		}
	});
});
