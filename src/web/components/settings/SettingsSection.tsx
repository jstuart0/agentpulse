import { type ReactNode, useId } from "react";
import { type SettingsPanel, panelAnchorId } from "../../pages/settings-panels.js";
import { LabsBadge } from "../LabsBadge.js";

/**
 * A Settings card a `?panel=` link can open: it carries the panel's anchor id, and its heading
 * takes focus (the page scrolls to it and focuses it), as the Account card's does.
 */
export function SettingsSection({
	panel,
	title,
	labs = true,
	description,
	children,
}: {
	panel: SettingsPanel;
	title: string;
	/** Shows the Labs badge beside the title. */
	labs?: boolean;
	description: string;
	children?: ReactNode;
}) {
	const headingId = useId();
	return (
		<section
			id={panelAnchorId(panel)}
			aria-labelledby={headingId}
			className="border border-border bg-card rounded-lg p-5 mb-6 relative"
		>
			<div className="flex items-center gap-2 mb-1">
				<h2 id={headingId} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
					{title}
				</h2>
				{labs && <LabsBadge />}
			</div>
			<p className="text-xs text-muted-foreground mb-4">{description}</p>
			{children}
		</section>
	);
}
