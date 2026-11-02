import * as fs from "node:fs";
import * as path from "node:path";
import {
	readMasteryFrontmatter,
	updateMasteryFrontmatter,
	removeMasteryFrontmatter,
	type MasteryEvidence,
	type MasteryRecord,
} from "./teach-learning-state.ts";
import {
	appendMasteryEvidenceSample,
	mergeMasteryEvidenceEvents,
	masteryEvidenceStorePath,
	readMasteryEvidenceStore,
	replayMasteryEvidence,
	type MasteryEvidenceStore,
	type MasteryEvidenceSample,
} from "./mastery-evidence.ts";
import {
	mergeMasteryConceptCatalogEntries,
	rankMasteryConceptCandidates,
	readMasteryConceptCatalog,
	type MasteryConceptCandidate,
} from "./mastery-concepts.ts";
import { createHash, randomUUID } from "node:crypto";

const SKIPPED_DIRECTORY_NAMES = new Set([".obsidian", ".git", ".pi", ".trash", "node_modules"]);

export interface MasteryVaultNote {
	filePath: string;
	relativePath: string;
	linkTarget: string;
	title: string;
	mastery: Map<string, MasteryRecord>;
}

export interface MasteryVaultScan {
	notes: MasteryVaultNote[];
	diagnostics: string[];
}

export interface PersistedMasteryEvidence extends MasteryEvidence {
	conceptId: string;
	evidenceType: "quiz" | "free_response";
	outcome: "correct" | "partial" | "incorrect";
	recordedAt: number;
}

