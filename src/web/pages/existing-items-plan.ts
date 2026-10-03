/** What was chosen for one key or host on the "Existing items" screen. */
export type OwnerChoice = { kind: "service" } | { kind: "assign"; userId: string | null };

export type ExistingOp =
	| { kind: "claim-sessions"; userId: string }
	| { kind: "assign-key"; keyId: string; userId: string }
	| { kind: "mark-service-key"; keyId: string }
	| { kind: "assign-host"; hostId: string; userId: string };

type Choices = Readonly<Record<string, OwnerChoice | undefined>>;

function assignments(choices: Choices): Array<[string, string]> {
	const result: Array<[string, string]> = [];
	for (const [id, choice] of Object.entries(choices)) {
		if (choice?.kind === "assign" && choice.userId) result.push([id, choice.userId]);
	}
	return result;
}

/**
 * The writes "Apply" performs, in order: past sessions, then each key, then
 * each host. Keys and hosts are never assigned in bulk: one operation each,
 * and "assign" with nobody picked is skipped rather than guessed.
 */
export function planExistingItems(input: {
	claimSessionsFor: string | null;
	keys: Choices;
	hosts: Choices;
	/** The server records "service key" decisions: a key left as a service key is written down, not just remembered here. */
	recordServiceKeys?: boolean;
}): ExistingOp[] {
	const ops: ExistingOp[] = [];
	if (input.claimSessionsFor) ops.push({ kind: "claim-sessions", userId: input.claimSessionsFor });
	for (const [keyId, userId] of assignments(input.keys))
		ops.push({ kind: "assign-key", keyId, userId });
	if (input.recordServiceKeys) {
		for (const [keyId, choice] of Object.entries(input.keys)) {
			if (choice?.kind === "service") ops.push({ kind: "mark-service-key", keyId });
		}
	}
	for (const [hostId, userId] of assignments(input.hosts)) {
		ops.push({ kind: "assign-host", hostId, userId });
	}
	return ops;
}

/** Ids someone looked at and left without an owner: remembered so the checklist stops counting them. */
export function idsKeptAsService(choices: Choices): string[] {
	return Object.entries(choices)
		.filter(([, choice]) => choice !== undefined && !(choice.kind === "assign" && choice.userId))
		.map(([id]) => id);
}

export interface ExistingResult {
	op: ExistingOp;
	ok: boolean;
	claimed?: number;
	message?: string;
}

export interface ExistingSummary {
	claimed: number | null;
	assignedKeys: number;
	keptKeys: number;
	assignedHosts: number;
	keptHosts: number;
	untouched: number;
}

export interface ExistingSettlement {
	remainingKeyChoices: Record<string, OwnerChoice | undefined>;
	remainingHostChoices: Record<string, OwnerChoice | undefined>;
	failures: Array<{ label: string; message: string }>;
	summary: ExistingSummary;
	/** Ids to remember (per person, in this browser) as looked at and left unassigned. Keys only: a host with no owner stays listed until it has one. */
	reviewedKeyIds: string[];
}

function plural(count: number, one: string, many: string): string {
	return count === 1 ? one : many;
}

/**
 * What Apply's results leave behind: choices whose write failed stay chosen,
 * everything else is cleared; failures are named; and the counts say exactly
 * what changed and how many rows nobody touched.
 */
