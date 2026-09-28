import { useState } from "react";
import type { AgentType } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import {
	type NameSource,
	type ResetButtonState,
	nameSourceCaption,
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
}: {
	sessionId: string;
	currentName: string;
	nameSource: NameSource;
	nativeName: string | null;
	agentType: AgentType;
	onRenamed: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(currentName);
	const [resetState, setResetState] = useState<ResetButtonState>("idle");

	async function save() {
		if (!value.trim()) {
			setEditing(false);
			return;
		}
		await api.renameSession(sessionId, value.trim());
		onRenamed(value.trim());
		setEditing(false);
	}

	async function useAgentName() {
		setResetState(resetButtonState(resetState, "start"));
		try {
			await api.resetSessionName(sessionId);
			// The dashboard picks up the new name/nameSource from the
			// WebSocket session_updated broadcast (D14/F48) — nothing to set
			// here beyond returning the button to idle.
			setResetState(resetButtonState(resetState, "success"));
		} catch {
			setResetState(resetButtonState(resetState, "error"));
		}
	}

	const showPin = nameSource === "user" && shouldShowPin(nameSource, nativeName, agentType);
	const caption =
		showPin || nameSource === "native"
			? nameSourceCaption(nameSource, nativeName, currentName, agentType)
			: null;
	const showUseAgentName =
		nameSource === "user" && nativeName !== null && nativeName !== currentName;

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
				onClick={() => {
					setEditing(true);
					setValue(currentName);
				}}
				title="Click to rename"
				className="font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1 cursor-pointer hover:bg-primary/20 transition-colors"
			>
				{currentName}
			</span>
			{caption && (
				<span className="text-[10px] text-muted-foreground" title={caption}>
					{caption}
				</span>
			)}
			{showUseAgentName && (
				<button
					type="button"
					onClick={useAgentName}
					disabled={resetState === "pending"}
					className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
				>
					{resetState === "pending" ? "Applying…" : "Use agent name"}
				</button>
			)}
			{resetState === "error" && (
				<span role="alert" className="text-[10px] text-red-400">
					Couldn't reset the name — try again
				</span>
			)}
		</span>
	);
}
