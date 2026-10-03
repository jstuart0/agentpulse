import { type ReactNode, useId } from "react";
import { ADMIN_ONLY_SETTINGS_NOTICE } from "../../lib/ownership-ui.js";

/**
 * Settings only an admin may change. For everyone else in team mode they stay
 * visible (members need to read the idle timeout and retention) but every
 * control is disabled, with the reason as text above the first one. Where
 * nothing is locked, this renders its children and nothing else.
 */
export function AdminSettingsGroup({ locked, children }: { locked: boolean; children: ReactNode }) {
	const noticeId = useId();
	if (!locked) return <>{children}</>;
	return (
		<>
			<p id={noticeId} className="mb-3 text-xs text-hint">
				{ADMIN_ONLY_SETTINGS_NOTICE}
			</p>
			<fieldset disabled aria-describedby={noticeId} className="m-0 min-w-0 border-0 p-0">
				{children}
			</fieldset>
		</>
	);
}
