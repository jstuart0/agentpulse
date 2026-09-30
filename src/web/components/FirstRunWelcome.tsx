import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";
import { api } from "../lib/api.js";
import {
	type LocationState,
	type OnboardingLocation,
	REPLACE_LOCALHOST_NOTE,
	buildOnboardingPlan,
	defaultKeyName,
	defaultLocation,
	isLoopbackHostname,
	onLocationChange,
} from "../lib/onboarding.js";
import { useUserStore } from "../stores/user-store.js";

const LOCATION_OPTIONS: Array<{ value: OnboardingLocation; title: string; detail: string }> = [
	{
		value: "local",
		title: "On this machine",
		detail: "Hooks post straight to this server.",
	},
	{
		value: "relay",
		title: "On other machines — install a relay",
		detail: "A small localhost relay forwards hooks here and keeps names in sync.",
	},
];

/**
 * Empty-state greeter the Dashboard renders when a user has zero
 * sessions. Collapses the real first-run tasks (say where the agents run,
 * mint an API key, install the hook, start an agent) into a single screen
 * so a fresh install doesn't have to hunt around Setup/Settings.
 *
 * Intentionally forgiving: when auth is disabled we skip the API-key
 * step entirely; when auth is on we surface an inline "create key"
 * action, scoped for the chosen location, so the user never has to leave
 * this card.
 */
