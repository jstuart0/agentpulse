import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import { cn } from "../lib/utils.js";

export interface ChoiceOption<T extends string> {
	value: T;
	label: string;
}

interface ChoiceGroupProps<T extends string> {
	legend: ReactNode;
	value: T | null;
	options: ReadonlyArray<ChoiceOption<T>>;
	onChange: (value: T) => void;
	/** Visually hide the legend when the surrounding layout already names the group. */
	legendHidden?: boolean;
}

/**
 * A radio group built the way Setup's agent picker is (native radios, visually
 * hidden, inside labels), with the focus ring that picker lacks. Arrow keys
 * come from the native inputs; each option is a 44px target on small screens.
 * The chosen option carries a check mark as well as its colour.
 */
export function ChoiceGroup<T extends string>({
	legend,
	value,
	options,
	onChange,
	legendHidden = false,
}: ChoiceGroupProps<T>) {
	const name = useId();
	return (
		<fieldset className="m-0 min-w-0 border-0 p-0">
			<legend className={cn("mb-1.5 text-sm text-foreground", legendHidden && "sr-only")}>
				{legend}
			</legend>
			<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
				{options.map((option) => {
					const selected = value === option.value;
					return (
						<label
							key={option.value}
							className={cn(
								"flex min-h-[44px] cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-center text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring sm:min-h-0",
								selected
									? "border-primary bg-primary/10 text-teal-800 dark:text-primary"
									: "border-border text-hint hover:text-foreground",
							)}
						>
							<input
								type="radio"
								name={name}
								value={option.value}
								checked={selected}
								onChange={() => onChange(option.value)}
								className="sr-only"
							/>
							{selected && <Check className="h-4 w-4 flex-shrink-0" aria-hidden="true" />}
							{option.label}
						</label>
					);
				})}
			</div>
		</fieldset>
	);
}
