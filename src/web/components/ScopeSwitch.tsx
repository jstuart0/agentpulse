import { OWNER_ALL, OWNER_ME, type OwnerParam } from "../lib/owner-scope.js";
import { cn } from "../lib/utils.js";
import { pressedSegment } from "../pages/dashboard-scope.js";

const OPTIONS: Array<{ value: typeof OWNER_ME | typeof OWNER_ALL; label: string }> = [
	{ value: OWNER_ME, label: "Mine" },
	{ value: OWNER_ALL, label: "Everyone" },
];

/**
 * Mine | Everyone. The page's subtitle says what it does (it narrows the view
 * and hides nothing from anyone). Two toggle buttons, so Space and Enter both
 * work, full width and 44px tall on narrow screens. It is one control with the
 * Owner select beside it: a segment looks pressed only for the owner it stands
 * for, so with a person, Service keys or Unassigned chosen (or before the
 * default is known, `owner` null) neither is, and both still switch the view.
 */
export function ScopeSwitch({
	owner,
	onChoose,
}: {
	owner: OwnerParam | null;
	onChoose: (owner: OwnerParam) => void;
}) {
	const pressed = pressedSegment(owner);
	return (
		<fieldset
			aria-label="Whose sessions"
			className="m-0 grid w-full min-w-0 grid-cols-2 gap-0.5 rounded-lg border-0 bg-muted p-1 md:inline-flex md:w-auto"
		>
			{OPTIONS.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={pressed === option.value}
					onClick={() => owner !== option.value && onChoose(option.value)}
					className={cn(
						"flex min-h-[44px] items-center justify-center rounded-md px-4 text-xs font-medium transition-colors md:min-h-0 md:py-1.5",
						"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
						pressed === option.value
							? "bg-background text-foreground shadow-sm"
							: "text-hint hover:text-foreground",
					)}
				>
					{option.label}
				</button>
			))}
		</fieldset>
	);
}
