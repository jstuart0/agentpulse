export const config = {
	port: Number(process.env.PORT || 3000),
	host: process.env.HOST || "0.0.0.0",
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

	// Telegram HITL channel — instance-wide bot token serves every
	// per-user channel enrollment. When unset, Telegram features stay
	// dark regardless of the labs flag.
	telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
	telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || "",

	get useSqlite(): boolean {
		return !this.databaseUrl || !this.databaseUrl.startsWith("postgres");
	},

	get sqlitePath(): string {
		if (this.sqlitePathOverride) return this.sqlitePathOverride;
		return `${this.dataDir}/agentpulse.db`;
	},
};
