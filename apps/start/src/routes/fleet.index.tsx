import { createFileRoute } from "@tanstack/react-router";

import { FleetPage } from "~/features/fleet/FleetPage";

export const Route = createFileRoute("/fleet/")({ component: FleetPage });
