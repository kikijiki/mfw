import { createFileRoute } from "@tanstack/react-router";
import { RunPodGlobalPage } from "~/features/runpod/RunPodGlobalPage";

export const Route = createFileRoute("/runpod")({
	component: RunPodGlobalPage,
});
