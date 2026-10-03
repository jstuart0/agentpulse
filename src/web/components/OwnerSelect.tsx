import type { Ref } from "react";
import { useId } from "react";
import type { DirectoryEntry } from "../lib/owner-label.js";
import { OWNER_ALL, type OwnerParam } from "../lib/owner-scope.js";

const PENDING_VALUE = "";
import { cn } from "../lib/utils.js";
import {
	ownerFromSelectValue,
	ownerOptions,
	selectValueForOwner,
} from "../pages/dashboard-scope.js";

/**
 * Whose sessions, by name: Everyone, you, each person, service keys,
 * unassigned. The same axis as the Mine | Everyone switch beside it, which is
 * why it sits there. "Mine" always reads as You, even before the directory has
 * loaded.
 */
export function OwnerSelect({
	owner,
	onChange,
	people,
	viewerUserId,
	selectRef,
	className,
}: {
	/** Null until the default is known: the select then shows a neutral placeholder rather than "Everyone". */
	owner: OwnerParam | null;
	onChange: (owner: OwnerParam) => void;
	people: readonly DirectoryEntry[];
	viewerUserId: string | null;
	selectRef?: Ref<HTMLSelectElement>;
	className?: string;
}) {
	const id = useId();
	const options = ownerOptions(people, viewerUserId, owner ?? OWNER_ALL);
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<label htmlFor={id} className="text-xs text-hint">
				Owner
			</label>
			<select
				id={id}
				ref={selectRef}
				value={owner === null ? PENDING_VALUE : selectValueForOwner(owner, viewerUserId)}
				onChange={(e) => onChange(ownerFromSelectValue(e.target.value, viewerUserId))}
				className="min-h-[44px] min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring md:min-h-0 md:max-w-[12rem] md:flex-none"
			>
				{owner === null && (
					<option value={PENDING_VALUE} disabled>
						…
					</option>
				)}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
	);
}
