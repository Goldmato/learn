import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export interface MasteryConceptDefinition {
	id: string;
	name: string;
	subjectPath: string[];
	definition: string;
	aliases: string[];
	parentId?: string;
	mergedInto?: string;
}

export interface MasteryConceptCatalog {
	version: 1;
	concepts: MasteryConceptDefinition[];
}

export interface MasteryConceptSearchResult {
	total: number;
	concepts: MasteryConceptDefinition[];
}

export interface MasteryConceptCandidate {
	id: string;
	name: string;
	subjectPath: string[];
	aliases: string[];
	definition?: string;
	parentId?: string;
	mergedInto?: string;
	notePaths: string[];
	score: number;
	matchedOn: string[];
}

const CATALOG_FILENAME = "mastery-concepts.json";
const CONCEPT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 160;
const MAX_DEFINITION_LENGTH = 2000;
const MAX_SUBJECT_DEPTH = 8;
const MAX_ALIASES = 30;

function assertOnlyKeys(input: Record<string, unknown>, allowed: string[], label: string): void {
	const unsupported = Object.keys(input).find((key) => !allowed.includes(key));
	if (unsupported) throw new Error(`${label} contains unsupported field "${unsupported}".`);
}

export function masteryConceptCatalogPath(vaultRoot: string): string {
	return path.join(vaultRoot, CATALOG_FILENAME);
}

function nonEmptyString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`Mastery concept ${field} must be a string.`);
	const normalized = value.trim();
	if (!normalized) throw new Error(`Mastery concept ${field} must contain non-whitespace text.`);
	if (normalized.length > maxLength) throw new Error(`Mastery concept ${field} must not exceed ${maxLength} characters.`);
	return normalized;
}

function parseConcept(value: unknown): MasteryConceptDefinition {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Mastery concept entries must be objects.");
	}
	const input = value as Record<string, unknown>;
	assertOnlyKeys(input, ["id", "name", "subjectPath", "definition", "aliases", "parentId", "mergedInto"], "Mastery concept");
	const id = nonEmptyString(input.id, "id", 100);
	if (!CONCEPT_ID_PATTERN.test(id)) throw new Error(`Mastery concept ID "${id}" must use lowercase kebab-case.`);
	const name = nonEmptyString(input.name, "name", MAX_NAME_LENGTH);
	const definition = nonEmptyString(input.definition, "definition", MAX_DEFINITION_LENGTH);
	if (!Array.isArray(input.subjectPath) || input.subjectPath.length < 1 || input.subjectPath.length > MAX_SUBJECT_DEPTH) {
		throw new Error(`Mastery concept "${id}" subjectPath must contain 1 to ${MAX_SUBJECT_DEPTH} segments.`);
	}
	const subjectPath = input.subjectPath.map((segment, index) =>
		nonEmptyString(segment, `subjectPath[${index}]`, MAX_NAME_LENGTH),
	);
	if (input.aliases !== undefined && (!Array.isArray(input.aliases) || input.aliases.length > MAX_ALIASES)) {
		throw new Error(`Mastery concept "${id}" aliases must contain at most ${MAX_ALIASES} strings.`);
	}
	const aliases = (input.aliases ?? []).map((alias, index) =>
		nonEmptyString(alias, `aliases[${index}]`, MAX_NAME_LENGTH),
	);
	const uniqueAliases = new Set(aliases.map((alias) => alias.toLocaleLowerCase()));
	if (uniqueAliases.size !== aliases.length) throw new Error(`Mastery concept "${id}" contains duplicate aliases.`);
	const parentId = input.parentId === undefined
		? undefined
		: nonEmptyString(input.parentId, "parentId", 100);
	if (parentId && !CONCEPT_ID_PATTERN.test(parentId)) {
		throw new Error(`Mastery concept "${id}" parentId must use lowercase kebab-case.`);
	}
	const mergedInto = input.mergedInto === undefined
		? undefined
		: nonEmptyString(input.mergedInto, "mergedInto", 100);
	if (mergedInto && (!CONCEPT_ID_PATTERN.test(mergedInto) || mergedInto === id)) {
		throw new Error(`Mastery concept "${id}" mergedInto must be a different lowercase kebab-case ID.`);
	}
	return { id, name, subjectPath, definition, aliases, parentId, mergedInto };
}

