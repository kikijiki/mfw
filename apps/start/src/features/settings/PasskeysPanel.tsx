import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	AuthRequestError,
	addPasskey,
	listPasskeys,
	type Passkey,
	passkeysSupported,
	revokePasskey,
} from "../../lib/auth-client";

const errorText = (e: unknown) =>
	e instanceof AuthRequestError ? e.message : "Could not reach the server.";

const when = (ms: number | null) =>
	ms === null ? "never" : new Date(ms).toLocaleString();

/**
 * Passkeys: an extra way for the owner to sign in. The password stays, and
 * adding one asks for the password (or an existing passkey) again.
 */
export function PasskeysPanel() {
	const [passkeys, setPasskeys] = useState<Passkey[]>([]);
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [supported, setSupported] = useState(true);
	const [message, setMessage] = useState<{
		tone: "error" | "ok";
		text: string;
	} | null>(null);

	const refresh = useCallback(async () => {
		try {
			setPasskeys(await listPasskeys());
		} catch (e) {
			setMessage({ tone: "error", text: errorText(e) });
		}
	}, []);

	useEffect(() => {
		setSupported(passkeysSupported());
		void refresh();
	}, [refresh]);

	async function add(proof: { password: string } | "passkey") {
		setBusy(true);
		setMessage(null);
		try {
			await addPasskey(name.trim() || "Passkey", proof);
			setName("");
			setPassword("");
			setMessage({ tone: "ok", text: "Passkey added." });
			await refresh();
		} catch (e) {
			setMessage({ tone: "error", text: errorText(e) });
		} finally {
			setBusy(false);
		}
	}

	function onSubmit(event: FormEvent) {
		event.preventDefault();
		void add({ password });
	}

	async function onRevoke(id: string) {
		setMessage(null);
		try {
			await revokePasskey(id);
			await refresh();
		} catch (e) {
			setMessage({ tone: "error", text: errorText(e) });
		}
	}

	return (
		<div className="flex max-w-xl flex-col gap-4">
			{passkeys.length > 0 && (
				<ul className="flex flex-col gap-2">
					{passkeys.map((p) => (
						<li
							key={p.id}
							className="flex items-center justify-between gap-3 text-sm"
						>
							<span className="min-w-0">
								<span className="font-medium">{p.name}</span>{" "}
								<span className="text-muted-foreground">
									{p.rpId} · added {when(p.createdAt)} · last used{" "}
									{when(p.lastUsedAt)}
									{p.backedUp ? " · synced" : ""}
								</span>
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => void onRevoke(p.id)}
							>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
			{supported ? (
				<form className="flex max-w-sm flex-col gap-3" onSubmit={onSubmit}>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="passkey-name">Name</Label>
						<Input
							id="passkey-name"
							value={name}
							maxLength={64}
							placeholder="Laptop"
							autoComplete="off"
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="passkey-password">Current password</Label>
						<Input
							id="passkey-password"
							type="password"
							value={password}
							autoComplete="current-password"
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button type="submit" size="sm" disabled={busy}>
							Add passkey
						</Button>
						{passkeys.length > 0 && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => void add("passkey")}
							>
								Confirm with a passkey instead
							</Button>
						)}
					</div>
				</form>
			) : (
				<p className="text-sm text-muted-foreground">
					This browser cannot use passkeys.
				</p>
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
		</div>
	);
}
