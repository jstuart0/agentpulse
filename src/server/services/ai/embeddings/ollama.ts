import type { EmbeddingAdapter } from "./types.js";

/**
 * Ollama embedding adapter. Uses the native `/api/embed` endpoint
 * (Ollama 0.3.0+) — that one returns batched results and is happy with
 * the `mxbai-embed-large` / `nomic-embed-text` / `bge-large` family.
 *
 * The legacy `/api/embeddings` (singular) endpoint stays around for
 * older servers but only handles one input at a time; we fall back to
 * it if `/api/embed` 404s, so users on older Ollama versions still
 * work without an upgrade prompt.
 */
export interface OllamaEmbeddingParams {
	baseUrl: string;
	model: string;
	/** Override the dim if the caller already knows it (skips a probe call). */
	dim?: number;
}

export async function createOllamaEmbeddingAdapter(
	params: OllamaEmbeddingParams,
): Promise<EmbeddingAdapter> {
	// Ollama exposes embeddings at `/api/embed` (root-level), but our LLM
	// provider records typically store the OpenAI-compatible chat URL
	// `…:11434/v1`. Strip a trailing `/v1` (with or without slash) so we
	// hit the right endpoint regardless of how the provider URL was saved.
	const baseUrl = params.baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
	const model = params.model;

	let dim = params.dim;
	if (!dim) {
		// One-shot probe so consumers don't have to know the model's dim
		// up-front. We pick a tiny token to keep the call cheap.
		const probe = await embedRaw(baseUrl, model, ["x"]);
		dim = probe[0]?.length ?? 0;
		if (!dim) {
			throw new Error(
				`Ollama embed probe for model "${model}" returned empty vector — is the model pulled?`,
			);
		}
	}

	return {
		kind: "ollama",
		model,
		dim,
		async embed(input: string): Promise<Float32Array> {
			const out = await embedRaw(baseUrl, model, [input]);
			if (!out[0]) throw new Error("Ollama embed returned no vectors");
			return out[0];
		},
		async embedBatch(inputs: string[]): Promise<Float32Array[]> {
			if (inputs.length === 0) return [];
			return embedRaw(baseUrl, model, inputs);
		},
	};
}

async function embedRaw(baseUrl: string, model: string, inputs: string[]): Promise<Float32Array[]> {
	// Try the modern batch endpoint first.
	const res = await fetch(`${baseUrl}/api/embed`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model, input: inputs }),
		signal: AbortSignal.timeout(60_000),
	});
	if (res.ok) {
		const json = (await res.json()) as { embeddings?: number[][] };
		if (json.embeddings && json.embeddings.length === inputs.length) {
			return json.embeddings.map((v) => Float32Array.from(v));
		}
		throw new Error(`Ollama /api/embed returned ${json.embeddings?.length ?? 0} vectors`);
	}
	if (res.status !== 404) {
		const body = await res.text().catch(() => "");
		throw new Error(`Ollama embed failed: ${res.status} ${body.slice(0, 200)}`);
	}

	// Fallback: legacy singular endpoint, called once per input.
	const vectors: Float32Array[] = [];
	for (const input of inputs) {
		const legacy = await fetch(`${baseUrl}/api/embeddings`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model, prompt: input }),
			signal: AbortSignal.timeout(60_000),
		});
		if (!legacy.ok) {
			const body = await legacy.text().catch(() => "");
			throw new Error(`Ollama embeddings failed: ${legacy.status} ${body.slice(0, 200)}`);
		}
		const json = (await legacy.json()) as { embedding?: number[] };
		if (!json.embedding) throw new Error("Ollama embeddings response missing 'embedding'");
		vectors.push(Float32Array.from(json.embedding));
	}
	return vectors;
}
