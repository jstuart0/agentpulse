import { useCallback, useEffect, useRef, useState } from "react";
import type { HostStatsGroup, HostStatsResponse } from "../../shared/types.js";
import { api } from "../lib/api.js";
import { HOST_ALL, echoMatchesHost } from "../lib/host-scope.js";
import { browserStorage } from "../lib/id-set-storage.js";
import { requestKey, useRequestGuard } from "../lib/live-request.js";
import { type DashboardScope, OWNER_ALL, echoMatchesRequest } from "../lib/owner-scope.js";
import { scopedQuery } from "../lib/scoped-query.js";
import { useUserStore } from "../stores/user-store.js";

export const MACHINE_COUNT_STORAGE_KEY = "agentpulse.dashboard.machineCount";

function storedCount(): number | null {
	const raw = browserStorage()?.getItem(MACHINE_COUNT_STORAGE_KEY);
	const n = raw === null || raw === undefined ? Number.NaN : Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/** How many machines an answer covers: those listed plus those rolled up. */
function machinesIn(res: Pick<HostStatsResponse, "groups" | "otherMachines">): number {
	return res.groups.length + (res.otherMachines ?? 0);
}

export interface MachineStats {
	/** The owner scope on screen's machines with their counts (the filter's options and the Group by Machine headers); null while the first answer for a scope loads. */
	groups: HostStatsGroup[] | null;
	/** The list was cut to the busiest machines. */
	groupsTruncated: boolean;
	/** Machines rolled up beyond the listed ones, and their sessions. */
	otherMachines: number;
	otherTotal: number;
	/** The last known number of machines across everyone (not the owner on screen's), which decides whether the control is drawn; it holds while a new answer loads and across visits. Null until it has ever been known. */
	machineCount: number | null;
	refresh: () => Promise<void>;
}

/**
 * The server's per-machine counts. Always about every machine, whatever machine
 * is chosen (the filter has to keep offering the others), in the owner scope and
 * scratch setting on screen. When that owner isn't everyone, one more cheap
 * request counts the machines across everyone, so choosing another owner can't
 * make the control come and go. `refresh` is called together with the page's own
 * counts, so it adds no timer of its own. An answer lands only while the scope it
 * was asked under is still the live one, and only if it says it covered every
 * machine and the owner scope that was asked for.
 */
export function useMachineStats(scope: DashboardScope | null): MachineStats {
	const [groups, setGroups] = useState<HostStatsGroup[] | null>(null);
	const [cut, setCut] = useState({ groupsTruncated: false, otherMachines: 0, otherTotal: 0 });
	const [machineCount, setMachineCount] = useState<number | null>(storedCount);
	const viewerUserId = useUserStore((s) => s.userId);
	const everyMachine = scope === null ? null : { ...scope, host: HOST_ALL };
	const scopeRef = useRef(everyMachine);
	scopeRef.current = everyMachine;
	const key = requestKey(everyMachine);
	const isCurrent = useRequestGuard(key);
	const generationRef = useRef(0);

	const rememberCount = useCallback((count: number) => {
		setMachineCount(count);
		try {
			browserStorage()?.setItem(MACHINE_COUNT_STORAGE_KEY, String(count));
		} catch {
			// Storage refused the write: the count still holds for this visit.
		}
	}, []);

	const load = useCallback(async () => {
		const asked = scopeRef.current;
		if (!asked) return;
		const askedKey = requestKey(asked);
		const generation = generationRef.current;
		const valid = (res: HostStatsResponse & { ownerScope?: unknown }, owner: string) =>
			echoMatchesRequest(owner, viewerUserId, res.ownerScope) &&
			res.hostFilter !== undefined &&
			echoMatchesHost(HOST_ALL, res.hostFilter);
		const stale = () => generation !== generationRef.current || !isCurrent(askedKey);
		const everyone = asked.owner === OWNER_ALL;
		const [scoped, wide] = await Promise.all([
			api.getStatsByHost(scopedQuery(asked)).catch(() => null),
			everyone
				? Promise.resolve(null)
				: api.getStatsByHost(scopedQuery({ ...asked, owner: OWNER_ALL })).catch(() => null),
		]);
		if (stale()) return;
		if (scoped && valid(scoped, asked.owner)) {
			setGroups(scoped.groups);
			setCut({
				groupsTruncated: scoped.groupsTruncated ?? false,
				otherMachines: scoped.otherMachines ?? 0,
				otherTotal: scoped.otherTotal ?? 0,
			});
			if (everyone) rememberCount(machinesIn(scoped));
		}
		if (wide && valid(wide, OWNER_ALL)) rememberCount(machinesIn(wide));
	}, [isCurrent, viewerUserId, rememberCount]);

	useEffect(() => {
		generationRef.current += 1;
		setGroups(null);
		if (key === "") return;
		void load();
	}, [key, load]);

	return { groups, ...cut, machineCount, refresh: load };
}
