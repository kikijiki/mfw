import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
	type ApiToken,
	type ApiTokenAudit,
	AuthRequestError,
	createApiToken,
	listApiTokens,
	readApiTokenAudit,
	revokeApiToken,
} from "../../lib/auth-client";
import {
	TOKEN_EXPIRY_MAX_DAYS,
	TOKEN_SCOPE_CHOICES,
	tokenDraft,
} from "./tokensForm";

const errorText = (e: unknown) =>
	e instanceof AuthRequestError ? e.message : "Could not reach the server.";

/** Create, list and revoke scoped API tokens for MCP clients and scripts. */
export function TokensPanel() {
	const [tokens, setTokens] = useState<ApiToken[]>([]);
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<string[]>(["board:read"]);
	const [project, setProject] = useState("");
	const [days, setDays] = useState("1");
	const [created, setCreated] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [audit, setAudit] = useState<ApiTokenAudit | null>(null);

	const refresh = useCallback(async () => {
		try {
			setTokens(await listApiTokens());
		} catch (e) {
			setError(errorText(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function onCreate(event: FormEvent) {
		event.preventDefault();
		const draft = tokenDraft({ name, scopes, project, days });
		if (typeof draft === "string") {
			setError(draft);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			setCreated(await createApiToken(draft));
			setName("");
			await refresh();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}

	async function onRevoke(id: string) {
		setError(null);
		try {
			await revokeApiToken(id);
			await refresh();
		} catch (e) {
			setError(errorText(e));
		}
	}

	async function toggleAudit() {
		if (audit) {
			setAudit(null);
			return;
		}
		setError(null);
		try {
			setAudit(await readApiTokenAudit());
		} catch (e) {
			setError(errorText(e));
		}
	}

	return (
		<div className="flex max-w-xl flex-col gap-4">
			{created && (
				<div className="flex flex-col gap-1.5" role="status">
					<Label htmlFor="new-api-token">
						Copy this token now. It is not shown again.
					</Label>
					<Input
						id="new-api-token"
						readOnly
						value={created}
						autoComplete="off"
						spellCheck={false}
						onFocus={(e) => e.currentTarget.select()}
					/>
					<Button
						variant="outline"
						size="sm"
						className="self-start"
						onClick={() => setCreated(null)}
					>
						Done
					</Button>
				</div>
			)}
			<form className="flex flex-col gap-3" onSubmit={onCreate}>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="token-name">Name</Label>
					<Input
						id="token-name"
						value={name}
						maxLength={64}
						autoComplete="off"
						onChange={(e) => setName(e.target.value)}
					/>
				</div>
				<fieldset className="flex flex-col gap-2">
					<legend className="mb-1 text-sm font-medium">Scopes</legend>
					{TOKEN_SCOPE_CHOICES.map((choice) => (
						<div key={choice.scope} className="flex items-start gap-2">
							<Checkbox
								id={`token-scope-${choice.scope}`}
								checked={scopes.includes(choice.scope)}
								onCheckedChange={(on) =>
									setScopes((current) =>
										on === true
											? [...current, choice.scope]
											: current.filter((s) => s !== choice.scope),
									)
								}
							/>
							<Label
								htmlFor={`token-scope-${choice.scope}`}
								className="flex flex-col items-start gap-0.5"
							>
								<span>{choice.label}</span>
								<span className="text-xs font-normal text-muted-foreground">
									{choice.hint}
								</span>
							</Label>
						</div>
					))}
				</fieldset>
				<div className="flex flex-wrap gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="token-project">Project (empty for all)</Label>
						<Input
							id="token-project"
							value={project}
							autoComplete="off"
							onChange={(e) => setProject(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="token-days">Expires in (days)</Label>
						<Input
							id="token-days"
							type="number"
							min={1}
							max={TOKEN_EXPIRY_MAX_DAYS}
							value={days}
							onChange={(e) => setDays(e.target.value)}
						/>
					</div>
				</div>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<Button type="submit" size="sm" disabled={busy} className="self-start">
					Create token
				</Button>
			</form>
			{tokens.length > 0 && (
				<ul className="flex flex-col gap-2">
					{tokens.map((t) => (
						<li
							key={t.id}
							className="flex items-center justify-between gap-3 text-sm"
						>
							<span className="min-w-0">
								<span className="font-medium">{t.name}</span>{" "}
								<span className="text-muted-foreground">
									{t.status} · {t.scopes.join(", ")} ·{" "}
									{t.project ?? "all projects"} · expires{" "}
									{new Date(t.expiresAt).toLocaleString()}
								</span>
							</span>
							{t.status === "active" && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void onRevoke(t.id)}
								>
									Revoke
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="self-start"
				onClick={() => void toggleAudit()}
			>
				{audit ? "Hide token activity" : "Show token activity"}
			</Button>
			{audit && (
				<div className="flex flex-col gap-2 text-sm">
					{audit.counters.map((c) => (
						<p key={c.tokenId} className="text-muted-foreground">
							<span className="font-medium text-foreground">{c.name}</span>:{" "}
							{c.refused} refused
							{c.lastRefusedPath ? ` (last ${c.lastRefusedPath})` : ""}
							{c.dropped > 0 ? `, ${c.dropped} older actions dropped` : ""}
						</p>
					))}
					{audit.actions.length === 0 && audit.counters.length === 0 && (
						<p className="text-muted-foreground">No token activity yet.</p>
					)}
					{audit.actions.length > 0 && (
						<ul className="flex flex-col gap-1">
							{audit.actions.map((a) => (
								<li key={a.id} className="min-w-0 break-words">
									<span className="font-medium">{a.name}</span>{" "}
									<span className="text-muted-foreground">
										{a.path} · {a.project ?? "no project"} · {a.outcome} ·{" "}
										{new Date(a.at).toLocaleString()}
									</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
