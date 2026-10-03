import brandIcon from "../../assets/agentpulse-icon.svg";
import { useSignOut } from "../../hooks/useSignOut.js";
import { useUserStore } from "../../stores/user-store.js";
import { AccountPanel } from "./AccountPanel.js";

/**
 * Everything a user sees until they replace a password someone else chose:
 * the form and a way out. The server refuses every other request for them, so
 * there is no navigation, no dashboard and no live connection behind it.
 */
export function ForcedPasswordChange() {
	const name = useUserStore((s) => s.user?.displayName ?? s.user?.name ?? null);
	const { handleSignOut } = useSignOut();

	return (
		<div className="flex min-h-dvh items-center justify-center bg-background p-4 md:p-6">
			<main className="w-full max-w-md space-y-5">
				<div className="space-y-2 text-center">
					<img src={brandIcon} alt="" className="mx-auto h-12 w-12" />
					<h1 className="text-xl font-semibold text-foreground">Choose a new password</h1>
					{name && <p className="text-xs text-hint">Signed in as {name}</p>}
				</div>
				<section className="rounded-lg border border-border bg-card p-5">
					<AccountPanel forced />
				</section>
				<p className="text-center text-xs text-hint">
					Not you?{" "}
					<button
						type="button"
						onClick={handleSignOut}
						className="inline-flex min-h-[44px] items-center rounded px-1 font-medium text-foreground underline underline-offset-2 hover:text-primary md:min-h-0"
					>
						Sign out
					</button>
				</p>
			</main>
		</div>
	);
}