export function settleExistingItems(input: {
	results: readonly ExistingResult[];
	keyChoices: Choices;
	hostChoices: Choices;
	visibleKeyIds: readonly string[];
	visibleHostIds: readonly string[];
	names: { key: (id: string) => string; host: (id: string) => string };
	recordServiceKeys: boolean;
}): ExistingSettlement {
	const failures: ExistingSettlement["failures"] = [];
	const remainingKeyChoices = { ...input.keyChoices };
	const remainingHostChoices = { ...input.hostChoices };
	const summary: ExistingSummary = {
		claimed: null,
		assignedKeys: 0,
		keptKeys: 0,
		assignedHosts: 0,
		keptHosts: 0,
		untouched: 0,
	};
	const failedKeyIds = new Set<string>();

	for (const { op, ok, claimed, message } of input.results) {
		if (!ok) {
			const label =
				op.kind === "claim-sessions"
					? "Assigning past sessions"
					: op.kind === "assign-host"
						? `Assigning ${input.names.host(op.hostId)}`
						: `Assigning ${input.names.key(op.keyId)}`;
			failures.push({ label, message: message ?? "Something went wrong. Try again." });
			if (op.kind === "assign-key" || op.kind === "mark-service-key") failedKeyIds.add(op.keyId);
			continue;
		}
		if (op.kind === "claim-sessions") summary.claimed = claimed ?? 0;
		else if (op.kind === "assign-key") {
			summary.assignedKeys += 1;
			delete remainingKeyChoices[op.keyId];
		} else if (op.kind === "mark-service-key") {
			summary.keptKeys += 1;
			delete remainingKeyChoices[op.keyId];
		} else {
			summary.assignedHosts += 1;
			delete remainingHostChoices[op.hostId];
		}
	}

	// A key left as a service key is remembered here only when the server isn't told.
	const keptKeyIds = idsKeptAsService(input.keyChoices).filter((id) => !failedKeyIds.has(id));
	const keptHostIds = idsKeptAsService(input.hostChoices);
	if (!input.recordServiceKeys) {
		summary.keptKeys = keptKeyIds.length;
		for (const id of keptKeyIds) delete remainingKeyChoices[id];
	}
	summary.keptHosts = keptHostIds.length;
	for (const id of keptHostIds) delete remainingHostChoices[id];

	const touched = (choices: Choices, id: string) => choices[id] !== undefined;
	summary.untouched =
		input.visibleKeyIds.filter((id) => !touched(input.keyChoices, id)).length +
		input.visibleHostIds.filter((id) => !touched(input.hostChoices, id)).length;

	return {
		remainingKeyChoices,
		remainingHostChoices,
		failures,
		summary,
		reviewedKeyIds: input.recordServiceKeys ? [] : keptKeyIds,
	};
}

/** Exactly what Apply did, in the words shown in the toast. */
export function existingSummaryText(summary: ExistingSummary): string {
	const parts: string[] = [];
	if (summary.claimed !== null && summary.claimed > 0) {
		parts.push(
			`${summary.claimed} ${plural(summary.claimed, "session is", "sessions are")} now yours.`,
		);
	}
	if (summary.assignedKeys > 0) {
		parts.push(`Assigned ${summary.assignedKeys} ${plural(summary.assignedKeys, "key", "keys")}.`);
	}
	if (summary.keptKeys > 0) {
		parts.push(
			`Kept ${summary.keptKeys} ${plural(summary.keptKeys, "key", "keys")} as a service ${plural(summary.keptKeys, "key", "key")}.`,
		);
	}
	if (summary.assignedHosts > 0) {
		parts.push(
			`Assigned ${summary.assignedHosts} ${plural(summary.assignedHosts, "host", "hosts")}.`,
		);
	}
	if (summary.keptHosts > 0) {
		parts.push(
			`Left ${summary.keptHosts} ${plural(summary.keptHosts, "host", "hosts")} unassigned.`,
		);
	}
	if (parts.length === 0) return "Nothing changed.";
	if (summary.untouched > 0) parts.push(`Left ${summary.untouched} unchanged.`);
	return parts.join(" ");
}

/** The first option of every owner select: nothing chosen yet, so Apply leaves the row alone. */
export const OWNER_CHOICE_PLACEHOLDER = "";

/** What "leave it without an owner" is called for each kind of row. */
export function leaveUnassignedLabel(noun: "key" | "host"): string {
	return noun === "key" ? "Keep as a service key" : "Leave unassigned";
}
