import { Page, PageHeader, Panel, Scroller } from "../../components/Page";
import { useTheme } from "../../lib/theme";
import { Segmented, Setting } from "./controls";
import { OpenRouterSettingsPanel } from "./OpenRouterSettingsPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { RunPodSettingsPanel } from "./RunPodSettingsPanel";

/** Global machine/browser settings. Project policy stays on each project. */

export const SETTINGS_SECTIONS = [
	"providers",
	"runpod",
	"openrouter",
	"appearance",
] as const;
export type SettingsTab = (typeof SETTINGS_SECTIONS)[number];

/**
 * Coerce anything into a known tab, or null.
 *
 * The route's `validateSearch` receives `Record<string, unknown>` for a real
 * reason: TanStack's search parser turns `?tab=1` into the NUMBER 1 and
 * `?tab=true` into the BOOLEAN true, so a `typeof === "string"` guard is load
 * bearing, not decoration. Anything else, including the retired `?tab=project`
 *, yields null and opens the page at the top rather than throwing.
 */
export function parseSettingsTab(value: unknown): SettingsTab | null {
	return typeof value === "string" &&
		(SETTINGS_SECTIONS as readonly string[]).includes(value)
		? (value as SettingsTab)
		: null;
}

export interface SettingsPageProps {
	/** Tab to reveal on arrival, from `?tab=`. */
	tab: SettingsTab | null;
	/** Writes selection back to `?tab=` so browser history and deep links agree. */
	onTabChange: (tab: SettingsTab) => void;
}

export function SettingsPage({ tab, onTabChange }: SettingsPageProps) {
	// The URL is the state. Keeping each panel mounted below also retains local
	// drafts and open dialogs when an operator briefly checks another section.
	const active = tab ?? "providers";
	const runpodActive = active === "runpod";
	const openrouterActive = active === "openrouter";
	return (
		<Page className="h-full">
			<PageHeader title="Settings" />
			<Scroller className="flex flex-col gap-3 p-3">
				<Segmented
					label="Settings section"
					value={active}
					options={["providers", "runpod", "openrouter", "appearance"]}
					onChange={(value) => onTabChange(value as SettingsTab)}
				/>
				<section hidden={active !== "providers"}>
					<ProvidersPanel />
				</section>
				<section hidden={!runpodActive}>
					<RunPodSettingsPanel />
				</section>
				<section hidden={!openrouterActive}>
					<OpenRouterSettingsPanel />
				</section>
				<section hidden={active !== "appearance"}>
					<Panel title="Appearance">
						<AppearanceSection />
					</Panel>
				</section>
			</Scroller>
		</Page>
	);
}

function AppearanceSection() {
	const { theme, setTheme, density, setDensity } = useTheme();
	return (
		<div className="flex flex-col gap-3">
			<Setting label="theme">
				<Segmented
					label="Theme"
					value={theme}
					options={["system", "light", "dark"]}
					onChange={(v) => setTheme(v as typeof theme)}
				/>
			</Setting>
			<Setting label="density">
				<Segmented
					label="Density"
					value={density}
					options={["comfortable", "compact"]}
					onChange={(v) => setDensity(v as typeof density)}
				/>
			</Setting>
		</div>
	);
}
