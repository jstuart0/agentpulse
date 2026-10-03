import { AlertTriangle } from "lucide-react";
import {
	EXCLUDE_CARD,
	EXCLUDE_CARD_ANCHOR,
	EXCLUDE_RULES_PATH,
	type ExcludeSenderRow,
} from "../lib/setup-steps.js";
import { InlineCode } from "./InlineCode.js";

// Below the sm breakpoint each row stacks (sender above its text) instead of squeezing two columns into 320px.
const ROW_LAYOUT = "block sm:table-row";
const CAUTION_CLASSES = `${ROW_LAYOUT} bg-amber-500/10 text-amber-700 dark:text-amber-300 border-t border-amber-500/40`;

/**
 * Setup page card: how to keep sessions in chosen directories from being
 * reported, and which sender applies the rules. The Claude-direct row is the
 * page's amber note (words and an icon, never colour alone).
 */
export function ExcludeDirectoriesCard({
	onCopy,
	showTeamCopy,
}: {
	onCopy: (text: string, label: string) => void | Promise<void>;
	showTeamCopy: boolean;
}) {
	const [beforePath, afterPath] = EXCLUDE_CARD.intro.split(EXCLUDE_RULES_PATH);
	return (
		<section
			id={EXCLUDE_CARD_ANCHOR}
			aria-labelledby={`${EXCLUDE_CARD_ANCHOR}-title`}
			className="border border-border bg-card rounded-lg p-5 mt-4 scroll-mt-20"
		>
			<h2
				id={`${EXCLUDE_CARD_ANCHOR}-title`}
				tabIndex={-1}
				className="text-sm font-semibold mb-2 focus:outline-none"
			>
				{EXCLUDE_CARD.title}
			</h2>
			<p className="text-xs text-muted-foreground mb-3">
				{beforePath}
				<code className="font-mono text-foreground">{EXCLUDE_RULES_PATH}</code>
				{afterPath}
			</p>

			<div className="space-y-2 mb-4">
				{EXCLUDE_CARD.commands.map(({ label, command }) => (
					<div key={command} className="flex gap-2 items-start">
						<code className="flex-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
							{command}
						</code>
						<button
							type="button"
							onClick={() => void onCopy(command, `${label}: command copied`)}
							aria-label={`Copy: ${command}`}
							className="min-h-11 min-w-11 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors sm:min-h-0 sm:min-w-0"
						>
							Copy
						</button>
					</div>
				))}
			</div>

			<table className="w-full text-left text-xs mb-3">
				<thead className="sr-only sm:not-sr-only sm:table-header-group">
					<tr className="text-muted-foreground">
						<th scope="col" className="w-[7.5rem] sm:w-48 py-1 pr-2 font-medium align-bottom">
							Who sends
						</th>
						<th scope="col" className="py-1 font-medium align-bottom">
							What applies your rules
						</th>
					</tr>
				</thead>
				<tbody>
					{EXCLUDE_CARD.senders.map((row) => (
						<SenderTableRow key={row.sender} row={row} />
					))}
				</tbody>
			</table>

			<p className="text-xs text-muted-foreground mb-2">{EXCLUDE_CARD.windowsNote}</p>
			<p className="text-xs text-muted-foreground">{EXCLUDE_CARD.newEventsNote}</p>
			{showTeamCopy && (
				<p className="text-xs text-muted-foreground mt-2">
					<InlineCode text={EXCLUDE_CARD.teamNote} />
				</p>
			)}
		</section>
	);
}

function SenderTableRow({ row }: { row: ExcludeSenderRow }) {
	if (row.caution) {
		return (
			<tr className={CAUTION_CLASSES}>
				<th
					scope="row"
					className="block px-2 pt-2 font-medium sm:table-cell sm:py-2 sm:pr-2 sm:align-top"
				>
					<AlertTriangle aria-hidden="true" className="mb-0.5 mr-1 inline h-3.5 w-3.5" />
					{row.sender}
				</th>
				<td className="block px-2 pb-2 pt-1 sm:table-cell sm:py-2 sm:pl-0 sm:align-top">
					<InlineCode text={row.applies} />
				</td>
			</tr>
		);
	}
	return (
		<tr className={`${ROW_LAYOUT} border-t border-border`}>
			<th
				scope="row"
				className="block pt-2 font-medium text-foreground sm:table-cell sm:py-2 sm:pr-2 sm:align-top"
			>
				{row.sender}
			</th>
			<td className="block pb-2 pt-1 text-muted-foreground sm:table-cell sm:py-2 sm:align-top">
				<InlineCode text={row.applies} />
			</td>
		</tr>
	);
}
