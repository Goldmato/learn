import * as fs from "node:fs";
import * as path from "node:path";
import {
	readMasteryFrontmatter,
	updateTeachingMastery,
	updateMasteryFrontmatter,
	type MasteryEvidence,
	type MasteryRecord,
} from "./teach-learning-state.ts";

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
	const scan = scanVaultMastery(vaultRoot);
	if (scan.diagnostics.length > 0) {
		throw new Error(`Could not safely scan mastery notes: ${scan.diagnostics.join("; ")}`);
	}
	const currentPath = fs.realpathSync(currentNotePath);
	const matchingNotes = scan.notes.filter((note) => note.mastery.has(conceptId));
	if (!matchingNotes.some((note) => path.resolve(note.filePath) === currentPath)) {
		const markdown = fs.readFileSync(currentPath, "utf-8");
		matchingNotes.push({
			filePath: currentPath,
			relativePath: path.relative(path.resolve(vaultRoot), currentPath),
			linkTarget: wikilinkTarget(path.relative(path.resolve(vaultRoot), currentPath)),
			title: propertyTitle(markdown) || path.basename(currentPath, path.extname(currentPath)),
			mastery: readMasteryFrontmatter(markdown),
		});
	}
	if (matchingNotes.length === 0) throw new Error(`No linked note found for mastery concept "${conceptId}".`);

	// Frontmatter is the only store: each note holds the latest aggregate record.
	const documents = matchingNotes.map((note) => {
		const markdown = fs.readFileSync(note.filePath, "utf-8");
		return { note, markdown, record: readMasteryFrontmatter(markdown).get(conceptId) };
	});
	const records = documents.flatMap((document) => document.record ? [document.record] : []);
	const sameRecords = records.length === 0 || records.every((record) => sameMasteryRecord(record, records[0]));
	if (!sameRecords) {
		throw new Error(
			`Mastery records for "${conceptId}" differ between linked notes, and the frontmatter alone cannot be merged safely. No related note was changed.`,
		);
	}

	const base = records[0];
	let record: MasteryRecord;
	if (options.evidence) {
		if (base && options.previousRecord && !sameMasteryRecord(base, options.previousRecord)) {
			throw new Error(`Mastery baseline for "${conceptId}" changed before the evidence could be synchronized.`);
		}
		record = base
			? updateTeachingMastery(base, options.evidence)
			: options.nextRecord ?? updateTeachingMastery(undefined, options.evidence);
		if (options.nextRecord && record.evidenceCount < options.nextRecord.evidenceCount) {
			throw new Error(`Merged mastery evidence for "${conceptId}" is incomplete; no related note was changed.`);
		}
	} else {
		if (!base) throw new Error(`No mastery record exists for "${conceptId}" in the linked notes.`);
		record = base;
	}

	const targets = matchingNotes.map((note) => note.linkTarget);
	const staged = documents.map(({ note, markdown }) => {
		// Remove legacy HTML evidence blocks: the frontmatter is the sole store now.
		let updated = stripLegacyMasteryEvidence(markdown);
		updated = updateMasteryFrontmatter(updated, conceptId, record);
		updated = updateRelatedFrontmatter(updated, targets.filter((target) => target !== note.linkTarget));
		return { filePath: note.filePath, updated, original: markdown };
	});
	for (const item of staged) {
		if (item.updated !== item.original) fs.writeFileSync(item.filePath, item.updated, "utf-8");
	}
	return {
		record,
		previousRecord: base,
		files: staged.filter((item) => item.updated !== item.original).map((item) => item.filePath),
		evidenceCount: record.evidenceCount,
	};
}

export function summarizeMasteryRecord(record: MasteryRecord): string {
	return JSON.stringify(record);
}
