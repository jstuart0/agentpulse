import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api.js";
import { afterPasswordChange, classifyPasswordChangeFailure } from "../../lib/auth-session.js";
import {
	type PasswordFormErrors,
	clearFieldError,
	passwordChecks,
	passwordRulesSummary,
	validatePasswordForm,
} from "../../lib/password-form.js";
import { useUserStore } from "../../stores/user-store.js";

interface AccountPanelProps {
	/** The only thing a flagged user can do: the form stands alone, with a heading of its own. */
	forced?: boolean;
}

const INPUT_CLASS =
	"min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm md:min-h-0 text-foreground focus:outline-none focus:ring-2 focus:ring-ring aria-[invalid=true]:border-red-500";

/**
 * Change your own password. Local accounts only; in both modes. For someone
 * whose password an admin chose, it is the whole app until it succeeds.
 */
export function AccountPanel({ forced = false }: AccountPanelProps) {
	const reloadUser = useUserStore((s) => s.load);
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [errors, setErrors] = useState<PasswordFormErrors>({});
	const [formError, setFormError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	// Set while the server is refusing this account for too many wrong attempts.
	const [blockedUntil, setBlockedUntil] = useState<number | null>(null);
	const alertRef = useRef<HTMLParagraphElement>(null);
	const currentRef = useRef<HTMLInputElement>(null);
	const nextRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);
	const ids = {
		current: useId(),
		next: useId(),
		confirm: useId(),
		rules: useId(),
		alert: useId(),
	};

	// Someone who can do nothing else starts on the first field.
	useEffect(() => {
		if (forced) currentRef.current?.focus();
	}, [forced]);

	// The throttle lifts by itself: re-enable the button and drop the stale sentence.
	useEffect(() => {
		if (blockedUntil === null) return;
		const timer = setTimeout(
			() => {
				setBlockedUntil(null);
				setFormError(null);
			},
			Math.max(0, blockedUntil - Date.now()),
		);
		return () => clearTimeout(timer);
	}, [blockedUntil]);

	// The submit button is disabled while the request runs, which drops focus;
	// a form-level sentence takes it so it is read and the keyboard stays here.
	useEffect(() => {
		if (formError) alertRef.current?.focus();
	}, [formError]);

	async function handleSubmit(e: FormEvent) {
		e.preventDefault();
		if (blockedUntil !== null) return;
		setFormError(null);
		const result = validatePasswordForm({ current, next, confirm });
		setErrors(result.errors);
		if (!result.ok) {
			(result.errors.current
				? currentRef
				: result.errors.next
					? nextRef
					: confirmRef
			).current?.focus();
			return;
		}

		setSubmitting(true);
		try {
			await api.changePassword({ currentPassword: current, newPassword: next });
			setCurrent("");
			setNext("");
			setConfirm("");
			// For a flagged user this flips the gate: the app loads without a reload.
			const outcome = afterPasswordChange(await reloadUser());
			if (outcome.ok) toast.success(outcome.message);
			else setFormError(outcome.message);
		} catch (err) {
			const failure = classifyPasswordChangeFailure(err);
			if (failure.field === "current") setErrors({ current: failure.message });
			else if (failure.field === "next") setErrors({ next: failure.message });
			else setFormError(failure.message);
			if (failure.retryAfterSeconds !== undefined) {
				setBlockedUntil(Date.now() + failure.retryAfterSeconds * 1000);
			}
			if (failure.field === "current") currentRef.current?.focus();
			else if (failure.field === "next") nextRef.current?.focus();
		} finally {
			setSubmitting(false);
		}
	}

	const checks = passwordChecks(next);

	return (
		<form onSubmit={handleSubmit} noValidate className="space-y-4" aria-label="Change password">
			{forced && (
				<p className="text-sm text-hint">
					An admin chose your current password. Choose your own to continue. You'll be signed in
					with it right away.
				</p>
			)}

			<div className="space-y-1">
				<label htmlFor={ids.current} className="block text-sm text-foreground">
					Current password
				</label>
				<input
					ref={currentRef}
					id={ids.current}
					type="password"
					autoComplete="current-password"
					value={current}
					onChange={(e) => {
						setCurrent(e.target.value);
						setErrors((prev) => clearFieldError(prev, "current"));
					}}
					aria-invalid={errors.current ? true : undefined}
					aria-describedby={errors.current ? `${ids.current}-error` : undefined}
					className={INPUT_CLASS}
				/>
				{errors.current && <FieldError id={`${ids.current}-error`}>{errors.current}</FieldError>}
			</div>

			<div className="space-y-1">
				<label htmlFor={ids.next} className="block text-sm text-foreground">
					New password
				</label>
				<input
					ref={nextRef}
					id={ids.next}
					type="password"
					autoComplete="new-password"
					value={next}
					onChange={(e) => {
						setNext(e.target.value);
						setErrors((prev) => clearFieldError(prev, "next"));
					}}
					aria-invalid={errors.next ? true : undefined}
					aria-describedby={`${ids.rules}${errors.next ? ` ${ids.next}-error` : ""}`}
					className={INPUT_CLASS}
				/>
				{errors.next && <FieldError id={`${ids.next}-error`}>{errors.next}</FieldError>}
				<output className="sr-only">{passwordRulesSummary(next)}</output>
				<ul id={ids.rules} className="grid gap-x-4 gap-y-0.5 pt-1 text-xs sm:grid-cols-2">
					{checks.map((check) => (
						<li
							key={check.id}
							className={check.met ? "text-emerald-700 dark:text-emerald-400" : "text-hint"}
						>
							<span aria-hidden="true">{check.met ? "✓ " : "○ "}</span>
							{check.label}
							<span className="sr-only">{check.met ? " (met)" : " (not met yet)"}</span>
						</li>
					))}
				</ul>
			</div>

			<div className="space-y-1">
				<label htmlFor={ids.confirm} className="block text-sm text-foreground">
					Confirm new password
				</label>
				<input
					ref={confirmRef}
					id={ids.confirm}
					type="password"
					autoComplete="new-password"
					value={confirm}
					onChange={(e) => {
						setConfirm(e.target.value);
						setErrors((prev) => clearFieldError(prev, "confirm"));
					}}
					aria-invalid={errors.confirm ? true : undefined}
					aria-describedby={errors.confirm ? `${ids.confirm}-error` : undefined}
					className={INPUT_CLASS}
				/>
				{errors.confirm && <FieldError id={`${ids.confirm}-error`}>{errors.confirm}</FieldError>}
			</div>

			{formError && (
				<p
					ref={alertRef}
					id={ids.alert}
					role="alert"
					tabIndex={-1}
					className="text-sm text-red-700 focus:outline-none dark:text-red-400"
				>
					{formError}
				</p>
			)}

			<div className="flex items-center gap-3">
				<button
					type="submit"
					disabled={submitting || blockedUntil !== null}
					aria-describedby={blockedUntil !== null ? ids.alert : undefined}
					className="min-h-[44px] rounded-md bg-primary text-primary-foreground hover:bg-primary/90 px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
				>
					{submitting ? "Changing…" : "Change password"}
				</button>
				{submitting && <span className="text-xs text-hint">Signing you in again…</span>}
				{blockedUntil !== null && (
					<span className="text-xs text-hint">Paused until the wait is over.</span>
				)}
			</div>
		</form>
	);
}

function FieldError({ id, children }: { id: string; children: string }) {
	return (
		<p id={id} role="alert" className="text-xs text-red-700 dark:text-red-400">
			{children}
		</p>
	);
}
