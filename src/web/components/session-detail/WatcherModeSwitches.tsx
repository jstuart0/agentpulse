import type { AiWatcherConfig, PromptDelivery } from "../../lib/api.js";
import {
	AUTO_COUNTER_NOTE,
	BOTH_MODES_OFF,
	CONTINUE_LABEL,
	NOTIFY_LABEL,
	autoCounter,
	promptDeliveryNotice,
} from "./watcher-panel-model.js";

interface WatcherModeSwitchesProps {
	config: AiWatcherConfig;
	delivery: PromptDelivery | null;
	onToggle: (key: "notifyEnabled" | "continueEnabled", value: boolean) => void;
	onReset: () => void;
}

function Switch({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<label className="flex min-h-[44px] cursor-pointer items-start gap-2 text-xs md:min-h-0">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="mt-0.5 h-4 w-4 flex-shrink-0"
			/>
			<span>{label}</span>
		</label>
	);
}

/**
 * The two modes, what Continue can do for this session, and the counter of
 * automatic sends with its Reset once the cap is reached.
 */
export function WatcherModeSwitches({
	config,
	delivery,
	onToggle,
	onReset,
}: WatcherModeSwitchesProps) {
	const notice = promptDeliveryNotice(config.continueEnabled, delivery);
	const counter = autoCounter(config);
	const bothOff = !config.notifyEnabled && !config.continueEnabled;
	return (
		<div className="space-y-2 border-t border-border pt-3">
			<Switch
				label={NOTIFY_LABEL}
				checked={config.notifyEnabled}
				onChange={(v) => onToggle("notifyEnabled", v)}
			/>
			<Switch
				label={CONTINUE_LABEL}
				checked={config.continueEnabled}
				onChange={(v) => onToggle("continueEnabled", v)}
			/>
			{bothOff && <p className="text-[11px] text-amber-300">{BOTH_MODES_OFF}</p>}
			{notice && (
				<p
					role="note"
					className="rounded border border-border bg-muted/30 p-2 text-[11px] text-hint"
				>
					{notice}
				</p>
			)}
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span className={counter.capReached ? "text-amber-300" : undefined}>{counter.text}</span>
				{counter.capReached && (
					<button
						type="button"
						onClick={onReset}
						className="min-h-[44px] rounded border border-border px-2 py-1 text-xs text-foreground hover:bg-muted/50 md:min-h-0"
					>
						Reset
					</button>
				)}
				<span className="text-[10px]">{AUTO_COUNTER_NOTE}</span>
			</div>
		</div>
	);
}
