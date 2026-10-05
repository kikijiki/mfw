import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const settings = readFileSync(
	join(import.meta.dir, "SettingsPage.tsx"),
	"utf8",
);
const route = readFileSync(
	join(import.meta.dir, "..", "..", "routes", "settings.tsx"),
	"utf8",
);

describe("global Settings tab state", () => {
	test("uses the URL as tab state while retaining mounted panel drafts", () => {
		expect(settings).not.toContain("useState<SettingsTab>");
		expect(settings).toContain('const active = tab ?? "providers"');
		expect(settings).toContain("onTabChange(value as SettingsTab)");
		expect(settings).toContain('hidden={active !== "providers"}');
		expect(settings).toContain("hidden={!runpodActive}");
		expect(settings).toContain("hidden={!openrouterActive}");
		expect(settings).toContain("<OpenRouterSettingsPanel />");
		expect(settings).toContain('hidden={active !== "appearance"}');
		expect(route).toContain("Route.useNavigate()");
		expect(route).toContain("search: () => ({ tab: next })");
	});
});
