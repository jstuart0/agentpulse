import type { ApprovalsVerdict, Verdict } from "./codex-protocol.js";
/**
 * Answers every request the Codex app-server makes of us (AGEN-87, D5). A request the app-server sends
 * and nobody answers hangs the turn with no sign anywhere, so this is the one place that decides what each
 * method gets, and the rule is default-deny: an approval is declined, everything else is refused or given
 * the empty answer that measures as a refusal (Phase 0, S9 to S12). In this phase no approval is ever
 * accepted; the tracker exists so that a later phase can put a person's answer in one place.
 *
 * Every answer comes out of one closed table. Nothing the agent wrote (a command, a path, Codex's
 * reason) is put into a warning or a report; the warnings carry fixed text and fixed codes only.
 */
import {
	type JsonRpcId,
	type JsonRpcServerRequest,
	RPC_METHOD_NOT_FOUND,
	type RpcClient,
	type RpcTimers,
} from "./codex-rpc.js";

/** An approval that arrives before the protocol verdict is held this long, then declined. */
export const VERDICT_WAIT_MS = 5_000;
/** Approvals held at once, across every runtime on this host. Past it, a request is declined at once. */
export const MAX_OPEN_APPROVALS = 64;

type Answer =
	| { kind: "result"; result: unknown }
	| { kind: "error"; code: number; message: string };

type MethodSpec = {
	/** What the warning calls the thing Codex asked for. */
	label: string;
	/** Approvals can be held for the verdict; the rest are answered the moment they arrive. */
	approval: boolean;
	answer: Answer;
};

const METHOD_NOT_FOUND: Answer = {
	kind: "error",
	code: RPC_METHOD_NOT_FOUND,
	message: "Method not found",
};

/**
 * Every server-request method Codex 0.163.0 can send (`__fixtures__/codex-0.163/methods.json`), and what
 * each gets. A method not in this table is answered `-32601`.
 */