export function findVaultRootForNote(notePath: string): string {
	const realNotePath = fs.realpathSync(notePath);
	if (!fs.statSync(realNotePath).isFile()) throw new Error(`Linked md-log path is not a file: ${notePath}`);
	let directory = path.dirname(realNotePath);
	while (true) {
		const marker = path.join(directory, ".obsidian");
		if (fs.existsSync(marker)) {
			if (!fs.statSync(marker).isDirectory()) throw new Error(`Obsidian marker is not a directory: ${marker}`);
			return directory;
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Could not locate an Obsidian vault root above linked note: ${notePath}`);
}

function frontmatterBounds(markdown: string): { start: number; end: number } | undefined {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
	if (!match) return undefined;
	const start = /^---[ \t]*\r?\n/.exec(markdown)?.[0].length ?? 0;
	const end = /\r?\n---[ \t]*(?:\r?\n|$)$/.exec(match[0])?.index ?? match[0].length;
	return { start, end: start + end };
}

function propertyTitle(markdown: string): string | undefined {
	const bounds = frontmatterBounds(markdown);
	if (!bounds) return undefined;
	const match = /^title:[ \t]*(.*)$/m.exec(markdown.slice(bounds.start, bounds.end));
	if (!match) return undefined;
	const value = match[1].trim();
	if (!value) return undefined;
	if (value.startsWith('"')) {
		try {
			const decoded: unknown = JSON.parse(value);
			return typeof decoded === "string" ? decoded : undefined;
		} catch {
			return undefined;
		}
	}
	return value.replace(/^['"]|['"]$/g, "");
}

function wikilinkTarget(relativePath: string): string {
	return relativePath
		.replace(/\.[^.]+$/, "")
		.replace(/\\/g, "/")
		.replace(/\]/g, "%5D")
		.replace(/\|/g, "%7C");
}

export function scanVaultMastery(vaultRoot: string): MasteryVaultScan {
	const root = fs.realpathSync(vaultRoot);
	if (!fs.statSync(root).isDirectory()) throw new Error(`Vault root is not a directory: ${vaultRoot}`);
	const markdownFiles: string[] = [];
	const diagnostics: string[] = [];

	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) visit(entryPath);
			} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
				markdownFiles.push(entryPath);
			}
		}
	};
	visit(root);

	const notes: MasteryVaultNote[] = [];
	for (const filePath of markdownFiles.sort((left, right) => left.localeCompare(right))) {
		try {
			const markdown = fs.readFileSync(filePath, "utf-8");
			const mastery = readMasteryFrontmatter(markdown);
			if (mastery.size === 0) continue;
			const relativePath = path.relative(root, filePath);
			notes.push({
				filePath,
				relativePath,
				linkTarget: wikilinkTarget(relativePath),
				title: propertyTitle(markdown) || path.basename(filePath, path.extname(filePath)),
				mastery,
			});
		} catch (error) {
			diagnostics.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { notes, diagnostics };
}

export function findRelatedMasteryNotes(
	scan: MasteryVaultScan,
	filePath: string,
): { current?: MasteryVaultNote; related: MasteryVaultNote[] } {
	const current = scan.notes.find((note) => path.resolve(note.filePath) === path.resolve(filePath));
	if (!current) return { related: [] };
	const conceptIds = new Set(current.mastery.keys());
	const related = scan.notes.filter((note) =>
		path.resolve(note.filePath) !== path.resolve(filePath) &&
		[...note.mastery.keys()].some((conceptId) => conceptIds.has(conceptId)),
	);
	return { current, related };
}

export function searchVaultMastery(
	scan: MasteryVaultScan,
	query = "",
	limit = 100,
): { total: number; concepts: Array<{ conceptId: string; notes: Array<{ title: string; path: string; record: MasteryRecord }> }>; diagnostics: string[] } {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Mastery search limit must be an integer from 1 to 1000.");
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const concepts = new Map<string, Array<{ title: string; path: string; record: MasteryRecord }>>();
	for (const note of scan.notes) {
		for (const [conceptId, record] of note.mastery) {
			if (normalizedQuery && ![conceptId, note.title, note.relativePath].some((value) =>
				value.toLocaleLowerCase().includes(normalizedQuery),
			)) continue;
			const matches = concepts.get(conceptId) ?? [];
			matches.push({ title: note.title, path: note.relativePath, record });
			concepts.set(conceptId, matches);
		}
	}
	const allMatches = [...concepts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([conceptId, notes]) => ({ conceptId, notes }));
	return { total: allMatches.length, concepts: allMatches.slice(0, limit), diagnostics: scan.diagnostics };
}

export function searchVaultMasteryCandidates(
	scan: MasteryVaultScan,
	vaultRoot: string,
	query: string,
	limit = 20,
): MasteryConceptCandidate[] {
	const catalog = readMasteryConceptCatalog(vaultRoot);
	const masteryEntries = new Map<string, Set<string>>();
	for (const note of scan.notes) {
		for (const conceptId of note.mastery.keys()) {
			const paths = masteryEntries.get(conceptId) ?? new Set<string>();
			paths.add(note.relativePath);
			masteryEntries.set(conceptId, paths);
		}
	}
	return rankMasteryConceptCandidates(query, catalog, [...masteryEntries].map(([id, notePaths]) => ({
		id,
		notePaths: [...notePaths],
	})), limit);
}

function parseRelatedValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error("Unsupported inline `related` frontmatter; expected a YAML list of quoted wikilinks.");
		}
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
			throw new Error("Unsupported inline `related` frontmatter; expected a list of strings.");
		}
		return parsed;
	}
	if (trimmed.startsWith('"')) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error("Invalid quoted `related` frontmatter value.");
		}
		if (typeof parsed !== "string") throw new Error("Unsupported `related` frontmatter value.");
		return [parsed];
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return [trimmed.slice(1, -1).replace(/''/g, "'")];
	if (trimmed.startsWith("[[")) return [trimmed];
	throw new Error("Unsupported `related` frontmatter; refusing to replace an unrecognized value.");
}

export function updateRelatedFrontmatter(markdown: string, linkTargets: string[]): string {
	const uniqueTargets = [...new Set(linkTargets)].sort((left, right) => left.localeCompare(right));
	if (uniqueTargets.length === 0) return markdown;
	const bounds = frontmatterBounds(markdown);
	const links = uniqueTargets.map((target) => `[[${target}]]`);
	if (!bounds) {
		const lines = links.map((link) => `  - ${JSON.stringify(link)}`).join("\n");
		return `---\nrelated:\n${lines}\n---\n\n${markdown}`;
	}

	const frontmatter = markdown.slice(bounds.start, bounds.end);
	const lines = frontmatter.split(/\r?\n/);
	const relatedIndex = lines.findIndex((line) => /^related:[ \t]*/.test(line));
	const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
	let outputLines: string[];
	if (relatedIndex < 0) {
		const rendered = ["related:", ...links.map((link) => `  - ${JSON.stringify(link)}`)];
		outputLines = [...lines, ...rendered];
	} else {
		const endIndex = lines.findIndex((line, index) =>
			index > relatedIndex && line.length > 0 && !/^[ \t]/.test(line),
		);
		const end = endIndex < 0 ? lines.length : endIndex;
		const header = /^related:[ \t]*(.*)$/.exec(lines[relatedIndex]);
		if (!header) throw new Error("Invalid `related` frontmatter.");
		const existing = parseRelatedValue(header[1]);
		for (const line of lines.slice(relatedIndex + 1, end)) {
			if (!line.trim()) continue;
			const item = /^[ \t]+-[ \t]*(.*)$/.exec(line);
			if (!item) throw new Error("Unsupported `related` frontmatter list; refusing to replace it.");
			existing.push(...parseRelatedValue(item[1]));
		}
		const merged = [...new Set([...existing, ...links])].sort((left, right) => left.localeCompare(right));
		outputLines = [
			...lines.slice(0, relatedIndex),
			"related:",
			...merged.map((link) => `  - ${JSON.stringify(link)}`),
			...lines.slice(end),
		];
	}
	const updatedFrontmatter = outputLines.join(newline);
	return `${markdown.slice(0, bounds.start)}${updatedFrontmatter}${markdown.slice(bounds.end)}`;
}

function sameMasteryRecord(left: MasteryRecord, right: MasteryRecord): boolean {
	return left.score === right.score &&
		left.evidenceCount === right.evidenceCount &&
		left.evidenceWeight === right.evidenceWeight &&
		left.evidenceSum === right.evidenceSum &&
		left.lastInteractionId === right.lastInteractionId &&
		left.confidence === right.confidence &&
		left.reasoningSummary === right.reasoningSummary;
}

/**
 * Legacy notes may carry an HTML evidence block written by an earlier version. The
 * frontmatter is the only mastery store, so strip every such block (including
 * duplicates) and any blank lines it leaves behind. Prose is never touched.
 */
export function stripLegacyMasteryEvidence(markdown: string): string {
	const blockPattern = /<!-- pi-mastery-evidence:start v1 -->[\s\S]*?<!-- pi-mastery-evidence:end v1 -->[ \t]*\r?\n?/g;
	const stripped = markdown.replace(blockPattern, "");
	if (stripped === markdown) return markdown;
	return stripped.replace(/\n{3,}/g, "\n\n");
}

export function syncMasteryAcrossVault(
	vaultRoot: string,
	currentNotePath: string,
	conceptId: string,
	options: {
		previousRecord?: MasteryRecord;
		nextRecord?: MasteryRecord;
		evidence?: PersistedMasteryEvidence;
	} = {},
): { record: MasteryRecord; previousRecord?: MasteryRecord; files: string[]; evidenceCount: number } {
	if (!conceptId.trim()) throw new Error("conceptId must contain non-whitespace text.");
	const root = fs.realpathSync(vaultRoot);
	const scan = scanVaultMastery(vaultRoot);
	if (scan.diagnostics.length > 0) {
		throw new Error(`Could not safely scan mastery notes: ${scan.diagnostics.join("; ")}`);
	}
	const currentPath = fs.realpathSync(currentNotePath);
	const relativeCurrentPath = path.relative(root, currentPath);
	if (relativeCurrentPath.startsWith(`..${path.sep}`) || relativeCurrentPath === ".." || path.isAbsolute(relativeCurrentPath)) {
		throw new Error(`Linked mastery note is outside the Obsidian vault: ${currentNotePath}`);
	}
	const matchingNotes = scan.notes.filter((note) => note.mastery.has(conceptId));
	if (!matchingNotes.some((note) => path.resolve(note.filePath) === currentPath)) {
		const markdown = fs.readFileSync(currentPath, "utf-8");
		matchingNotes.push({
			filePath: currentPath,
			relativePath: relativeCurrentPath,
			linkTarget: wikilinkTarget(relativeCurrentPath),
			title: propertyTitle(markdown) || path.basename(currentPath, path.extname(currentPath)),
			mastery: readMasteryFrontmatter(markdown),
		});
	}
	if (matchingNotes.length === 0) throw new Error(`No linked note found for mastery concept "${conceptId}".`);

	const documents = matchingNotes.map((note) => {
		const markdown = fs.readFileSync(note.filePath, "utf-8");
		return { note, markdown, record: readMasteryFrontmatter(markdown).get(conceptId) };
	});
	const records = documents.flatMap((document) => document.record ? [document.record] : []);
	const evidenceStorePath = masteryEvidenceStorePath(root);
	let evidenceStore = readMasteryEvidenceStore(root);
	let conceptEvents = evidenceStore.events.filter((event) => event.conceptId === conceptId);
	const hasStoredEvidence = conceptEvents.length > 0;
	if (!hasStoredEvidence) {
		const sameRecords = records.length === 0 || records.every((record) => sameMasteryRecord(record, records[0]));
		if (!sameRecords) {
			throw new Error(
				`Mastery records for "${conceptId}" differ between linked notes, and no event history can reconcile them. No note was changed.`,
			);
		}
		if (records[0]) {
			conceptEvents = [{
				kind: "baseline",
				conceptId,
				record: records[0],
				recordedAt: 0,
			}];
		}
	}
	const base = hasStoredEvidence ? replayMasteryEvidence(conceptEvents, conceptId) : records[0];
	let record: MasteryRecord;
	if (options.evidence) {
		if (base && options.previousRecord && !sameMasteryRecord(base, options.previousRecord)) {
			throw new Error(`Mastery history for "${conceptId}" changed before the evidence could be synchronized; no evidence was added.`);
		}
		const sample: Omit<MasteryEvidenceSample, "kind"> = {
			conceptId,
			interactionId: options.evidence.interactionId,
			evidenceType: options.evidence.evidenceType ?? "free_response",
			outcome: options.evidence.outcome ?? "partial",
			score: options.evidence.score,
			confidence: options.evidence.confidence,
			reasoningSummary: options.evidence.reasoningSummary?.trim() || undefined,
			recordedAt: options.evidence.recordedAt,
		};
		evidenceStore = appendMasteryEvidenceSample(
			{
				version: 1,
				events: hasStoredEvidence ? evidenceStore.events : [...evidenceStore.events, ...conceptEvents],
			},
			sample,
		);
		conceptEvents = evidenceStore.events.filter((event) => event.conceptId === conceptId);
		record = replayMasteryEvidence(conceptEvents, conceptId)!;
		if (options.nextRecord && !sameMasteryRecord(record, options.nextRecord)) {
			throw new Error(`Replayed mastery evidence for "${conceptId}" differs from the session projection; no note was changed.`);
		}
	} else {
		if (!base) throw new Error(`No mastery record exists for "${conceptId}" in the linked notes.`);
		record = base;
	}

	const targets = matchingNotes.map((note) => note.linkTarget);
	const staged = documents.map(({ note, markdown }) => {
		let updated = stripLegacyMasteryEvidence(markdown);
		updated = updateMasteryFrontmatter(updated, conceptId, record);
		const projected = readMasteryFrontmatter(updated).get(conceptId);
		if (!projected || !sameMasteryRecord(projected, record)) {
			throw new Error(`Could not safely project replayed mastery for "${conceptId}" to "${note.relativePath}". No note was changed.`);
		}
		updated = updateRelatedFrontmatter(updated, targets.filter((target) => target !== note.linkTarget));
		return { filePath: note.filePath, updated, original: markdown };
	});
	const filesToCommit = [
		...(options.evidence || (!hasStoredEvidence && conceptEvents.length > 0)
			? [{ filePath: evidenceStorePath, contents: `${JSON.stringify(evidenceStore, null, "\t")}\n` }]
			: []),
		...staged
			.filter((item) => item.updated !== item.original)
			.map(({ filePath, updated }) => ({ filePath, contents: updated })),
	];
	commitStagedTextFiles(filesToCommit);
	return {
		record,
		previousRecord: base,
		files: staged.filter((item) => item.updated !== item.original).map((item) => item.filePath),
		evidenceCount: record.evidenceCount,
	};
}

export interface MasteryConceptMergePreview {
	sourceId: string;
	canonicalId: string;
	canMerge: boolean;
	previewToken: string;
	affectedNotePaths: string[];
	sourceEvidenceCount: number;
	canonicalEvidenceCount: number;
	mergedEvidenceCount: number;
	resultingMastery?: MasteryRecord;
	blockers: string[];
}

function hashMergeInputs(
	catalogPath: string,
	evidencePath: string,
	documents: Array<{ filePath: string; markdown: string }>,
): string {
	const hash = createHash("sha256");
	for (const filePath of [catalogPath, evidencePath]) {
		hash.update(filePath);
		hash.update(fs.existsSync(filePath) ? fs.readFileSync(filePath) : "<absent>");
	}
	for (const document of documents.sort((left, right) => left.filePath.localeCompare(right.filePath))) {
		hash.update(document.filePath);
		hash.update(document.markdown);
	}
	return hash.digest("hex");
}

export function previewMasteryConceptMerge(
	vaultRoot: string,
	sourceId: string,
	canonicalId: string,
): MasteryConceptMergePreview {
	if (!sourceId.trim() || !canonicalId.trim()) throw new Error("Source and canonical mastery concept IDs must contain text.");
	const root = fs.realpathSync(vaultRoot);
	const scan = scanVaultMastery(root);
	if (scan.diagnostics.length > 0) throw new Error(`Could not safely preview mastery merge: ${scan.diagnostics.join("; ")}`);
	const catalogPath = path.join(root, "mastery-concepts.json");
	const evidencePath = masteryEvidenceStorePath(root);
	const catalog = readMasteryConceptCatalog(root);
	const evidenceStore = readMasteryEvidenceStore(root);
	const sourceEntry = catalog.concepts.find((concept) => concept.id === sourceId);
	const canonicalEntry = catalog.concepts.find((concept) => concept.id === canonicalId);
	const sourceNotes = scan.notes.filter((note) => note.mastery.has(sourceId));
	const canonicalNotes = scan.notes.filter((note) => note.mastery.has(canonicalId));
	const affectedNotes = [...new Map([...sourceNotes, ...canonicalNotes].map((note) => [note.filePath, note])).values()];
	const relevantEvents = evidenceStore.events.filter((event) => event.conceptId === sourceId || event.conceptId === canonicalId);
	const sourceEvents = relevantEvents.filter((event) => event.conceptId === sourceId);
	const canonicalEvents = relevantEvents.filter((event) => event.conceptId === canonicalId);
	const blockers: string[] = [];

	if (sourceId === canonicalId) blockers.push("Source and canonical IDs are identical.");
	if (!sourceEntry) blockers.push(`Source concept "${sourceId}" is not registered in the concept catalogue.`);
	if (!canonicalEntry) blockers.push(`Canonical concept "${canonicalId}" is not registered in the concept catalogue.`);
	if (sourceEntry?.mergedInto) blockers.push(`Source concept "${sourceId}" is already merged into "${sourceEntry.mergedInto}".`);
	if (canonicalEntry?.mergedInto) blockers.push(`Canonical concept "${canonicalId}" is itself merged; use its current canonical ID.`);

	for (const [conceptId, events, notes] of [
		[sourceId, sourceEvents, sourceNotes],
		[canonicalId, canonicalEvents, canonicalNotes],
	] as const) {
		if (events.some((event) => event.kind === "baseline")) {
			blockers.push(`"${conceptId}" has a legacy aggregate baseline without its original answer-level evidence.`);
		} else if (events.length === 0 && notes.length > 0) {
			blockers.push(`"${conceptId}" has mastery records but no replayable evidence events.`);
		}
	}
	try {
		mergeMasteryConceptCatalogEntries(catalog, sourceId, canonicalId);
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : String(error));
	}

	let mergedStore: MasteryEvidenceStore | undefined;
	let resultingMastery: MasteryRecord | undefined;
	try {
		mergedStore = mergeMasteryEvidenceEvents(evidenceStore, sourceId, canonicalId);
		resultingMastery = replayMasteryEvidence(mergedStore.events, canonicalId);
	} catch (error) {
		blockers.push(error instanceof Error ? error.message : String(error));
	}

	const documents = affectedNotes.map((note) => ({
		filePath: note.filePath,
		relativePath: note.relativePath,
		markdown: fs.readFileSync(note.filePath, "utf-8"),
	}));
	if (resultingMastery) {
		for (const document of documents) {
			const projected = updateMasteryFrontmatter(
				removeMasteryFrontmatter(document.markdown, sourceId),
				canonicalId,
				resultingMastery,
			);
			const currentProjection = readMasteryFrontmatter(projected).get(canonicalId);
			if (!currentProjection || !sameMasteryRecord(currentProjection, resultingMastery)) {
				blockers.push(`"${document.relativePath}" has a mastery projection that cannot be safely replaced by replayed events.`);
			}
		}
	}
	return {
		sourceId,
		canonicalId,
		canMerge: blockers.length === 0,
		previewToken: hashMergeInputs(catalogPath, evidencePath, documents),
		affectedNotePaths: affectedNotes.map((note) => note.relativePath).sort((left, right) => left.localeCompare(right)),
		sourceEvidenceCount: sourceEvents.filter((event) => event.kind === "sample").length,
		canonicalEvidenceCount: canonicalEvents.filter((event) => event.kind === "sample").length,
		mergedEvidenceCount: mergedStore?.events.filter((event) => event.kind === "sample" && event.conceptId === canonicalId).length ?? 0,
		resultingMastery,
		blockers,
	};
}

function commitStagedTextFiles(files: Array<{ filePath: string; contents: string }>): void {
	const staged = files.map((file) => ({
		...file,
		temporaryPath: `${file.filePath}.${process.pid}.${randomUUID()}.tmp`,
		backupPath: `${file.filePath}.${process.pid}.${randomUUID()}.bak`,
		existed: fs.existsSync(file.filePath),
		committed: false,
		backedUp: false,
	}));
	try {
		for (const file of staged) fs.writeFileSync(file.temporaryPath, file.contents, { flag: "wx" });
		for (const file of staged) {
			if (file.existed) {
				fs.renameSync(file.filePath, file.backupPath);
				file.backedUp = true;
			}
			fs.renameSync(file.temporaryPath, file.filePath);
			file.committed = true;
		}
	} catch (error) {
		const rollbackErrors: string[] = [];
		for (const file of [...staged].reverse()) {
			try {
				if (file.committed && fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
				if (file.backedUp && fs.existsSync(file.backupPath)) fs.renameSync(file.backupPath, file.filePath);
			} catch (rollbackError) {
				rollbackErrors.push(`${file.filePath}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
			}
		}
		for (const file of staged) {
			if (fs.existsSync(file.temporaryPath)) fs.unlinkSync(file.temporaryPath);
		}
		if (rollbackErrors.length > 0) {
			throw new Error(`Mastery merge failed and rollback was incomplete: ${rollbackErrors.join("; ")}`);
		}
		throw new Error(`Mastery merge failed; staged note and index changes were rolled back: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const file of staged) {
		if (file.backedUp && fs.existsSync(file.backupPath)) fs.unlinkSync(file.backupPath);
	}
}

export function mergeMasteryConceptsAcrossVault(
	vaultRoot: string,
	sourceId: string,
	canonicalId: string,
	expectedPreviewToken: string,
): { preview: MasteryConceptMergePreview; files: string[] } {
	const preview = previewMasteryConceptMerge(vaultRoot, sourceId, canonicalId);
	if (preview.previewToken !== expectedPreviewToken) {
		throw new Error("Mastery merge inputs changed after preview; no changes were made. Preview the merge again.");
	}
	if (!preview.canMerge) {
		throw new Error(`Mastery merge is blocked: ${preview.blockers.join("; ")}`);
	}

	const root = fs.realpathSync(vaultRoot);
	const scan = scanVaultMastery(root);
	const catalog = readMasteryConceptCatalog(root);
	const nextCatalog = mergeMasteryConceptCatalogEntries(catalog, sourceId, canonicalId);
	const evidenceStore = readMasteryEvidenceStore(root);
	const nextEvidenceStore = mergeMasteryEvidenceEvents(evidenceStore, sourceId, canonicalId);
	const record = replayMasteryEvidence(nextEvidenceStore.events, canonicalId);
	const sourceNotes = scan.notes.filter((note) => note.mastery.has(sourceId) || note.mastery.has(canonicalId));
	const relatedTargets = sourceNotes.map((note) => note.linkTarget);
	const staged = sourceNotes.map((note) => {
		const original = fs.readFileSync(note.filePath, "utf-8");
		let updated = removeMasteryFrontmatter(original, sourceId);
		if (record) {
			updated = updateMasteryFrontmatter(updated, canonicalId, record);
			const projected = readMasteryFrontmatter(updated).get(canonicalId);
			if (!projected || !sameMasteryRecord(projected, record)) {
				throw new Error(`Could not safely project merged mastery to "${note.relativePath}". No merge was applied.`);
			}
		}
		updated = updateRelatedFrontmatter(updated, relatedTargets.filter((target) => target !== note.linkTarget));
		return { filePath: note.filePath, original, updated };
	}).filter((document) => document.original !== document.updated);
	const filesToCommit = [
		...(fs.existsSync(masteryEvidenceStorePath(root)) || nextEvidenceStore.events.length > 0
			? [{ filePath: masteryEvidenceStorePath(root), contents: `${JSON.stringify(nextEvidenceStore, null, "\t")}\n` }]
			: []),
		{ filePath: path.join(root, "mastery-concepts.json"), contents: `${JSON.stringify(nextCatalog, null, "\t")}\n` },
		...staged.map(({ filePath, updated }) => ({ filePath, contents: updated })),
	];
	commitStagedTextFiles(filesToCommit);
	return { preview, files: staged.map((document) => document.filePath) };
}

export function summarizeMasteryRecord(record: MasteryRecord): string {
	return JSON.stringify(record);
}
