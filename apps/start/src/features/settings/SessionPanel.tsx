import { type FormEvent, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	AuthRequestError,
	changePassword,
	listPasskeys,
	type Passkey,
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
	const [passkeys, setPasskeys] = useState<Passkey[]>([]);
	// A password change is an eviction: revoking every passkey is the default.
	const [revokeAll, setRevokeAll] = useState(true);
	const [keep, setKeep] = useState<string[]>([]);

	useEffect(() => {
		listPasskeys()
			.then((list) => {
				setPasskeys(list);
				setKeep(list.map((p) => p.id));
			})
			.catch(() => setPasskeys([]));
	}, []);
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
			await changePassword(current, next, revokeAll ? "revoke-all" : keep);
			setCurrent("");
			setNext("");
			setConfirm("");
			const remaining = await listPasskeys().catch(() => []);
			setPasskeys(remaining);
			setKeep(remaining.map((p) => p.id));
			setRevokeAll(true);
			setMessage({
				tone: "ok",
				text:
					remaining.length === 0
						? "Password changed. Every other session is signed out and no passkeys remain."
						: `Password changed. Every other session is signed out; ${remaining.length} passkey(s) kept.`,
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
				{passkeys.length > 0 && (
					<fieldset className="flex flex-col gap-2">
						<div className="flex items-start gap-2">
							<Checkbox
								id="revoke-all-passkeys"
								checked={revokeAll}
								onCheckedChange={(on) => setRevokeAll(on === true)}
							/>
							<Label htmlFor="revoke-all-passkeys">Revoke all passkeys</Label>
						</div>
						<ul className="flex flex-col gap-1.5 text-sm">
							{passkeys.map((p) => (
								<li key={p.id} className="flex items-start gap-2">
									{!revokeAll && (
										<Checkbox
											id={`keep-passkey-${p.id}`}
											aria-label={`Keep ${p.name}`}
											checked={keep.includes(p.id)}
											onCheckedChange={(on) =>
												setKeep((ids) =>
													on === true
														? [...ids, p.id]
														: ids.filter((id) => id !== p.id),
												)
											}
										/>
									)}
									<span className="min-w-0">
										<span className="font-medium">{p.name}</span>{" "}
										<span className="text-muted-foreground">
											{p.rpId} · added {new Date(p.createdAt).toLocaleString()}{" "}
											from {p.createdFrom ?? "unknown"} · last used{" "}
											{p.lastUsedAt
												? new Date(p.lastUsedAt).toLocaleString()
												: "never"}
											{!revokeAll && !keep.includes(p.id)
												? " · will be revoked"
												: ""}
										</span>
									</span>
								</li>
							))}
						</ul>
					</fieldset>
				)}
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
