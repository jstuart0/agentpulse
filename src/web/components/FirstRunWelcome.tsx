import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.js";
import { useUserStore } from "../stores/user-store.js";

/**
 * Empty-state greeter the Dashboard renders when a user has zero
 * sessions. Collapses the three real first-run tasks (mint an API key,
 * install the hook, start an agent) into a single screen so a fresh
 * install doesn't have to hunt around Setup/Settings to get wired up.
 *
 * Intentionally forgiving: when auth is disabled we skip the API-key
 * step entirely; when auth is on we surface an inline "create key"
 * action so the user never has to leave this card.
 */
export function FirstRunWelcome({ serverUrl }: { serverUrl: string }) {
	const user = useUserStore((s) => s.user);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const [keys, setKeys] = useState<Array<{
		id: string;
		name: string;
		keyPrefix: string;
		isActive: boolean;
	}> | null>(null);
	const [keysError, setKeysError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [newKeyName, setNewKeyName] = useState("my-laptop");
	const [revealedKey, setRevealedKey] = useState<string | null>(null);

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
		if (!newKeyName.trim()) return;
		setCreating(true);
		try {
			const res = await api.createApiKey(newKeyName.trim());
			setRevealedKey(res.key);
			const list = await api.getApiKeys().catch(() => ({ keys: [] as typeof keys }));
			setKeys(list.keys ?? []);
		} catch (err) {
			setKeysError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	}

	// Key-for-copy: if we just minted one we have the raw value; otherwise
	// leave the env placeholder so the command is still copyable and the
	// user can paste their own key in.
	const activeKeys = keys?.filter((k) => k.isActive) ?? [];
	const keyForCommand =
		revealedKey ?? (activeKeys.length > 0 ? "$AGENTPULSE_API_KEY" : "YOUR_API_KEY");
	const localCommand = disableAuth
		? `curl -sSL ${serverUrl}/setup.sh | bash`
		: `curl -sSL ${serverUrl}/setup.sh | bash -s -- --key ${keyForCommand}`;
	const relayCommand = `curl -sSL ${serverUrl}/setup-relay.sh | bash -s -- --key ${keyForCommand}`;

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard API unavailable in some contexts (http + sandbox);
			// fall back to no-op rather than surfacing a noisy error.
		}
	}

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
						Sessions appear here live as Claude Code / Codex emit hooks. Two quick steps and
						you&apos;re done.
					</p>
				</div>
			</div>

			{/* Step 1: API key (only when auth is on) */}
			{!disableAuth && (
				<div className="border border-border rounded-md p-4 mb-3">
					<div className="flex items-center gap-2 mb-2">
						<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
							1
						</span>
						<h3 className="text-sm font-semibold text-foreground">Create an API key</h3>
						{activeKeys.length > 0 && !revealedKey && (
							<span className="ml-auto text-[10px] text-emerald-400">
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
								<code className="flex-1 min-w-0 truncate bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
									{revealedKey}
								</code>
								<button
									type="button"
									onClick={() => void copy(revealedKey)}
									className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
								>
									Copy
								</button>
							</div>
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
								value={newKeyName}
								onChange={(e) => setNewKeyName(e.target.value)}
								placeholder="Key name (e.g. macbook-pro)"
								className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
							/>
							<button
								type="button"
								onClick={handleCreateKey}
								disabled={creating || !newKeyName.trim()}
								className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
							>
								{creating ? "Creating…" : "Create key"}
							</button>
						</div>
					)}
					{keysError && (
						<p className="mt-2 text-xs text-red-400">Couldn&apos;t load API keys: {keysError}</p>
					)}
				</div>
			)}

			{/* Step 2: Install hooks */}
			<div className="border border-border rounded-md p-4 mb-3">
				<div className="flex items-center gap-2 mb-2">
					<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
						{disableAuth ? "1" : "2"}
					</span>
					<h3 className="text-sm font-semibold text-foreground">
						Install the hook on your machine
					</h3>
				</div>
				<p className="text-xs text-muted-foreground mb-2">
					Runs a self-contained script that writes the hook config into{" "}
					<code className="font-mono text-foreground">~/.claude/settings.json</code> and{" "}
					<code className="font-mono text-foreground">~/.codex/hooks.json</code>. Safe to re-run.
				</p>

				<div className="space-y-2">
					<CopyRow
						label="Direct install (agent can reach the server over LAN/VPN)"
						command={localCommand}
						onCopy={copy}
					/>
					<CopyRow
						label="Remote server (agent is on a machine without direct access — installs a localhost relay)"
						command={relayCommand}
						onCopy={copy}
					/>
				</div>

				<p className="text-xs text-muted-foreground mt-3">
					Need something more surgical?{" "}
					<Link to="/setup" className="text-primary hover:underline">
						Open the full Setup page
					</Link>{" "}
					for a step-by-step walkthrough with editable config blobs.
				</p>
			</div>

			{/* Step 3: Start an agent */}
			<div className="border border-border rounded-md p-4">
				<div className="flex items-center gap-2 mb-1.5">
					<span className="w-5 h-5 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-[10px] font-bold">
						{disableAuth ? "2" : "3"}
					</span>
					<h3 className="text-sm font-semibold text-foreground">
						Start an agent — sessions show up live
					</h3>
				</div>
				<p className="text-xs text-muted-foreground">
					Open Claude Code or Codex in any project. Within a second or two this dashboard will light
					up with the session. You can pin it, rename it, or open the workspace to chat alongside
					the transcript.
				</p>
			</div>
		</div>
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
				<code className="flex-1 min-w-0 truncate bg-background border border-border rounded px-2 py-1.5 text-xs text-foreground font-mono">
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
