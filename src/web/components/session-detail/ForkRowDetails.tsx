import { useId, useState } from "react";
import type { ForkToolCallIndexEntry } from "../../../shared/fork-tool-calls.js";
import type { ToolDetailAccess } from "../../lib/session-action-access.js";
import { ForkToolCallDetail } from "./ForkToolCallDetail.js";
import {
	DETAIL_BUTTON,
	TURN_DETAIL_BUTTON,
	detailButtonLabel,
} from "./fork-detail-availability.js";

const BUTTON_CLASS =
	"min-h-11 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary md:min-h-0 md:py-0.5";

/** What a Details control needs to know about who is reading and when the turn ended. */
export interface DetailContext {
	sessionId: string;
	access: ToolDetailAccess;
	/** The session's owner as a name, or null when it has none. */
	ownerName: string | null;
}

/** "Details" under one call's row. Opening it reads that call; closed, it costs nothing. */
export function CallDetails({
	context,
	record,
	turnEndedAt,
}: {
	context: DetailContext;
	record: ForkToolCallIndexEntry;
	turnEndedAt: number | null;
}) {
	const [open, setOpen] = useState(false);
	const panelId = useId();
	return (
		<div className="mt-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				aria-label={detailButtonLabel(record.tool === "mcp" ? "MCP tool" : record.tool)}
				className={BUTTON_CLASS}
				onClick={() => setOpen((v) => !v)}
			>
				{DETAIL_BUTTON}
			</button>
			<div id={panelId}>
				{open ? (
					<ForkToolCallDetail
						panelId={`${panelId}-body`}
						sessionId={context.sessionId}
						toolUseId={record.toolUseId}
						access={context.access}
						ownerName={context.ownerName}
						turnEndedAt={turnEndedAt}
					/>
				) : null}
			</div>
		</div>
	);
}

/** "Show what ran" under a turn's "Ran without asking you" line: that turn's unasked calls, each with its Details. */
export function TurnDetails({
	context,
	records,
	turnEndedAt,
}: {
	context: DetailContext;
	records: readonly ForkToolCallIndexEntry[];
	turnEndedAt: number | null;
}) {
	const [open, setOpen] = useState(false);
	const listId = useId();
	if (records.length === 0) return null;
	return (
		<div className="mt-1">
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				className={BUTTON_CLASS}
				onClick={() => setOpen((v) => !v)}
			>
				{TURN_DETAIL_BUTTON}
			</button>
			<div id={listId}>
				{open ? (
					<ul className="mt-1 space-y-2">
						{records.map((record) => (
							<li key={record.toolUseId} className="text-xs">
								<span className="font-medium">
									{record.tool === "mcp" ? "MCP tool" : record.tool}
								</span>
								<CallDetails context={context} record={record} turnEndedAt={turnEndedAt} />
							</li>
						))}
					</ul>
				) : null}
			</div>
		</div>
	);
}
