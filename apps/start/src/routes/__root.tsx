/// <reference types="vite/client" />

import type { AppRouter } from "@mfw/api";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
	useParams,
	useRouterState,
} from "@tanstack/react-router";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type * as React from "react";
import { useState } from "react";

import { AppShell } from "~/components/AppShell";
import { KeyboardHelp } from "~/components/KeyboardHelp";
import { useGo } from "~/lib/nav";
import { useDarkClassSync } from "~/lib/theme";
import { makeQueryClient, makeTRPCClient, TRPCProvider } from "~/lib/trpc";

import appCss from "~/styles.css?url";

/** Mount prefix, no trailing slash. `public/` files live at `${BASE}/...`; the icon is linked explicitly because `/favicon.ico` hits the origin root, which is not routed here under `tailscale serve`. */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const Route = createRootRouteWithContext<{
	queryClient: QueryClient;
	trpc: TRPCOptionsProxy<AppRouter>;
}>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: `${BASE}/icon.svg`, type: "image/svg+xml" },
		],
		title: "mfw",
	}),
	component: RootComponent,
});

function RootComponent() {
	return (
		<RootDocument>
			<AppProviders />
		</RootDocument>
	);
}

/** One tRPC + QueryClient pair per session, created in state, not at module scope (the server would share a cache across requests). */
function AppProviders() {
	const [clients] = useState(() => ({
		queryClient: makeQueryClient(),
		trpcClient: makeTRPCClient(),
	}));
	return (
		<QueryClientProvider client={clients.queryClient}>
			<TRPCProvider
				trpcClient={clients.trpcClient}
				queryClient={clients.queryClient}
			>
				<Shell />
			</TRPCProvider>
		</QueryClientProvider>
	);
}

function Shell() {
	// `strict: false`: the shell renders above every route; only some are project-scoped.
	const params = useParams({ strict: false }) as { project?: string };
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	const go = useGo();
	useDarkClassSync();

	return (
		<AppShell project={params.project} activePath={pathname} navigate={go}>
			<Outlet />
			<KeyboardHelp />
		</AppShell>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				{/*
				 * Sets the theme before first paint, synchronously in <head>. Sets BOTH
				 * `data-theme` (`--mfw-*` tokens) and `.dark` (shadcn `dark:`);
				 * `useDarkClassSync` keeps them in step. Storage keys are duplicated
				 * from lib/theme.ts since this cannot import.
				 */}
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: same
					dangerouslySetInnerHTML={{
						__html: `(function(){try{
var t=localStorage.getItem("mfw:v2:theme");
var d=localStorage.getItem("mfw:v2:density");
var r=document.documentElement;
if(t==="light"||t==="dark")r.setAttribute("data-theme",t);
if(d==="compact")r.setAttribute("data-density",d);
var dark=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);
r.classList.toggle("dark",dark);
}catch(e){}})()`,
					}}
				/>
				<HeadContent />
			</head>
			{/* `h-dvh`, not `min-h-screen`: a definite height gives scroll regions a measurement instead of scrolling the whole app. `dvh` because mobile browser chrome retracts. */}
			<body className="bg-background text-foreground h-dvh overflow-hidden">
				{children}
				<Scripts />
			</body>
		</html>
	);
}
