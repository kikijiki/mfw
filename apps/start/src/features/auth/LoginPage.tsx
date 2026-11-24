import { type FormEvent, useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
	AuthRequestError,
	type AuthState,
	afterLogin,
	fetchAuthState,
	passkeysSupported,
	signInWithPasskey,
	submitLogin,
	submitSetup,
} from "~/lib/auth-client";

const MIN_PASSWORD = 12;

function describe(error: unknown): string {
	if (error instanceof AuthRequestError) {
		if (error.code === "locked" && error.retryAfterSeconds > 0)
			return `Too many failed attempts. Try again in ${error.retryAfterSeconds} s.`;
		if (error.code === "passkey_copied")
			return "This passkey looks copied, so it was refused. Sign in with your password and check Settings > Passkeys.";
		if (error.code === "busy" && error.retryAfterSeconds > 0)
			return `The server is busy. Try again in ${error.retryAfterSeconds} s.`;
		return error.message;
	}
	return "Could not reach the server.";
}

/** First-run setup and sign-in. Plain fetches: no session exists yet. */
export function LoginPage() {
	const [state, setState] = useState<AuthState | null>(null);
	const [token, setToken] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		fetchAuthState()
			.then((s) => {
				if (s.state === "authenticated") afterLogin(window.location.search);
				else setState(s.state);
			})
			.catch((e) => setError(describe(e)));
	}, []);

	const isSetup = state === "setup";
	const [canUsePasskey, setCanUsePasskey] = useState(false);
	useEffect(() => setCanUsePasskey(passkeysSupported()), []);

	async function onPasskey() {
		setError(null);
		setBusy(true);
		try {
			await signInWithPasskey();
			afterLogin(window.location.search);
		} catch (e) {
			setError(describe(e));
			setBusy(false);
		}
	}

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		if (isSetup && password !== confirm) {
			setError("The passwords do not match.");
			return;
		}
		setBusy(true);
		try {
			if (isSetup) await submitSetup(token, password);
			else await submitLogin(password);
			afterLogin(window.location.search);
		} catch (e) {
			setError(describe(e));
			setBusy(false);
		}
	}

	return (
		<main className="flex h-full items-center justify-center overflow-y-auto p-4">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{isSetup ? "Set up mfw" : "Sign in to mfw"}</CardTitle>
					<CardDescription>
						{isSetup
							? "Enter the setup token from the server's log, then choose the owner password."
							: "Enter the owner password."}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{state === null ? (
						error ? (
							<p role="alert" className="text-sm text-destructive">
								{error}
							</p>
						) : (
							<p className="text-sm text-muted-foreground">Loading…</p>
						)
					) : (
						<form className="flex flex-col gap-3" onSubmit={onSubmit}>
							{isSetup && (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="setup-token">Setup token</Label>
									<Input
										id="setup-token"
										value={token}
										onChange={(e) => setToken(e.target.value)}
										autoComplete="off"
										spellCheck={false}
										required
										autoFocus
									/>
								</div>
							)}
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="password">Password</Label>
								<Input
									id="password"
									type="password"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									autoComplete={isSetup ? "new-password" : "current-password"}
									minLength={isSetup ? MIN_PASSWORD : undefined}
									required
									autoFocus={!isSetup}
								/>
							</div>
							{isSetup && (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="confirm">Confirm password</Label>
									<Input
										id="confirm"
										type="password"
										value={confirm}
										onChange={(e) => setConfirm(e.target.value)}
										autoComplete="new-password"
										required
									/>
								</div>
							)}
							{error && (
								<p role="alert" className="text-sm text-destructive">
									{error}
								</p>
							)}
							<Button type="submit" disabled={busy}>
								{isSetup ? "Create owner" : "Sign in"}
							</Button>
							{!isSetup && canUsePasskey && (
								<Button
									type="button"
									variant="outline"
									disabled={busy}
									onClick={() => void onPasskey()}
								>
									Sign in with a passkey
								</Button>
							)}
						</form>
					)}
				</CardContent>
			</Card>
		</main>
	);
}
