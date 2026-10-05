import { createFileRoute } from "@tanstack/react-router";

import {
	parseSettingsTab,
	SettingsPage,
	type SettingsTab,
} from "~/features/settings/SettingsPage";

/** `?tab=` deep-links to a global settings tab; invalid values fall back safely. */
export const Route = createFileRoute("/settings")({
	// Omit the key instead of returning null: TanStack serialises the result back
	// into the URL, so null turns a bare /settings into `/settings?tab=null`.
	validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } => {
		const tab = parseSettingsTab(search.tab);
		return tab === null ? {} : { tab };
	},
	component: SettingsRoute,
});

function SettingsRoute() {
	const { tab } = Route.useSearch();
	const navigate = Route.useNavigate();
	return (
		<SettingsPage
			tab={tab ?? null}
			onTabChange={(next) => void navigate({ search: () => ({ tab: next }) })}
		/>
	);
}
