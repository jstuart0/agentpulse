import type { ProviderKind } from "./types.js";

/**
 * Probe a provider's model-listing endpoint so the UI can turn a
 * free-form model input into a dropdown of whatever the server
 * actually has loaded. This is a pre-save helper — nothing is
 * persisted here; the caller chooses one of the returned ids and
 * POSTs it back via the normal create-provider flow.
 *
 * Two shapes we care about:
 *   - OpenAI-compatible (`/models`): used by OpenAI, OpenRouter,
 *     Ollama, LM Studio, vLLM, llama.cpp server, Gemini's OpenAI
 *     surface, etc. Returns `{ data: [{ id: string, ... }] }`.
 *   - Anthropic (`/v1/models`): distinct auth header
 *     (`x-api-key` + `anthropic-version`). Same response shape.
 */

export interface ListModelsInput {
	kind: ProviderKind;
	/** Same shape saved on the provider row. */
	baseUrl?: string;
	/** May be empty/"ollama" for local OpenAI-compatible servers. */
	apiKey: string;
	/** Abort the probe if the remote doesn't answer quickly. */
	timeoutMs?: number;
}

export interface ListedModel {
	id: string;
	/** Free-form provider-supplied description, e.g. Ollama's "7B" family. */
	description?: string;
}

export interface ListModelsResult {
	ok: true;
	models: ListedModel[];
}

export interface ListModelsError {
	ok: false;
	error: string;
	status?: number;
}

function defaultBaseUrl(kind: ProviderKind): string {
	switch (kind) {
		case "anthropic":
			return "https://api.anthropic.com";
		case "openai":
			return "https://api.openai.com/v1";
		case "openrouter":
			return "https://openrouter.ai/api/v1";
		case "google":
			return "https://generativelanguage.googleapis.com/v1beta/openai";
		case "openai_compatible":
			return "http://localhost:11434/v1";
		case "cohere":
			return "https://api.cohere.com";
	}
}

export async function listAvailableModels(
	input: ListModelsInput,
): Promise<ListModelsResult | ListModelsError> {
	const kind = input.kind;
	const baseUrl = (input.baseUrl?.trim() || defaultBaseUrl(kind)).replace(/\/+$/, "");
	const timeoutMs = input.timeoutMs ?? 10_000;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		let url: string;
		const headers: Record<string, string> = { Accept: "application/json" };

		if (kind === "anthropic") {
			// Anthropic exposes /v1/models on the api.anthropic.com host.
			url = `${baseUrl}/v1/models`;
			if (!input.apiKey) return { ok: false, error: "Anthropic API key is required." };
			headers["x-api-key"] = input.apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (kind === "cohere") {
			// Cohere exposes /v1/models on the api.cohere.com host. The
			// response shape is { models: [{ name }] } which the existing
			// `.data ?? .models` fallback below already handles.
			url = `${baseUrl}/v1/models`;
			if (!input.apiKey) return { ok: false, error: "Cohere API key is required." };
			headers.Authorization = `Bearer ${input.apiKey}`;
		} else {
			// OpenAI-compatible surface: baseUrl already ends with /v1 for
			// the normal provider configs.
			url = `${baseUrl}/models`;
			// Ollama/LM Studio don't require a real key but happily accept
			// any Bearer header; send what we have to stay compatible with
			// gated deployments (OpenRouter, OpenAI proper).
			const key = input.apiKey?.trim() || "ollama";
			headers.Authorization = `Bearer ${key}`;
		}

		let res: Response;
		try {
			res = await fetch(url, { method: "GET", headers, signal: controller.signal });
		} catch (err) {
			if (controller.signal.aborted) {
				return { ok: false, error: `Timed out after ${timeoutMs}ms contacting ${url}` };
			}
			return {
				ok: false,
				error: `Couldn't reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
			};
		}

		if (!res.ok) {
			let detail = "";
			try {
				const body = (await res.json()) as {
					error?: string | { message?: string };
				};
				if (typeof body.error === "string") detail = body.error;
				else if (body.error && typeof body.error === "object" && body.error.message)
					detail = body.error.message;
			} catch {
				detail = await res.text().catch(() => "");
			}
			return {
				ok: false,
				status: res.status,
				error: `${url} responded ${res.status}${detail ? `: ${detail.slice(0, 400)}` : ""}`,
			};
		}

		const body = (await res.json()) as {
			data?: Array<{ id?: string; description?: string; name?: string }>;
			models?: Array<{ id?: string; name?: string; description?: string }>;
		};
		// Prefer `.data` (OpenAI) but fall back to `.models` (some
		// llama.cpp builds, older Ollama-proxy modes).
		const rows = body.data ?? body.models ?? [];
		const models: ListedModel[] = [];
		for (const row of rows) {
			const id = row?.id ?? row?.name;
			if (typeof id === "string" && id.trim()) {
				models.push({
					id,
					description:
						typeof row.description === "string" && row.description.trim()
							? row.description
							: undefined,
				});
			}
		}
		models.sort((a, b) => a.id.localeCompare(b.id));
		return { ok: true, models };
	} finally {
		clearTimeout(timeout);
	}
}
