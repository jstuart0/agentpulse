import { useEffect, useId, useState } from "react";
import { AGENT_METADATA } from "../../shared/constants.js";
import { buildCodexHooksFile, buildCopilotHooksFile } from "../../shared/hook-command.js";
import type { AgentType, ApiKeyInfo } from "../../shared/types.js";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";
import { useOwnershipUi } from "../hooks/useOwnershipUi.js";
import { describeApiError, keyCreationErrorMessage } from "../lib/api-errors.js";
import { api } from "../lib/api.js";
import {
	LOCAL_KEY_SCOPES,
	RELAY_KEY_NOTE,
	RELAY_KEY_SCOPES,
	REPLACE_LOCALHOST_NOTE,
	buildRelayCommand,
	isLoopbackHostname,
	withRelaySuffix,
} from "../lib/onboarding.js";
import { AUTH_STEP, codexSetupSteps, lastEventLine } from "../lib/setup-steps.js";
import { useUserStore } from "../stores/user-store.js";
import { keysForSetup } from "./team-view-state.js";

const AGENT_TOGGLE: Array<{ value: AgentType; label: string }> = [
	{ value: "claude_code", label: "Claude Code" },
	{ value: "codex_cli", label: "Codex CLI" },
	{ value: "copilot_cli", label: "Copilot CLI" },
];

const CONFIG_FILE: Record<AgentType, string> = {
	claude_code: "~/.claude/settings.json",
	codex_cli: "~/.codex/hooks.json",
	copilot_cli: "~/.copilot/hooks/agentpulse.json",
};

