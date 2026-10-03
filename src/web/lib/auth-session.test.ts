import { describe, expect, test } from "bun:test";
import type { AuthMeResponse } from "../../shared/types.js";
import { ApiError } from "./api.js";
import {
	FRESH_WATCH,
	SIGNED_OUT_MESSAGE,
	UNCONFIRMED_AFTER_REFUSALS,
	afterPasswordChange,
	classifyPasswordChangeFailure,
	createRecheckGate,
	createSingleFlight,
	isNetworkFailure,
	loadedAfter,
	loginNotice,
	reduceAuthLoad,
	reduceSignInWatch,
	resetTarget,
	shouldRecheckAuth,
} from "./auth-session.js";

function me(userId: string | null, extra: Partial<AuthMeResponse["user"]> = {}): AuthMeResponse {
	return {
		authenticated: userId !== null,
		user:
			userId === null
				? null
				: ({ name: userId, source: "local", id: userId, role: "user", userId, ...extra } as never),
		signOutUrl: null,
		disableAuth: false,
		allowSignup: false,
	};
}

describe("reduceAuthLoad", () => {
	const signedInA = { userId: "A", authenticated: true };

	test("a normal answer replaces the state and asks for no reset", () => {
		const { patch, reset } = reduceAuthLoad(signedInA, { kind: "ok", res: me("A") });
		expect(patch.authenticated).toBe(true);
		expect(patch.userId).toBe("A");
		expect(patch.error).toBeNull();
		expect(reset).toBeNull();
	});

	test("the answer 'signed out' after being signed in is a signed-out reset", () => {
		const { patch, reset } = reduceAuthLoad(signedInA, { kind: "ok", res: me(null) });
		expect(patch.authenticated).toBe(false);
		expect(reset).toBe("signed_out");
	});

	test("a different user than before is a switched reset", () => {
		expect(reduceAuthLoad(signedInA, { kind: "ok", res: me("B") }).reset).toBe("switched");
	});

	test("a change to or from an identity with no user id is a switched reset too", () => {
		const ownerless: AuthMeResponse = {
			...me("A"),
			user: { name: "key", source: "api_key", id: "k1", userId: null } as never,
		};
		expect(reduceAuthLoad(signedInA, { kind: "ok", res: ownerless }).reset).toBe("switched");
		expect(
			reduceAuthLoad({ userId: null, authenticated: true }, { kind: "ok", res: me("B") }).reset,
		).toBe("switched");
		expect(
			reduceAuthLoad({ userId: null, authenticated: true }, { kind: "ok", res: ownerless }).reset,
		).toBeNull();
	});

	test("the first sign-in (nobody before) needs no reset", () => {
		expect(
			reduceAuthLoad({ userId: null, authenticated: false }, { kind: "ok", res: me("B") }).reset,
		).toBeNull();
	});

	test("a flagged user is reported as must-change-password, same user, no reset", () => {
		const { patch, reset } = reduceAuthLoad(signedInA, {
			kind: "ok",
			res: me("A", { mustChangePassword: true }),
		});
		expect(patch.mustChangePassword).toBe(true);
		expect(reset).toBeNull();
	});

	test("a failed answer that isn't a network error signs the viewer out", () => {
		const { patch, reset } = reduceAuthLoad(signedInA, {
			kind: "failed",
			network: false,
			message: "boom",
		});
		expect(patch.authenticated).toBe(false);
		expect(patch.user).toBeNull();
		expect(patch.error).toBe("boom");
		expect(reset).toBe("signed_out");
	});

	test("a network error changes nothing but the message", () => {
		const { patch, reset } = reduceAuthLoad(signedInA, {
			kind: "failed",
			network: true,
			message: "offline",
		});
		expect(patch).toEqual({ error: "offline" });
		expect(reset).toBeNull();
	});

	test("a failure while nobody was signed in resets nothing", () => {
		expect(
			reduceAuthLoad(
				{ userId: null, authenticated: false },
				{ kind: "failed", network: false, message: "x" },
			).reset,
		).toBeNull();
	});
});

describe("an unhealthy server is not a signed-out viewer", () => {
	test("a 5xx or a 429 from the identity call is treated like the network being down", () => {
		for (const status of [500, 502, 503, 504, 429]) {
			expect(isNetworkFailure(new ApiError(status, "x", null))).toBe(true);
		}
	});

	test("a 401 or 403 is still an answer about the viewer", () => {
		for (const status of [401, 403]) {
			expect(isNetworkFailure(new ApiError(status, "x", null))).toBe(false);
		}
	});

	test("such a failure on the first load leaves standing unknown and signs nobody out", () => {
		const outcome = {
			kind: "failed" as const,
			network: isNetworkFailure(new ApiError(503, "x")),
			message: "x",
		};
		expect(loadedAfter(false, outcome)).toBe(false);
		expect(reduceAuthLoad({ userId: "A", authenticated: true }, outcome).reset).toBeNull();
	});
});

