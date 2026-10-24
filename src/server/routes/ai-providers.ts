import { Hono } from "hono";
import { AI_FAST_PROVIDER_ID_KEY, getFastProviderId } from "../services/ai/feature.js";
import { listAvailableModels } from "../services/ai/llm/list-models.js";
import { KNOWN_PROVIDER_KINDS, type ProviderKind } from "../services/ai/llm/types.js";
import {
	createProvider,
	deleteProvider,
	getDefaultProvider,
	listProviders,
	updateProvider,
} from "../services/ai/providers-service.js";
import { upsertSetting } from "../services/settings-service.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

const aiProvidersRouter = new Hono();

// --------------------------------------------------------------------------
// Providers
// --------------------------------------------------------------------------

aiProvidersRouter.get("/ai/providers", async (c) => {
	const gate = await requireAiBuild(c);
	if (gate) return gate;
	const providers = await listProviders();
	const defaultProvider = await getDefaultProvider();
	const fastProviderId = await getFastProviderId();
	return c.json({
		providers,
		defaultProviderId: defaultProvider?.id ?? null,
		fastProviderId: providers.some((p) => p.id === fastProviderId) ? fastProviderId : null,
	});
});

aiProvidersRouter.post("/ai/providers", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{
		name: string;
		kind: ProviderKind;
		model: string;
		baseUrl?: string;
		apiKey: string;
		isDefault?: boolean;
	}>();

	if (!body.name || !body.kind || !body.model || !body.apiKey) {
		return c.json({ error: "Missing required fields" }, 400);
	}
	if (!KNOWN_PROVIDER_KINDS.includes(body.kind)) {
		return c.json({ error: `Unknown provider kind: ${body.kind}` }, 400);
	}

	const provider = await createProvider(body);
	return c.json({ provider }, 201);
});

/**
 * Pre-save model discovery. Takes the same connection details the
 * create/update forms use and asks the target server what models it
 * has loaded — so the user picks from a real list instead of guessing
 * the exact id their Ollama / LM Studio / OpenRouter install exposes.
 * Nothing is persisted here; the caller still needs to POST back to
 * /ai/providers with the chosen model.
 */
aiProvidersRouter.post("/ai/providers/probe-models", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const body = await c.req.json<{
		kind: ProviderKind;
		baseUrl?: string;
		apiKey?: string;
	}>();
	if (!body.kind || !KNOWN_PROVIDER_KINDS.includes(body.kind)) {
		return c.json({ error: `Unknown provider kind: ${body.kind}` }, 400);
	}
	const result = await listAvailableModels({
		kind: body.kind,
		baseUrl: body.baseUrl,
		apiKey: body.apiKey ?? "",
	});
	if (!result.ok) {
		// Preserve the upstream status when it's a 4xx so the UI can tell
		// auth failures apart from network failures; everything else is a
		// 502 because the problem is downstream of AgentPulse.
		const status: 400 | 401 | 403 | 404 | 502 =
			result.status === 401
				? 401
				: result.status === 403
					? 403
					: result.status === 404
						? 404
						: result.status && result.status >= 400 && result.status < 500
							? 400
							: 502;
		return c.json({ error: result.error }, status);
	}
	return c.json({ models: result.models });
});

aiProvidersRouter.put("/ai/providers/:id", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{
		name?: string;
		model?: string;
		baseUrl?: string;
		apiKey?: string;
		isDefault?: boolean;
		isFast?: boolean;
	}>();
	if (body.isFast !== undefined && typeof body.isFast !== "boolean") {
		return c.json({ error: "isFast must be a boolean" }, 400);
	}
	const { isFast, ...update } = body;
	const provider = await updateProvider(id, update);
	if (!provider) return c.json({ error: "Provider not found" }, 404);
	// Marking a provider fast moves the setting to it; unmarking clears it only
	// if this provider is the fast one.
	if (isFast === true) {
		await upsertSetting(AI_FAST_PROVIDER_ID_KEY, id, { allowProtected: true });
	} else if (isFast === false && (await getFastProviderId()) === id) {
		await upsertSetting(AI_FAST_PROVIDER_ID_KEY, "", { allowProtected: true });
	}
	return c.json({ provider });
});

aiProvidersRouter.delete("/ai/providers/:id", async (c) => {
	const gate = await requireAiActive(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const deleted = await deleteProvider(id);
	if (!deleted) return c.json({ error: "Provider not found" }, 404);
	if ((await getFastProviderId()) === id) {
		await upsertSetting(AI_FAST_PROVIDER_ID_KEY, "", { allowProtected: true });
	}
	return c.json({ ok: true });
});

export default aiProvidersRouter;
