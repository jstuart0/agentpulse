import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import brandIcon from "../assets/agentpulse-icon.svg";
import { useUserStore } from "../stores/user-store.js";

/**
 * Public login page. Also renders a one-time "create admin" flow when
 * the users table is empty and AGENTPULSE_ALLOW_SIGNUP is on. After
 * success we hand off to the next page via navigate("/").
 */
export function LoginPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const user = useUserStore((s) => s.user);
	const allowSignup = useUserStore((s) => s.allowSignup);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const refreshUser = useUserStore((s) => s.load);

	const [mode, setMode] = useState<"login" | "signup">("login");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Redirect if already authenticated or auth is disabled globally.
	useEffect(() => {
		if (user || disableAuth) {
			const next = (location.state as { from?: string } | null)?.from ?? "/";
			navigate(next, { replace: true });
		}
	}, [user, disableAuth, navigate, location.state]);

	// Switch to signup automatically when the server says signup is allowed
	// (first-run installs with zero users).
	useEffect(() => {
		if (allowSignup) setMode("signup");
	}, [allowSignup]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (mode === "signup" && password !== confirmPassword) {
			setError("Passwords don't match.");
			return;
		}
		setSubmitting(true);
		try {
			const endpoint = mode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/signup";
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			});
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setError(data.error ?? `HTTP ${res.status}`);
				return;
			}
			await refreshUser();
			const next = (location.state as { from?: string } | null)?.from ?? "/";
			navigate(next, { replace: true });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="min-h-dvh flex items-center justify-center bg-background p-6">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center space-y-2">
					<img src={brandIcon} alt="AgentPulse" className="w-12 h-12 mx-auto" />
					<h1 className="text-xl font-semibold text-foreground">AgentPulse</h1>
					<p className="text-xs text-muted-foreground">
						{mode === "signup"
							? "Create the first admin account for this instance."
							: "Sign in to continue."}
					</p>
				</div>

				<form
					onSubmit={handleSubmit}
					className="rounded-lg border border-border bg-card p-5 space-y-3"
				>
					<label className="block space-y-1 text-xs">
						<span className="text-muted-foreground">Username</span>
						<input
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							autoComplete="username"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
							required
						/>
					</label>
					<label className="block space-y-1 text-xs">
						<span className="text-muted-foreground">Password</span>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete={mode === "login" ? "current-password" : "new-password"}
							minLength={mode === "signup" ? 12 : undefined}
							className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
							required
						/>
						{mode === "signup" && (
							<span className="text-[10px] text-muted-foreground">At least 12 characters.</span>
						)}
					</label>
					{mode === "signup" && (
						<label className="block space-y-1 text-xs">
							<span className="text-muted-foreground">Confirm password</span>
							<input
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								autoComplete="new-password"
								className="w-full bg-background border border-border rounded px-3 py-2 text-sm text-foreground"
								required
							/>
						</label>
					)}

					{error && (
						<div className="rounded border border-red-500/30 bg-red-500/10 text-red-300 text-xs px-3 py-2">
							{error}
						</div>
					)}

					<button
						type="submit"
						disabled={submitting || !username || !password}
						className="w-full rounded-md bg-primary text-primary-foreground font-medium text-sm px-3 py-2 hover:bg-primary/90 disabled:opacity-50"
					>
						{submitting ? "Working…" : mode === "signup" ? "Create admin account" : "Sign in"}
					</button>
				</form>

				<p className="text-[11px] text-muted-foreground text-center">
					{mode === "signup"
						? "You are creating the first user on this instance; they'll be given the admin role. Further signups are disabled by default."
						: "Local accounts use username + password. If your team uses Authentik SSO, sign in via the configured IdP instead."}
				</p>
			</div>
		</div>
	);
}
