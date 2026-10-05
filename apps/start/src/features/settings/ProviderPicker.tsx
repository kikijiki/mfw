import { useQuery } from "@tanstack/react-query";
import { useId } from "react";

import { Input } from "~/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { AppLink } from "../../components/AppLink";
import { Mono } from "../../components/Cost";
import { ErrorState } from "../../components/ErrorState";
import { LoadingRows } from "../../components/Loading";
import { Chip } from "../../components/Page";
import type { RouterOutputs } from "../../lib/trpc";
import { useTRPC } from "../../lib/trpc";
import { href } from "../../routes";

/**
 * Which agent CLI this project's runs launch, and which model they ask it for.
 *
 * The provider is a picker over `selectableProviderIds`; other catalogue
 * entries render disabled with the daemon's `unsupportedReason`.
 *
 * The model is a picker and a text field: `settings.update` accepts any
 * non-empty string so new vendor models are not blocked.
 */

type Catalogue = RouterOutputs["settings"]["providers"]["catalogue"];

export function ProviderPicker({
	value,
	onChange,
}: {
	value: string;
	onChange: (id: string, defaultModel: string) => void;
}) {
	const trpc = useTRPC();
	const name = useId();
	const catalogue = useQuery(trpc.settings.providers.catalogue.queryOptions());

	if (catalogue.isLoading) return <LoadingRows rows={3} />;
	if (catalogue.error || !catalogue.data) {
		return (
			<ErrorState
				title="Could not load providers"
				error={catalogue.error}
				onRetry={() => void catalogue.refetch()}
			/>
		);
	}

	const data = catalogue.data;
	const selectable = new Set(data.selectableProviderIds);
	// Show the stored provider even if the catalogue dropped it, so the UI reflects what is actually set.
	const orphaned = value !== "" && !data.providers.some((p) => p.id === value);

	return (
		<fieldset
			className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
			aria-label="Agent CLI"
		>
			{data.providers.map((provider) => (
				<ProviderChoice
					key={provider.id}
					name={name}
					provider={provider}
					checked={provider.id === value}
					selectable={selectable.has(provider.id)}
					onChange={() => onChange(provider.id, provider.defaultModel)}
				/>
			))}

			{orphaned ? (
				<p style={{ color: "var(--mfw-warn)", fontSize: "var(--mfw-text-xs)" }}>
					<Mono value={value} /> is unavailable. Choose another provider.
				</p>
			) : null}
		</fieldset>
	);
}

function ProviderChoice({
	name,
	provider,
	checked,
	selectable,
	onChange,
}: {
	name: string;
	provider: Catalogue["providers"][number];
	checked: boolean;
	selectable: boolean;
	onChange: () => void;
}) {
	return (
		<label
			className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
			style={{
				opacity: selectable ? 1 : 0.6,
				cursor: selectable ? "pointer" : "not-allowed",
			}}
		>
			<input
				type="radio"
				name={name}
				value={provider.id}
				checked={checked}
				disabled={!selectable}
				onChange={onChange}
			/>
			<span>{provider.name}</span>
			<Mono value={provider.id} />
			{provider.installed ? (
				<Chip tone="ok">
					{provider.version ? `v${provider.version}` : "installed"}
				</Chip>
			) : (
				<Chip tone="warn">not found</Chip>
			)}
			{selectable ? null : <Chip>not drivable</Chip>}
			{selectable ? null : (
				<span
					className="w-full pl-6"
					style={{
						color: "var(--mfw-fg-faint)",
						fontSize: "var(--mfw-text-2xs)",
					}}
				>
					{provider.unsupportedReason}
				</span>
			)}
		</label>
	);
}

export function ModelPicker({
	providerId,
	value,
	onChange,
}: {
	providerId: string;
	value: string;
	onChange: (model: string) => void;
}) {
	const trpc = useTRPC();
	const catalogue = useQuery(trpc.settings.providers.catalogue.queryOptions());

	const data = catalogue.data;
	const provider = data?.providers.find((p) => p.id === providerId);
	const models = provider?.models ?? [];
	const aliases = models.filter((m) => m.kind === "alias");
	const pinned = models.filter((m) => m.kind === "pinned");
	const known = models.some((m) => m.id === value);

	return (
		<div className="flex min-w-0 flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2">
				{models.length > 0 ? (
					<Select value={known ? value : undefined} onValueChange={onChange}>
						<SelectTrigger
							aria-label="Choose a known model"
							className="min-w-48"
						>
							<SelectValue placeholder="Custom model" />
						</SelectTrigger>
						<SelectContent position="popper">
							{aliases.length > 0 ? (
								<SelectGroup>
									<SelectLabel>Aliases</SelectLabel>
									{aliases.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{model.label}
										</SelectItem>
									))}
								</SelectGroup>
							) : null}
							{pinned.length > 0 ? (
								<SelectGroup>
									<SelectLabel>Models</SelectLabel>
									{pinned.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{model.label}
										</SelectItem>
									))}
								</SelectGroup>
							) : null}
						</SelectContent>
					</Select>
				) : null}

				<Input
					className="max-w-56"
					aria-label="Model"
					placeholder="sonnet"
					autoComplete="off"
					spellCheck={false}
					value={value}
					onChange={(e) => onChange(e.target.value)}
				/>
			</div>
		</div>
	);
}

/** Where the machine-scoped half of this lives. */
export function ProvidersLink() {
	return (
		<span
			style={{ color: "var(--mfw-fg-faint)", fontSize: "var(--mfw-text-2xs)" }}
		>
			Installation and credentials are per machine, not per project,{" "}
			<AppLink to={`${href.settings()}?tab=providers`}>
				Settings → Providers
			</AppLink>
			.
		</span>
	);
}
