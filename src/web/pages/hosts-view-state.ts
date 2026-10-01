import type { SupervisorRecord } from "../../shared/types.js";

/**
 * Pure derivation of what HostsPage should render. Splits the "no hosts
 * are registered yet" empty state from a failed `GET /admin/supervisors`
 * request — the symptom this exists to fix: the page used to render the
 * genuine-empty-state copy indistinguishably from a silently failed load,
 * which is exactly how a registered-but-invisible host goes unnoticed.
 *
 * `loadError` takes priority over the supervisors list even when the list
 * is non-empty — a failed refresh leaves stale data on screen, and stale
 * data presented as current is its own kind of silent failure.
 */
export type HostsViewState =
	| { kind: "loading" }
	| { kind: "error"; message: string }
	| { kind: "empty" }
	| { kind: "populated"; supervisors: SupervisorRecord[] };

export function deriveHostsViewState(params: {
	loading: boolean;
	loadError: string | null;
	supervisors: SupervisorRecord[];
}): HostsViewState {
	if (params.loading) return { kind: "loading" };
	if (params.loadError) return { kind: "error", message: params.loadError };
	if (params.supervisors.length === 0) return { kind: "empty" };
	return { kind: "populated", supervisors: params.supervisors };
}