describe("isNetworkFailure", () => {
	test("a refusal from the server is not a network failure; anything else thrown is", () => {
		expect(isNetworkFailure(new ApiError(404, "x", null))).toBe(false);
		expect(isNetworkFailure(new TypeError("Failed to fetch"))).toBe(true);
	});
});

describe("shouldRecheckAuth", () => {
	test("a 401 on an ordinary call means the session ended: look again", () => {
		expect(shouldRecheckAuth({ status: 401, code: "Unauthorized", path: "/sessions" })).toBe(true);
	});

	test("a 403 that says the password must change: look again, the gate takes over", () => {
		expect(
			shouldRecheckAuth({ status: 403, code: "password_change_required", path: "/sessions" }),
		).toBe(true);
	});

	test("a refusal that says the viewer's role or ownership isn't what the page thought: look again", () => {
		for (const code of ["admin_required", "human_admin_required", "not_owner"]) {
			expect(shouldRecheckAuth({ status: 403, code, path: "/sessions/1" })).toBe(true);
		}
	});

	test("other refusals are the caller's business", () => {
		expect(shouldRecheckAuth({ status: 403, code: "bad_origin", path: "/sessions/1" })).toBe(false);
		expect(shouldRecheckAuth({ status: 403, code: null, path: "/sessions/1" })).toBe(false);
		expect(shouldRecheckAuth({ status: 404, code: null, path: "/sessions/1" })).toBe(false);
	});

	test("the identity call itself never triggers another identity call", () => {
		expect(shouldRecheckAuth({ status: 401, code: null, path: "/auth/me" })).toBe(false);
	});

	test("a wrong current password is a 401 that is not an ended session", () => {
		expect(
			shouldRecheckAuth({
				status: 401,
				code: "Invalid current password",
				path: "/auth/change-password",
			}),
		).toBe(false);
	});

	test("an ended session during a password change is still an ended session", () => {
		expect(
			shouldRecheckAuth({ status: 401, code: "Unauthorized", path: "/auth/change-password" }),
		).toBe(true);
	});
});

