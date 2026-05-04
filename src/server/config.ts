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

	// Authentik shared-secret trust gate. When non-empty, every request that
	// carries X-Authentik-* headers MUST also carry X-Authentik-Verify with this
	// value (HMAC-constant in Authentik property mapping). The middleware strips
	// all X-Authentik-* headers on mismatch so forged headers can't pass through.
	// Empty = trust gate disabled (startup warning emitted; not recommended in prod).
	authentikTrustSecret: process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET || "",

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

	get useSqlite(): boolean {
		return !this.databaseUrl || !this.databaseUrl.startsWith("postgres");
	},

	get sqlitePath(): string {
		if (this.sqlitePathOverride) return this.sqlitePathOverride;
		return `${this.dataDir}/agentpulse.db`;
	},
};
