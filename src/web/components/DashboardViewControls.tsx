import { ChevronDown } from "lucide-react";
import type { Ref } from "react";
import { useId, useState } from "react";
import type { HostParam } from "../lib/host-scope.js";
import { cn } from "../lib/utils.js";
import { GROUP_BY_LABEL, type GroupBy } from "../pages/dashboard-groups.js";
import { type MachineOption, machineLabel } from "../pages/dashboard-machines.js";
import { MachineSelect } from "./MachineSelect.js";

const SELECT_CLASS =
	"min-h-[44px] min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring md:min-h-0 md:flex-none";
const LABEL_CLASS = "text-xs text-hint";

/** The Machine select's state, when the control is on offer (see machineControlVisible). */
export interface MachineControl {
	host: HostParam;
	options: readonly MachineOption[];
	onChange: (host: HostParam) => void;
	selectRef?: Ref<HTMLSelectElement>;
}

/**
 * Machine, Group by and Show scratch, in the filter row beside the search box.
 * (Whose sessions is the page header's: one axis in one place.) Under md they sit
 * behind one disclosure whose button already says what is chosen ("build-01 ·
 * Grouped by Project"), so a phone gets one extra row, not two.
 */
export function DashboardViewControls({
	groupBy,
	groupOptions,
	onGroupByChange,
	machine,
	showScratch,
	onShowScratchChange,
	scratchHidden,
}: {
	groupBy: GroupBy;
	/** The groupings on offer, in order. */
	groupOptions: readonly GroupBy[];
	onGroupByChange: (groupBy: GroupBy) => void;
	/** Null when there is only one machine to speak of: the select isn't drawn. */
	machine: MachineControl | null;
	showScratch: boolean;
	onShowScratchChange: (show: boolean) => void;
	/** How many sessions the scratch exclusion leaves out of every number (the server's count). */
	scratchHidden: number;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	const groupId = useId();

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-controls={panelId}
				className="flex min-h-[44px] w-full items-center justify-between gap-2 rounded-md border border-border px-3 text-xs text-foreground md:hidden"
			>
				<span className="truncate">
					{machine && machine.host !== "" ? `${machineLabel(machine.host)} · ` : ""}
					Grouped by {GROUP_BY_LABEL[groupBy]} · scratch {showScratch ? "shown" : "hidden"}
				</span>
				<ChevronDown
					aria-hidden="true"
					className={cn("h-4 w-4 shrink-0 transition-transform", open && "rotate-180")}
				/>
			</button>
			<div
				id={panelId}
				className={cn(
					"w-full flex-col gap-3 md:flex md:w-auto md:flex-row md:flex-wrap md:items-center",
					open ? "flex" : "hidden",
				)}
			>
				{machine && (
					<MachineSelect
						host={machine.host}
						options={machine.options}
						onChange={machine.onChange}
						selectRef={machine.selectRef}
					/>
				)}
				<div className="flex items-center gap-2">
					<label htmlFor={groupId} className={LABEL_CLASS}>
						Group by
					</label>
					<select
						id={groupId}
						value={groupBy}
						onChange={(e) => onGroupByChange(e.target.value as GroupBy)}
						className={SELECT_CLASS}
					>
						{groupOptions.map((value) => (
							<option key={value} value={value}>
								{GROUP_BY_LABEL[value]}
							</option>
						))}
					</select>
				</div>
				<ScratchToggle
					showScratch={showScratch}
					onChange={onShowScratchChange}
					scratchHidden={scratchHidden}
				/>
			</div>
		</>
	);
}

/** "Show scratch workspaces", with how many are left out of every number while it is off. */
export function ScratchToggle({
	showScratch,
	onChange,
	scratchHidden,
}: {
	showScratch: boolean;
	onChange: (show: boolean) => void;
	scratchHidden: number;
}) {
	return (
		<label
			className="inline-flex min-h-[44px] cursor-pointer select-none items-center gap-2 text-xs text-hint md:min-h-0"
			title="When on, sessions whose project is tagged scratch (AI-initiated workspaces) are counted and listed, with a dashed border and amber chip. Hidden by default."
		>
			<input
				type="checkbox"
				checked={showScratch}
				onChange={(e) => onChange(e.target.checked)}
				className="h-3.5 w-3.5 rounded border-input bg-background text-primary focus:ring-1 focus:ring-ring"
			/>
			Show scratch workspaces
			{!showScratch && scratchHidden > 0 && (
				<span className="text-[10px] text-hint">({scratchHidden} hidden)</span>
			)}
		</label>
	);
}
