import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_BOARD_LAYOUT,
	parseBoardLayout,
	readBoardLayout,
	writeBoardLayout,
} from "./boardColumns";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

function installStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
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

const KEY = "mfw:v2:board:layout:alpha";

describe("the board layout preference", () => {
	test("the grid is the default; unknown or missing values fall back to it", () => {
		expect(DEFAULT_BOARD_LAYOUT).toBe("grid");
		expect(parseBoardLayout(null)).toBe("grid");
		expect(parseBoardLayout("wide")).toBe("grid");
		expect(parseBoardLayout(42)).toBe("grid");
		expect(parseBoardLayout("grid")).toBe("grid");
		expect(parseBoardLayout("columns")).toBe("columns");
	});

	test("a stored 'lanes' reads as the grid and is rewritten once", () => {
		const values = installStorage({ [KEY]: "lanes" });
		expect(readBoardLayout("alpha")).toBe("grid");
		expect(values.get(KEY)).toBe("grid");
		expect(readBoardLayout("alpha")).toBe("grid");
	});

	test("a stored 'columns' is kept, per project", () => {
		const values = installStorage({ [KEY]: "columns" });
		expect(readBoardLayout("alpha")).toBe("columns");
		expect(readBoardLayout("beta")).toBe("grid");
		writeBoardLayout("beta", "columns");
		expect(values.get("mfw:v2:board:layout:beta")).toBe("columns");
		expect(values.get(KEY)).toBe("columns");
	});

	test("blocked storage reads as the default instead of throwing", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				localStorage: {
					getItem: () => {
						throw new Error("blocked");
					},
					setItem: () => {
						throw new Error("blocked");
					},
				},
			},
		});
		expect(readBoardLayout("alpha")).toBe("grid");
		expect(() => writeBoardLayout("alpha", "columns")).not.toThrow();
	});

	test("on the server there is no storage: the default", () => {
		Reflect.deleteProperty(globalThis, "window");
		expect(readBoardLayout("alpha")).toBe("grid");
	});
});
