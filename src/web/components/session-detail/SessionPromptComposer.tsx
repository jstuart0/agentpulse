import { useEffect, useState } from "react";
import type { Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";

export function SessionPromptComposer({
	session,
	onSubmitted,
}: {
	session: Session;
	onSubmitted: () => Promise<void>;
}) {
	const [prompt, setPrompt] = useState("");
	const [sending, setSending] = useState(false);
	const [interactiveControlState, setInteractiveControlState] = useState<{
		available: boolean;
		reason: string | null;
	} | null>(null);
	const isClaudeManaged = session.agentType === "claude_code" && Boolean(session.managedSession);
	const interactive = session.managedSession?.managedState === "interactive_terminal";
	const capabilitySnapshot =
		session.managedSession?.providerCapabilitySnapshot &&
		typeof session.managedSession.providerCapabilitySnapshot === "object" &&
		!Array.isArray(session.managedSession.providerCapabilitySnapshot)
			? (session.managedSession.providerCapabilitySnapshot as {
					interactiveTerminalControl?: { available: boolean; reason: string | null };
				})
			: null;
	const interactiveControlReady = interactive
		? (interactiveControlState?.available ??
			capabilitySnapshot?.interactiveTerminalControl?.available) !== false
		: true;
	const interactiveControlReason =
		interactive && !interactiveControlReady
			? interactiveControlState?.reason ||
				capabilitySnapshot?.interactiveTerminalControl?.reason ||
				"This host can launch the interactive session, but AgentPulse cannot hand prompts into the terminal yet."
			: null;
	const label = interactive ? "Send to terminal" : "Send task";
	const hint = interactive
		? "This sends your prompt into the owned interactive Claude session and keeps the terminal and workspace on the same session."
		: "This runs a follow-up headless turn inside the same Claude session and streams the visible output back here.";

	useEffect(() => {
		if (!isClaudeManaged) return;
		if (!interactive || !session.managedSession?.supervisorId) return;
		let cancelled = false;
		void api
			.getSupervisor(session.managedSession.supervisorId)
			.then((result) => {
				const supervisor = result.supervisor;
				if (cancelled) return;
				setInteractiveControlState(
					supervisor?.capabilities?.interactiveTerminalControl
						? {
								available: supervisor.capabilities.interactiveTerminalControl.available,
								reason: supervisor.capabilities.interactiveTerminalControl.reason,
							}
						: null,
				);
			})
			.catch(() => {
				if (!cancelled) setInteractiveControlState(null);
			});
		return () => {
			cancelled = true;
		};
	}, [interactive, isClaudeManaged, session.managedSession?.supervisorId]);

	if (!isClaudeManaged) return null;

	async function submit() {
		const clean = prompt.trim();
		if (!clean) return;
		setSending(true);
		try {
			await api.sendSessionPrompt(session.sessionId, clean);
			setPrompt("");
			await onSubmitted();
		} catch (error) {
			console.error("Failed to send prompt", error);
		} finally {
			setSending(false);
		}
	}

	return (
		<div className="border-t border-border bg-card/80 px-3 py-3 md:px-6">
			<div className="flex flex-col gap-3">
				<div className="text-[11px] text-muted-foreground">{hint}</div>
				<div className="flex flex-col gap-2 md:flex-row">
					<textarea
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder={
							interactive
								? "What should the interactive Claude session do next?"
								: "Describe the next task for this headless session."
						}
						disabled={!interactiveControlReady}
						className="min-h-20 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
					/>
					<div className="flex flex-col gap-2 md:w-40">
						<button
							onClick={submit}
							disabled={sending || !prompt.trim() || !interactiveControlReady}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
						>
							{sending ? "Sending..." : label}
						</button>
						<div className="text-[11px] text-muted-foreground">
							{interactiveControlReason
								? interactiveControlReason
								: interactive
									? "AgentPulse will also log the prompt in the session timeline."
									: "Visible output lands in Activity and Launch."}
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}

