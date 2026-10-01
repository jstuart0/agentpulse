import { describe, expect, test } from "bun:test";
import type { SupervisorRecord } from "../../shared/types.js";
import { deriveHostsViewState } from "./hosts-view-state.js";

function supervisor(id: string): SupervisorRecord {
	return {
		id,
		hostName: `host-${id}`,
		platform: "linux",
		arch: "x64",
		version: "1.0.0",
		status: "connected",
		enrollmentState: "active",
		capabilities: {
			launchModes: [],
			agentTypes: [],
			features: [],
		},
		trustedRoots: [],
		lastHeartbeatAt: new Date().toISOString(),
	} as unknown as SupervisorRecord;
}

describe("deriveHostsViewState", () => {
	test("loading takes priority over everything else", () => {
		expect(
			deriveHostsViewState({ loading: true, loadError: "boom", supervisors: [supervisor("1")] }),
		).toEqual({ kind: "loading" });
	});

	test("load error (not loading) surfaces as a distinct error state, even with stale supervisors", () => {
		expect(
			deriveHostsViewState({
				loading: false,
				loadError: "Couldn't load hosts: 403 insufficient_scope",
				supervisors: [],
			}),
		).toEqual({ kind: "error", message: "Couldn't load hosts: 403 insufficient_scope" });
	});

	test("a load error takes priority over a non-empty (stale) supervisor list — the list may be stale/wrong", () => {
		expect(
			deriveHostsViewState({
				loading: false,
				loadError: "Couldn't load hosts: network error",
				supervisors: [supervisor("1")],
			}),
		).toEqual({ kind: "error", message: "Couldn't load hosts: network error" });
	});

	test("no error, empty list → genuine empty state", () => {
		expect(deriveHostsViewState({ loading: false, loadError: null, supervisors: [] })).toEqual({
			kind: "empty",
		});
	});

	test("no error, non-empty list → populated state carrying the supervisors", () => {
		const supervisors = [supervisor("1"), supervisor("2")];
		expect(deriveHostsViewState({ loading: false, loadError: null, supervisors })).toEqual({
			kind: "populated",
			supervisors,
		});
	});
});
