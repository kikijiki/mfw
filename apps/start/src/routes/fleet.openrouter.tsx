import { createFileRoute } from "@tanstack/react-router";

import { OpenRouterGlobalPage } from "~/features/openrouter/OpenRouterGlobalPage";

export const Route = createFileRoute("/fleet/openrouter")({
	component: OpenRouterGlobalPage,
});
