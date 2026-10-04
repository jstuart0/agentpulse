import { Hono } from "hono";

// Red-commit stub (AGEN-69 phase 6): answers 501 until the handlers land.
const aiSessionSummaryRouter = new Hono();

aiSessionSummaryRouter.get("/ai/sessions/:sessionId/summary", (c) =>
	c.json({ error: "not_implemented" }, 501),
);
aiSessionSummaryRouter.post("/ai/sessions/:sessionId/summary", (c) =>
	c.json({ error: "not_implemented" }, 501),
);

export default aiSessionSummaryRouter;
