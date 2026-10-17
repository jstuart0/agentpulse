import QRCode from "qrcode";
import { useCallback, useEffect, useReducer, useState } from "react";
import { useSecretLifetime } from "../../hooks/useSecretLifetime.js";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import {
	PAIRING_ACCESS_OPTIONS,
	type PairingAccess,
	type PairingServerStatus,
	countdownText,
	heldCode,
	pairingUri,
	pairingView,
	revokeReducer,
	revokeTarget,
} from "../../lib/pairing-flow.js";

const STATUS_POLL_MS = 2000;
const QR_WIDTH_PX = 224;

interface MadeCode {
	id: string;
	/** Held only while the code is live; dropped once it is redeemed, expired or cancelled. */
	code: string | null;
	expiresAt: string;
}

/**
 * Settings › Mobile › "Pair a phone". Makes a single-use code and shows it as a
 * QR for the phone to scan (never a link, and the code is not written out),
 * counts down its five minutes, then says which device took it, with a Revoke.
 */
export function PairDevicePanel() {
	const [access, setAccess] = useState<PairingAccess>("respond");
	const [label, setLabel] = useState("");
	const [made, setMade] = useState<MadeCode | null>(null);
	const [status, setStatus] = useState<PairingServerStatus | null>(null);
	const [nowMs, setNowMs] = useState(Date.now());
	const [qr, setQr] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revoke, dispatchRevoke] = useReducer(revokeReducer, { step: "idle" });

	const view = pairingView(made, status, nowMs);
	const code = heldCode(made, view, false);
	const showingCode = code !== null;

	const forgetCode = useCallback(() => {
		setMade((current) => (current ? { ...current, code: null } : current));
		setQr(null);
	}, []);

	// A live code is a secret on screen: gone when the tab is hidden or after the usual lifetime.
	useSecretLifetime(showingCode, forgetCode);

	useEffect(() => {
		if (view !== "pending") {
			if (made?.code) forgetCode();
			return;
		}
		const tick = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(tick);
	}, [view, made?.code, forgetCode]);

	useEffect(() => {
		if (!made || view !== "pending") return;
		let stopped = false;
		const poll = async () => {
			try {
				const next = await api.getPairingCodeStatus(made.id);
				if (!stopped) setStatus(next);
			} catch {
				// a missed poll is retried; the countdown still ends the code on its own
			}
		};
		const timer = setInterval(poll, STATUS_POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [made, view]);

	useEffect(() => {
		if (code === null) return;
		let cancelled = false;
		QRCode.toDataURL(pairingUri(window.location.origin, code), {
			width: QR_WIDTH_PX,
			margin: 1,
			errorCorrectionLevel: "M",
		})
			.then((url) => {
				if (!cancelled) setQr(url);
			})
			.catch(() => {
				if (!cancelled) setError("Couldn't draw the QR code. Try again.");
			});
		return () => {
			cancelled = true;
		};
	}, [code]);

	async function createCode() {
		setBusy(true);
		setError(null);
		dispatchRevoke({ type: "reset" });
		try {
			const created = await api.createPairingCode(access, label.trim() || undefined);
			setStatus(null);
			setQr(null);
			setNowMs(Date.now());
			setMade({ id: created.id, code: created.code, expiresAt: created.expiresAt });
		} catch (err) {
			setError(describeApiError(err, "Couldn't make a pairing code. Try again."));
		} finally {
			setBusy(false);
		}
	}

	async function revokePhone() {
		const keyId = revokeTarget(status);
		if (keyId === null) return;
		dispatchRevoke({ type: "submit" });
		try {
			await api.revokeApiKey(keyId);
			dispatchRevoke({ type: "succeeded" });
		} catch (err) {
			dispatchRevoke({
				type: "failed",
				message: describeApiError(err, "Couldn't revoke that phone. Try again."),
			});
		}
	}

	function reset() {
		setMade(null);
		setStatus(null);
		setQr(null);
		setError(null);
		dispatchRevoke({ type: "reset" });
	}

	const deviceName = status?.redeemedDeviceName ?? "the phone";

	return (
		<div className="space-y-4">
			{(view === "idle" || view === "expired") && (
				<div className="space-y-3">
					{view === "expired" && (
						<output className="block text-xs text-muted-foreground">
							That code expired before it was used. Make a new one.
						</output>
					)}
					<fieldset className="space-y-2">
						<legend className="text-xs font-medium text-foreground mb-1">
							What the phone may do
						</legend>
						{PAIRING_ACCESS_OPTIONS.map((option) => (
							<label
								key={option.value}
								className="flex min-h-[44px] items-start gap-2 text-xs cursor-pointer md:min-h-0"
							>
								<input
									type="radio"
									name="pairing-access"
									value={option.value}
									checked={access === option.value}
									onChange={() => setAccess(option.value)}
									className="mt-0.5"
								/>
								<span>
									<span className="font-medium text-foreground">{option.label}</span>
									<span className="block text-muted-foreground">{option.hint}</span>
								</span>
							</label>
						))}
					</fieldset>
					<label className="block text-xs">
						<span className="font-medium text-foreground">Name for this phone (optional)</span>
						<input
							type="text"
							value={label}
							maxLength={64}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="Kitchen iPhone"
							className="mt-1 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm"
						/>
					</label>
					<button
						type="button"
						onClick={() => void createCode()}
						disabled={busy}
						className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{busy ? "Making code…" : "Show pairing code"}
					</button>
				</div>
			)}

			{view === "pending" && (
				<div className="space-y-3">
					<p className="text-xs text-muted-foreground">
						In AgentPulse on your phone, choose Add server and scan this code. It works once.
					</p>
					<div className="flex flex-col items-start gap-2">
						{qr ? (
							<img
								src={qr}
								alt="Pairing QR code for AgentPulse on your phone"
								width={QR_WIDTH_PX}
								height={QR_WIDTH_PX}
								className="rounded bg-white p-1"
							/>
						) : (
							<div
								className="rounded bg-muted animate-pulse"
								style={{ width: QR_WIDTH_PX, height: QR_WIDTH_PX }}
							/>
						)}
						<p className="text-xs text-muted-foreground" aria-live="off">
							Expires in{" "}
							<span className="font-mono text-foreground">
								{made ? countdownText(made.expiresAt, nowMs) : "0:00"}
							</span>
						</p>
					</div>
					<button
						type="button"
						onClick={reset}
						className="text-xs text-muted-foreground hover:text-foreground underline"
					>
						Cancel
					</button>
				</div>
			)}

			{view === "redeemed" && (
				<output className="block space-y-3">
					{revoke.step === "revoked" ? (
						<p className="text-sm text-foreground">
							{deviceName} was revoked. It can no longer reach this server.
						</p>
					) : (
						<>
							<p className="text-sm text-foreground">
								Redeemed by <span className="font-medium">{deviceName}</span>.
							</p>
							{revoke.step === "idle" && (
								<button
									type="button"
									onClick={() => dispatchRevoke({ type: "ask" })}
									disabled={revokeTarget(status) === null}
									className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
								>
									Revoke
								</button>
							)}
							{(revoke.step === "confirming" ||
								revoke.step === "revoking" ||
								revoke.step === "error") && (
								<div className="flex flex-wrap items-center gap-2 text-xs">
									<span className="text-muted-foreground">
										Revoke {deviceName}? It loses access right away.
									</span>
									{revoke.step === "error" ? (
										<button
											type="button"
											onClick={() => dispatchRevoke({ type: "ask" })}
											className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
										>
											Try again
										</button>
									) : (
										<button
											type="button"
											onClick={() => void revokePhone()}
											disabled={revoke.step === "revoking"}
											className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
										>
											{revoke.step === "revoking" ? "Revoking…" : `Revoke ${deviceName}`}
										</button>
									)}
									<button
										type="button"
										onClick={() => dispatchRevoke({ type: "cancel" })}
										disabled={revoke.step === "revoking"}
										className="text-muted-foreground hover:text-foreground underline"
									>
										Keep it
									</button>
								</div>
							)}
							{revoke.step === "error" && (
								<p role="alert" className="text-xs text-red-700 dark:text-red-400">
									{revoke.message}
								</p>
							)}
						</>
					)}
					<button
						type="button"
						onClick={reset}
						className="block text-xs text-muted-foreground hover:text-foreground underline"
					>
						Pair another phone
					</button>
				</output>
			)}

			{error && (
				<p role="alert" className="text-xs text-red-700 dark:text-red-400">
					{error}
				</p>
			)}
		</div>
	);
}
