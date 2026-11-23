import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import { serializeFileMutation } from "../serialized-file-mutation.ts";

/**
 * The machine-level chat budget (DESIGN §6 Q13: chat cannot starve the brain's
 * work turns). It is its own ledger in `$MFW_HOME`, shared by every project and
 * separate from `spend_ledger`, so chat use never counts toward the act
 * breaker's spend threshold or a project's brain budget.
 *
 * A turn reserves its full token cap at admission and is charged what it used
 * when it settles. A crash leaves the reservation in place until it ages out
 * of the window. An unreadable ledger admits nothing.
 */

export interface ChatTurnCaps {
	maxSteps: number;
	maxReads: number;
	maxTokens: number;
	/** Characters of one read result the model sees. */
	maxReadChars: number;
	stepTimeoutMs: number;
	turnTimeoutMs: number;
}

export const DEFAULT_CHAT_CAPS: ChatTurnCaps = {
	maxSteps: 6,
	maxReads: 5,
	maxTokens: 40_000,
	maxReadChars: 8_000,
	stepTimeoutMs: 60_000,
	turnTimeoutMs: 120_000,
};

export interface ChatBudgetConfig {
	windowMs: number;
	turns: number;
	tokens: number;
	usd: number;
	/** Reserved per open turn. */
	turnTokens: number;
}

export const DEFAULT_CHAT_BUDGET: ChatBudgetConfig = {
	windowMs: 24 * 3_600_000,
	turns: 100,
	tokens: 1_000_000,
	usd: 5,
	turnTokens: DEFAULT_CHAT_CAPS.maxTokens,
};

interface LedgerTurn {
	id: string;
	project: string;
	at: number;
	tokens: number;
	usd: number;
	open: boolean;
}

export interface ChatBudgetUsage {
	turns: number;
	tokens: number;
	usd: number;
	limits: { turns: number; tokens: number; usd: number };
}

export const chatBudgetPath = (home: string) => join(home, "chat-budget.json");

export class ChatBudget {
	readonly config: ChatBudgetConfig;

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
		config: Partial<ChatBudgetConfig> = {},
	) {
		this.config = { ...DEFAULT_CHAT_BUDGET, ...config };
	}

	private async load(): Promise<LedgerTurn[]> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw e;
		}
		const turns = (JSON.parse(raw) as { turns?: unknown }).turns;
		if (!Array.isArray(turns)) throw new Error("malformed chat budget ledger");
		return turns as LedgerTurn[];
	}

	private async save(turns: LedgerTurn[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFileAtomic(this.path, `${JSON.stringify({ turns })}\n`, {
			mode: 0o600,
		});
	}

	private live(turns: LedgerTurn[]): LedgerTurn[] {
		const from = this.now() - this.config.windowMs;
		return turns.filter((t) => t.at > from);
	}

	private totals(turns: LedgerTurn[]) {
		return {
			turns: turns.length,
			tokens: turns.reduce(
				(n, t) =>
					n + (t.open ? Math.max(t.tokens, this.config.turnTokens) : t.tokens),
				0,
			),
			usd: turns.reduce((n, t) => n + t.usd, 0),
		};
	}

	/** Reserve one turn, or say no. Serialized, so two projects cannot both take the last one. */
	admit(id: string, project: string): Promise<boolean> {
		return serializeFileMutation(this.path, async () => {
			let turns: LedgerTurn[];
			try {
				turns = this.live(await this.load());
			} catch {
				return false;
			}
			const used = this.totals(turns);
			const c = this.config;
			if (
				used.turns >= c.turns ||
				used.tokens + c.turnTokens > c.tokens ||
				used.usd >= c.usd
			) {
				return false;
			}
			turns.push({
				id,
				project,
				at: this.now(),
				tokens: 0,
				usd: 0,
				open: true,
			});
			await this.save(turns);
			return true;
		});
	}

	/** Add what one model step used. Written before the next step starts. */
	charge(id: string, tokens: number, usd: number): Promise<void> {
		return this.update(id, (t) => {
			t.tokens += tokens;
			t.usd += usd;
		});
	}

	/** The turn is over: from now on it counts for what it really used. */
	settle(id: string): Promise<void> {
		return this.update(id, (t) => {
			t.open = false;
		});
	}

	private update(id: string, apply: (t: LedgerTurn) => void): Promise<void> {
		return serializeFileMutation(this.path, async () => {
			const turns = this.live(await this.load());
			const turn = turns.find((t) => t.id === id);
			if (!turn) return;
			apply(turn);
			await this.save(turns);
		});
	}

	/** Current use, or null when the ledger cannot be read. */
	async usage(): Promise<ChatBudgetUsage | null> {
		try {
			const { turns, tokens, usd } = this.totals(this.live(await this.load()));
			const c = this.config;
			return {
				turns,
				tokens,
				usd,
				limits: { turns: c.turns, tokens: c.tokens, usd: c.usd },
			};
		} catch {
			return null;
		}
	}
}
