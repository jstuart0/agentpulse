import "../../lib/watcher-api-errors.js";
import { useState } from "react";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { plainErrorMessage } from "../../lib/api-errors.js";
import { type AiProposal, type HitlReplyKind, type PromptDelivery, api } from "../../lib/api.js";
import { continueKindLabel, suggestionControls } from "./watcher-panel-model.js";

const PRIMARY =
	"min-h-[44px] rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40 md:min-h-0";
const OUTLINED =
	"min-h-[44px] rounded border border-border px-3 py-1.5 text-xs hover:bg-muted/40 md:min-h-0";
const QUIET = `${OUTLINED} text-muted-foreground hover:text-foreground`;

/**
 * A suggestion waiting for the person. It can be sent only when the session can
 * take a prompt and the text passed the sanitiser as stored; otherwise it is
 * copied, and (when sending would work) edited first. A refusal from the server
 * is shown in words and the card reloads, because it is out of date.
 */
export function WatcherHitlCard({
	proposal,
	delivery,
	onResolved,
	onError,
}: {
	proposal: AiProposal;
	delivery: PromptDelivery;
	onResolved: () => void;
	onError: (err: string) => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const { copy } = useCopyFeedback();
	const suggested = proposal.suggestedPrompt ?? proposal.nextPrompt ?? "";
	const [customPrompt, setCustomPrompt] = useState(suggested);
	const controls = suggestionControls(proposal, delivery);
	const kind = continueKindLabel(proposal.continueKind);

	async function act(action: HitlReplyKind) {
		setSubmitting(true);
		try {
			await api.decideAiProposal(proposal.id, {
				action,
				customPrompt: action === "custom" ? customPrompt : undefined,
				promptSha256: proposal.promptSha256,
			});
		} catch (err) {
			onError(plainErrorMessage(err));
		} finally {
			setSubmitting(false);
			// A refusal also means this card is stale: show what the server has now.
			onResolved();
		}
	}

	const why = (proposal.rawResponse as Record<string, unknown> | null)?.why ?? null;

	return (
		<div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
			<div className="flex items-center justify-between">
				<div className="text-sm font-semibold text-amber-200">Watcher wants your approval</div>
				<span className="font-mono text-[10px] text-muted-foreground">
					{new Date(proposal.createdAt).toLocaleTimeString()}
				</span>
			</div>
			<div className="text-xs text-muted-foreground">
				Proposed next prompt{kind ? ` (${kind})` : ""}:
			</div>
			<pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-3 font-mono text-xs">
				{suggested || proposal.reportSummary || "(no content)"}
			</pre>
			{typeof why === "string" && why && (
				<div className="text-xs text-muted-foreground">Why: {why}</div>
			)}
			{controls.note && <p className="text-xs text-amber-300">{controls.note}</p>}

			{customOpen && (
				<div className="space-y-2">
					<label
						htmlFor={`custom-${proposal.id}`}
						className="text-[10px] uppercase tracking-wider text-muted-foreground"
					>
						Custom prompt
					</label>
					<textarea
						id={`custom-${proposal.id}`}
						rows={5}
						value={customPrompt}
						onChange={(e) => setCustomPrompt(e.target.value)}
						className="w-full rounded border border-border bg-background p-2 font-mono text-xs"
					/>
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				{customOpen ? (
					<>
						<button
							type="button"
							onClick={() => act("custom")}
							disabled={submitting || !customPrompt.trim()}
							className={PRIMARY}
						>
							Send custom
						</button>
						<button type="button" onClick={() => setCustomOpen(false)} className={OUTLINED}>
							Back
						</button>
					</>
				) : (
					<>
						{controls.primary === "send" ? (
							<button
								type="button"
								onClick={() => act("approve")}
								disabled={submitting || !suggested}
								className={PRIMARY}
							>
								Send to session
							</button>
						) : (
							<button
								type="button"
								onClick={() => void copy(suggested, "Prompt copied")}
								disabled={!suggested}
								className={PRIMARY}
							>
								Copy prompt
							</button>
						)}
						{controls.edit && (
							<button type="button" onClick={() => setCustomOpen(true)} className={OUTLINED}>
								{controls.primary === "copy" ? "Edit…" : "Custom…"}
							</button>
						)}
						<button
							type="button"
							onClick={() => act("decline")}
							disabled={submitting}
							className={QUIET}
						>
							Dismiss
						</button>
					</>
				)}
			</div>
		</div>
	);
}
