import { Hono } from "hono";

const health = new Hono();

health.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "agentpulse",
		timestamp: new Date().toISOString(),
	});
});

export { health };
