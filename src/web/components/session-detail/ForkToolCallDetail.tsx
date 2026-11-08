import { useCallback, useEffect, useState } from "react";
import type { ForkToolCallDto } from "../../../shared/fork-tool-calls.js";
import { ApiError, getForkToolCall } from "../../lib/api.js";
import type { ToolDetailAccess } from "../../lib/session-action-access.js";
import {
	DETAIL_ARRIVING,
	DETAIL_FORBIDDEN,
	DETAIL_INPUT_HEADING,
	DETAIL_KEPT,
	DETAIL_LOAD_FAILED,
	DETAIL_NOT_CAPTURED,
	DETAIL_OUTPUT_HEADING,
	DETAIL_REDACTED,
	DETAIL_TRUNCATED,
	accessNote,
	missingDetailState,
} from "./fork-detail-availability.js";

/** What loading one call's detail came to. */
export type DetailLoad =
	| { state: "loading" }
	| { state: "loaded"; call: ForkToolCallDto }
	| { state: "arriving" }
	| { state: "not_captured" }
	| { state: "forbidden" }
	| { state: "failed" };

/** The text of a field, or null when it has none. Shown only as text nodes: it came from a tool. */
function TextBlock({
	heading,
	text,
	truncated,
}: { heading: string; text: string | null; truncated: boolean }) {
	if (text === null || text === "") return null;
	return (
		<section aria-label={heading}>
			<div className="flex items-center justify-between gap-2">
				<h4 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
					{heading}
				</h4>
				<CopyButton text={text} label={`Copy ${heading.toLowerCase()}`} />
			</div>
			<pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 font-mono text-xs [overflow-wrap:anywhere]">
				{text}
			</pre>
			{truncated ? <p className="mt-1 text-xs text-muted-foreground">{DETAIL_TRUNCATED}</p> : null}
		</section>
	);
}

function CopyButton({ text, label }: { text: string; label: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label={label}
			className="min-h-11 rounded px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary md:min-h-0"
			onClick={() => {
				void navigator.clipboard
					?.writeText(text)
					.then(() => setCopied(true))
					.catch(() => setCopied(false));
			}}
		>
			{copied ? "Copied" : "Copy"}
		</button>
	);
}

/** The panel for a load result. Pure: everything it shows comes in through its props. */
export function ForkToolCallPanel({
	id,
	load,
	access,
	ownerName,
	onRetry,
}: {
	id: string;
	load: DetailLoad;
	access: ToolDetailAccess;
	ownerName: string | null;
	onRetry: () => void;
}) {
	const note = accessNote(access, ownerName);
	return (
		<div id={id} className="mt-2 space-y-2 rounded-lg border border-border bg-card/40 p-3 text-sm">
			{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
			{load.state === "loading" ? (
				<div aria-busy="true" className="animate-pulse space-y-2">
					<div className="h-3 w-1/4 rounded bg-muted" />
					<div className="h-16 rounded bg-muted" />
				</div>
			) : load.state === "loaded" ? (
				<>
					<TextBlock
						heading={DETAIL_INPUT_HEADING}
						text={load.call.input}
						truncated={load.call.inputTruncated}
					/>
					<TextBlock
						heading={DETAIL_OUTPUT_HEADING}
						text={load.call.output}
						truncated={load.call.outputTruncated}
					/>
					{load.call.redacted ? (
						<p className="text-xs text-muted-foreground">{DETAIL_REDACTED}</p>
					) : null}
					<p className="text-xs text-muted-foreground">{DETAIL_KEPT}</p>
				</>
			) : load.state === "failed" ? (
				<div className="flex items-center gap-2">
					<p role="alert">{DETAIL_LOAD_FAILED}</p>
					<button
						type="button"
						onClick={onRetry}
						className="min-h-11 rounded border border-border px-2 text-xs md:min-h-0"
					>
						Try again
					</button>
				</div>
			) : (
				<p>
					{load.state === "forbidden"
						? DETAIL_FORBIDDEN
						: load.state === "arriving"
							? DETAIL_ARRIVING
							: DETAIL_NOT_CAPTURED}
				</p>
			)}
		</div>
	);
}

/**
 * Loads one call's detail when it is opened (never before, so closed rows cost nothing) and shows it.
 * `turnEndedAt` decides what a missing record means: still arriving, or not captured.
 */
export function ForkToolCallDetail({
	panelId,
	sessionId,
	toolUseId,
	access,
	ownerName,
	turnEndedAt,
	fetchCall = getForkToolCall,
	now = Date.now,
}: {
	panelId: string;
	sessionId: string;
	toolUseId: string;
	access: ToolDetailAccess;
	ownerName: string | null;
	turnEndedAt: number | null;
	fetchCall?: (sessionId: string, toolUseId: string) => Promise<ForkToolCallDto>;
	now?: () => number;
}) {
	const [load, setLoad] = useState<DetailLoad>({ state: "loading" });
	const [attempt, setAttempt] = useState(0);
	const run = useCallback(() => {
		setLoad({ state: "loading" });
		setAttempt((n) => n + 1);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
	useEffect(() => {
		let live = true;
		fetchCall(sessionId, toolUseId).then(
			(call) => live && setLoad({ state: "loaded", call }),
			(error: unknown) => {
				if (!live) return;
				if (error instanceof ApiError && error.status === 404) {
					setLoad({ state: missingDetailState(turnEndedAt, now()) });
				} else if (error instanceof ApiError && error.status === 403) {
					setLoad({ state: "forbidden" });
				} else {
					setLoad({ state: "failed" });
				}
			},
		);
		return () => {
			live = false;
		};
	}, [attempt, sessionId, toolUseId]);
	return (
		<ForkToolCallPanel
			id={panelId}
			load={load}
			access={access}
			ownerName={ownerName}
			onRetry={run}
		/>
	);
}
