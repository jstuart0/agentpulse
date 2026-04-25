import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";

/**
 * Settings card for vector search. Renders only when the build flag is
 * on (the GET /ai/vector-search/status `build` field tells us).
 *
 * Three controls:
 *   - Enabled toggle (binds to vectorSearch.enabled)
 *   - Embedding model picker (free-form, default mxbai-embed-large)
 *   - Re-index button + progress bar
 */
type VectorStatus = Awaited<ReturnType<typeof api.getVectorSearchStatus>>;

const RECOMMENDED_MODELS = [
	{
		id: "mxbai-embed-large",
		label: "mxbai-embed-large (default)",
		hint: "335M params · 1024-dim · ~30-60ms/embed · top-5 MTEB English",
	},
	{
		id: "nomic-embed-text",
		label: "nomic-embed-text",
		hint: "137M params · 768-dim · ~20ms/embed · faster, slightly weaker recall",
	},
	{
		id: "bge-large-en-v1.5",
		label: "bge-large-en-v1.5",
		hint: "335M params · 1024-dim · solid retrieval baseline",
	},
	{
		id: "qwen3-embedding-8b",
		label: "qwen3-embedding-8b (max quality)",
		hint: "8B params · 4096-dim · ~200-500ms/embed · top MTEB scores; slow backfill",
	},
];

export function VectorSearchSection() {
	const [status, setStatus] = useState<VectorStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draftModel, setDraftModel] = useState("");

	async function reload() {
		try {
			const s = await api.getVectorSearchStatus();
			setStatus(s);
			setDraftModel(s.model);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void reload();
	}, []);

	// Poll while a backfill is running so the progress bar updates.
	useEffect(() => {
		if (!status?.progress?.running) return;
		const id = setInterval(() => void reload(), 2000);
		return () => clearInterval(id);
	}, [status?.progress?.running]);

	if (loading) return null;
	if (!status?.build) return null;

	async function toggleEnabled(enabled: boolean) {
		setBusy(true);
		setError(null);
		try {
			await api.updateVectorSearchStatus({ enabled });
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function saveModel() {
		if (!draftModel.trim() || draftModel === status?.model) return;
		setBusy(true);
		setError(null);
		try {
			await api.updateVectorSearchStatus({ model: draftModel.trim() });
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function rebuild() {
		setBusy(true);
		setError(null);
		try {
			await api.rebuildVectorIndex();
			await reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const progress = status.progress;
	const pct =
		progress && progress.total > 0 ? Math.round((progress.embedded / progress.total) * 100) : 0;

	return (
		<div className="rounded-lg border border-border bg-card/30 p-4 space-y-3">
			<div className="flex items-center justify-between">
				<div>
					<div className="text-sm font-semibold">Vector search</div>
					<div className="text-xs text-muted-foreground">
						{status.active
							? "Active — Ask matches by meaning, not just keywords."
							: status.enabled
								? "Enabled but inactive — AI must be on with a default provider."
								: "Disabled. Lexical search and LLM expansion still work."}
					</div>
				</div>
				<label className="inline-flex items-center gap-2 cursor-pointer">
					<input
						type="checkbox"
						checked={status.enabled}
						disabled={busy}
						onChange={(e) => void toggleEnabled(e.target.checked)}
						className="w-4 h-4"
					/>
					<span className="text-xs">Enabled</span>
				</label>
			</div>

			<div className="border-t border-border pt-3 space-y-2">
				<div className="text-xs font-semibold text-foreground">Embedding model</div>
				<div className="flex gap-2">
					<input
						type="text"
						list="recommended-embedding-models"
						value={draftModel}
						onChange={(e) => setDraftModel(e.target.value)}
						placeholder="mxbai-embed-large"
						className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5 font-mono"
					/>
					<datalist id="recommended-embedding-models">
						{RECOMMENDED_MODELS.map((m) => (
							<option key={m.id} value={m.id}>
								{m.label}
							</option>
						))}
					</datalist>
					<button
						type="button"
						disabled={busy || !draftModel.trim() || draftModel === status.model}
						onClick={() => void saveModel()}
						className="text-xs px-3 py-1.5 rounded bg-primary/15 border border-primary/30 text-primary hover:bg-primary/20 disabled:opacity-40"
					>
						Save
					</button>
				</div>
				<details className="text-[10px] text-muted-foreground">
					<summary className="cursor-pointer hover:text-foreground">
						Recommended models (Ollama)
					</summary>
					<ul className="mt-1 space-y-0.5">
						{RECOMMENDED_MODELS.map((m) => (
							<li key={m.id}>
								<span className="font-mono">{m.id}</span> — {m.hint}
							</li>
						))}
					</ul>
				</details>
				<div className="text-[10px] text-muted-foreground">
					Pulled from your default LLM provider's host. Different model = different vector space —
					switching forces a re-index.
				</div>
			</div>

			<div className="border-t border-border pt-3 space-y-2">
				<div className="flex items-center justify-between">
					<div className="text-xs font-semibold text-foreground">Indexing progress</div>
					<button
						type="button"
						disabled={busy || progress?.running}
						onClick={() => void rebuild()}
						className="text-[11px] px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-40"
					>
						{progress?.running ? "Indexing…" : "Re-index now"}
					</button>
				</div>
				{progress && (
					<div className="space-y-1">
						<div className="h-1.5 w-full rounded bg-muted overflow-hidden">
							<div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
						</div>
						<div className="flex justify-between text-[10px] text-muted-foreground">
							<span>
								{progress.embedded} / {progress.total} events embedded
							</span>
							<span className="font-mono">{progress.model ?? "no model"}</span>
						</div>
						{progress.error && <div className="text-[10px] text-red-300">{progress.error}</div>}
					</div>
				)}
			</div>

			{error && (
				<div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
					{error}
				</div>
			)}
		</div>
	);
}
