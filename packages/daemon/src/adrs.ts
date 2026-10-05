import { basename, join } from "node:path";
import {
	type BoardDocument,
	BoardStore,
	DocumentNotFoundError,
	formatId,
	idPattern,
	loadBoardConfig,
	parseIdNum,
	type UpdateInput,
} from "@mfw/board-core";
import { ensureBoardConfig } from "./default-board-config.ts";
import type { Logger } from "./log.ts";

/**
 * ADRs live in `.mfw/adrs/<KEY>-ADR-<n>-<slug>.md`, declared as the "adr" type
 * in `.mfw/board.yaml`; `@mfw/board-core`'s `BoardStore` owns the file I/O,
 * id allocation and locking. This class adds the one thing the generic engine
 * deliberately does not know about: ADR-specific workflow rules.
 *
 * `proposed` ADRs are editable; once `accepted` title and body are frozen and
 * a decision changes only via a new ADR that supersedes it.
 *
 *   proposed → accepted | rejected
 *   accepted → superseded   (only via `supersede`)
 *
 * Optimistic concurrency uses the sha256 of the file bytes (`hash`, now a
 * field `BoardDocument` carries directly), since hand edits bump no revision
 * counter.
 */

export type AdrStatus = "proposed" | "accepted" | "superseded" | "rejected";

export interface AdrRecord {
	/** `<KEY>-ADR-7`: the project key, `ADR`, and the number. */
	id: string;
	num: number;
	title: string;
	status: AdrStatus;
	/** ISO date (YYYY-MM-DD) of creation. */
	date: string;
	supersedes: string | null;
	supersededBy: string | null;
	body: string;
	/** sha256 of the file bytes: the `baseHash` an edit must present. */
	hash: string;
	fileName: string;
	/** Set when the file could not be parsed; the other fields are then blanks. */
	error?: string;
}

export interface CreateAdrInput {
	title: string;
	body?: string;
}

export interface EditAdrPatch {
	title?: string;
	body?: string;
}

/** Body a new ADR starts from in the UI. Recommended, never enforced. */
export const ADR_BODY_TEMPLATE =
	"## Context\n\nWhat is the issue that motivates this decision?\n\n## Decision\n\nWhat we are going to do.\n\n## Consequences\n\nWhat becomes easier or harder as a result.\n";

export class AdrConflictError extends Error {
	constructor(readonly current: AdrRecord) {
		super(`${current.id} was modified since it was read`);
		this.name = "AdrConflictError";
	}
}

export class AdrImmutableError extends Error {
	constructor(
		readonly id: string,
		readonly status: AdrStatus,
	) {
		super(
			`${id} is ${status}: its title and body are frozen. Supersede it with a new ADR instead.`,
		);
		this.name = "AdrImmutableError";
	}
}

export class AdrTransitionError extends Error {
	constructor(
		readonly id: string,
		readonly from: AdrStatus,
		readonly to: string,
		detail?: string,
	) {
		super(detail ?? `${id}: cannot go from ${from} to ${to}`);
		this.name = "AdrTransitionError";
	}
}

export class AdrNotFoundError extends Error {
	constructor(readonly id: string) {
		super(`${id} not found`);
		this.name = "AdrNotFoundError";
	}
}

/** `MFW-ADR-7`: unique across projects, and distinct from task ids (`MFW-7`). */
export const adrId = (key: string, num: number) => formatId(key, num, "ADR");

/** Grammar of an ADR id for a project key. Never overlaps `taskIdRe`. */
export const adrIdRe = (key: string) => idPattern(key, "ADR");

export class AdrService {
	/** Set by boot: told when an ADR changed, so the board can be committed. */
	onBoardChanged: (() => void) | null = null;
	private storePromise: Promise<BoardStore> | null = null;

	constructor(
		private readonly deps: {
			mfwDir: string;
			taskKey: string;
			log: Logger;
			now?: () => Date;
		},
	) {}