export function SetupPage() {
	const { copy } = useCopyFeedback();
	const [apiKey, setApiKey] = useState("");
	const serverUrl = window.location.origin;
	const [agentType, setAgentType] = useState<AgentType>("claude_code");
	const disableAuth = useUserStore((s) => s.disableAuth);
	const ownership = useOwnershipUi();
	const viewerUserId = useUserStore((s) => s.userId);
	const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
	const [keysLoaded, setKeysLoaded] = useState(false);
	const [keysError, setKeysError] = useState<string | null>(null);
	const [createKeyError, setCreateKeyError] = useState<string | null>(null);
	const [relayKeyError, setRelayKeyError] = useState<string | null>(null);
	const [newKeyName, setNewKeyName] = useState("my-laptop");
	const [creatingKey, setCreatingKey] = useState(false);
	const [relayKey, setRelayKey] = useState<string | null>(null);
	const [creatingRelayKey, setCreatingRelayKey] = useState(false);
	const [codexNamesAgentpulse, setCodexNamesAgentpulse] = useState(false);
	const codexNamesHelpId = useId();
	// D22: "Last Codex event" / "No Codex events yet" (SetupPage Codex card).
	const [lastCodexEvent, setLastCodexEvent] = useState<{ at: string; cwd: string | null } | null>(
		null,
	);
	const [lastCodexEventLoaded, setLastCodexEventLoaded] = useState(false);

	useEffect(() => {
		if (agentType !== "codex_cli") return;
		let cancelled = false;
		setLastCodexEventLoaded(false);
		api
			.getCodexProbeSessions()
			.then((res) => {
				if (cancelled) return;
				const session = res.sessions[0];
				setLastCodexEvent(session ? { at: session.lastActivityAt, cwd: session.cwd } : null);
				setLastCodexEventLoaded(true);
			})
			.catch(() => {
				if (!cancelled) setLastCodexEventLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [agentType]);

	useEffect(() => {
		if (disableAuth) {
			setKeysLoaded(true);
			return;
		}
		let cancelled = false;
		async function load() {
			try {
				const res = await api.getApiKeys();
				if (!cancelled) {
					setKeys(res.keys);
					setKeysLoaded(true);
				}
			} catch (err) {
				if (!cancelled) {
					setKeysError(describeApiError(err, err instanceof Error ? err.message : String(err)));
					setKeysLoaded(true);
				}
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [disableAuth]);

	async function handleCreateKey() {
		if (!newKeyName.trim()) return;
		setCreatingKey(true);
		setCreateKeyError(null);
		try {
			// Hook-setup keys are ingest-only: they go into agent hook config and
			// must not carry management privileges. Use Settings to mint manage keys.
			const res = await api.createApiKey(newKeyName.trim(), LOCAL_KEY_SCOPES);
			setApiKey(res.key); // flow the raw key into the config blobs below
			const list = await api.getApiKeys().catch(() => ({ keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setCreateKeyError(keyCreationErrorMessage(err));
		} finally {
			setCreatingKey(false);
		}
	}

	async function handleCreateRelayKey() {
		setCreatingRelayKey(true);
		setRelayKeyError(null);
		try {
			const res = await api.createApiKey(withRelaySuffix(newKeyName), RELAY_KEY_SCOPES);
			setRelayKey(res.key);
			const list = await api.getApiKeys().catch(() => ({ keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setRelayKeyError(keyCreationErrorMessage(err));
		} finally {
			setCreatingRelayKey(false);
		}
	}

	// Team mode lists only the caller's own keys, even for an admin who can list everyone's.
	const activeKeys = keysForSetup(keys, ownership, viewerUserId);
	// F167/F177: the key is never in the command (shell history, argv); the
	// installer asks for it, and only a key minted here is offered to paste.
	const relayCommand = buildRelayCommand({ serverUrl, codexNamesAgentpulse });

	const claudeHookEvents = [
		"SessionStart",
		"SessionEnd",
		"PreToolUse",
		"PostToolUse",
		"Stop",
		"SubagentStart",
		"SubagentStop",
		"TaskCreated",
		"TaskCompleted",
		"UserPromptSubmit",
		"PermissionRequest",
		"PermissionDenied",
		"Notification",
		"PreCompact",
		"PostCompact",
		"PostToolUseFailure",
	];

	const generateClaudeConfig = () => {
		const hooks: Record<string, unknown[]> = {};
		for (const event of claudeHookEvents) {
			hooks[event] = [
				{
					matcher: "",
					hooks: [
						{
							type: "http",
							url: `${serverUrl}/api/v1/hooks`,
							async: true,
							allowedEnvVars: ["AGENTPULSE_API_KEY"],
							headers: {
								Authorization: "Bearer $AGENTPULSE_API_KEY",
								"X-Agent-Type": "claude_code",
							},
						},
					],
				},
			];
		}
		return JSON.stringify({ hooks }, null, 2);
	};

	// check-hook-event-parity.ts's drift guard extracts this list (must stay
	// in lockstep with src/shared/types.ts's CodexEvent union); also used
	// below as a defensive floor on buildCodexHooksFile's output.
	const codexHookEvents = [
		"SessionStart",
		"SessionEnd",
		"PreToolUse",
		"PostToolUse",
		"UserPromptSubmit",
		"Stop",
		"Interrupt",
		"SubagentStart",
		"SubagentStop",
		"PermissionRequest",
		"PreCompact",
		"PostCompact",
	];

	// D12/D13: the manual-copy config is direct-mode (reads
	// ~/.agentpulse/hook-auth-header, written by the auth step below) — same
	// shape the installers write, so `/hooks` trust carries over if you
	// later switch to `setup-hooks.sh`.
	const generateCodexConfig = () => {
		const text = buildCodexHooksFile({ baseUrl: serverUrl, direct: true });
		const events = Object.keys(JSON.parse(text).hooks);
		if (
			events.length !== codexHookEvents.length ||
			!codexHookEvents.every((e) => events.includes(e))
		) {
			throw new Error(
				`buildCodexHooksFile() event set drifted from the expected ${codexHookEvents.length} CodexEvent members`,
			);
		}
		return text;
	};

	// check-hook-event-parity.ts's drift guard extracts this list (must stay
	// in lockstep with src/shared/types.ts's CopilotEvent union); also used
	// below as a defensive floor on buildCopilotHooksFile's output.
	const copilotHookEvents = [
		"sessionStart",
		"sessionEnd",
		"userPromptSubmitted",
		"postToolUse",
		"postToolUseFailure",
		"agentStop",
		"subagentStart",
		"subagentStop",
		"preCompact",
		"errorOccurred",
	];

	// D12/D13: direct-mode, same as Codex's manual-copy config above.
	const generateCopilotConfig = () => {
		const text = buildCopilotHooksFile({ baseUrl: serverUrl, direct: true });
		const events = Object.keys(JSON.parse(text).hooks);
		if (
			events.length !== copilotHookEvents.length ||
			!copilotHookEvents.every((e) => events.includes(e))
		) {
			throw new Error(
				`buildCopilotHooksFile() event set drifted from the expected ${copilotHookEvents.length} CopilotEvent members`,
			);
		}
		return text;
	};

	const config =
		agentType === "claude_code"
			? generateClaudeConfig()
			: agentType === "codex_cli"
				? generateCodexConfig()
				: generateCopilotConfig();
	const configFile = CONFIG_FILE[agentType];
	const showStatusLine = agentType === "codex_cli";
	const showStatusSnippet = agentType !== "copilot_cli";
	const authStep = AUTH_STEP[agentType](apiKey, disableAuth);

	let stepCounter = 1;
	const stepApiKey = stepCounter++;
	const stepAgentType = stepCounter++;
	const stepConfig = stepCounter++;
	const stepStatusLine = showStatusLine ? stepCounter++ : null;
	const stepSupervisor = stepCounter++;
	const stepAuth = authStep ? stepCounter++ : null;
	const stepStatusSnippet = showStatusSnippet ? stepCounter++ : null;

	return (
		<div className="p-3 md:p-6 max-w-3xl">
			<h1 className="text-xl md:text-2xl font-bold text-foreground mb-2">Setup</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Configure your AI agents to report their activity to AgentPulse.
			</p>

			{/* Step 1: API Key */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{stepApiKey}
					</span>
					API Key
				</h2>

				{disableAuth ? (
					<p className="text-xs text-muted-foreground">
						This instance has <code className="font-mono text-foreground">DISABLE_AUTH=true</code>,
						so hooks don&apos;t need an API key. You can skip to step 2.
					</p>
				) : (
					<>
						<p className="text-xs text-muted-foreground mb-3">
							{ownership.showTeamCopy
								? "This key is yours. Sessions it reports are shown as yours, so use one key per machine and don't share it."
								: "Mint one key per machine."}{" "}
							{ownership.showTeamCopy ? "Your" : "Active"} keys are listed below for reference (only
							the prefix is stored — the full key is shown once at creation).
						</p>

						{keysLoaded && activeKeys.length > 0 && (
							<ul className="mb-3 space-y-1">
								{activeKeys.map((k) => (
									<li key={k.id} className="flex items-center gap-2 text-xs text-muted-foreground">
										<code className="font-mono text-foreground">{k.keyPrefix}…</code>
										<span>·</span>
										<span>{k.name}</span>
									</li>
								))}
							</ul>
						)}

						<div className="flex flex-col sm:flex-row gap-2 mb-3">
							<input
								type="text"
								value={newKeyName}
								onChange={(e) => setNewKeyName(e.target.value)}
								placeholder="Key name (e.g. macbook-pro)"
								className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={handleCreateKey}
								disabled={creatingKey || !newKeyName.trim()}
								className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creatingKey ? "Creating…" : "Create new key"}
							</button>
						</div>

						<p className="text-[11px] text-muted-foreground mb-2">
							Or paste a key you already have so the config blobs below are ready to copy:
						</p>
						<input
							type="text"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="ap_..."
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						{ownership.showTeamCopy && (
							<p className="mt-1 text-[11px] text-hint">
								A key that belongs to someone else, or a service key, will report sessions under
								that owner instead of you.
							</p>
						)}
						{apiKey?.startsWith("ap_") && (
							<p className="mt-2 text-[11px] text-emerald-700 dark:text-emerald-400">
								✓ Key staged. It will appear in the config blobs below. Save it somewhere — it
								won&apos;t be shown again.
							</p>
						)}
						{keysError && (
							<p className="mt-2 text-xs text-red-600 dark:text-red-400">
								Couldn&apos;t load keys: {keysError}
							</p>
						)}
						{createKeyError && (
							<p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
								{createKeyError}
							</p>
						)}
					</>
				)}
			</div>

			{/* Remote relay: the alternative to the manual hook steps, for other machines */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2">
					Agents on other machines? Use the relay instead of the manual hook steps below
				</h2>
				<p className="text-xs text-muted-foreground mb-3">
					Claude Code only sends hooks to localhost, so on any other machine you install a small
					relay that forwards them here. It runs as a login service, points Claude Code and Codex
					CLI at it, and installs the statusline. Re-run it anytime to update.
				</p>

				{!disableAuth && (
					<div className="mb-3">
						<p className="text-xs text-amber-700 dark:text-amber-300 mb-2">{RELAY_KEY_NOTE}</p>
						{relayKey ? (
							<div>
								<p className="text-[11px] text-muted-foreground mb-1">
									Relay key created — save it, it won&apos;t be shown again. The installer asks for
									it; paste it there.
								</p>
								<div className="flex gap-2">
									<code className="flex-1 min-w-0 break-all bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
										{relayKey}
									</code>
									<button
										type="button"
										onClick={() => void copy(relayKey, "Relay key copied")}
										className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
									>
										Copy
									</button>
								</div>
							</div>
						) : (
							<button
								type="button"
								onClick={handleCreateRelayKey}
								disabled={creatingRelayKey}
								className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creatingRelayKey ? "Creating…" : "Mint relay key"}
							</button>
						)}
						{relayKeyError && (
							<p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
								{relayKeyError}
							</p>
						)}
					</div>
				)}

				<div className="relative mb-3">
					{/* F198: overflow-wrap breaks only where the line actually overflows,
					unlike break-all, which forces a break between every character
					pair. */}
					<pre className="bg-background border border-border rounded-md p-3 pr-16 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
						<code>{relayCommand}</code>
					</pre>
					<button
						type="button"
						onClick={() => void copy(relayCommand, "Relay command copied")}
						className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						Copy
					</button>
				</div>
				{isLoopbackHostname(window.location.hostname) && (
					<p className="text-xs text-muted-foreground -mt-1 mb-3">{REPLACE_LOCALHOST_NOTE}</p>
				)}

				<label className="flex items-start gap-2 text-xs cursor-pointer">
					<input
						type="checkbox"
						checked={codexNamesAgentpulse}
						onChange={(e) => setCodexNamesAgentpulse(e.target.checked)}
						aria-describedby={codexNamesHelpId}
						className="mt-0.5 rounded border-input accent-primary"
					/>
					<span className="text-foreground">Use dashboard names in Codex too</span>
				</label>
				<p id={codexNamesHelpId} className="mt-1 pl-5 text-xs text-muted-foreground">
					Adds <code className="font-mono text-foreground">--codex-names agentpulse</code>. By
					default Codex&apos;s own thread names show on the dashboard. With this, dashboard names
					are written into Codex and replace its titles, renames made in Codex won&apos;t come back,
					and Codex sessions don&apos;t offer &ldquo;Use agent name&rdquo;.
				</p>
			</div>

			{/* Step 2: Agent Type */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{stepAgentType}
					</span>
					Agent Type
				</h2>
				<div role="radiogroup" aria-label="Agent Type" className="flex flex-col sm:flex-row gap-2">
					{AGENT_TOGGLE.map((agent) => (
						<label
							key={agent.value}
							className={`flex-1 flex items-center justify-center cursor-pointer rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
								agentType === agent.value
									? "border-primary bg-primary/10 text-primary"
									: "border-border text-muted-foreground hover:text-foreground"
							}`}
						>
							<input
								type="radio"
								name="agentType"
								value={agent.value}
								checked={agentType === agent.value}
								onChange={() => setAgentType(agent.value)}
								className="sr-only"
							/>
							{agent.label}
						</label>
					))}
				</div>
			</div>

			{/* Step 3: Configuration */}
			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{stepConfig}
					</span>
					Add to {configFile}
				</h2>
				{agentType === "claude_code" ? (
					<p className="text-xs text-muted-foreground mb-3">
						Merge this into your Claude Code settings.json. If you already have hooks, add these
						entries to each event array.
					</p>
				) : agentType === "codex_cli" ? (
					<ol className="text-xs text-muted-foreground mb-3 list-decimal list-inside space-y-1">
						{codexSetupSteps(
							lastEventLine({
								at: lastCodexEvent?.at ?? null,
								cwd: lastCodexEvent?.cwd,
								execIndexed: false,
							}),
						).map((text, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static, order-stable list
							<li key={i}>{lastCodexEventLoaded || i < 3 ? text : "Checking…"}</li>
						))}
					</ol>
				) : (
					<p className="text-xs text-muted-foreground mb-3">
						Save this as {configFile} (created automatically if{" "}
						<span className="font-mono text-foreground">copilot</span> is detected — see the
						installer commands below for an automated alternative).
					</p>
				)}
				<div className="relative">
					<pre className="bg-background border border-border rounded-md p-4 text-xs overflow-auto max-h-80">
						<code>{config}</code>
					</pre>
					<button
						type="button"
						onClick={() => void copy(config, "Hook config copied")}
						className="absolute top-2 right-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						Copy
					</button>
				</div>
			</div>

			{/* Step 4: Codex-only — Status Line integration */}
			{showStatusLine && (
				<div className="border border-border bg-card rounded-lg p-5 mb-4">
					<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
						<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
							{stepStatusLine}
						</span>
						Status Line{" "}
						<span className="text-[10px] font-mono text-primary/60 bg-primary/8 px-1.5 py-0.5 rounded">
							Codex only
						</span>
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						Codex 0.120.0+ can show the thread title in its built-in status line. In Codex, run{" "}
						<span className="font-mono text-foreground">/statusline</span> and enable{" "}
						<span className="font-mono text-foreground">thread-title</span>. Then run{" "}
						<span className="font-mono text-foreground">/rename &lt;session-name&gt;</span> to match
						the AgentPulse name.
					</p>
				</div>
			)}

			{/* Copilot: observed-only notice — no equivalent to Codex's status
			    line integration, and no native-name source (D14/Pattern D), so
			    Copilot sessions always keep AgentPulse's generated name. */}
			{agentType === "copilot_cli" && (
				<div className="border border-fuchsia-500/20 bg-fuchsia-500/5 rounded-lg p-5 mb-4">
					<p className="text-xs text-muted-foreground">
						<span className="font-medium text-foreground">Observed only.</span>{" "}
						{AGENT_METADATA.copilot_cli.observeOnlyHint} Copilot sessions keep AgentPulse's
						generated name — Copilot has no way to report its own session name back.
					</p>
				</div>
			)}

			<div className="border border-border bg-card rounded-lg p-5 mb-4">
				<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
					<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
						{stepSupervisor}
					</span>
					Supervisor Enrollment
				</h2>
				<p className="text-xs text-muted-foreground">
					For orchestration and managed sessions, create host enrollment tokens on the{" "}
					<span className="font-mono text-foreground">Hosts</span> page. That issues a one-time
					token a machine can exchange for a persistent scoped supervisor credential. Use{" "}
					<span className="font-mono text-foreground">Rotate</span> to re-enroll a host and replace
					its credential, or <span className="font-mono text-foreground">Revoke</span> to cut off
					future supervisor access.
				</p>
			</div>

			{/* Auth step (D13) — env var for Claude, the hook-auth-header file
			    for command-hook agents (Codex, Copilot) */}
			{authStep && (
				<div className="border border-border bg-card rounded-lg p-5 mb-4">
					<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
						<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
							{stepAuth}
						</span>
						{authStep.title}
					</h2>
					<p className="text-xs text-muted-foreground mb-3">{authStep.description}</p>
					<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-x-auto">
						<code>{authStep.command}</code>
					</pre>
					{authStep.windowsCommand && (
						<>
							<p className="text-xs text-muted-foreground mt-3 mb-1">Windows (PowerShell):</p>
							<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-x-auto">
								<code>{authStep.windowsCommand}</code>
							</pre>
						</>
					)}
					{authStep.note && (
						<p className="text-[11px] text-muted-foreground mt-2">{authStep.note}</p>
					)}
				</div>
			)}

			{/* Optional status snippet for CLAUDE.md / AGENTS.md — hidden for
			    Copilot (observed-only, no semantic-status hook to report through). */}
			{showStatusSnippet && (
				<div className="border border-border bg-card rounded-lg p-5">
					<h2 className="text-sm font-semibold mb-2 flex items-center gap-2">
						<span className="w-6 h-6 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold">
							{stepStatusSnippet}
						</span>
						Optional: Add Status Snippet to {AGENT_METADATA[agentType].instructionsFile}
					</h2>
					<p className="text-xs text-muted-foreground mb-3">
						Add this to your project's {AGENT_METADATA[agentType].instructionsFile} for semantic
						status reporting. This lets the agent tell the dashboard what it's working on.
					</p>
					<pre className="bg-background border border-border rounded-md p-3 text-xs overflow-auto max-h-40">
						<code>{`## AgentPulse Status Reporting
When working on tasks, report your status every 3-5 tool uses:
\`\`\`bash
curl -s -X POST "${serverUrl}/api/v1/hooks/status" \\
  -H "Authorization: Bearer \${AGENTPULSE_API_KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"session_id":"'"\$${agentType === "claude_code" ? "CLAUDE_SESSION_ID" : "CODEX_SESSION_ID"}"'","status":"<status>","task":"<task>"}'
\`\`\``}</code>
					</pre>
				</div>
			)}
		</div>
	);
}
