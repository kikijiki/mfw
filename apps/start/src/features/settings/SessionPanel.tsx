import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	AuthRequestError,
	changePassword,
	signOut,
	signOutEverywhere,
} from "../../lib/auth-client";

const MIN_PASSWORD = 12;

/** Sign out, sign out everywhere, and change the owner password. */
export function SessionPanel() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{
		tone: "error" | "ok";
		text: string;
	} | null>(null);

	async function onSubmit(event: FormEvent) {
		event.preventDefault();
		if (next !== confirm) {
			setMessage({ tone: "error", text: "The new passwords do not match." });
			return;
		}
		setBusy(true);
		setMessage(null);
		try {
			await changePassword(current, next);
			setCurrent("");
			setNext("");
			setConfirm("");
			setMessage({
				tone: "ok",
				text: "Password changed. Every other session is signed out.",
			});
		} catch (e) {
			setMessage({
				tone: "error",
				text:
					e instanceof AuthRequestError
						? e.message
						: "Could not reach the server.",
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex max-w-sm flex-col gap-4">
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" size="sm" onClick={() => void signOut()}>
					Sign out
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void signOutEverywhere()}
				>
					Sign out everywhere
				</Button>
			</div>
			<form className="flex flex-col gap-3" onSubmit={onSubmit}>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="current-password">Current password</Label>
					<Input
						id="current-password"
						type="password"
						value={current}
						onChange={(e) => setCurrent(e.target.value)}
						autoComplete="current-password"
						required
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="new-password">New password</Label>
					<Input
						id="new-password"
						type="password"
						value={next}
						onChange={(e) => setNext(e.target.value)}
						autoComplete="new-password"
						minLength={MIN_PASSWORD}
						required
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="confirm-password">Confirm new password</Label>
					<Input
						id="confirm-password"
						type="password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
						autoComplete="new-password"
						required
					/>
				</div>
				{message && (
					<p
						role={message.tone === "error" ? "alert" : "status"}
						className={
							message.tone === "error"
								? "text-sm text-destructive"
								: "text-sm text-muted-foreground"
						}
					>
						{message.text}
					</p>
				)}
				<Button type="submit" size="sm" disabled={busy} className="self-start">
					Change password
				</Button>
			</form>
		</div>
	);
}
