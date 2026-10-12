import { useSyncExternalStore } from "react";

/**
 * Which modifier words/symbols a keyboard hint should show. Pure so the
 * detection is testable: it takes the navigator-ish bits it reads. macOS (and
 * iOS) get the command-key symbols; everything else gets words (`Ctrl`).
 */
export interface NavigatorLike {
	platform?: string | undefined;
	userAgent?: string | undefined;
	userAgentData?: { platform?: string | undefined } | undefined;
}

const MAC = /Mac|iPhone|iPad|iPod/i;

/** Is this a Mac-family platform? `userAgentData` first, then `platform`, then the UA. */
export function isMacPlatform(nav: NavigatorLike | undefined): boolean {
	if (!nav) return false;
	const hinted = nav.userAgentData?.platform;
	if (hinted) return MAC.test(hinted);
	if (nav.platform) return MAC.test(nav.platform);
	return MAC.test(nav.userAgent ?? "");
}

/** The detection against the real `navigator`; false where there is none (server, tests). */
export function detectMac(): boolean {
	return isMacPlatform(
		typeof navigator === "undefined" ? undefined : (navigator as NavigatorLike),
	);
}

const subscribe = () => () => {};

/**
 * Whether to show Mac key symbols. The server snapshot is `false` (non-Mac
 * words), and the client renders that same text during hydration and then
 * switches, so there is no hydration mismatch.
 */
export function useIsMac(): boolean {
	return useSyncExternalStore(subscribe, detectMac, () => false);
}

/** The key that a `mod+` binding means on this platform, as text: `⌘` or `Ctrl`. */
export function modLabel(mac: boolean): string {
	return mac ? "⌘" : "Ctrl";
}