describe("createSingleFlight", () => {
	function deferred() {
		let resolve!: () => void;
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	test("calls made while one is running share one trailing run, and wait for it", async () => {
		const gates = [deferred(), deferred()];
		let started = 0;
		const run = createSingleFlight(async () => {
			const gate = gates[started];
			started += 1;
			await gate.promise;
			return started;
		});

		const first = run();
		const second = run();
		const third = run();
		expect(started).toBe(1);

		gates[0].resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(started).toBe(2);

		let secondDone = false;
		void second.then(() => {
			secondDone = true;
		});
		await new Promise((r) => setTimeout(r, 0));
		expect(secondDone).toBe(false);

		gates[1].resolve();
		expect(await first).toBe(1);
		expect(await second).toBe(2);
		expect(await third).toBe(2);
		expect(started).toBe(2);
	});

	test("a call after everything finished starts a fresh run", async () => {
		let count = 0;
		const run = createSingleFlight(async () => {
			count += 1;
			return count;
		});
		expect(await run()).toBe(1);
		expect(await run()).toBe(2);
	});

	test("a failed run doesn't wedge later calls", async () => {
		let count = 0;
		const run = createSingleFlight(async () => {
			count += 1;
			if (count === 1) throw new Error("first");
			return count;
		});
		await expect(run()).rejects.toThrow("first");
		expect(await run()).toBe(2);
	});
});

describe("the signed-out notice and reset targets", () => {
	test("the login page says why, only when asked", () => {
		expect(SIGNED_OUT_MESSAGE).toBe("You've been signed out.");
		expect(loginNotice("?reason=signed_out")).toBe("You've been signed out.");
		expect(loginNotice("")).toBeNull();
		expect(loginNotice("?reason=other")).toBeNull();
	});

	test("both resets are a full load of the login page; only a sign-out carries the reason", () => {
		expect(resetTarget("signed_out")).toBe("/login?reason=signed_out");
		expect(resetTarget("switched")).toBe("/login");
	});
});

describe("password change outcomes", () => {
	test("a wrong current password points at that field", () => {
		const err = new ApiError(401, "Invalid current password", {
			error: "Invalid current password",
		});
		expect(classifyPasswordChangeFailure(err)).toEqual({
			field: "current",
			message: "That isn't your current password.",
		});
	});

	test("an ended session is not reported as a wrong current password", () => {
		const err = new ApiError(401, "Unauthorized", { error: "Unauthorized" });
		const result = classifyPasswordChangeFailure(err);
		expect(result.field).toBeNull();
		expect(result.message).toBe("You've been signed out. Sign in again to change your password.");
	});

	test("a refused new password points at the new-password field, in the server's words", () => {
		const err = new ApiError(400, "x", {
			error: "password_complexity_failed",
			reason: "Password must contain at least one digit.",
		});
		expect(classifyPasswordChangeFailure(err)).toEqual({
			field: "next",
			message: "Password must contain at least one digit.",
		});
	});

	test("anything else is a form-level sentence", () => {
		expect(classifyPasswordChangeFailure(new TypeError("Failed to fetch"))).toEqual({
			field: null,
			message: "Couldn't change the password. Try again.",
		});
	});

	test("after a successful change, a failed identity reload says so instead of leaving the form stuck", () => {
		expect(afterPasswordChange(true)).toEqual({ ok: true, message: "Password changed." });
		expect(afterPasswordChange(false)).toEqual({
			ok: false,
			message: "Your password was changed, but we couldn't confirm your sign-in. Reload the page.",
		});
	});
});

describe("loadedAfter", () => {
	test("a first load that never reached the server is not a load", () => {
		expect(loadedAfter(false, { kind: "failed", network: true, message: "x" })).toBe(false);
	});

	test("an answer, or a refusal from the server, is a load", () => {
		expect(loadedAfter(false, { kind: "ok", res: me("A") })).toBe(true);
		expect(loadedAfter(false, { kind: "failed", network: false, message: "x" })).toBe(true);
	});

	test("once loaded, a later network failure doesn't unload", () => {
		expect(loadedAfter(true, { kind: "failed", network: true, message: "x" })).toBe(true);
	});
});

describe("classifyPasswordChangeFailure when throttled", () => {
	const throttled = (seconds: number | null) =>
		new ApiError(429, "Too many failed attempts. Try again later.", null, seconds);

	test("says how long to wait, in minutes, rounded up", () => {
		expect(classifyPasswordChangeFailure(throttled(900))).toEqual({
			field: null,
			message: "Too many wrong attempts. Wait about 15 minutes, then try again.",
			retryAfterSeconds: 900,
		});
		expect(classifyPasswordChangeFailure(throttled(61)).message).toBe(
			"Too many wrong attempts. Wait about 2 minutes, then try again.",
		);
	});

	test("under a minute reads as one minute, singular", () => {
		expect(classifyPasswordChangeFailure(throttled(20)).message).toBe(
			"Too many wrong attempts. Wait about 1 minute, then try again.",
		);
	});

	test("without a header it still says why and doesn't invent a number", () => {
		const failure = classifyPasswordChangeFailure(throttled(null));
		expect(failure.message).toBe("Too many wrong attempts. Wait a few minutes, then try again.");
		expect(failure.retryAfterSeconds).toBeUndefined();
	});

	test("is not the generic failure sentence", () => {
		expect(classifyPasswordChangeFailure(throttled(900)).message).not.toContain("Couldn't");
	});
});

describe("reduceSignInWatch", () => {
	const run = (...events: Parameters<typeof reduceSignInWatch>[1][]) => {
		let state = { watch: FRESH_WATCH, unconfirmed: false };
		for (const event of events) state = reduceSignInWatch(state.watch, event);
		return state;
	};

	test("refusals alone never make the sign-in unconfirmed: the identity check decides", () => {
		const refusals = Array<"refused">(UNCONFIRMED_AFTER_REFUSALS + 2).fill("refused");
		expect(run(...refusals).unconfirmed).toBe(false);
	});

	test("enough refusals while the identity check cannot answer do", () => {
		const refusals = Array<"refused">(UNCONFIRMED_AFTER_REFUSALS).fill("refused");
		expect(run("identity_unanswered", ...refusals).unconfirmed).toBe(true);
		expect(run("identity_unanswered", ...refusals.slice(1)).unconfirmed).toBe(false);
	});

	test("a successful call in between starts the count again", () => {
		const refusals = Array<"refused">(UNCONFIRMED_AFTER_REFUSALS - 1).fill("refused");
		expect(run("identity_unanswered", ...refusals, "answered", "refused").unconfirmed).toBe(false);
	});

	test("the identity check answering clears it", () => {
		const refusals = Array<"refused">(UNCONFIRMED_AFTER_REFUSALS).fill("refused");
		expect(run("identity_unanswered", ...refusals, "identity_answered").unconfirmed).toBe(false);
	});
});

describe("createRecheckGate", () => {
	test("lets one run start, refuses another while it is in flight, and allows one after the quiet interval", () => {
		let now = 1_000;
		const gate = createRecheckGate(5_000, () => now);
		expect(gate.tryStart()).toBe(true);
		expect(gate.tryStart()).toBe(false);
		gate.finish();
		now += 4_999;
		expect(gate.tryStart()).toBe(false);
		now += 1;
		expect(gate.tryStart()).toBe(true);
	});

	test("a run that never finishes does not block forever past the interval's ten-fold", () => {
		let now = 0;
		const gate = createRecheckGate(1_000, () => now);
		expect(gate.tryStart()).toBe(true);
		now += 60_000;
		expect(gate.tryStart()).toBe(true);
	});
});