	/** `board.yaml` is a small, hand-edited file; load it once and reuse the
	 * `BoardStore` for the life of this service. */
	private boardStore(): Promise<BoardStore> {
		if (!this.storePromise) {
			this.storePromise = ensureBoardConfig(this.deps.mfwDir, this.deps.taskKey)
				.then(() => loadBoardConfig(join(this.deps.mfwDir, "board.yaml")))
				.then((config) => new BoardStore(this.deps.mfwDir, config));
		}
		return this.storePromise;
	}

	private toRecord(doc: BoardDocument): AdrRecord {
		return {
			id: doc.id,
			num: parseIdNum(this.deps.taskKey, "ADR", doc.id) ?? 0,
			title: String(doc.fields.title ?? ""),
			status: (doc.fields.status as AdrStatus | undefined) ?? "proposed",
			date: String(doc.fields.date ?? ""),
			supersedes: (doc.fields.supersedes as string | null | undefined) ?? null,
			supersededBy:
				(doc.fields.superseded_by as string | null | undefined) ?? null,
			body: doc.body,
			hash: doc.hash,
			fileName: basename(doc.path),
		};
	}

	/** The id a malformed file's `id:` could not be trusted for is still
	 * recoverable from its file name, which carries `<id>-<slug>.md` — the
	 * slug is frozen at creation and never depends on the frontmatter parsing. */
	private idFromFileName(fileName: string): string | null {
		const re = new RegExp(
			`^(${this.deps.taskKey}-ADR-[1-9][0-9]*)(?:-.*)?\\.md$`,
		);
		return re.exec(fileName)?.[1] ?? null;
	}

	/**
	 * Every ADR, well-formed or not. `BoardStore.listDocuments` silently skips
	 * a document it can't parse (so one bad file never hides the others); this
	 * re-adds it as a blank record carrying `error`, matching the UX a human
	 * editing ADRs by hand has always had here.
	 */
	private async scanAll(): Promise<AdrRecord[]> {
		const store = await this.boardStore();
		const docs = await store.listDocuments("adr");
		const out = docs.map((d) => this.toRecord(d));
		const seenIds = new Set(out.map((r) => r.id));
		for (const issue of await store.validate()) {
			if (issue.type !== "adr") continue;
			const fileName = basename(issue.path);
			const id = this.idFromFileName(fileName) ?? issue.id ?? fileName;
			if (seenIds.has(id)) continue; // a structural issue on an otherwise-valid doc, not a parse failure
			seenIds.add(id);
			this.deps.log.warn(
				{ file: fileName, err: issue.message },
				"malformed ADR",
			);
			out.push({
				id,
				num: parseIdNum(this.deps.taskKey, "ADR", id) ?? 0,
				title: fileName,
				status: "proposed",
				date: "",
				supersedes: null,
				supersededBy: null,
				body: "",
				hash: "",
				fileName,
				error: issue.message,
			});
		}
		return out.sort((a, b) => a.num - b.num);
	}

	async list(status?: AdrStatus): Promise<AdrRecord[]> {
		const all = await this.scanAll();
		return status ? all.filter((r) => r.status === status) : all;
	}

	async get(id: string): Promise<AdrRecord | null> {
		return (await this.scanAll()).find((r) => r.id === id) ?? null;
	}

	private async require(id: string): Promise<AdrRecord> {
		const rec = await this.get(id);
		if (!rec) throw new AdrNotFoundError(id);
		if (rec.error) {
			throw new Error(
				`${id} has a malformed file (${rec.error}); fix it by hand`,
			);
		}
		return rec;
	}

	/**
	 * Lock `id`, re-read it fresh, let `fn` decide (throwing for a refused
	 * transition, or returning the patch to apply) — `BoardStore.transact`'s
	 * primitive, with ADR-shaped not-found/malformed errors instead of the
	 * generic engine's. A pre-check via `require()` gets the right error for
	 * those two cases before the atomic section even starts; the narrow gap
	 * between that check and the lock (the doc vanishing in between) surfaces
	 * as the generic error instead, which is an acceptable rarity here.
	 */
	private async transactOrNotFound(
		id: string,
		fn: (current: BoardDocument, rec: AdrRecord) => Promise<UpdateInput | null>,
	): Promise<AdrRecord> {
		await this.require(id);
		const store = await this.boardStore();
		try {
			const result = await store.transact("adr", id, (current) =>
				fn(current, this.toRecord(current)),
			);
			return this.toRecord(result as BoardDocument);
		} catch (e) {
			if (e instanceof DocumentNotFoundError) throw new AdrNotFoundError(id);
			throw e;
		}
	}