function validateCatalog(value: unknown): MasteryConceptCatalog {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Mastery concept catalogue must be a JSON object.");
	}
	const input = value as Record<string, unknown>;
	assertOnlyKeys(input, ["version", "concepts"], "Mastery concept catalogue");
	if (input.version !== 1) throw new Error("Unsupported mastery concept catalogue version.");
	if (!Array.isArray(input.concepts)) throw new Error("Mastery concept catalogue must contain a concepts array.");
	const concepts = input.concepts.map(parseConcept);
	const byId = new Map<string, MasteryConceptDefinition>();
	for (const concept of concepts) {
		if (byId.has(concept.id)) throw new Error(`Mastery concept catalogue repeats ID "${concept.id}".`);
		byId.set(concept.id, concept);
	}
	for (const concept of concepts) {
		if (concept.parentId && !byId.has(concept.parentId)) {
			throw new Error(`Mastery concept "${concept.id}" refers to missing parent "${concept.parentId}".`);
		}
		if (concept.mergedInto && !byId.has(concept.mergedInto)) {
			throw new Error(`Mastery concept "${concept.id}" refers to missing merge target "${concept.mergedInto}".`);
		}
		const visited = new Set([concept.id]);
		let parentId = concept.parentId;
		while (parentId) {
			if (visited.has(parentId)) throw new Error(`Mastery concept hierarchy contains a cycle at "${parentId}".`);
			visited.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
		const mergeTargets = new Set([concept.id]);
		let mergedInto = concept.mergedInto;
		while (mergedInto) {
			if (mergeTargets.has(mergedInto)) throw new Error(`Mastery concept merge hierarchy contains a cycle at "${mergedInto}".`);
			mergeTargets.add(mergedInto);
			mergedInto = byId.get(mergedInto)?.mergedInto;
		}
	}
	return { version: 1, concepts };
}

