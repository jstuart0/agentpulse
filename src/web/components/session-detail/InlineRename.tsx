import { useState } from "react";
import { api } from "../../lib/api.js";

/**
 * Small click-to-edit rename field for the session header. Kept in its
 * own file because it holds internal state and handles a side effect;
 * per the WS5 extraction guidelines, components with state live apart.
 */
export function InlineRename({
	sessionId,
	currentName,
	onRenamed,
}: {
	sessionId: string;
	currentName: string;
	onRenamed: (name: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(currentName);

	async function save() {
		if (!value.trim()) {
			setEditing(false);
			return;
		}
		await api.renameSession(sessionId, value.trim());
		onRenamed(value.trim());
		setEditing(false);
	}

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
	);
}
