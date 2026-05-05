export const config = {
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "127.0.0.1",
	databaseUrl: process.env.DATABASE_URL || "",
	publicUrl: process.env.PUBLIC_URL || "http://localhost:3000",
	logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
	initialApiKey: process.env.AGENTPULSE_INITIAL_API_KEY || "",
	disableAuth: process.env.DISABLE_AUTH === "true",
	isProduction: process.env.NODE_ENV === "production",
	dataDir: process.env.DATA_DIR || "./data",
	sqlitePathOverride: process.env.SQLITE_PATH || "",

	// AI watcher feature — two-level opt-in. AGENTPULSE_AI_ENABLED gates the
	// feature surface at boot (tables, routes, UI); a runtime settings toggle
	// controls whether the compiled-in feature actually runs. When enabled,
	// AGENTPULSE_SECRETS_KEY must be set — it encrypts provider credentials.
	aiEnabled: process.env.AGENTPULSE_AI_ENABLED === "true",
	secretsKey: process.env.AGENTPULSE_SECRETS_KEY || "",

	// Vector embeddings for semantic search — third-tier opt-in beyond the AI
	// flag. AGENTPULSE_VECTOR_SEARCH gates the embeddings table, ingest
	// indexing, and Settings UI. Unset = the feature is invisible (no table,
	// no UI, no embed calls). Set = surface is built; users still toggle on
	// at runtime in Settings.
	vectorSearchEnabled: process.env.AGENTPULSE_VECTOR_SEARCH === "true",

	// Telegram HITL channel — instance-wide bot token serves every
	// per-user channel enrollment. When unset, Telegram features stay
	// dark regardless of the labs flag.
	telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
	telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",

	// Local accounts. When DISABLE_AUTH=false (default), local username+
	// password auth is always available. Bootstrap a first admin by
	// setting AGENTPULSE_LOCAL_ADMIN_USERNAME / _PASSWORD; first-run
	// signup is otherwise gated by AGENTPULSE_ALLOW_SIGNUP and only fires
	// when the users table is empty.
	allowSignup: process.env.AGENTPULSE_ALLOW_SIGNUP === "true",
	localAdminUsername: process.env.AGENTPULSE_LOCAL_ADMIN_USERNAME || "",
	localAdminPassword: process.env.AGENTPULSE_LOCAL_ADMIN_PASSWORD || "",

	// Generic forwardauth configuration. When non-empty, every request that carries
	// forwardauth identity headers MUST also carry the verify header with this value
	// (set via a property mapping in the upstream IdP). The middleware strips all
	// forwardauth headers on mismatch so forged headers can't pass through.
	// Empty = trust gate disabled (startup warning emitted; not recommended in prod).
	//
	// Header names are configurable via FORWARDAUTH_HEADER_* env vars so any
	// forwardauth-capable IdP (Authentik (default), Authelia, oauth2-proxy, Pomerium,
	// Cloudflare Access, etc.) works without code changes.

	// Lookup table of Authentik default header names. Reads FORWARDAUTH_HEADER_<SLOT>
	// at call time so env overrides take effect in tests without re-importing config.
	forwardauthHeader(
		slot: "username" | "email" | "groups" | "name" | "uid" | "verify" | "strip_prefix",
	): string {
		const HEADER_ENV_KEYS: Record<typeof slot, string> = {
			username: "FORWARDAUTH_HEADER_USERNAME",
			email: "FORWARDAUTH_HEADER_EMAIL",
			groups: "FORWARDAUTH_HEADER_GROUPS",
			name: "FORWARDAUTH_HEADER_NAME",
			uid: "FORWARDAUTH_HEADER_UID",
			verify: "FORWARDAUTH_HEADER_VERIFY",
			strip_prefix: "FORWARDAUTH_HEADER_STRIP_PREFIX",
		};
		const HEADER_DEFAULTS: Record<typeof slot, string> = {
			username: "X-Authentik-Username",
			email: "X-Authentik-Email",
			groups: "X-Authentik-Groups",
			name: "X-Authentik-Name",
			uid: "X-Authentik-Uid",
			verify: "X-Authentik-Verify",
			strip_prefix: "X-Authentik-",
		};
		return process.env[HEADER_ENV_KEYS[slot]] || HEADER_DEFAULTS[slot];
	},

	// The configured forwardauth provider label (e.g. "authentik", "authelia").
	// Free-form string — only "authentik" triggers provider-specific behaviour
	// (signOutUrl). All other values are UI labels only.
	get forwardauthProvider(): string {
		return process.env.FORWARDAUTH_PROVIDER || "authentik";
	},

	// The forwardauth trust secret. Reads FORWARDAUTH_TRUST_SECRET first, then
	// the deprecated AGENTPULSE_AUTHENTIK_TRUST_SECRET as a fallback.
	// Memoized on first access — env is read at module load and cannot change
	// at runtime (consistent with the dialect getter pattern).
	// writable: true so tests can delete the cached value to pick up env changes.
	get forwardauthTrustSecret(): string {
		if (Object.prototype.hasOwnProperty.call(this, "_forwardauthTrustSecret")) {
			return (this as unknown as { _forwardauthTrustSecret: string })._forwardauthTrustSecret;
		}
		const resolved =
			process.env.FORWARDAUTH_TRUST_SECRET || process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET || "";
		Object.defineProperty(this, "_forwardauthTrustSecret", {
			value: resolved,
			writable: true,
			configurable: true,
		});
		return resolved;
	},

	/**
	 * @deprecated Use config.forwardauthTrustSecret instead.
	 * Retained for one release as a back-compat alias.
	 * Callers in private overlays or extensions continue to work.
	 */
	get authentikTrustSecret(): string {
		return this.forwardauthTrustSecret;
	},

	// Comma-separated list of allowed WebSocket origins, derived from PUBLIC_URL.
	// Example: "https://agentpulse.example.com,http://localhost:5173"
	// The first entry is treated as the canonical public URL; extras are dev origins.
	get allowedOrigins(): string[] {
		const raw = process.env.PUBLIC_URL || "http://localhost:3000";
		return raw
			.split(",")
			.map((u) => u.trim())
			.filter(Boolean)
			.map((u) => new URL(u).origin);
	},

	/** @deprecated use config.dialect directly; this alias removed in next campaign. */
	get useSqlite(): boolean {
		return this.dialect === "sqlite";
	},

	/**
	 * Resolved dialect for this process lifetime. Resolution rule:
	 *   - empty / undefined DATABASE_URL → "sqlite"
	 *   - starts with "postgres:" or "postgresql:" → "postgres"
	 *   - anything else (e.g. a file path)  → "sqlite"
	 *
	 * Memoized on first access: databaseUrl is read from process.env at
	 * module load and cannot change at runtime, so the memo is safe.
	 */
	get dialect(): "sqlite" | "postgres" {
		// Lazily resolve and cache on the object itself to avoid re-running the
		// check on every hot-path call (dexter L-1 concern).
		if (Object.prototype.hasOwnProperty.call(this, "_dialect")) {
			return (this as unknown as { _dialect: "sqlite" | "postgres" })._dialect;
		}
		const url = this.databaseUrl;
		const resolved: "sqlite" | "postgres" =
			url && (url.startsWith("postgres:") || url.startsWith("postgresql:")) ? "postgres" : "sqlite";
		Object.defineProperty(this, "_dialect", { value: resolved, writable: false });
		return resolved;
	},

	get sqlitePath(): string {
		if (this.sqlitePathOverride) return this.sqlitePathOverride;
		return `${this.dataDir}/agentpulse.db`;
	},
};