export function readMasteryConceptCatalog(vaultRoot: string): MasteryConceptCatalog {
	const catalogPath = masteryConceptCatalogPath(vaultRoot);
	if (!fs.existsSync(catalogPath)) return { version: 1, concepts: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
	} catch (error) {
		throw new Error(`Could not read mastery concept catalogue "${catalogPath}": ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return validateCatalog(parsed);
	} catch (error) {
		throw new Error(`Invalid mastery concept catalogue "${catalogPath}": ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writeMasteryConceptCatalog(vaultRoot: string, catalog: MasteryConceptCatalog): void {
	const validated = validateCatalog(catalog);
	const catalogPath = masteryConceptCatalogPath(vaultRoot);
	const temporaryPath = `${catalogPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, "\t")}\n`, { flag: "wx" });
		fs.renameSync(temporaryPath, catalogPath);
	} catch (error) {
		if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
		throw new Error(`Could not write mastery concept catalogue "${catalogPath}": ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function registerMasteryConcept(
	vaultRoot: string,
	value: unknown,
): { catalog: MasteryConceptCatalog; concept: MasteryConceptDefinition } {
	const concept = parseConcept(value);
	const catalog = readMasteryConceptCatalog(vaultRoot);
	if (catalog.concepts.some((existing) => existing.id === concept.id)) {
		throw new Error(`Mastery concept "${concept.id}" is already registered; existing catalogue entries are not overwritten.`);
	}
	if (concept.parentId) {
		const parent = catalog.concepts.find((existing) => existing.id === concept.parentId);
		if (!parent) throw new Error(`Mastery concept parent "${concept.parentId}" must be registered before "${concept.id}".`);
		if (parent.mergedInto) throw new Error(`Mastery concept parent "${concept.parentId}" is retired; use "${parent.mergedInto}".`);
	}
	const updated = validateCatalog({ version: 1, concepts: [...catalog.concepts, concept] });
	writeMasteryConceptCatalog(vaultRoot, updated);
	return { catalog: updated, concept };
}

export function searchMasteryConceptCatalog(
	catalog: MasteryConceptCatalog,
	query = "",
	limit = 100,
): MasteryConceptSearchResult {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("Mastery concept catalogue search limit must be an integer from 1 to 1000.");
	}
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const matches = catalog.concepts
		.filter((concept) => !normalizedQuery || [
			concept.id,
			concept.name,
			concept.definition,
			...concept.subjectPath,
			...concept.aliases,
		].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
		.sort((left, right) => left.id.localeCompare(right.id));
	return { total: matches.length, concepts: matches.slice(0, limit) };
}

function normalizeSearchText(value: string): string {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function searchTokens(value: string): Set<string> {
	return new Set(normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? []);
}

function scoreSearchField(query: string, field: string, exactScore: number, phraseScore: number): number {
	const normalizedQuery = normalizeSearchText(query).trim();
	const normalizedField = normalizeSearchText(field).trim();
	if (!normalizedQuery || !normalizedField) return 0;
	if (normalizedQuery === normalizedField) return exactScore;
	if (normalizedField.includes(normalizedQuery)) return phraseScore;

	const queryTokens = searchTokens(normalizedQuery);
	const fieldTokens = searchTokens(normalizedField);
	if (queryTokens.size === 0 || fieldTokens.size === 0) return 0;
	const overlap = [...queryTokens].filter((token) => fieldTokens.has(token)).length;
	if (overlap === 0) return 0;
	return Math.round(35 * overlap / queryTokens.size);
}

export function rankMasteryConceptCandidates(
	query: string,
	catalog: MasteryConceptCatalog,
	masteryEntries: Array<{ id: string; notePaths: string[] }>,
	limit = 20,
): MasteryConceptCandidate[] {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new Error("Mastery concept candidate limit must be an integer from 1 to 1000.");
	}
	const entries = new Map<string, { concept?: MasteryConceptDefinition; notePaths: Set<string> }>();
	for (const concept of catalog.concepts) entries.set(concept.id, { concept, notePaths: new Set() });
	for (const mastery of masteryEntries) {
		const entry = entries.get(mastery.id) ?? { notePaths: new Set<string>() };
		for (const notePath of mastery.notePaths) entry.notePaths.add(notePath);
		entries.set(mastery.id, entry);
	}

	const normalizedQuery = query.trim();
	const candidates = [...entries].flatMap(([id, entry]) => {
		const concept = entry.concept;
		const fields: Array<{ label: string; value: string; exact: number; phrase: number }> = [
			{ label: "ID", value: id, exact: 100, phrase: 75 },
		];
		if (concept) {
			fields.push(
				{ label: "canonical name", value: concept.name, exact: 100, phrase: 90 },
				{ label: "definition", value: concept.definition, exact: 70, phrase: 65 },
				...concept.aliases.map((alias) => ({ label: `alias: ${alias}`, value: alias, exact: 100, phrase: 90 })),
				...concept.subjectPath.map((segment, index) => ({
					label: `subject: ${concept.subjectPath.slice(0, index + 1).join(" / ")}`,
					value: segment,
					exact: 95,
					phrase: 80,
				})),
			);
		}
		for (const notePath of entry.notePaths) {
			fields.push(
				{ label: "note path", value: notePath, exact: 65, phrase: 50 },
				{ label: "note title", value: notePath.split(/[\\/]/).at(-1)?.replace(/\.[^.]+$/, "") ?? "", exact: 80, phrase: 70 },
			);
		}
		const scored = fields
			.map((field) => ({ label: field.label, score: scoreSearchField(normalizedQuery, field.value, field.exact, field.phrase) }))
			.filter((field) => field.score > 0)
			.sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
		if (normalizedQuery && scored.length === 0) return [];
		return [{
			id,
			name: concept?.name ?? id,
			subjectPath: concept?.subjectPath ?? [],
			aliases: concept?.aliases ?? [],
			definition: concept?.definition,
			parentId: concept?.parentId,
			mergedInto: concept?.mergedInto,
			notePaths: [...entry.notePaths].sort((left, right) => left.localeCompare(right)),
			score: scored[0]?.score ?? 0,
			matchedOn: scored.map(({ label }) => label),
		}];
	});
	return candidates
		.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
		.slice(0, limit);
}

export function resolveMasteryConceptId(catalog: MasteryConceptCatalog, conceptId: string): string {
	const concepts = new Map(catalog.concepts.map((concept) => [concept.id, concept]));
	const visited = new Set<string>();
	let currentId = conceptId;
	while (true) {
		if (visited.has(currentId)) throw new Error(`Mastery concept merge hierarchy contains a cycle at "${currentId}".`);
		visited.add(currentId);
		const nextId = concepts.get(currentId)?.mergedInto;
		if (!nextId) return currentId;
		currentId = nextId;
	}
}

export function mergeMasteryConceptCatalogEntries(
	catalog: MasteryConceptCatalog,
	sourceId: string,
	canonicalId: string,
): MasteryConceptCatalog {
	if (sourceId === canonicalId) throw new Error("Source and canonical mastery concept IDs must differ.");
	const source = catalog.concepts.find((concept) => concept.id === sourceId);
	const canonical = catalog.concepts.find((concept) => concept.id === canonicalId);
	if (!source || !canonical) throw new Error("Both concepts must be registered before they can be merged.");
	if (source.mergedInto) throw new Error(`Mastery concept "${sourceId}" is already merged into "${source.mergedInto}".`);
	if (canonical.mergedInto) throw new Error(`Canonical mastery concept "${canonicalId}" is itself merged; use its canonical ID.`);

	const aliases = [...new Map([...(canonical.aliases ?? []), source.name, ...source.aliases]
		.filter((alias) => alias.toLocaleLowerCase() !== canonical.name.toLocaleLowerCase())
		.map((alias) => [alias.toLocaleLowerCase(), alias])).values()];
	if (aliases.length > MAX_ALIASES) throw new Error(`Merging "${sourceId}" would exceed the ${MAX_ALIASES}-alias limit.`);
	const concepts = catalog.concepts.map((concept) => {
		if (concept.id === sourceId) return { ...concept, mergedInto: canonicalId };
		if (concept.id === canonicalId) {
			return {
				...concept,
				aliases,
				parentId: concept.parentId === sourceId ? source.parentId : concept.parentId,
			};
		}
		if (concept.parentId === sourceId) return { ...concept, parentId: canonicalId };
		return concept;
	});
	return validateCatalog({ version: 1, concepts });
}