export function FirstRunWelcome({ serverUrl }: { serverUrl: string }) {
	const user = useUserStore((s) => s.user);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const { copy } = useCopyFeedback();
	const [keys, setKeys] = useState<Array<{
		id: string;
		name: string;
		keyPrefix: string;
		isActive: boolean;
	}> | null>(null);
	const [keysError, setKeysError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	// null until edited, so the default follows the location (F184).
	const [newKeyName, setNewKeyName] = useState<string | null>(null);
	const [locationState, setLocationState] = useState<LocationState>(() => ({
		location: defaultLocation(window.location.hostname),
		revealedKey: null,
		notice: null,
	}));
	const { location, revealedKey, notice } = locationState;
	const keyName = newKeyName ?? defaultKeyName(location);

	useEffect(() => {
		if (disableAuth) return;
		let cancelled = false;
		async function load() {
			try {
				const res = await api.getApiKeys();
				if (!cancelled) setKeys(res.keys);
			} catch (err) {
				if (!cancelled) setKeysError(err instanceof Error ? err.message : String(err));
			}
		}
		void load();
		return () => {
			cancelled = true;
		};
	}, [disableAuth]);

	async function handleCreateKey() {
		if (!keyName.trim()) return;
		setCreating(true);
		try {
			// Scoped for the chosen location: ingest-only for direct hooks,
			// ingest+observe for a relay. Never manage; that's Settings' job.
			const res = await api.createApiKey(keyName.trim(), plan.scopes);
			setLocationState((s) => ({ ...s, revealedKey: res.key, notice: null }));
			const list = await api.getApiKeys().catch(() => ({ keys: [] as typeof keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setKeysError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}

	// AGEN-49: neither installer command carries the key any more (local
	// asks for it at a hidden terminal prompt, same as the relay always
	// has) — buildOnboardingPlan needs only the location and auth mode.
	const activeKeys = keys?.filter((k) => k.isActive) ?? [];
	const plan = buildOnboardingPlan({ location, serverUrl, disableAuth });
	const step = (n: number) => String(disableAuth ? n - 1 : n);

	return (
		<div className="rounded-lg border border-border bg-card p-5 md:p-6">
			<div className="flex items-start gap-3 mb-4">
				<div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center flex-shrink-0">
					<svg
						className="w-4 h-4"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={2}
						role="img"
						aria-label="Welcome"
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
					</svg>
				</div>
				<div className="min-w-0">
					<h2 className="text-base font-semibold text-foreground">
						Welcome{user?.name ? `, ${user.name}` : ""} — let&apos;s wire up your first agent
					</h2>
					<p className="text-xs text-muted-foreground mt-0.5">
						Sessions appear here live as Claude Code, Codex CLI, or Copilot CLI emit hooks. A few
						quick steps and you&apos;re done.
					</p>
				</div>
			</div>

			{/* Step 1: where the agents run */}
			<fieldset className="border border-border rounded-md p-4 mb-3">
				<legend className="sr-only">Where will your agents run?</legend>
				<div className="flex items-center gap-2 mb-2" aria-hidden="true">
					<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
						1
					</span>
					<h3 className="text-sm font-semibold text-foreground">Where will your agents run?</h3>
				</div>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
					{LOCATION_OPTIONS.map((option) => (
						<label
							key={option.value}
							className={`cursor-pointer rounded-md border p-3 text-xs transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${
								location === option.value
									? "border-primary/50 bg-primary/10"
									: "border-border bg-background/40 hover:bg-muted"
							}`}
						>
							<input
								type="radio"
								name="agent-location"
								value={option.value}
								checked={location === option.value}
								onChange={() => setLocationState((s) => onLocationChange(s, option.value))}
								className="sr-only"
							/>
							<div className="font-semibold text-foreground">{option.title}</div>
							<div className="mt-1 text-muted-foreground">{option.detail}</div>
						</label>
					))}
				</div>
			</fieldset>

			{/* Step 2: API key (only when auth is on) */}
			{!disableAuth && (
				<div className="border border-border rounded-md p-4 mb-3">
					<div className="flex items-center gap-2 mb-2">
						<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
							2
						</span>
						<h3 className="text-sm font-semibold text-foreground">Create an API key</h3>
						{activeKeys.length > 0 && !revealedKey && (
							<span className="ml-auto text-[10px] text-emerald-700 dark:text-emerald-400">
								✓ {activeKeys.length} key{activeKeys.length === 1 ? "" : "s"} exists
							</span>
						)}
					</div>

					{revealedKey ? (
						<div>
							<p className="text-xs text-muted-foreground mb-2">
								Save this key — it won&apos;t be shown again.
							</p>
							<div className="flex gap-2">
								<code className="flex-1 min-w-0 break-all bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
									{revealedKey}
								</code>
								<button
									type="button"
									onClick={() => void copy(revealedKey, "API key copied")}
									className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
								>
									Copy
								</button>
							</div>
							{location === "relay" && (
								<p className="text-xs text-muted-foreground mt-2">
									The relay installer asks for it; paste it there.
								</p>
							)}
						</div>
					) : activeKeys.length > 0 ? (
						<p className="text-xs text-muted-foreground">
							You already have {activeKeys.length === 1 ? "a key" : `${activeKeys.length} keys`}.
							Grab the one you want from{" "}
							<Link to="/settings" className="text-primary hover:underline">
								Settings
							</Link>{" "}
							or mint a new one below.
						</p>
					) : (
						<p className="text-xs text-muted-foreground mb-2">
							Agents present this key when sending hooks. Mint one per machine so you can rotate or
							revoke without touching the others.
						</p>
					)}

					{!revealedKey && (
						<div className="flex flex-col sm:flex-row gap-2 mt-2">
							<input
								type="text"
								value={keyName}
								onChange={(e) => setNewKeyName(e.target.value)}
								placeholder="Key name (e.g. macbook-pro)"
								className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={handleCreateKey}
								disabled={creating || !keyName.trim()}
								className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creating ? "Creating…" : "Create key"}
							</button>
						</div>
					)}
					{plan.keyNote && (
						<p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{plan.keyNote}</p>
					)}
					{notice && (
						<p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
							{notice}
						</p>
					)}
					{keysError && (
						<p className="mt-2 text-xs text-red-600 dark:text-red-400">
							Couldn&apos;t load API keys: {keysError}
						</p>
					)}
				</div>
			)}

			{/* Step 3: Install hooks */}
			<div className="border border-border rounded-md p-4 mb-3">
				<div className="flex items-center gap-2 mb-2">
					<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
						{step(3)}
					</span>
					<h3 className="text-sm font-semibold text-foreground">
						{location === "relay" ? "Install the relay on each machine" : "Install the hook"}
					</h3>
				</div>
				<p className="text-xs text-muted-foreground mb-2">
					{location === "relay"
						? "Runs a self-contained script that installs the relay as a login service and writes "
						: "Runs a self-contained script that writes "}
					<FileList files={plan.files} />. Safe to re-run.
				</p>

				<CopyRow
					label={
						location === "relay"
							? "Run on every machine where your agents run"
							: "Run on this machine"
					}
					command={plan.command}
					onCopy={copy}
				/>
				{location === "relay" && isLoopbackHostname(window.location.hostname) && (
					<p className="text-xs text-muted-foreground mt-2">{REPLACE_LOCALHOST_NOTE}</p>
				)}

				<p className="text-xs text-muted-foreground mt-3">
					Need something more surgical?{" "}
					<Link to="/setup" className="text-primary hover:underline">
						Open the full Setup page
					</Link>{" "}
					for a step-by-step walkthrough with editable config blobs.
				</p>
			</div>

			{/* Step 4: Start an agent */}
			<div className="border border-border rounded-md p-4">
				<div className="flex items-center gap-2 mb-1.5">
					<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
						{step(4)}
					</span>
					<h3 className="text-sm font-semibold text-foreground">
						Start an agent — sessions show up live
					</h3>
				</div>
				<p className="text-xs text-muted-foreground">
					Open Claude Code, Codex CLI, or Copilot CLI in any project. Within a second or two this
					dashboard will light up with the session. Claude Code and Codex sessions can be pinned,
					renamed, or opened to chat alongside the transcript — Copilot sessions are observed only.
				</p>
			</div>
		</div>
	);
}

function FileList({ files }: { files: string[] }) {
	return (
		<>
			{files.map((file, i) => (
				<span key={file}>
					{i > 0 && (i === files.length - 1 ? " and " : ", ")}
					<code className="font-mono text-foreground">{file}</code>
				</span>
			))}
		</>
	);
}

function CopyRow({
	label,
	command,
	onCopy,
}: {
	label: string;
	command: string;
	onCopy: (text: string) => Promise<void>;
}) {
	const [copied, setCopied] = useState(false);
	async function handleCopy() {
		await onCopy(command);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}
	return (
		<div>
			<p className="text-[11px] text-muted-foreground mb-1">{label}</p>
			<div className="flex gap-2">
				{/* F198: overflow-wrap breaks only where the line actually
				overflows, unlike break-all, which forces a break between every
				character pair. */}
				<code className="flex-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
					{command}
				</code>
				<button
					type="button"
					onClick={handleCopy}
					className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}
