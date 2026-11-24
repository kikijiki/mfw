import { useCallback, useEffect, useState } from "react";
import {
	acknowledgePasskeyNotice,
	listPasskeyNotices,
	type PasskeyNotice,
	signOutEverywhere,
} from "../lib/auth-client";
import { Button } from "./ui/button";

const RECHECK_MS = 60_000;

/**
 * Tells this session when another one (or the host CLI) added or revoked a
 * passkey, until this session dismisses it. A passkey someone added with a
 * stolen password is the thing the owner must not miss.
 */
export function PasskeyNotices() {
	const [notices, setNotices] = useState<PasskeyNotice[]>([]);

	const refresh = useCallback(async () => {
		try {
			setNotices(await listPasskeyNotices());
		} catch {
			// Signed out or offline: nothing to show.
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), RECHECK_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	if (notices.length === 0) return null;
	return (
		<div
			role="alert"
			className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-3 rounded-md border bg-card p-4 text-sm shadow-lg"
		>
			{notices.map((n) => (
				<div key={n.id} className="flex flex-col gap-2">
					<p>
						{n.kind === "added" ? (
							<>
								A passkey, <span className="font-medium">{n.name}</span>, was
								added for {n.rpId} from {n.source ?? "an unknown address"} on{" "}
								{new Date(n.at).toLocaleString()}. Not you? Sign out everywhere:
								that also deletes every passkey.
							</>
						) : (
							<>
								The passkey <span className="font-medium">{n.name}</span> was
								revoked{n.source ? ` from ${n.source}` : ""} on{" "}
								{new Date(n.at).toLocaleString()}.
							</>
						)}
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() =>
								void acknowledgePasskeyNotice(n.id).then(refresh, refresh)
							}
						>
							Dismiss
						</Button>
						{n.kind === "added" && (
							<Button
								size="sm"
								variant="destructive"
								onClick={() => void signOutEverywhere()}
							>
								Sign out everywhere
							</Button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}
