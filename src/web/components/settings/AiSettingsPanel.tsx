import { useEffect, useState } from "react";
import { type AiProvider, type AiProviderKind, api } from "../../lib/api.js";
import { VectorSearchSection } from "./VectorSearchSection.js";

type Status = {
	build: boolean;
	runtime: boolean;
	killSwitch: boolean;
	active: boolean;
	autoEnableWatcherForAsk?: boolean;
};

// `as const` preserves narrow `value` literals for the exhaustiveness
// check below. The wider `AiProviderKind` constraint is enforced by the
// satisfies clause — a typo in any `value` becomes a compile error.
const PROVIDER_KINDS = [
	{ value: "anthropic", label: "Anthropic (Claude)", hint: "claude-sonnet-4-6" },
	{ value: "openai", label: "OpenAI (ChatGPT)", hint: "gpt-4o" },
	{ value: "google", label: "Google (Gemini)", hint: "gemini-1.5-pro" },
	{ value: "openrouter", label: "OpenRouter", hint: "meta-llama/llama-3.1-70b-instruct" },
	{ value: "openai_compatible", label: "Local / OpenAI-compatible", hint: "qwen2.5:7b" },
] as const satisfies ReadonlyArray<{ value: AiProviderKind; label: string; hint: string }>;

// Compile-time exhaustiveness: if a new ProviderKind is added to the
// canonical const in shared/types.ts without a matching dropdown entry
// above, this type evaluates to a non-empty union and `_check` errors.
type _MissingProviderKind = Exclude<AiProviderKind, (typeof PROVIDER_KINDS)[number]["value"]>;
const _checkProviderKindCoverage: [_MissingProviderKind] extends [never] ? true : never = true;
void _checkProviderKindCoverage;

