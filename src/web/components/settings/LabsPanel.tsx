import { useEffect } from "react";
import type { LabsFlag } from "../../lib/api.js";
import { useLabsStore } from "../../stores/labs-store.js";

/**
 * Labs settings panel. Shows every flag from the server registry with
 * its description and a toggle. Enabling a flag makes the related
 * surface visible in the app; disabling hides it and drops the Labs
 * badge until it's graduated.
 */
export function LabsPanel() {
	const flags = useLabsStore((s) => s.flags);
	const registry = useLabsStore((s) => s.registry);
	const loading = useLabsStore((s) => s.loading);
	const error = useLabsStore((s) => s.error);
	const load = useLabsStore((s) => s.load);
	const setFlag = useLabsStore((s) => s.setFlag);

	useEffect(() => {
		if (!flags && !loading) void load();
	}, [flags, loading, load]);

	if (!flags) {
		return (
			<div className="text-sm text-muted-foreground">
				{loading ? "Loading labs flags…" : (error ?? "No labs data.")}
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{registry.map((def) => (
				<div
					key={def.key}
					className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/40 px-3 py-2"
				>
					<div className="min-w-0">
						<div className="text-sm font-medium text-foreground">{def.label}</div>
						<div className="text-xs text-muted-foreground">{def.description}</div>
					</div>
					<ToggleSwitch
						enabled={flags[def.key as LabsFlag]}
						onChange={(v) => void setFlag(def.key as LabsFlag, v)}
						label={`Toggle ${def.label}`}
					/>
				</div>
			))}
			{error && <div className="text-xs text-red-300">{error}</div>}
		</div>
	);
}

function ToggleSwitch({
	enabled,
	onChange,
	label,
}: {
	enabled: boolean;
	onChange: (v: boolean) => void;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={enabled}
			aria-label={label}
			onClick={() => onChange(!enabled)}
			className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
				enabled ? "bg-primary" : "bg-muted"
			}`}
		>
			<span
				className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${
					enabled ? "translate-x-[1.125rem]" : "translate-x-[0.125rem]"
				}`}
			/>
		</button>
	);
}
