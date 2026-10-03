import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentType } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import {
	type NameSource,
	type ResetButtonState,
	nameSourceCaption,
	nameSourceTitle,
	resetButtonState,
	shouldShowPin,
} from "../../lib/name-source.js";

/**
 * Small click-to-edit rename field for the session header. Kept in its
 * own file because it holds internal state and handles a side effect;
 * per the WS5 extraction guidelines, components with state live apart.
 *
 * D14: also owns the name-pin caption and the "Use agent name" reset
 * control — header only, never SessionCard (that's a compact list-row
 * component with no room for the extra state this needs).
 */
export function InlineRename({
	sessionId,
	currentName,
	nameSource,
	nativeName,
	agentType,
	onRenamed,
	onRefresh,
	renameBlockedReason = null,
}: {
	sessionId: string;
	currentName: string;
	nameSource: NameSource;
	nativeName: string | null;
	agentType: AgentType;
	onRenamed: (name: string) => void;
	/** F95: re-fetch the session after a reset instead of waiting for a poll. */
	onRefresh?: () => Promise<void> | void;
	/** Why renaming isn't allowed for this viewer (team mode, someone else's session), or null when it is. */
	renameBlockedReason?: string | null;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(currentName);
	const [resetState, setResetState] = useState<ResetButtonState>("idle");
	const [announcement, setAnnouncement] = useState("");
	// The reason shows when someone tries, not as a permanent line under every name.
	const [triedBlocked, setTriedBlocked] = useState(false);
	const nameRef = useRef<HTMLSpanElement>(null);

	// F102: a stale error doesn't outlive the name it was about.
	// biome-ignore lint/correctness/useExhaustiveDependencies: currentName/nameSource are the triggers, not values read inside
	useEffect(() => {
		setResetState((state) => (state === "error" ? resetButtonState(state, "reset") : state));
	}, [currentName, nameSource]);

	async function save() {
		if (!value.trim()) {
			setEditing(false);
			return;
		}
		try {
			await api.renameSession(sessionId, value.trim());
			onRenamed(value.trim());
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't rename the session."));
		}
		setEditing(false);
	}

	async function useAgentName() {
		// F96: aria-disabled instead of disabled keeps focus on the button, so
		// a click while pending is ignored here.
		if (resetState === "pending") return;
		const target = nativeName;
		setResetState(resetButtonState(resetState, "start"));
		try {
			await api.resetSessionName(sessionId);
			// The WebSocket broadcast also carries the change (D14/F48); the
			// explicit refresh makes it immediate even without a socket (F95).
			await onRefresh?.();
			setResetState(resetButtonState("pending", "success"));
			// The button unmounts once the pin clears: hand focus to the name
			// and say what happened.
			nameRef.current?.focus();
			if (target) setAnnouncement(`Name changed to ${target}`);
		} catch {
			setResetState(resetButtonState("pending", "error"));
		}
	}

	const showPin = nameSource === "user" && shouldShowPin(nameSource, nativeName, agentType);
	const caption =
		showPin || nameSource === "native"
			? nameSourceCaption(nameSource, nativeName, currentName, agentType)
			: null;
	const showUseAgentName =
		nameSource === "user" &&
		nativeName !== null &&
		nativeName !== currentName &&
		renameBlockedReason === null;

	if (editing) {
		return (
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") save();
					if (e.key === "Escape") setEditing(false);
				}}
				className="font-mono font-bold text-sm bg-background border border-primary/30 rounded px-2.5 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-primary"
			/>
		);
	}

	return (
		<span className="inline-flex items-center gap-1.5 flex-wrap">
			<span
				ref={nameRef}
				// Programmatic focus target only (F96); keyboard rename on this chip
				// is a separate follow-up.
				tabIndex={-1}
				onClick={
					renameBlockedReason
						? () => setTriedBlocked(true)
						: () => {
								setEditing(true);
								setValue(currentName);
							}
				}
				aria-disabled={renameBlockedReason ? true : undefined}
				aria-describedby={renameBlockedReason && triedBlocked ? "rename-blocked-reason" : undefined}
				title={renameBlockedReason ?? "Click to rename"}
				className={`font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${
					renameBlockedReason ? "cursor-default" : "cursor-pointer hover:bg-primary/20"
				}`}
			>
				{currentName}
			</span>
			{renameBlockedReason && triedBlocked && (
				<output id="rename-blocked-reason" className="basis-full text-[11px] text-hint">
					{renameBlockedReason}
				</output>
			)}
			{caption && (
				<span
					className="text-[10px] text-muted-foreground truncate max-w-[10rem] md:max-w-[18rem]"
					title={nameSourceTitle(nameSource, nativeName, currentName, agentType) ?? caption}
				>
					{caption}
				</span>
			)}
			{showUseAgentName && (
				<button
					type="button"
					onClick={useAgentName}
					aria-disabled={resetState === "pending"}
					// F199: the caption carrying this name may be truncated, so the
					// button itself names it too.
					title={`Use agent name "${nativeName}"`}
					aria-label={`Use agent name "${nativeName}"`}
					className="relative before:absolute before:-inset-y-3 before:inset-x-0 md:before:hidden rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors aria-disabled:opacity-50 aria-disabled:cursor-wait"
				>
					{resetState === "pending" ? "Applying…" : "Use agent name"}
				</button>
			)}
			{resetState === "error" && (
				<span role="alert" className="text-[10px] text-red-600 dark:text-red-400">
					Couldn't reset the name — try again
				</span>
			)}
			<span className="sr-only" aria-live="polite">
				{announcement}
			</span>
		</span>
	);
}