export function AiSettingsPanel() {
	const [status, setStatus] = useState<Status | null>(null);
	const [providers, setProviders] = useState<AiProvider[]>([]);
	const [defaultProviderId, setDefaultProviderId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [banner, setBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
	const [spendCents, setSpendCents] = useState(0);

	async function reload() {
		try {
			const s = await api.getAiStatus();
			setStatus(s);
			if (s.build) {
				const [p, spend] = await Promise.all([api.getAiProviders(), api.getAiSpend()]);
				setProviders(p.providers);
				setDefaultProviderId(p.defaultProviderId);
				setSpendCents(spend.spendCents);
			}
		} catch (err) {
			setBanner({ kind: "error", text: `Failed to load AI settings: ${String(err)}` });
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void reload();
	}, []);

	async function toggleRuntime(enabled: boolean) {
		try {
			const next = await api.updateAiStatus({ enabled });
			setStatus(next);
			if (enabled) void reload();
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	async function toggleKillSwitch(killSwitch: boolean) {
		try {
			const next = await api.updateAiStatus({ killSwitch });
			setStatus(next);
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	async function toggleAutoEnableWatcherForAsk(autoEnableWatcherForAsk: boolean) {
		try {
			const next = await api.updateAiStatus({ autoEnableWatcherForAsk });
			setStatus(next);
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	async function removeProvider(id: string) {
		if (!confirm("Delete this provider? Watchers configured to use it will break.")) return;
		try {
			await api.deleteAiProvider(id);
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	async function makeDefault(id: string) {
		try {
			await api.updateAiProvider(id, { isDefault: true });
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	if (loading) {
		return <div className="text-sm text-muted-foreground">Loading AI settings…</div>;
	}

	if (!status) {
		return <div className="text-sm text-red-400">Failed to load AI settings.</div>;
	}

	if (!status.build) {
		return (
			<div className="rounded-lg border border-border bg-card/30 p-4 text-sm text-muted-foreground">
				AI watcher is not compiled into this build. Set{" "}
				<code className="text-xs bg-muted px-1 py-0.5 rounded">AGENTPULSE_AI_ENABLED=true</code> and{" "}
				<code className="text-xs bg-muted px-1 py-0.5 rounded">AGENTPULSE_SECRETS_KEY</code> at
				server boot to enable.
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{banner && (
				<div
					className={`rounded-md border p-3 text-xs ${
						banner.kind === "error"
							? "border-red-500/30 bg-red-500/10 text-red-300"
							: "border-primary/30 bg-primary/10 text-primary"
					}`}
				>
					{banner.text}
				</div>
			)}

			{/* Master enable + kill switch */}
			<div className="rounded-lg border border-border bg-card/30 p-4 space-y-3">
				<div className="flex items-center justify-between">
					<div>
						<div className="text-sm font-semibold">AI watcher</div>
						<div className="text-xs text-muted-foreground">
							{status.active
								? "Active — watchers can run on enabled sessions."
								: status.runtime
									? "Runtime enabled but paused by kill switch."
									: "Disabled at runtime. Nothing runs until enabled."}
						</div>
					</div>
					<label className="inline-flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={status.runtime}
							onChange={(e) => toggleRuntime(e.target.checked)}
							className="w-4 h-4"
						/>
						<span className="text-xs">Enabled</span>
					</label>
				</div>
				<div className="flex items-center justify-between border-t border-border pt-3">
					<div>
						<div className="text-sm font-semibold">Pause all watchers</div>
						<div className="text-xs text-muted-foreground">
							Kill switch cancels every open HITL; new triggers are ignored until turned off.
						</div>
					</div>
					<label className="inline-flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={status.killSwitch}
							onChange={(e) => toggleKillSwitch(e.target.checked)}
							className="w-4 h-4"
						/>
						<span className="text-xs text-red-400">Paused</span>
					</label>
				</div>
				<div className="flex items-center justify-between border-t border-border pt-3">
					<div>
						<div className="text-sm font-semibold">Auto-enable on Ask-initiated sessions</div>
						<div className="text-xs text-muted-foreground">
							When Ask launches a session, attach a watcher (ask_on_risk policy, default provider).
							You can still flip it off per session in the AI tab.
						</div>
					</div>
					<label className="inline-flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={status.autoEnableWatcherForAsk !== false}
							onChange={(e) => toggleAutoEnableWatcherForAsk(e.target.checked)}
							className="w-4 h-4"
						/>
						<span className="text-xs">Enabled</span>
					</label>
				</div>
				<div className="border-t border-border pt-3 text-xs text-muted-foreground">
					Today's spend:{" "}
					<span className="font-mono text-foreground">${(spendCents / 100).toFixed(2)}</span>
				</div>
			</div>

			{/* Providers table */}
			<div className="rounded-lg border border-border bg-card/30">
				<div className="px-4 py-3 border-b border-border flex items-center justify-between">
					<div>
						<div className="text-sm font-semibold">LLM providers</div>
						<div className="text-xs text-muted-foreground">
							Bring your own key. Credentials encrypted at rest.
						</div>
					</div>
					<ProviderForm
						disabled={!status.active}
						onCreated={reload}
						onError={(e) => setBanner({ kind: "error", text: e })}
					/>
				</div>
				{providers.length === 0 ? (
					<div className="p-4 text-xs text-muted-foreground">
						No providers yet. Add one to enable the watcher on a session.
					</div>
				) : (
					<ul className="divide-y divide-border">
						{providers.map((p) => (
							<li key={p.id} className="px-4 py-3 flex items-center gap-3">
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm font-semibold truncate">{p.name}</span>
										{p.id === defaultProviderId && (
											<span className="text-[10px] bg-primary/15 text-primary border border-primary/30 rounded px-1.5 py-0.5">
												default
											</span>
										)}
									</div>
									<div className="text-xs text-muted-foreground font-mono mt-0.5">
										{p.kind} / {p.model} / key {p.credentialHint}
										{p.baseUrl ? ` · ${p.baseUrl}` : ""}
									</div>
								</div>
								{p.id !== defaultProviderId && (
									<button
										type="button"
										onClick={() => makeDefault(p.id)}
										className="text-xs text-primary hover:underline"
									>
										Make default
									</button>
								)}
								<button
									type="button"
									onClick={() => removeProvider(p.id)}
									className="text-xs text-muted-foreground hover:text-red-400"
								>
									Delete
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{/* Vector search — only renders when the build flag is on */}
			<VectorSearchSection />

			{/* Redactor preview */}
			<RedactorPreview />
		</div>
	);
}

function ProviderForm({
	disabled,
	onCreated,
	onError,
}: {
	disabled: boolean;
	onCreated: () => void;
	onError: (err: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [form, setForm] = useState({
		name: "",
		kind: "anthropic" as AiProviderKind,
		model: "",
		baseUrl: "",
		apiKey: "",
		isDefault: false,
	});
	const [availableModels, setAvailableModels] = useState<string[] | null>(null);
	const [loadingModels, setLoadingModels] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);

	async function handleLoadModels() {
		setLoadingModels(true);
		setModelsError(null);
		try {
			const res = await api.probeAiProviderModels({
				kind: form.kind,
				baseUrl: form.baseUrl.trim() || undefined,
				apiKey: form.apiKey || undefined,
			});
			setAvailableModels(res.models.map((m) => m.id));
			// If the current model input doesn't match anything the server
			// reports, fall through and let the user pick one. If the list
			// is empty, keep the free-form input so they can still type.
			if (res.models.length > 0 && !res.models.some((m) => m.id === form.model)) {
				setForm((f) => ({ ...f, model: res.models[0].id }));
			}
		} catch (err) {
			setAvailableModels(null);
			setModelsError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingModels(false);
		}
	}

	// Invalidate a loaded list whenever the connection details change —
	// picking from a stale list would silently save a model the new
	// endpoint doesn't have.
	const resetLoadedModels = () => {
		if (availableModels !== null) setAvailableModels(null);
		if (modelsError) setModelsError(null);
	};

	if (!open) {
		return (
			<button
				type="button"
				disabled={disabled}
				onClick={() => setOpen(true)}
				className="text-xs px-3 py-1.5 rounded bg-primary/15 border border-primary/30 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed"
			>
				Add provider
			</button>
		);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		try {
			await api.createAiProvider({
				name: form.name.trim(),
				kind: form.kind,
				model: form.model.trim(),
				baseUrl: form.baseUrl.trim() || undefined,
				apiKey: form.apiKey,
				isDefault: form.isDefault,
			});
			setOpen(false);
			setForm({
				name: "",
				kind: "anthropic",
				model: "",
				baseUrl: "",
				apiKey: "",
				isDefault: false,
			});
			setAvailableModels(null);
			setModelsError(null);
			onCreated();
		} catch (err) {
			onError(String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<form
			onSubmit={submit}
			className="absolute right-4 mt-2 z-20 w-[22rem] rounded-lg border border-border bg-card p-3 space-y-2 shadow-lg"
		>
			<div>
				<label className="text-[10px] uppercase tracking-wider text-muted-foreground">Kind</label>
				<select
					value={form.kind}
					onChange={(e) => {
						setForm({ ...form, kind: e.target.value as AiProviderKind });
						resetLoadedModels();
					}}
					className="w-full text-xs bg-background border border-border rounded px-2 py-1"
				>
					{PROVIDER_KINDS.map((k) => (
						<option key={k.value} value={k.value}>
							{k.label}
						</option>
					))}
				</select>
			</div>
			<Input
				label="Name"
				value={form.name}
				onChange={(v) => setForm({ ...form, name: v })}
				placeholder="e.g. Claude main"
			/>
			{(form.kind === "openai_compatible" || form.kind === "openrouter") && (
				<Input
					label="Base URL"
					value={form.baseUrl}
					onChange={(v) => {
						setForm({ ...form, baseUrl: v });
						resetLoadedModels();
					}}
					placeholder={
						form.kind === "openrouter"
							? "https://openrouter.ai/api/v1"
							: "http://localhost:11434/v1"
					}
				/>
			)}
			<Input
				label="API key"
				type="password"
				value={form.apiKey}
				onChange={(v) => {
					setForm({ ...form, apiKey: v });
					resetLoadedModels();
				}}
				placeholder={form.kind === "openai_compatible" ? "(any string works for Ollama)" : "sk-…"}
			/>

			<div className="space-y-1">
				<div className="flex items-center justify-between">
					<label className="text-[10px] uppercase tracking-wider text-muted-foreground">
						Model
					</label>
					<button
						type="button"
						onClick={handleLoadModels}
						disabled={loadingModels}
						className="text-[10px] text-primary hover:underline disabled:opacity-50"
						title="Ask the target server what models it has loaded"
					>
						{loadingModels ? "Loading…" : "Load available models"}
					</button>
				</div>
				{availableModels && availableModels.length > 0 ? (
					<select
						value={form.model}
						onChange={(e) => setForm({ ...form, model: e.target.value })}
						className="w-full text-xs bg-background border border-border rounded px-2 py-1"
					>
						{availableModels.map((m) => (
							<option key={m} value={m}>
								{m}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						value={form.model}
						onChange={(e) => setForm({ ...form, model: e.target.value })}
						placeholder={PROVIDER_KINDS.find((k) => k.value === form.kind)?.hint ?? ""}
						className="w-full text-xs bg-background border border-border rounded px-2 py-1"
					/>
				)}
				{availableModels && availableModels.length === 0 && (
					<p className="text-[10px] text-amber-300">
						Server reached but reported no models. Load one there first, or type an id by hand.
					</p>
				)}
				{modelsError && <p className="text-[10px] text-red-300">{modelsError}</p>}
			</div>
			<label className="flex items-center gap-2 text-xs">
				<input
					type="checkbox"
					checked={form.isDefault}
					onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
				/>
				Set as default
			</label>
			<div className="flex items-center justify-end gap-2 pt-1">
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Cancel
				</button>
				<button
					type="submit"
					disabled={submitting || !form.name || !form.model || !form.apiKey}
					className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-40"
				>
					{submitting ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}

function Input({
	label,
	value,
	onChange,
	placeholder,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	type?: "text" | "password";
}) {
	return (
		<div>
			<label className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>
			<input
				type={type}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder={placeholder}
				className="w-full text-xs bg-background border border-border rounded px-2 py-1 font-mono"
			/>
		</div>
	);
}

function RedactorPreview() {
	const [sample, setSample] = useState("export API_KEY=sk-ant-api03-example-key-here-12345");
	const [result, setResult] = useState<{ text: string; hits: unknown[] } | null>(null);
	const [busy, setBusy] = useState(false);

	async function run() {
		setBusy(true);
		try {
			const res = await api.aiRedactorDryRun(sample);
			setResult(res);
		} catch (err) {
			setResult({ text: `Error: ${err}`, hits: [] });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-lg border border-border bg-card/30 p-4 space-y-2">
			<div className="text-sm font-semibold">Redactor preview</div>
			<div className="text-xs text-muted-foreground">
				Paste sample text to see what the redactor would scrub before any transcript reaches an LLM.
			</div>
			<textarea
				value={sample}
				onChange={(e) => setSample(e.target.value)}
				rows={3}
				className="w-full text-xs font-mono bg-background border border-border rounded p-2"
			/>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={run}
					disabled={busy}
					className="text-xs px-3 py-1.5 rounded bg-primary/15 border border-primary/30 text-primary hover:bg-primary/20"
				>
					{busy ? "Checking…" : "Dry run"}
				</button>
				{result && (
					<span className="text-xs text-muted-foreground">
						{result.hits.length} hit{result.hits.length === 1 ? "" : "s"}
					</span>
				)}
			</div>
			{result && (
				<pre className="text-xs font-mono bg-background border border-border rounded p-2 whitespace-pre-wrap break-words">
					{result.text}
				</pre>
			)}
		</div>
	);
}
