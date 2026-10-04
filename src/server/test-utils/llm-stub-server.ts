/**
 * Stand-in model provider for tests (AGEN-69 contract C-3).
 *
 * Serves each real adapter's own path and wire shape (OpenAI chat, Anthropic
 * messages, Cohere chat) on the loopback address only, so the real adapters
 * run unmodified against it. Answers are scripted per shape and replayed in
 * order. There is no default answer: a request nothing was scripted for gets
 * `UNSCRIPTED_STATUS`, is recorded, and makes `verify()` throw, so a test can
 * never pass because the stub quietly said something plausible.
 */

export type WireShape = "openai" | "anthropic" | "cohere";

export interface StubGate {
	/** Resolves once a request is being held at this gate. */
	readonly arrived: Promise<void>;
	/** Lets the held response go. Safe to call before the request arrives. */
	release(): void;
}

export interface ScriptedAnswer {
	text: string;
	/**
	 * The provider's own stop field (`finish_reason`, `stop_reason`): a string
	 * is sent as is, `null` is sent as JSON null, `undefined` omits the field.
	 */
	stop?: string | null;
	/** Token counts the provider reports; omitted from the wire when absent. */
	usage?: { input: number; output: number };
	/** A non-2xx status makes `errorBody` the whole response. */
	status?: number;
	errorBody?: string;
	/** Holds the response until released. */
	gate?: StubGate;
}

export interface RecordedRequest {
	shape: WireShape;
	path: string;
	headers: Record<string, string>;
	/** The raw request body, exactly as received. */
	body: string;
}

export interface LlmStubServer {
	/** The address the server is bound to. */
	readonly hostname: string;
	readonly origin: string;
	/** The `baseUrl` to give a provider row or adapter for each wire shape. */
	baseUrl(shape: WireShape): string;
	/** Queues answers for a shape; they are replayed in order. */
	script(shape: WireShape, ...answers: ScriptedAnswer[]): void;
	createGate(): StubGate;
	requests(shape?: WireShape): RecordedRequest[];
	/** Requests that arrived with nothing scripted for them. */
	readonly unscripted: RecordedRequest[];
	/** Throws when any request arrived unscripted. Call in `afterEach`. */
	verify(): void;
	/** Clears scripts, recordings and the unscripted list. */
	reset(): void;
	stop(): Promise<void>;
}

/** The status an unscripted request receives. */
export const UNSCRIPTED_STATUS = 599;

const PATHS: Record<string, WireShape> = {
	"/v1/chat/completions": "openai",
	"/v1/messages": "anthropic",
	"/v1/chat": "cohere",
};

function successBody(shape: WireShape, a: ScriptedAnswer): unknown {
	const hasStop = a.stop !== undefined;
	switch (shape) {
		case "openai":
			return {
				choices: [{ message: { content: a.text }, ...(hasStop ? { finish_reason: a.stop } : {}) }],
				...(a.usage
					? { usage: { prompt_tokens: a.usage.input, completion_tokens: a.usage.output } }
					: {}),
			};
		case "anthropic":
			return {
				content: [{ type: "text", text: a.text }],
				...(hasStop ? { stop_reason: a.stop } : {}),
				...(a.usage
					? { usage: { input_tokens: a.usage.input, output_tokens: a.usage.output } }
					: {}),
			};
		case "cohere":
			return {
				text: a.text,
				...(hasStop ? { finish_reason: a.stop } : {}),
				...(a.usage
					? { meta: { tokens: { input_tokens: a.usage.input, output_tokens: a.usage.output } } }
					: {}),
			};
	}
}

function createGate(): StubGate & { wait(): Promise<void>; markArrived(): void } {
	let release!: () => void;
	let markArrived!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	const arrived = new Promise<void>((resolve) => {
		markArrived = resolve;
	});
	return { arrived, release, wait: () => released, markArrived };
}

export function startLlmStubServer(): LlmStubServer {
	const scripts: Record<WireShape, ScriptedAnswer[]> = { openai: [], anthropic: [], cohere: [] };
	let recorded: RecordedRequest[] = [];
	let unscripted: RecordedRequest[] = [];
	const gates = new WeakMap<StubGate, ReturnType<typeof createGate>>();

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const shape = PATHS[path];
			const headers: Record<string, string> = {};
			req.headers.forEach((value, key) => {
				headers[key] = value;
			});
			const record = {
				shape: shape ?? ("openai" as WireShape),
				path,
				headers,
				body: await req.text(),
			};
			const answer = shape ? scripts[shape].shift() : undefined;
			if (!shape || !answer) {
				unscripted.push(record);
				return new Response(`llm-stub: unscripted ${req.method} ${path}`, {
					status: UNSCRIPTED_STATUS,
				});
			}
			recorded.push(record);
			if (answer.gate) {
				const gate = gates.get(answer.gate);
				if (gate) {
					gate.markArrived();
					await gate.wait();
				}
			}
			if (answer.status !== undefined && answer.status >= 400) {
				return new Response(answer.errorBody ?? "", { status: answer.status });
			}
			return Response.json(successBody(shape, answer));
		},
	});

	const origin = `http://${server.hostname}:${server.port}`;
	return {
		hostname: server.hostname ?? "",
		origin,
		baseUrl: (shape) => (shape === "openai" ? `${origin}/v1` : origin),
		script(shape, ...answers) {
			scripts[shape].push(...answers);
		},
		createGate() {
			const gate = createGate();
			const handle: StubGate = { arrived: gate.arrived, release: gate.release };
			gates.set(handle, gate);
			return handle;
		},
		requests: (shape) => (shape ? recorded.filter((r) => r.shape === shape) : [...recorded]),
		get unscripted() {
			return unscripted;
		},
		verify() {
			if (unscripted.length > 0) {
				const lines = unscripted.map((r) => `${r.shape} ${r.path}`).join(", ");
				throw new Error(`llm-stub: ${unscripted.length} unscripted request(s): ${lines}`);
			}
		},
		reset() {
			for (const shape of Object.keys(scripts) as WireShape[]) scripts[shape] = [];
			recorded = [];
			unscripted = [];
		},
		async stop() {
			await server.stop(true);
		},
	};
}
