import type { Headline } from "@mfw/daemon/headlines";
import { Fragment } from "react";

import { AppLink } from "../../components/AppLink";
import { Chip } from "../../components/Page";
import { href } from "../../routes";
import { ClaimChips } from "../agents/ProvenanceChips";
import { headlineTarget } from "./needs";

/**
 * One mechanical sentence per project ("Landed 7, needs you 1; main green;
 * spend 62%"). Built by the daemon from host-observed facts only; each part
 * is a link to the list behind its number.
 */
export function Headlines({ headlines }: { headlines: readonly Headline[] }) {
	if (headlines.length === 0) return null;
	return (
		<ul className="flex flex-col gap-1">
			{headlines.map((h) => (
				<li
					key={h.project}
					data-headline={h.project}
					className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
					style={{ fontSize: "var(--mfw-text-sm)" }}
				>
					<AppLink to={href.project(h.project)} className="shrink-0">
						<Chip>{h.project}</Chip>
					</AppLink>
					<span>
						{h.parts.map((p, i) => (
							<Fragment key={p.key}>
								{i === 0 ? "" : i === 1 ? ", " : "; "}
								<span data-claim-class={p.claimClass}>
									<AppLink to={headlineTarget(h.project, p.link)}>
										{p.text}
									</AppLink>
								</span>
							</Fragment>
						))}
					</span>
					<ClaimChips parts={h.parts} />
				</li>
			))}
		</ul>
	);
}
