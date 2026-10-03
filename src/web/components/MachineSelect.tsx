import type { Ref } from "react";
import { useId } from "react";
import type { HostParam } from "../lib/host-scope.js";
import { cn } from "../lib/utils.js";
import type { MachineOption } from "../pages/dashboard-machines.js";

/**
 * Which machine's sessions, by name: every machine, each one the server counted
 * (with how many sessions it has in this view), and the sessions with no
 * machine. The same kind of control as the Owner select, and it narrows the
 * view the same way: nothing is hidden from anyone, and a machine's name is
 * only what its events said it was.
 */
export function MachineSelect({
	host,
	options,
	onChange,
	selectRef,
	className,
}: {
	host: HostParam;
	options: readonly MachineOption[];
	onChange: (host: HostParam) => void;
	selectRef?: Ref<HTMLSelectElement>;
	className?: string;
}) {
	const id = useId();
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<label htmlFor={id} className="text-xs text-hint">
				Machine
			</label>
			<select
				id={id}
				ref={selectRef}
				value={host}
				onChange={(e) => onChange(e.target.value)}
				title="Show only the sessions running on one machine. A machine's name is what its relay or supervisor reported; it narrows the view and decides nothing about access."
				className="min-h-[44px] min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring md:min-h-0 md:max-w-[14rem] md:flex-none"
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}