const METHODS: Record<string, MethodSpec> = {
	"item/commandExecution/requestApproval": {
		label: "to run a command",
		approval: true,
		answer: { kind: "result", result: { decision: "decline" } },
	},
	"item/fileChange/requestApproval": {
		label: "to change files",
		approval: true,
		answer: { kind: "result", result: { decision: "decline" } },
	},
	"item/permissions/requestApproval": {
		label: "for extra permissions",
		approval: false,
		answer: { kind: "result", result: { permissions: {} } },
	},
	"item/tool/requestUserInput": {
		label: "for input",
		approval: false,
		answer: { kind: "result", result: { answers: {} } },
	},
	"mcpServer/elicitation/request": {
		label: "for an MCP server's question",
		approval: false,
		answer: { kind: "result", result: { action: "decline" } },
	},
	applyPatchApproval: {
		label: "to change files",
		approval: false,
		answer: { kind: "result", result: { decision: "denied" } },
	},
	execCommandApproval: {
		label: "to run a command",
		approval: false,
		answer: { kind: "result", result: { decision: "denied" } },
	},
	"item/tool/call": {
		label: "to call a client tool",
		approval: false,
		answer: { kind: "result", result: { contentItems: [], success: false } },
	},
	"account/chatgptAuthTokens/refresh": {
		label: "for a new sign-in token",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
	"attestation/generate": {
		label: "for an attestation",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
	"currentTime/read": {
		label: "for the time",
		approval: false,
		answer: METHOD_NOT_FOUND,
	},
};

/** The methods the table answers, for the test that holds it equal to what Codex declares. */
export const HANDLED_SERVER_METHODS: readonly string[] = Object.keys(METHODS).sort();

/** Why a request was refused: a fixed vocabulary, safe to report. */
export type RefusalReason =
	| "approvals_not_enabled"
	| "protocol_unsupported"
	| "insecure_transport"
	| "verdict_timeout"
	| "over_capacity"
	| "fenced"
	| "out_of_scope"
	| "unknown_method";

export type ApprovalLaunch = {
	sessionId: string;
	/** Reports one fixed-text warning on the session. The tracker never hands it agent-written text. */
	warn(content: string, detail: { method: string; reason: string }): Promise<void>;
};

export type ApprovalHandle = {
	readonly sessionId: string;
	/** Which attached connection this is; ids restart with each app-server. */
	readonly epoch: number;
};

type Held = {
	key: string;
	id: JsonRpcId;
	method: string;
	timer: unknown;
	done: boolean;
};

type State = {
	handle: ApprovalHandle;
	client: RpcClient;
	launch: ApprovalLaunch;
	verdict: Verdict | null;
	fenced: boolean;
	disposed: boolean;
	held: Map<string, Held>;
	unsubscribe: Array<() => void>;
};

export type CodexApprovalTracker = {
	/** Call before `initialize`: every launch failure after it is covered by the client's close. */
	attachClient(client: RpcClient, launch: ApprovalLaunch): ApprovalHandle;
	setVerdict(handle: ApprovalHandle, verdict: Verdict): void;
	/** Declines any held request past its deadline. Does nothing, and does no I/O, when none is held. */
	tick(): void;
	pendingCount(): number;
	/** After this, nothing for the session is let through: held requests are declined. */
	fence(sessionId: string): void;
	/** Declines what is held, forgets the handle. Safe to call twice. */
	dispose(handle: ApprovalHandle): void;
};

export type TrackerOptions = {
	timers?: RpcTimers;
	now?: () => number;
	verdictWaitMs?: number;
	maxOpen?: number;
};

const REAL_TIMERS: RpcTimers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const keyOf = (id: JsonRpcId) => JSON.stringify(id);

function warningText(spec: MethodSpec, refused: boolean): string {
	return refused
		? `Codex asked ${spec.label}. AgentPulse declined it automatically; approvals can't be answered from AgentPulse yet.`
		: `Codex asked ${spec.label}. AgentPulse refused it automatically.`;
}

function reasonForVerdict(verdict: Verdict | null): RefusalReason {
	if (!verdict) return "verdict_timeout";
	const state: ApprovalsVerdict = verdict.verdict;
	if (state === "insecure_transport") return "insecure_transport";
	if (state === "unsupported") return "protocol_unsupported";
	return "approvals_not_enabled";
}

export function createCodexApprovalTracker(options: TrackerOptions = {}): CodexApprovalTracker {
	const timers = options.timers ?? REAL_TIMERS;
	const now = options.now ?? Date.now;
	const verdictWaitMs = options.verdictWaitMs ?? VERDICT_WAIT_MS;
	const maxOpen = options.maxOpen ?? MAX_OPEN_APPROVALS;
	const states = new Set<State>();
	const deadlines = new WeakMap<Held, number>();
	let epoch = 0;
	let open = 0;

	function answer(state: State, id: JsonRpcId, spec: MethodSpec | undefined) {
		const chosen = spec?.answer ?? METHOD_NOT_FOUND;
		try {
			if (chosen.kind === "result") state.client.respond(id, chosen.result);
			else state.client.respondError(id, chosen.code, chosen.message);
		} catch {
			// A closed stdin is the child going away: there is nobody left to answer.
		}
	}

	function warn(state: State, method: string, spec: MethodSpec | undefined, reason: RefusalReason) {
		const content = spec
			? warningText(spec, spec.answer.kind === "result")
			: "Codex sent a request AgentPulse doesn't recognize. It was refused automatically.";
		void state.launch
			.warn(content, { method: spec ? method : "unknown", reason })
			.catch((error) => {
				console.error("[codex-approvals] could not report a refusal:", error);
			});
	}

	/** Answers a held request once, whoever gets there first. */
	function settle(state: State, held: Held, reason: RefusalReason | null) {
		if (held.done) return;
		held.done = true;
		timers.clear(held.timer);
		state.held.delete(held.key);
		deadlines.delete(held);
		open--;
		const spec = METHODS[held.method];
		answer(state, held.id, spec);
		if (reason) warn(state, held.method, spec, reason);
	}

	function onRequest(state: State, call: JsonRpcServerRequest) {
		if (state.disposed) return;
		const spec = METHODS[call.method];
		if (!spec) {
			answer(state, call.id, undefined);
			warn(state, call.method, undefined, "unknown_method");
			return;
		}
		if (!spec.approval) {
			answer(state, call.id, spec);
			warn(state, call.method, spec, "out_of_scope");
			return;
		}
		if (state.fenced) {
			answer(state, call.id, spec);
			warn(state, call.method, spec, "fenced");
			return;
		}
		if (open >= maxOpen) {
			answer(state, call.id, spec);
			warn(state, call.method, spec, "over_capacity");
			return;
		}
		if (state.verdict) {
			answer(state, call.id, spec);
			warn(state, call.method, spec, reasonForVerdict(state.verdict));
			return;
		}
		// No verdict yet: hold it, but never past the wait.
		const held: Held = {
			key: keyOf(call.id),
			id: call.id,
			method: call.method,
			timer: undefined,
			done: false,
		};
		held.timer = timers.set(() => settle(state, held, "verdict_timeout"), verdictWaitMs);
		deadlines.set(held, now() + verdictWaitMs);
		state.held.set(held.key, held);
		open++;
	}

	function declineAll(state: State, reason: RefusalReason | null) {
		for (const held of [...state.held.values()]) settle(state, held, reason);
	}

	function dispose(state: State) {
		if (state.disposed) return;
		declineAll(state, null);
		state.disposed = true;
		for (const stop of state.unsubscribe) stop();
		states.delete(state);
	}

	const byHandle = new WeakMap<ApprovalHandle, State>();

	return {
		attachClient(client, launch) {
			const handle: ApprovalHandle = { sessionId: launch.sessionId, epoch: ++epoch };
			const state: State = {
				handle,
				client,
				launch,
				verdict: null,
				fenced: false,
				disposed: false,
				held: new Map(),
				unsubscribe: [],
			};
			states.add(state);
			byHandle.set(handle, state);
			state.unsubscribe.push(client.onServerRequest((call) => onRequest(state, call)));
			state.unsubscribe.push(client.onClose(() => dispose(state)));
			return handle;
		},

		setVerdict(handle, verdict) {
			const state = byHandle.get(handle);
			if (!state || state.disposed) return;
			state.verdict = verdict;
			declineAll(state, reasonForVerdict(verdict));
		},

		tick() {
			if (open === 0) return;
			const at = now();
			for (const state of states) {
				for (const held of [...state.held.values()]) {
					const deadline = deadlines.get(held);
					if (deadline !== undefined && at >= deadline) settle(state, held, "verdict_timeout");
				}
			}
		},

		pendingCount: () => open,

		fence(sessionId) {
			for (const state of states) {
				if (state.handle.sessionId !== sessionId) continue;
				state.fenced = true;
				declineAll(state, "fenced");
			}
		},

		dispose(handle) {
			const state = byHandle.get(handle);
			if (state) dispose(state);
		},
	};
}

// ---- the one tracker a supervisor runs ----

let shared: CodexApprovalTracker | null = null;
let fallback: CodexApprovalTracker | null = null;

/** Installs the tracker managed Codex runtimes attach to. Unconfigured means the default-deny one. */
export function configureCodexApprovals(tracker: CodexApprovalTracker | null): void {
	shared = tracker;
}

export function sharedCodexApprovals(): CodexApprovalTracker {
	if (shared) return shared;
	fallback ??= createCodexApprovalTracker();
	return fallback;
}
