import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	type BoardConfig,
	type FieldSpec,
	type HierarchySpec,
	parentRuleProblem,
	refCovers,
	type TypeSpec,
} from "./config.ts";
import {
	looksLikeBoardDocument,
	materializeFields,
	parseDocument,
	renderDocument,
} from "./document.ts";
import { writeFileAtomic } from "./fsatomic.ts";
import {
	formatId,
	idPattern,
	nameMatchesId,
	parseIdNum,
	slugify,
} from "./ids.ts";
import { KeyedLock } from "./lock.ts";

/**
 * The generic board engine: reads/writes documents as declared by
 * `board.yaml`. Deliberately stateless between calls — no in-memory index, no
 * cache, no "last seen" bookkeeping. Every call re-reads the files it needs.
 * A long-lived consumer that wants a cache, external-edit detection, or a
 * mass-delete circuit breaker builds that on top, by calling this repeatedly;
 * it is not this engine's job (see `board-tool-design.md`'s non-goals).
 */

export class UnknownTypeError extends Error {
	constructor(readonly type: string) {
		super(`unknown document type '${type}'`);
		this.name = "UnknownTypeError";
	}
}

export class DocumentNotFoundError extends Error {
	constructor(
		readonly type: string,
		readonly id: string,
	) {
		super(`${type} '${id}' not found`);
		this.name = "DocumentNotFoundError";
	}
}

export class DocumentConflictError extends Error {
	constructor(
		readonly type: string,
		readonly id: string,
		readonly currentRev: number,
	) {
		super(`${type} '${id}' was modified: current rev is ${currentRev}`);
		this.name = "DocumentConflictError";
	}
}

export class DocumentExistsError extends Error {
	constructor(
		readonly type: string,
		readonly id: string,
	) {
		super(`${type} '${id}' already exists`);
		this.name = "DocumentExistsError";
	}
}

export class InvalidIdError extends Error {
	constructor(
		readonly type: string,
		readonly id: string,
		reason?: string,
	) {
		super(
			reason
				? `${type}: id '${id}' ${reason}`
				: `${type}: id '${id}' does not match its own-sequence grammar`,
		);
		this.name = "InvalidIdError";
	}
}

export class MalformedDocumentError extends Error {
	constructor(
		readonly type: string,
		readonly path: string,
		readonly reason: string,
	) {
		super(`${type} at ${path} is malformed: ${reason}`);
		this.name = "MalformedDocumentError";
	}
}

export class InvalidFieldsError extends Error {
	constructor(
		readonly type: string,
		readonly errors: readonly string[],
	) {
		super(`${type}: ${errors.join("; ")}`);
		this.name = "InvalidFieldsError";
	}
}

export type HierarchyErrorCode =
	| "parent-not-found"
	| "parent-ambiguous"
	| "parent-type-not-allowed"
	| "max-depth"
	| "cycle"
	| "has-children"
	| "children-mismatch"
	| "direct-write"
	| "no-hierarchy";

/** A parent/children mutation the board's `hierarchy` rules refuse. Nothing
 * has been written when one of these is thrown. */
export class HierarchyError extends Error {
	constructor(
		readonly code: HierarchyErrorCode,
		readonly type: string,
		readonly id: string,
		message: string,
	) {
		super(`${type} '${id}': ${message}`);
		this.name = "HierarchyError";
	}
}

type RefField = Extract<FieldSpec, { kind: "ref" }>;
const RETRY = Symbol("retry");

export interface BoardDocument {
	type: string;
	id: string;
	rev: number;
	fields: Record<string, unknown>;
	body: string;
	path: string;
	/** sha256 of the exact bytes this was parsed from — not cached or compared
	 * by this engine (it's stateless), but a long-lived consumer that wants to
	 * detect an out-of-band edit needs the raw hash, not just `rev` (a hand
	 * edit might not know to bump it). */
	hash: string;
}

export interface CreateInput {
	/** Required for `id: { strategy: "inherit" }`; optional (explicit import) otherwise. */
	id?: string;
	fields: Record<string, unknown>;
	body?: string;
}

export interface UpdateInput {
	fields?: Record<string, unknown>;
	body?: string;
}

/** Stable classification of a validation issue (the CLI maps these to exit codes). */
export type ValidationIssueKind =
	| "document"
	| "id"
	| "reference"
	| "hierarchy"
	| "cycle";

export interface ValidationIssue {
	kind: ValidationIssueKind;
	type: string;
	id: string | null;
	path: string;
	message: string;
}

interface ScannedEntry {
	path: string;
	raw: string;
}

