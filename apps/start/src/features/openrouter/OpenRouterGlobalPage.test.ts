import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const page = readFileSync(
	join(import.meta.dir, "OpenRouterGlobalPage.tsx"),
	"utf8",
);
const settings = readFileSync(
	join(import.meta.dir, "..", "settings", "OpenRouterSettingsPanel.tsx"),
	"utf8",
);

describe("OpenRouter account UI", () => {
	test("keeps credentials in Settings and usage in a machine-wide page", () => {
		expect(settings).toContain('type="password"');
		expect(settings).toContain('id: "openrouter"');
		expect(settings).toContain('id: "openrouter-management"');
		expect(settings).toContain("Management key");
		expect(settings).toContain("write-only");
		expect(settings).not.toContain("credential.apiKey");
		expect(page).toContain("trpc.openrouter.get.queryOptions()");
		expect(page).toContain("trpc.openrouter.refresh.mutationOptions");
		expect(page).not.toContain("settings.providers.set");
	});

	test("renders human-readable live, credit, and activity views without raw JSON", () => {
		for (const text of [
			"Today",
			"This week",
			"This month",
			"Account credits left",
			"Daily activity: last 30 completed UTC days",
			"Models",
			"Providers",
		])
			expect(page).toContain(text);
		expect(page).toContain("LiveMetricChart");
		expect(page).toContain("refetchInterval: AUTO_REFRESH_MS");
		expect(page).toContain("refetchIntervalInBackground: true");
		expect(page).toContain("auto-refresh every 15s");
		expect(page).toContain("credits {money(model.credits.remainingCredits)}");
		expect(page).not.toContain("JSON.stringify");
		expect(page).toContain("management key");
		expect(page).toContain("model.accountUsage.available");
	});
});
