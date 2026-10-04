/**
 * Stand-in model provider for tests (AGEN-69 contract C-3). Phase 2a stub:
 * the types are final, the implementation lands in the green commit.
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

export function startLlmStubServer(): LlmStubServer {
	throw new Error("startLlmStubServer: not implemented");
}
