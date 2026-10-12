import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "~/features/home/HomePage";

/** Home: what needs you, what is running, what happened since you left. */
export const Route = createFileRoute("/")({ component: HomePage });