	private today(): string {
		return (this.deps.now?.() ?? new Date()).toISOString().slice(0, 10);
	}

	private touch(): void {
		this.onBoardChanged?.();
	}

	private async createAdrDocument(
		input: CreateAdrInput,
		supersedes: string | null,
	): Promise<AdrRecord> {
		const title = input.title.trim();
		if (!title) throw new Error("an ADR needs a title");
		const store = await this.boardStore();
		const doc = await store.createDocument("adr", {
			fields: { title, date: this.today(), supersedes, superseded_by: null },
			body: input.body ?? ADR_BODY_TEMPLATE,
		});
		return this.toRecord(doc);
	}

	async create(input: CreateAdrInput): Promise<AdrRecord> {
		const rec = await this.createAdrDocument(input, null);
		this.touch();
		return rec;
	}

	async update(
		id: string,
		patch: EditAdrPatch,
		baseHash: string,
	): Promise<AdrRecord> {
		const next = await this.transactOrNotFound(id, async (_current, rec) => {
			if (rec.status !== "proposed")
				throw new AdrImmutableError(id, rec.status);
			if (rec.hash !== baseHash) throw new AdrConflictError(rec);
			const title = (patch.title ?? rec.title).trim();
			if (!title) throw new Error("an ADR needs a title");
			return { fields: { title }, body: patch.body ?? rec.body };
		});
		this.touch();
		return next;
	}

	/** proposed → accepted | rejected. `baseHash`, when given, guards against
	 *  accepting text the reviewer did not see. */
	async setStatus(
		id: string,
		to: "accepted" | "rejected",
		baseHash?: string,
	): Promise<AdrRecord> {
		const next = await this.transactOrNotFound(id, async (_current, rec) => {
			if (rec.status !== "proposed")
				throw new AdrTransitionError(id, rec.status, to);
			if (baseHash !== undefined && rec.hash !== baseHash) {
				throw new AdrConflictError(rec);
			}
			return { fields: { status: to } };
		});
		this.touch();
		return next;
	}

	/**
	 * Write the new ADR first, then mark the old one superseded — both inside
	 * the lock `transactOrNotFound` takes on `oldId`, so a retried call after a
	 * crash between the two finds and reuses the already-created pending
	 * successor instead of creating a second one.
	 */
	async supersede(
		oldId: string,
		input: CreateAdrInput,
	): Promise<{ old: AdrRecord; next: AdrRecord }> {
		const store = await this.boardStore();
		let createdNext: AdrRecord | null = null;
		const old = await this.transactOrNotFound(oldId, async (_current, rec) => {
			if (rec.status !== "accepted") {
				throw new AdrTransitionError(
					oldId,
					rec.status,
					"superseded",
					`${oldId} is ${rec.status}; only an accepted ADR can be superseded`,
				);
			}
			const all = await store.listDocuments("adr");
			const pendingDoc = all.find(
				(d) => (d.fields.supersedes as string | null) === oldId,
			);
			createdNext = pendingDoc
				? this.toRecord(pendingDoc)
				: await this.createAdrDocument(input, oldId);
			return {
				fields: { status: "superseded", superseded_by: createdNext.id },
			};
		});
		this.touch();
		if (!createdNext)
			throw new Error(
				`supersede(${oldId}): unreachable, no successor recorded`,
			);
		return { old, next: createdNext };
	}

	async remove(id: string): Promise<void> {
		const rec = await this.require(id);
		if (rec.status !== "proposed" && rec.status !== "rejected") {
			throw new AdrTransitionError(
				id,
				rec.status,
				"deleted",
				`${id} is ${rec.status}: only proposed or rejected ADRs can be deleted`,
			);
		}
		const store = await this.boardStore();
		await store.deleteDocument("adr", id);
		this.touch();
	}
}