async function safeRead(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class BoardStore {
	private readonly lock: KeyedLock;

	constructor(
		private readonly root: string,
		private readonly config: BoardConfig,
	) {
		this.lock = new KeyedLock(join(root, ".board", "locks"));
	}

	private typeOf(typeName: string): TypeSpec {
		const spec = this.config.types[typeName];
		if (!spec) throw new UnknownTypeError(typeName);
		return spec;
	}

	private typeDir(type: TypeSpec): string {
		return join(this.root, type.dir);
	}

	private pathFor(type: TypeSpec, id: string, slug: string): string {
		const name = slug ? `${id}-${slug}` : id;
		return type.layout === "flat"
			? join(this.typeDir(type), `${name}.md`)
			: join(this.typeDir(type), name, type.primary as string);
	}

	/** Every file/directory in a type's dir that could be one of its documents, unparsed. */
	private async scan(type: TypeSpec): Promise<ScannedEntry[]> {
		let entries: Dirent[];
		try {
			entries = await readdir(this.typeDir(type), { withFileTypes: true });
		} catch {
			return [];
		}
		const out: ScannedEntry[] = [];
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			if (type.layout === "flat") {
				if (!e.isFile() || !e.name.endsWith(".md")) continue;
				const path = join(this.typeDir(type), e.name);
				const raw = await safeRead(path);
				if (raw === null || !looksLikeBoardDocument(raw)) continue;
				out.push({ path, raw });
			} else {
				if (!e.isDirectory()) continue;
				const path = join(this.typeDir(type), e.name, type.primary as string);
				const raw = await safeRead(path);
				if (raw === null) continue; // no primary file: not a document (e.g. attachments-only leftover)
				out.push({ path, raw });
			}
		}
		return out;
	}

	private toDocument(
		typeName: string,
		type: TypeSpec,
		entry: ScannedEntry,
	): BoardDocument {
		const parsed = parseDocument(entry.raw, typeName, type);
		if (!parsed.ok)
			throw new MalformedDocumentError(typeName, entry.path, parsed.reason);
		return {
			type: typeName,
			id: parsed.doc.id,
			rev: parsed.doc.rev,
			fields: parsed.doc.fields,
			body: parsed.doc.body,
			path: entry.path,
			hash: sha256(entry.raw),
		};
	}

	/** `toDocument`, but a malformed entry is invisible instead of throwing —
	 * one bad file must not hide every good one from `list`/`read`. Surfacing
	 * malformed documents is `validate()`'s job specifically. */
	private tryToDocument(
		typeName: string,
		type: TypeSpec,
		entry: ScannedEntry,
	): BoardDocument | null {
		try {
			return this.toDocument(typeName, type, entry);
		} catch (e) {
			if (e instanceof MalformedDocumentError) return null;
			throw e;
		}
	}

	async listDocuments(
		typeName: string,
		filter: Record<string, string> = {},
	): Promise<BoardDocument[]> {
		const type = this.typeOf(typeName);
		const entries = await this.scan(type);
		const seen = new Set<string>();
		const out: BoardDocument[] = [];
		for (const entry of entries) {
			const doc = this.tryToDocument(typeName, type, entry);
			if (!doc || seen.has(doc.id)) continue; // a duplicate id is `validate()`'s job to report, not list's
			seen.add(doc.id);
			out.push(doc);
		}
		return out.filter((doc) =>
			Object.entries(filter).every(([k, v]) =>
				k === "id" ? doc.id === v : String(doc.fields[k]) === v,
			),
		);
	}

	async readDocument(
		typeName: string,
		id: string,
	): Promise<BoardDocument | null> {
		const type = this.typeOf(typeName);
		for (const entry of await this.scan(type)) {
			const parsed = parseDocument(entry.raw, typeName, type);
			if (parsed.ok) {
				if (parsed.doc.id === id) {
					return {
						type: typeName,
						id: parsed.doc.id,
						rev: parsed.doc.rev,
						fields: parsed.doc.fields,
						body: parsed.doc.body,
						path: entry.path,
						hash: sha256(entry.raw),
					};
				}
				continue;
			}
			// A document every other entry's own id ruled out is invisible (one
			// bad file must not hide the others — `validate()`'s job to surface
			// it). But `id` is known to exist and callers are asking for it BY
			// NAME: every document's slug/filename starts with its id by
			// construction (`pathFor`), so if this broken entry's own name
			// matches, it almost certainly IS the one asked for — surface the
			// real parse failure instead of a misleading "not found".
			const name =
				type.layout === "directory"
					? basename(dirname(entry.path))
					: basename(entry.path);
			if (nameMatchesId(name, id)) {
				throw new MalformedDocumentError(typeName, entry.path, parsed.reason);
			}
		}
		return null;
	}

	/** An explicit id on `createDocument` must still match its type's own id
	 * grammar — an id that `nextOwnSequenceId`'s own max-scan could never parse
	 * back out would silently fall outside sequence reconciliation forever. */
	private validatedExplicitId(
		typeName: string,
		idSpec: Extract<TypeSpec["id"], { strategy: "own-sequence" }>,
		id: string,
	): string {
		if (!idPattern(idSpec.key, idSpec.suffix).test(id)) {
			throw new InvalidIdError(typeName, id);
		}
		if (parseIdNum(idSpec.key, idSpec.suffix, id) === null) {
			throw new InvalidIdError(
				typeName,
				id,
				"is too large (its number exceeds Number.MAX_SAFE_INTEGER)",
			);
		}
		return id;
	}

	/** The types whose documents share `typeName`'s id space: every type
	 * declaring the same `sequence`, or just this type. */
	private sequenceGroup(
		typeName: string,
		type: TypeSpec,
	): [string, TypeSpec][] {
		const sequence =
			type.id.strategy === "own-sequence" ? type.id.sequence : undefined;
		return sequence
			? Object.entries(this.config.types).filter(
					([, t]) =>
						t.id.strategy === "own-sequence" && t.id.sequence === sequence,
				)
			: [[typeName, type]];
	}

	/** Refuse an explicit id whose NUMBER is already used anywhere in its
	 * sequence group (`WH-42` when `WH-0042` exists, or `WH-5` as an epic when a
	 * task has it) - the caller holds the group's counter lock. */
	private async assertIdFree(
		typeName: string,
		type: TypeSpec,
		idSpec: Extract<TypeSpec["id"], { strategy: "own-sequence" }>,
		id: string,
	): Promise<void> {
		const num = parseIdNum(idSpec.key, idSpec.suffix, id);
		for (const [otherName, otherType] of this.sequenceGroup(typeName, type)) {
			for (const entry of await this.scan(otherType)) {
				const parsed = parseDocument(entry.raw, otherName, otherType);
				if (!parsed.ok) continue;
				if (parsed.doc.id === id) throw new DocumentExistsError(otherName, id);
				if (parseIdNum(idSpec.key, idSpec.suffix, parsed.doc.id) === num) {
					throw new InvalidIdError(
						typeName,
						id,
						`has the same number as existing ${otherName} '${parsed.doc.id}'`,
					);
				}
			}
		}
	}

	/** Next free id for an `own-sequence` type: the stored counter reconciled
	 * against the highest id actually on disk, so a deleted/restored counter
	 * file can never reissue one. `idSpec.sequence` shares one counter and one
	 * max-scan across every type declaring that same sequence name (otherwise
	 * the counter and scan are scoped to just this type) — scanning a sibling
	 * type's documents with THIS type's key/suffix grammar assumes every
	 * type sharing a sequence shares its id grammar too, which is the point of
	 * sharing one. */
	private async nextOwnSequenceId(
		typeName: string,
		type: TypeSpec,
		idSpec: Extract<TypeSpec["id"], { strategy: "own-sequence" }>,
	): Promise<string> {
		const { key, suffix, pad, sequence } = idSpec;
		const counterKey = sequence ?? typeName;
		return this.lock.with(`::counter:${counterKey}`, async () => {
			const sharing = this.sequenceGroup(typeName, type);
			let max = 0;
			for (const [otherName, otherType] of sharing) {
				for (const entry of await this.scan(otherType)) {
					const parsed = parseDocument(entry.raw, otherName, otherType);
					if (!parsed.ok) continue;
					const num = parseIdNum(key, suffix, parsed.doc.id);
					if (num !== null && num > max) max = num;
				}
			}
			const counterPath = join(
				this.root,
				".board",
				"state",
				`${counterKey}.json`,
			);
			let stored = 0;
			const raw = await safeRead(counterPath);
			if (raw !== null) {
				try {
					stored = Number((JSON.parse(raw) as { next?: unknown }).next) || 0;
				} catch {
					stored = 0;
				}
			}
			// `stored` is already "next id to allocate" (not "last used"), so it's
			// a candidate as-is; `max` is "highest id actually on disk" and DOES
			// need +1. Mixing the two under one `+1` double-increments whichever
			// one came from the counter file.
			const num = Math.max(stored || 1, max + 1);
			await mkdir(join(this.root, ".board", "state"), { recursive: true });
			await writeFileAtomic(
				counterPath,
				`${JSON.stringify({ next: num + 1 })}\n`,
			);
			return formatId(key, num, suffix, pad);
		});
	}

	async createDocument(
		typeName: string,
		input: CreateInput,
	): Promise<BoardDocument> {
		const type = this.typeOf(typeName);
		const idSpec = type.id;
		if (idSpec.strategy === "inherit") {
			const id = await this.inheritedId(typeName, idSpec, input.id);
			return this.createWithId(typeName, type, id, input);
		}
		if (input.id !== undefined) {
			const explicit = this.validatedExplicitId(typeName, idSpec, input.id);
			// Held across the whole create so no auto allocation or sibling-type
			// explicit create can take the same number in between.
			return this.lock.with(
				`::counter:${idSpec.sequence ?? typeName}`,
				async () => {
					await this.assertIdFree(typeName, type, idSpec, explicit);
					return this.createWithId(typeName, type, explicit, input);
				},
			);
		}
		// Auto allocation can still lose to an explicit create in another
		// process that took the number first: re-allocate a bounded number of times.
		for (let attempt = 1; ; attempt++) {
			const id = await this.nextOwnSequenceId(typeName, type, idSpec);
			try {
				return await this.createWithId(typeName, type, id, input);
			} catch (e) {
				if (!(e instanceof DocumentExistsError) || attempt >= 5) throw e;
			}
		}
	}

	private async createWithId(
		typeName: string,
		type: TypeSpec,
		id: string,
		input: CreateInput,
	): Promise<BoardDocument> {
		const h = this.hierarchyFor(type);
		if (!h)
			return this.lock.with(`${typeName}:${id}`, () =>
				this.createLocked(typeName, type, id, input),
			);
		const parentId = nonEmptyString(input.fields[h.parent]);
		return this.lockedBy(
			() => this.planKeys(typeName, id, parentId),
			async () => {
				let parent: BoardDocument | null = null;
				const doc = await this.createLocked(
					typeName,
					type,
					id,
					input,
					async (materialized) => {
						if (parentId) {
							parent = await this.validateParentChange(
								typeName,
								type,
								h,
								id,
								parentId,
								materialized,
							);
						}
						if (input.fields[h.children] != null) {
							await this.checkChildren(
								typeName,
								h,
								id,
								input.fields[h.children],
							);
						}
					},
				);
				if (parent) {
					try {
						await this.addChild(parent, id);
					} catch (e) {
						await this.removeFiles(type, doc).catch(() => {});
						throw e;
					}
				}
				return doc;
			},
		);
	}

	/** Create body; the caller holds the lock on `typeName:id`. `check` runs
	 * after field validation and before anything is written. */
	private async createLocked(
		typeName: string,
		type: TypeSpec,
		id: string,
		input: CreateInput,
		check?: (fields: Record<string, unknown>) => Promise<void>,
	): Promise<BoardDocument> {
		if (await this.readDocument(typeName, id))
			throw new DocumentExistsError(typeName, id);
		const result = materializeFields(typeName, type, input.fields);
		if (!result.ok) throw new InvalidFieldsError(typeName, result.errors);
		await this.refuseCycles(typeName, type, id, result.fields);
		await check?.(result.fields);
		const slug = type.slugFrom
			? slugify(String(input.fields[type.slugFrom] ?? ""))
			: "";
		const path = this.pathFor(type, id, slug);
		const content = renderDocument(type, {
			id,
			rev: 1,
			fields: result.fields,
			body: input.body ?? "",
		});
		const doc: BoardDocument = {
			type: typeName,
			id,
			rev: 1,
			fields: result.fields,
			body: input.body ?? "",
			path,
			hash: sha256(content),
		};
		await mkdir(dirname(path), { recursive: true });
		await writeFileAtomic(path, content);
		return doc;
	}

	private async inheritedId(
		typeName: string,
		idSpec: { strategy: "inherit"; from: string },
		id: string | undefined,
	): Promise<string> {
		if (!id) {
			throw new Error(
				`type '${typeName}' inherits its id from '${idSpec.from}'; pass one explicitly`,
			);
		}
		if (!(await this.readDocument(idSpec.from, id))) {
			throw new Error(
				`type '${typeName}': no '${idSpec.from}' document '${id}' to inherit an id from`,
			);
		}
		return id;
	}

	/**
	 * The primitive every exclusive transition is built from: lock `id`,
	 * re-read it fresh, let `fn` decide (it may read OTHER documents too — a
	 * plain `readDocument` call, no lock, is safe: every write is an atomic
	 * replace, so a concurrent reader sees fully-old or fully-new content,
	 * never torn), then atomically write whatever patch `fn` returns. `fn`
	 * returning `null` aborts with no write at all — the caller's precondition
	 * failed. This is the flock-guarded, re-validated, atomic-replace sequence
	 * `updateDocument` and any caller with extra domain rules (e.g. mfw's
	 * `claim`) both build on.
	 */
	async transact(
		typeName: string,
		id: string,
		fn: (current: BoardDocument) => Promise<UpdateInput | null>,
	): Promise<BoardDocument | null> {
		const type = this.typeOf(typeName);
		const h = this.hierarchyFor(type);
		return this.lock.with(`${typeName}:${id}`, async () => {
			const current = await this.readDocument(typeName, id);
			if (!current) throw new DocumentNotFoundError(typeName, id);
			const patch = await fn(current);
			if (!patch) return null;
			if (h) {
				// A one-document lock cannot keep both sides of the relation in sync.
				for (const key of [h.parent, h.children]) {
					if (
						patch.fields &&
						key in patch.fields &&
						JSON.stringify(patch.fields[key] ?? null) !==
							JSON.stringify(current.fields[key] ?? null)
					) {
						throw new HierarchyError(
							"direct-write",
							typeName,
							id,
							`'${key}' is part of the hierarchy and cannot change inside transact(); use updateDocument/setParent`,
						);
					}
				}
			}
			return this.writePatch(typeName, type, current, patch);
		});
	}

	/**
	 * A rule may match on a field's value (`kind=subtask`). Changing such a field
	 * on a document that already has a parent or children can break the rules on
	 * either side, so refuse the write when the document's new fields no longer
	 * fit its current parent, or its current children no longer fit it.
	 */
	private async refuseRuleBreaks(
		typeName: string,
		type: TypeSpec,
		id: string,
		before: Record<string, unknown>,
		after: Record<string, unknown>,
	): Promise<void> {
		const h = this.hierarchyFor(type);
		if (!h?.rules) return;
		const watched = new Set<string>();
		for (const r of h.rules) {
			for (const sel of [r.child, ...r.parents]) {
				if (sel.type === typeName) {
					for (const f of Object.keys(sel.where ?? {})) watched.add(f);
				}
			}
		}
		if ([...watched].every((f) => before[f] === after[f])) return;
		const me = { type: typeName, fields: after };
		const parentId = nonEmptyString(after[h.parent]);
		if (parentId) {
			const found = await this.findRef(
				(type.fields[h.parent] as RefField).ref,
				parentId,
			);
			const parent = found.length === 1 ? found[0] : undefined;
			const problem = parent && parentRuleProblem(h.rules, me, parent);
			if (problem) {
				throw new HierarchyError(
					"parent-type-not-allowed",
					typeName,
					id,
					`this change would break the hierarchy rules for its parent '${parentId}': ${problem}`,
				);
			}
		}
		const kids = (after[h.children] as string[] | undefined) ?? [];
		const childRef = (type.fields[h.children] as RefField).ref;
		for (const childId of kids) {
			const found = await this.findRef(childRef, childId);
			const child = found.length === 1 ? found[0] : undefined;
			const problem = child && parentRuleProblem(h.rules, child, me);
			if (problem) {
				throw new HierarchyError(
					"parent-type-not-allowed",
					typeName,
					id,
					`this change would break the hierarchy rules for its child '${childId}': ${problem}`,
				);
			}
		}
	}

	/**
	 * Refuse a write that would put `id` on a dependency cycle through an
	 * `acyclic` field: walk the field from each target `id` is about to point at
	 * (reading the other documents as they are on disk) and fail if the walk
	 * returns to `id`. Like the hierarchy walks this reads unlocked, so two
	 * concurrent edits of different documents can still close a cycle together;
	 * `validate()` reports that afterwards.
	 */
	private async refuseCycles(
		typeName: string,
		type: TypeSpec,
		id: string,
		fields: Record<string, unknown>,
	): Promise<void> {
		for (const [fieldName, spec] of Object.entries(type.fields)) {
			if (spec.kind !== "ref" || !spec.acyclic) continue;
			const direct = (fields[fieldName] as string[] | undefined) ?? [];
			if (direct.length === 0) continue;
			const others = new Map(
				(await this.listDocuments(typeName)).map((d) => [d.id, d] as const),
			);
			const seen = new Set<string>();
			const walk = (at: string, path: string[]): string[] | null => {
				if (at === id) return [...path, id];
				if (seen.has(at)) return null;
				seen.add(at);
				const next = (others.get(at)?.fields[fieldName] as string[]) ?? [];
				for (const n of next) {
					const hit = walk(n, [...path, at]);
					if (hit) return hit;
				}
				return null;
			};
			for (const target of direct) {
				const cycle = walk(target, [id]);
				if (cycle) {
					throw new InvalidFieldsError(typeName, [
						`field '${fieldName}' would create a cycle: ${cycle.join(" → ")}`,
					]);
				}
			}
		}
	}

	/** Validate and atomically write `patch` over `current`; the caller holds
	 * the lock on `current`. */
	private async writePatch(
		typeName: string,
		type: TypeSpec,
		current: BoardDocument,
		patch: UpdateInput,
	): Promise<BoardDocument> {
		const result = materializeFields(typeName, type, {
			...current.fields,
			...patch.fields,
		});
		if (!result.ok) throw new InvalidFieldsError(typeName, result.errors);
		await this.refuseCycles(typeName, type, current.id, result.fields);
		await this.refuseRuleBreaks(
			typeName,
			type,
			current.id,
			current.fields,
			result.fields,
		);
		const rev = current.rev + 1;
		const body = patch.body ?? current.body;
		const content = renderDocument(type, {
			id: current.id,
			rev,
			fields: result.fields,
			body,
		});
		const next: BoardDocument = {
			type: typeName,
			id: current.id,
			rev,
			fields: result.fields,
			body,
			path: current.path, // paths never move after creation (see TypeSpec.slugFrom)
			hash: sha256(content),
		};
		await writeFileAtomic(current.path, content);
		return next;
	}

	async updateDocument(
		typeName: string,
		id: string,
		patch: UpdateInput,
		opts: { baseRev?: number } = {},
	): Promise<BoardDocument> {
		const type = this.typeOf(typeName);
		const h = this.hierarchyFor(type);
		if (
			h &&
			patch.fields &&
			(h.parent in patch.fields || h.children in patch.fields)
		) {
			return this.updateHierarchical(typeName, type, h, id, patch, opts);
		}
		const result = await this.transact(typeName, id, async (current) => {
			if (opts.baseRev !== undefined && opts.baseRev !== current.rev) {
				throw new DocumentConflictError(typeName, id, current.rev);
			}
			return patch;
		});
		// `fn` above always returns a patch (never null), so this is unreachable.
		return result as BoardDocument;
	}

	/** Re-parent (or `null` to detach) a document, keeping the old and new
	 * parents' `children` lists in sync. Same as an `updateDocument` that only
	 * changes the hierarchy's `parent` field. */
	async setParent(
		typeName: string,
		id: string,
		newParentId: string | null,
	): Promise<BoardDocument> {
		const h = this.hierarchyFor(this.typeOf(typeName));
		if (!h) {
			throw new HierarchyError(
				"no-hierarchy",
				typeName,
				id,
				"this type does not participate in the board's hierarchy",
			);
		}
		return this.updateDocument(typeName, id, {
			fields: { [h.parent]: newParentId },
		});
	}

	private async updateHierarchical(
		typeName: string,
		type: TypeSpec,
		h: HierarchySpec,
		id: string,
		patch: UpdateInput,
		opts: { baseRev?: number },
	): Promise<BoardDocument> {
		const fields = patch.fields as Record<string, unknown>;
		const requested = h.parent in fields ? fields[h.parent] : undefined;
		const requestedParent =
			requested === undefined ? undefined : nonEmptyString(requested);
		return this.lockedBy(
			() => this.planKeys(typeName, id, requestedParent ?? null),
			async () => {
				const current = await this.readDocument(typeName, id);
				if (!current) throw new DocumentNotFoundError(typeName, id);
				if (opts.baseRev !== undefined && opts.baseRev !== current.rev) {
					throw new DocumentConflictError(typeName, id, current.rev);
				}
				const merged = materializeFields(typeName, type, {
					...current.fields,
					...fields,
				});
				if (!merged.ok) throw new InvalidFieldsError(typeName, merged.errors);
				const oldParent = nonEmptyString(current.fields[h.parent]);
				const newParent =
					requested === undefined
						? oldParent
						: nonEmptyString(merged.fields[h.parent]);
				if (h.children in fields && fields[h.children] != null) {
					await this.checkChildren(typeName, h, id, fields[h.children]);
				}
				const changed = newParent !== oldParent;
				const newDoc =
					changed && newParent
						? await this.validateParentChange(
								typeName,
								type,
								h,
								id,
								newParent,
								merged.fields,
							)
						: null;
				const oldDoc =
					changed && oldParent
						? await this.uniqueRef(type, h, oldParent)
						: null;
				const next = await this.writePatch(typeName, type, current, patch);
				if (oldDoc) await this.removeChild(oldDoc, id);
				if (newDoc) await this.addChild(newDoc, id);
				return next;
			},
		);
	}

	/** Delete one document (its whole directory, for `layout: "directory"`).
	 * Returns false if it did not exist. In a hierarchy, a document that still
	 * has children is refused (`HierarchyError`), and the document is removed
	 * from its parent's `children`. */
	async deleteDocument(typeName: string, id: string): Promise<boolean> {
		const type = this.typeOf(typeName);
		const h = this.hierarchyFor(type);
		const remove = async (doc: BoardDocument) => {
			await this.removeFiles(type, doc);
		};
		if (!h) {
			return this.lock.with(`${typeName}:${id}`, async () => {
				const doc = await this.readDocument(typeName, id);
				if (!doc) return false;
				await remove(doc);
				return true;
			});
		}
		return this.lockedBy(
			() => this.planKeys(typeName, id, null),
			async () => {
				const doc = await this.readDocument(typeName, id);
				if (!doc) return false;
				const kids = await this.actualChildren(typeName, h, id);
				if (kids.length > 0) {
					throw new HierarchyError(
						"has-children",
						typeName,
						id,
						`still has children (${kids.join(", ")}); delete or re-parent them first`,
					);
				}
				const parentId = nonEmptyString(doc.fields[h.parent]);
				const parent = parentId
					? await this.uniqueRef(type, h, parentId)
					: null;
				await remove(doc);
				if (parent) await this.removeChild(parent, id);
				return true;
			},
		);
	}

	private async removeFiles(type: TypeSpec, doc: BoardDocument): Promise<void> {
		const target = type.layout === "directory" ? dirname(doc.path) : doc.path;
		await rm(target, { recursive: true, force: true });
	}

	/** Delete every document of a type as one declared operation. The id
	 * counter is NOT reset: ids are never reused (see `nextOwnSequenceId`).
	 * Under a hierarchy, documents with children go after their children. */
	async wipeType(typeName: string): Promise<string[]> {
		let pending = (await this.listDocuments(typeName)).map((d) => d.id);
		const removed: string[] = [];
		while (pending.length > 0) {
			const blocked: string[] = [];
			let lastError: unknown;
			for (const id of pending) {
				try {
					if (await this.deleteDocument(typeName, id)) removed.push(id);
				} catch (e) {
					if (!(e instanceof HierarchyError && e.code === "has-children"))
						throw e;
					blocked.push(id);
					lastError = e;
				}
			}
			if (blocked.length === pending.length) throw lastError;
			pending = blocked;
		}
		return removed;
	}

	// -----------------------------------------------------------------------
	// Hierarchy
	//
	// Every re-parent / create-under / delete touches up to three documents
	// (self, old parent, new parent). They are locked together, always in
	// sorted key order, so concurrent operations cannot deadlock. The writes
	// themselves are separate atomic file replaces: a crash between them leaves
	// parent and children disagreeing, which `validate()` reports.
	// -----------------------------------------------------------------------

	/** The hierarchy spec, if this type participates (declares its fields). */
	private hierarchyFor(type: TypeSpec): HierarchySpec | null {
		const h = this.config.hierarchy;
		return h && h.parent in type.fields ? h : null;
	}

	private candidateTypes(ref: "any" | readonly string[]): string[] {
		return ref === "any" ? Object.keys(this.config.types) : [...ref];
	}

	private async findRef(
		ref: "any" | readonly string[],
		id: string,
	): Promise<BoardDocument[]> {
		const found: BoardDocument[] = [];
		for (const t of this.candidateTypes(ref)) {
			const doc = await this.readDocument(t, id);
			if (doc) found.push(doc);
		}
		return found;
	}

	/** Lock keys for an operation on `typeName:id`: itself, its current
	 * parent, and `newParent` (every type the id could resolve in). */
	private async planKeys(
		typeName: string,
		id: string,
		newParent: string | null,
	): Promise<string[]> {
		const type = this.typeOf(typeName);
		const h = this.hierarchyFor(type) as HierarchySpec;
		const keys = [`${typeName}:${id}`];
		const current = await this.readDocument(typeName, id);
		const ref = (type.fields[h.parent] as RefField).ref;
		for (const p of [
			current ? nonEmptyString(current.fields[h.parent]) : null,
			newParent,
		]) {
			if (!p) continue;
			for (const d of await this.findRef(ref, p))
				keys.push(`${d.type}:${d.id}`);
		}
		return keys;
	}

	private async withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
		const sorted = [...new Set(keys)].sort();
		const run = (i: number): Promise<T> =>
			i >= sorted.length
				? fn()
				: this.lock.with(sorted[i] as string, () => run(i + 1));
		return run(0);
	}

	/** Plan the lock set, take it, and re-plan under the locks: if the set
	 * grew in between (a concurrent re-parent), release and try again. */
	private async lockedBy<T>(
		plan: () => Promise<string[]>,
		fn: () => Promise<T>,
	): Promise<T> {
		for (let attempt = 0; attempt < 8; attempt++) {
			const keys = await plan();
			const result = await this.withLocks(keys, async () => {
				const again = await plan();
				if (again.some((k) => !keys.includes(k))) return RETRY;
				return fn();
			});
			if (result !== RETRY) return result as T;
		}
		throw new Error(
			"hierarchy lock set kept changing; giving up after 8 attempts",
		);
	}

	/** The single document `parentId` resolves to through `type`'s parent
	 * field, or null if it does not resolve or is ambiguous. */
	private async uniqueRef(
		type: TypeSpec,
		h: HierarchySpec,
		parentId: string,
	): Promise<BoardDocument | null> {
		const found = await this.findRef(
			(type.fields[h.parent] as RefField).ref,
			parentId,
		);
		return found.length === 1 ? (found[0] as BoardDocument) : null;
	}

	private async addChild(
		parent: BoardDocument,
		childId: string,
	): Promise<void> {
		await this.syncChildren(parent, { add: childId });
	}

	private async removeChild(
		parent: BoardDocument,
		childId: string,
	): Promise<void> {
		await this.syncChildren(parent, { remove: childId });
	}

	/**
	 * Rewrite `parent`'s `children` from the truth: the documents whose own
	 * `parent` field points at it (plus `add`, minus `remove`, for a change that
	 * is not on disk yet). Existing entries keep their order, stale ones are
	 * dropped and missing ones appended in id order, so any mutation touching a
	 * parent also heals a list that was desynced by a hand edit. The caller
	 * holds the lock on `parent`. Returns the before/after lists when it wrote.
	 */
	private async syncChildren(
		parent: BoardDocument,
		opts: { add?: string; remove?: string } = {},
	): Promise<{ before: string[]; after: string[] } | null> {
		const h = this.config.hierarchy as HierarchySpec;
		const fresh = (await this.readDocument(parent.type, parent.id)) ?? parent;
		const before = (fresh.fields[h.children] as string[] | undefined) ?? [];
		const actual = new Set(
			await this.actualChildren(parent.type, h, parent.id),
		);
		if (opts.add) actual.add(opts.add);
		if (opts.remove) actual.delete(opts.remove);
		const after = [
			...before.filter((c) => actual.has(c)),
			...[...actual].filter((c) => !before.includes(c)).sort(),
		];
		if (JSON.stringify(before) === JSON.stringify(after)) return null;
		await this.writePatch(parent.type, this.typeOf(parent.type), fresh, {
			fields: { [h.children]: after },
		});
		return { before, after };
	}

	/**
	 * Recompute every parent's `children` list from the children's `parent`
	 * fields (the fix for boards whose parents were set by hand, or files edited
	 * outside the tool). Each parent is rewritten under its own lock; returns
	 * the ones that changed. Problems a rewrite cannot fix (dangling or
	 * disallowed parents, cycles) are left for `validate`.
	 */
	async repairHierarchy(): Promise<
		{ type: string; id: string; before: string[]; after: string[] }[]
	> {
		const h = this.config.hierarchy as HierarchySpec | undefined;
		if (!h) throw new HierarchyError("no-hierarchy", "", "", "no hierarchy");
		const changed: {
			type: string;
			id: string;
			before: string[];
			after: string[];
		}[] = [];
		for (const [typeName, spec] of Object.entries(this.config.types)) {
			if (!(h.parent in spec.fields) || !(h.children in spec.fields)) continue;
			for (const doc of await this.listDocuments(typeName)) {
				const result = await this.lock.with(`${typeName}:${doc.id}`, () =>
					this.syncChildren(doc),
				);
				if (result) changed.push({ type: typeName, id: doc.id, ...result });
			}
		}
		return changed;
	}

	/** Ids of every document whose parent is `typeName:id`. */
	private async actualChildren(
		typeName: string,
		h: HierarchySpec,
		id: string,
	): Promise<string[]> {
		const out: string[] = [];
		for (const [t, spec] of Object.entries(this.config.types)) {
			const field = spec.fields[h.parent];
			if (field?.kind !== "ref" || !refCovers(field.ref, typeName)) continue;
			for (const d of await this.listDocuments(t)) {
				if (
					nonEmptyString(d.fields[h.parent]) === id &&
					!(t === typeName && d.id === id)
				) {
					out.push(d.id);
				}
			}
		}
		return out;
	}

	/** A caller-supplied `children` must be exactly the document's real
	 * children (order is the caller's): listing a stranger or dropping a real
	 * child would desync the relation. */
	private async checkChildren(
		typeName: string,
		h: HierarchySpec,
		id: string,
		supplied: unknown,
	): Promise<void> {
		if (!Array.isArray(supplied)) return; // materializeFields reports the shape error
		const actual = await this.actualChildren(typeName, h, id);
		const problems: string[] = [];
		for (const c of supplied) {
			if (!actual.includes(c as string)) {
				problems.push(
					`lists '${c}' as a child, but no such document has this one as its parent`,
				);
			}
		}
		for (const c of actual) {
			if (!supplied.includes(c)) {
				problems.push(
					`child '${c}' has this document as its parent but is not listed`,
				);
			}
		}
		if (new Set(supplied).size !== supplied.length)
			problems.push("lists a child twice");
		if (problems.length > 0) {
			throw new HierarchyError(
				"children-mismatch",
				typeName,
				id,
				`'${h.children}' cannot be written by hand: ${problems.join("; ")}`,
			);
		}
	}

	/** Everything that must hold for `typeName:id` to sit under `parentId`:
	 * the parent exists (unambiguously), the rules allow its type, no cycle,
	 * and `maxDepth` holds for the document and its whole subtree. Returns the
	 * parent. Throws before anything is written. */
	private async validateParentChange(
		typeName: string,
		type: TypeSpec,
		h: HierarchySpec,
		id: string,
		parentId: string,
		childFields: Record<string, unknown>,
	): Promise<BoardDocument> {
		const found = await this.findRef(
			(type.fields[h.parent] as RefField).ref,
			parentId,
		);
		if (found.length === 0) {
			throw new HierarchyError(
				"parent-not-found",
				typeName,
				id,
				`parent '${parentId}' does not exist`,
			);
		}
		if (found.length > 1) {
			throw new HierarchyError(
				"parent-ambiguous",
				typeName,
				id,
				`parent '${parentId}' exists in more than one type (${found.map((f) => f.type).join(", ")})`,
			);
		}
		const parent = found[0] as BoardDocument;
		if (!(h.children in this.typeOf(parent.type).fields)) {
			throw new HierarchyError(
				"parent-type-not-allowed",
				typeName,
				id,
				`type '${parent.type}' cannot have children`,
			);
		}
		if (h.rules) {
			const problem = parentRuleProblem(
				h.rules,
				{ type: typeName, fields: childFields },
				parent,
			);
			if (problem) {
				throw new HierarchyError(
					"parent-type-not-allowed",
					typeName,
					id,
					problem,
				);
			}
		}
		// Known limitation: this ancestor walk (and the descendant-height walk
		// below) reads documents that are NOT locked, so a three-way concurrent
		// re-parent race can slip a cycle/maxDepth violation past the planner;
		// `validate()` reports it afterwards.
		// Walk up from the new parent: it must not lead back to this document.
		let ancestors = 0;
		const seen = new Set<string>();
		let cur: BoardDocument | null = parent;
		while (cur) {
			if (cur.type === typeName && cur.id === id) {
				throw new HierarchyError(
					"cycle",
					typeName,
					id,
					`'${parentId}' is this document or one of its descendants; that would make a cycle`,
				);
			}
			const key = `${cur.type}:${cur.id}`;
			if (seen.has(key)) break; // a pre-existing cycle above; validate() reports it
			seen.add(key);
			ancestors++;
			const curType = this.typeOf(cur.type);
			const up = nonEmptyString(cur.fields[h.parent]);
			cur =
				up && h.parent in curType.fields
					? await this.uniqueRef(curType, h, up)
					: null;
		}
		if (h.maxDepth !== undefined) {
			const height = await this.subtreeHeight(typeName, h, id);
			if (ancestors + height > h.maxDepth) {
				throw new HierarchyError(
					"max-depth",
					typeName,
					id,
					`parent chain would be ${ancestors + height} deep (maxDepth is ${h.maxDepth})`,
				);
			}
		}
		return parent;
	}

	/** Longest descendant chain below `typeName:id` (0 for a leaf). */
	private async subtreeHeight(
		typeName: string,
		h: HierarchySpec,
		id: string,
		seen: Set<string> = new Set(),
	): Promise<number> {
		const key = `${typeName}:${id}`;
		if (seen.has(key)) return 0;
		seen.add(key);
		let best = 0;
		for (const t of Object.keys(this.config.types)) {
			if (!(h.parent in this.typeOf(t).fields)) continue;
			for (const d of await this.listDocuments(t)) {
				if (nonEmptyString(d.fields[h.parent]) !== id) continue;
				const ref = (this.typeOf(t).fields[h.parent] as RefField).ref;
				if (!refCovers(ref, typeName)) continue;
				best = Math.max(best, 1 + (await this.subtreeHeight(t, h, d.id, seen)));
			}
		}
		return best;
	}

	/** Structural validation only (required fields, enum membership, ref
	 * resolution, duplicate ids, acyclic fields, inherit sources exist) — never
	 * workflow/ordering correctness. See `board-tool-design.md`'s non-goals. */
	async validate(): Promise<ValidationIssue[]> {
		const issues: ValidationIssue[] = [];
		const byType = new Map<string, BoardDocument[]>();
		for (const [typeName, type] of Object.entries(this.config.types)) {
			const docs: BoardDocument[] = [];
			const seenIds = new Set<string>();
			for (const entry of await this.scan(type)) {
				const parsed = parseDocument(entry.raw, typeName, type);
				if (!parsed.ok) {
					issues.push({
						kind: "document",
						type: typeName,
						id: null,
						path: entry.path,
						message: parsed.reason,
					});
					continue;
				}
				if (seenIds.has(parsed.doc.id)) {
					issues.push({
						kind: "id",
						type: typeName,
						id: parsed.doc.id,
						path: entry.path,
						message: `duplicate id: another file already claims '${parsed.doc.id}'`,
					});
					continue;
				}
				seenIds.add(parsed.doc.id);
				if (
					type.id.strategy === "own-sequence" &&
					!idPattern(type.id.key, type.id.suffix).test(parsed.doc.id)
				) {
					issues.push({
						kind: "id",
						type: typeName,
						id: parsed.doc.id,
						path: entry.path,
						message: `id '${parsed.doc.id}' does not match its own-sequence grammar`,
					});
				}
				docs.push({
					type: typeName,
					id: parsed.doc.id,
					rev: parsed.doc.rev,
					fields: parsed.doc.fields,
					body: parsed.doc.body,
					path: entry.path,
					hash: sha256(entry.raw),
				});
			}
			byType.set(typeName, docs);
		}

		// Id spaces shared across types (or one type's own numbering): the same
		// id in two types, or one number spelled two ways, is ambiguous.
		const groups = new Map<string, string[]>();
		for (const [typeName, type] of Object.entries(this.config.types)) {
			if (type.id.strategy !== "own-sequence") continue;
			const g = type.id.sequence ? `s:${type.id.sequence}` : `t:${typeName}`;
			groups.set(g, [...(groups.get(g) ?? []), typeName]);
		}
		for (const members of groups.values()) {
			const seen = new Map<number, { type: string; doc: BoardDocument }>();
			for (const typeName of members) {
				const idSpec = this.config.types[typeName]?.id;
				if (idSpec?.strategy !== "own-sequence") continue;
				for (const doc of byType.get(typeName) ?? []) {
					const num = parseIdNum(idSpec.key, idSpec.suffix, doc.id);
					if (num === null) continue;
					const first = seen.get(num);
					if (!first) {
						seen.set(num, { type: typeName, doc });
						continue;
					}
					issues.push({
						kind: "id",
						type: typeName,
						id: doc.id,
						path: doc.path,
						message:
							first.doc.id === doc.id
								? `duplicate id: ${first.type} '${first.doc.id}' already claims '${doc.id}'`
								: `id '${doc.id}' has the same number as ${first.type} '${first.doc.id}'`,
					});
				}
			}
		}

		const idsOf = (typeName: string) =>
			new Set((byType.get(typeName) ?? []).map((d) => d.id));

		for (const [typeName, type] of Object.entries(this.config.types)) {
			if (type.id.strategy === "inherit") {
				const sourceIds = idsOf(type.id.from);
				for (const doc of byType.get(typeName) ?? []) {
					if (!sourceIds.has(doc.id)) {
						issues.push({
							kind: "id",
							type: typeName,
							id: doc.id,
							path: doc.path,
							message: `inherits its id from '${type.id.from}', but no such '${type.id.from}' exists`,
						});
					}
				}
			}
			for (const [fieldName, field] of Object.entries(type.fields)) {
				if (field.kind !== "ref") continue;
				const targetTypes = field.ref === "any" ? null : field.ref;
				for (const doc of byType.get(typeName) ?? []) {
					const raw = doc.fields[fieldName];
					const refs = field.list
						? ((raw as string[] | undefined) ?? [])
						: raw
							? [raw as string]
							: [];
					for (const ref of refs) {
						if (targetTypes && !targetTypes.some((t) => idsOf(t).has(ref))) {
							issues.push({
								kind: "reference",
								type: typeName,
								id: doc.id,
								path: doc.path,
								message: `field '${fieldName}' references unknown ${(targetTypes as readonly string[]).join("/")} '${ref}'`,
							});
						}
					}
				}
				if (field.acyclic) {
					issues.push(
						...findCycles(typeName, fieldName, byType.get(typeName) ?? []),
					);
				}
			}
		}
		issues.push(...this.hierarchyIssues(byType));
		return issues;
	}

	private hierarchyIssues(
		byType: Map<string, BoardDocument[]>,
	): ValidationIssue[] {
		const h = this.config.hierarchy;
		if (!h) return [];
		const issues: ValidationIssue[] = [];
		const lookup = (ref: "any" | readonly string[], id: string) =>
			this.candidateTypes(ref).flatMap((t) =>
				(byType.get(t) ?? []).filter((d) => d.id === id),
			);
		const participates = (t: string) => h.parent in this.typeOf(t).fields;
		const parentRef = (t: string) =>
			(this.typeOf(t).fields[h.parent] as RefField).ref;
		const childrenRef = (t: string) =>
			(this.typeOf(t).fields[h.children] as RefField).ref;
		const issue = (d: BoardDocument, message: string) =>
			issues.push({
				kind: "hierarchy",
				type: d.type,
				id: d.id,
				path: d.path,
				message,
			});

		for (const [typeName, docs] of byType) {
			if (!participates(typeName)) continue;
			for (const d of docs) {
				const parentId = nonEmptyString(d.fields[h.parent]);
				if (parentId) {
					const found = lookup(parentRef(typeName), parentId);
					if (found.length > 1) {
						issue(
							d,
							`parent '${parentId}' is ambiguous: it exists in ${found.map((f) => f.type).join(", ")}`,
						);
					} else if (found.length === 1) {
						const p = found[0] as BoardDocument;
						const listed = (p.fields[h.children] as string[] | undefined) ?? [];
						if (!(h.children in this.typeOf(p.type).fields)) {
							issue(
								d,
								`parent '${parentId}' is a '${p.type}', which has no '${h.children}' field`,
							);
						} else if (!listed.includes(d.id)) {
							issue(
								d,
								`names '${parentId}' as its ${h.parent}, but '${parentId}' does not list it in '${h.children}'`,
							);
						}
						if (h.rules) {
							const problem = parentRuleProblem(h.rules, d, p);
							if (problem) issue(d, problem);
						}
					}
				}
				for (const childId of (d.fields[h.children] as string[] | undefined) ??
					[]) {
					const found = lookup(childrenRef(typeName), childId);
					if (found.length !== 1) continue; // unknown: the ref check reports it
					const c = found[0] as BoardDocument;
					if (!participates(c.type)) {
						issue(
							d,
							`lists child '${childId}', a '${c.type}', which has no '${h.parent}' field`,
						);
					} else if (nonEmptyString(c.fields[h.parent]) !== d.id) {
						issue(
							d,
							`lists '${childId}' in '${h.children}', but its ${h.parent} is ${nonEmptyString(c.fields[h.parent]) ? `'${nonEmptyString(c.fields[h.parent])}'` : "unset"}`,
						);
					}
				}
				// Walk the parent chain: cycle, then depth.
				const chain = [`${d.type}:${d.id}`];
				let cur: BoardDocument = d;
				let cyclic = false;
				for (;;) {
					const up = participates(cur.type)
						? nonEmptyString(cur.fields[h.parent])
						: null;
					const found = up ? lookup(parentRef(cur.type), up) : [];
					if (found.length !== 1) break;
					const next = found[0] as BoardDocument;
					const key = `${next.type}:${next.id}`;
					if (key === chain[0]) {
						cyclic = true;
						issue(
							d,
							`${h.parent} chain has a cycle: ${[...chain, key].join(" → ")}`,
						);
						break;
					}
					if (chain.includes(key)) break; // leads into a cycle it is not part of
					chain.push(key);
					cur = next;
				}
				if (
					!cyclic &&
					h.maxDepth !== undefined &&
					chain.length - 1 > h.maxDepth
				) {
					issue(
						d,
						`${h.parent} chain is ${chain.length - 1} deep, over maxDepth ${h.maxDepth}`,
					);
				}
			}
		}
		return issues;
	}
}

function nonEmptyString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function findCycles(
	typeName: string,
	fieldName: string,
	docs: readonly BoardDocument[],
): ValidationIssue[] {
	const adjacency = new Map<string, string[]>();
	const byId = new Map(docs.map((d) => [d.id, d] as const));
	for (const doc of docs) {
		adjacency.set(
			doc.id,
			(doc.fields[fieldName] as string[] | undefined) ?? [],
		);
	}
	const state = new Map<string, "visiting" | "done">();
	const issues: ValidationIssue[] = [];
	const visit = (id: string, path: string[]): void => {
		const s = state.get(id);
		if (s === "done") return;
		if (s === "visiting") {
			const cycle = [...path.slice(path.indexOf(id)), id].join(" → ");
			const doc = byId.get(id);
			if (doc) {
				issues.push({
					kind: "cycle",
					type: typeName,
					id,
					path: doc.path,
					message: `field '${fieldName}' has a cycle: ${cycle}`,
				});
			}
			return;
		}
		state.set(id, "visiting");
		for (const next of adjacency.get(id) ?? []) visit(next, [...path, id]);
		state.set(id, "done");
	};
	for (const doc of docs) visit(doc.id, []);
	return issues;
}
