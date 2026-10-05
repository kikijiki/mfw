import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
	DEFAULT_SIDEBAR_PREFERENCE,
	readSidebarPreference,
	SIDEBAR_STORAGE_KEY,
	useSidebarPreference,
	writeSidebarPreference,
} from "./sidebarPreference";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

function installStorage(initial?: string) {
	const values = new Map<string, string>();
	if (initial !== undefined) values.set(SIDEBAR_STORAGE_KEY, initial);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
			},
		},
	});
	return values;
}

describe("desktop sidebar preference", () => {
	test("defaults to expanded on the server and with no stored value", () => {
		expect(readSidebarPreference()).toBe(DEFAULT_SIDEBAR_PREFERENCE);

		function Probe() {
			const sidebar = useSidebarPreference();
			return createElement(
				"span",
				null,
				sidebar.expanded ? "expanded" : "collapsed",
			);
		}

		// Effects do not run during SSR, pinning the hydration-safe first snapshot.
		expect(renderToString(createElement(Probe))).toBe("<span>expanded</span>");
		installStorage();
		expect(readSidebarPreference()).toBe("expanded");
	});

	test("restores either valid stored preference", () => {
		const values = installStorage("collapsed");
		function Probe() {
			return createElement(
				"span",
				null,
				useSidebarPreference().expanded ? "expanded" : "collapsed",
			);
		}
		// A browser with a collapsed value still starts from the server snapshot;
		// the hook's effect applies the stored value only after hydration.
		expect(renderToString(createElement(Probe))).toBe("<span>expanded</span>");
		expect(readSidebarPreference()).toBe("collapsed");
		values.set(SIDEBAR_STORAGE_KEY, "expanded");
		expect(readSidebarPreference()).toBe("expanded");
	});

	test("persists changes under one namespaced key", () => {
		const values = installStorage();
		writeSidebarPreference("collapsed");
		expect([...values.entries()]).toEqual([[SIDEBAR_STORAGE_KEY, "collapsed"]]);
		writeSidebarPreference("expanded");
		expect(values.get(SIDEBAR_STORAGE_KEY)).toBe("expanded");
		expect(SIDEBAR_STORAGE_KEY.startsWith("mfw:v2:")).toBe(true);
	});

	test("malformed and unavailable storage fall back without throwing", () => {
		installStorage("not-a-sidebar-state");
		expect(readSidebarPreference()).toBe("expanded");

		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				localStorage: {
					getItem: () => {
						throw new Error("disabled");
					},
					setItem: () => {
						throw new Error("quota exceeded");
					},
				},
			},
		});
		expect(readSidebarPreference()).toBe("expanded");
		expect(() => writeSidebarPreference("collapsed")).not.toThrow();
	});
});
