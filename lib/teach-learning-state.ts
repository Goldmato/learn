import { buildBackfill } from "./md-log-format.ts";

export type TeachingOutcome = "correct" | "partial" | "incorrect";

export interface TeachingResponse {
	callId: string;
	interactionId: string;
	source: "quiz" | "free_response";
	question: string;
	response: string;
	correct?: boolean;
	scratchpad?: string;
	note?: string;
	conceptId?: string;
	summaryTitle?: string;
}

export interface MasteryRecord {
	score?: number;
	evidenceCount: number;
	evidenceWeight: number;
	evidenceSum?: number;
	lastInteractionId?: string;
	confidence: number;
	reasoningSummary?: string;
}

export interface MasteryEvidence {
	interactionId: string;
	score: number;
	confidence: number;
	reasoningSummary?: string;
}

export interface TeachingHistory {
	responses: Map<string, TeachingResponse>;
	recordedInteractionIds: Set<string>;
	mastery: Map<string, MasteryRecord>;
}

export function resolveTeachingResponse(
	responses: ReadonlyMap<string, TeachingResponse>,
	interactionId: string,
): TeachingResponse | undefined {
	const exact = responses.get(interactionId);
	if (exact) return exact;

	const quizMatches = [...responses.values()].filter((response) =>
		response.source === "quiz" && response.interactionId.startsWith(`${interactionId}|`),
	);
	if (quizMatches.length > 1) {
		throw new Error(`Interaction prefix "${interactionId}" matches multiple quiz responses; use the full interactionId.`);
	}
	return quizMatches[0];
}

const INITIAL_QUESTION_COUNT = 3;
const INITIAL_BASELINE_WEIGHT = 3;

export function masteryEvidenceWeight(confidence: number): number {
	if (!Number.isFinite(confidence) || confidence < 0 || confidence > 10) {
		throw new Error("confidence must be a finite number from 0 to 10.");
	}
	return Math.round((0.8 + confidence * 0.02) * 100) / 100;
}

export function updateTeachingMastery(
	previous: MasteryRecord | undefined,
	evidence: MasteryEvidence,
): MasteryRecord {
	if (!evidence.interactionId.trim()) throw new Error("interactionId must contain non-whitespace text.");
	if (previous?.lastInteractionId === evidence.interactionId) throw new Error(`Interaction "${evidence.interactionId}" is already the latest mastery sample.`);
	if (!Number.isFinite(evidence.score) || evidence.score < 0 || evidence.score > 10) {
		throw new Error("evidence score must be a finite number from 0 to 10.");
	}
	const weight = masteryEvidenceWeight(evidence.confidence);
	const count = (previous?.evidenceCount ?? 0) + 1;
	const record: MasteryRecord = {
		evidenceCount: count,
		evidenceWeight: previous?.evidenceWeight ?? 0,
		lastInteractionId: evidence.interactionId,
		confidence: evidence.confidence,
		reasoningSummary: evidence.reasoningSummary?.trim() || undefined,
	};

	if (previous?.score === undefined) {
		const evidenceSum = (previous?.evidenceSum ?? 0) + evidence.score * weight;
		const evidenceWeight = (previous?.evidenceWeight ?? 0) + weight;
		if (count < INITIAL_QUESTION_COUNT) {
			record.evidenceWeight = evidenceWeight;
			record.evidenceSum = evidenceSum;
			return record;
		}
		record.score = roundScore(evidenceSum / evidenceWeight);
		record.evidenceWeight = INITIAL_BASELINE_WEIGHT;
		return record;
	}

	const priorWeight = Math.max(INITIAL_BASELINE_WEIGHT, previous.evidenceWeight);
	const change = (weight / (priorWeight + weight)) * (evidence.score - previous.score);
	const roundedChange = Math.trunc(change * 100) / 100;
	record.score = roundScore(previous.score + roundedChange);
	record.evidenceWeight = priorWeight + weight;
	return record;
}

function roundScore(score: number): number {
	return Math.round(Math.max(0, Math.min(10, score)) * 100) / 100;
}

export function readTeachingHistory(
	entriesValue: unknown,
	persistedMastery: Map<string, MasteryRecord> = new Map(),
): TeachingHistory {
	const { blocks, diagnostics } = buildBackfill(entriesValue);
	if (!Array.isArray(entriesValue)) throw new Error("Could not read learning history: session entries were not an array.");
	if (diagnostics.some((diagnostic) => diagnostic.includes("No session entry with an id"))) {
		throw new Error("Could not read learning history: no current session branch was found.");
	}

	const responses = new Map<string, TeachingResponse>();
	const recordedInteractionIds = new Set<string>();
	const mastery = new Map(persistedMastery);
	for (const block of blocks) {
		if (block.kind === "free_response") {
			responses.set(block.interactionId, {
				callId: block.callId,
				interactionId: block.interactionId,
				source: "free_response",
				question: block.question,
				response: block.response,
				conceptId: block.conceptId,
				summaryTitle: block.summaryTitle,
			});
		} else if (block.kind === "attempt") {
			recordedInteractionIds.add(block.interactionId);
			if (block.masteryState) {
				const current = mastery.get(block.conceptId);
				if (!current || block.masteryState.evidenceCount >= current.evidenceCount) {
					mastery.set(block.conceptId, block.masteryState);
				}
			}
		} else if (block.kind === "quiz" && block.details?.status === "answered") {
			const details = block.details;
			const answers = Array.isArray(details.answers)
				? details.answers
					.filter((answer: unknown) =>
						typeof answer === "object" && answer !== null && typeof (answer as Record<string, unknown>).label === "string")
					.map((answer: Record<string, unknown>) => String(answer.label))
				: [];
			responses.set(block.callId, {
				callId: block.callId,
				interactionId: block.callId,
				source: "quiz",
				question: block.question,
				response: details.dontKnow === true ? "I don't know" : answers.join(", "),
				correct: details.correct === true,
				scratchpad: typeof details.scratchpad === "string" ? details.scratchpad : undefined,
				note: typeof details.note === "string" ? details.note : undefined,
				conceptId: typeof details.conceptId === "string" ? details.conceptId : undefined,
			});
		}
	}
	return { responses, recordedInteractionIds, mastery };
}

function frontmatterBounds(markdown: string): { start: number; end: number; bodyStart: number } | undefined {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
	if (!match) return undefined;
	const openingLength = /^---[ \t]*\r?\n/.exec(markdown)?.[0].length ?? 0;
	const closingStart = /\r?\n---[ \t]*(?:\r?\n|$)$/.exec(match[0])?.index ?? match[0].length;
	return { start: openingLength, end: closingStart, bodyStart: match[0].length };
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed);
		} catch {
			throw new Error("Mastery frontmatter contains an invalid quoted value.");
		}
	}
	if (trimmed === "null") return undefined;
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	const number = Number(trimmed);
	return Number.isFinite(number) ? number : trimmed;
}

const MASTERY_FIELDS = [
	"score",
	"evidence-count",
	"evidence-weight",
	"evidence-sum",
	"last-interaction-id",
	"confidence",
	"reasoning-summary",
] as const;
type MasteryField = (typeof MASTERY_FIELDS)[number];

function masteryPropertyKey(conceptId: string, field: MasteryField): string {
	return `mastery__${encodeURIComponent(conceptId)}__${field}`;
}

function validateMasteryRecord(conceptId: string, fields: Record<string, unknown>): MasteryRecord {
	const { score, evidence_count, evidence_weight, evidence_sum, last_interaction_id, confidence, reasoning_summary } = fields;
	if (
		typeof evidence_count !== "number" || !Number.isInteger(evidence_count) || evidence_count < 0 ||
		typeof evidence_weight !== "number" || !Number.isFinite(evidence_weight) || evidence_weight < 0 ||
		typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 10 ||
		(score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10)) ||
		(evidence_sum !== undefined && (typeof evidence_sum !== "number" || !Number.isFinite(evidence_sum))) ||
		(last_interaction_id !== undefined && typeof last_interaction_id !== "string") ||
		(reasoning_summary !== undefined && typeof reasoning_summary !== "string")
	) throw new Error(`Linked note has invalid mastery values for "${conceptId}".`);
	const record: MasteryRecord = { evidenceCount: evidence_count, evidenceWeight: evidence_weight, confidence };
	if (typeof score === "number") record.score = score;
	if (typeof evidence_sum === "number") record.evidenceSum = evidence_sum;
	if (typeof last_interaction_id === "string") record.lastInteractionId = last_interaction_id;
	if (typeof reasoning_summary === "string") record.reasoningSummary = reasoning_summary;
	return record;
}

function readLegacyMastery(lines: string[], records: Map<string, MasteryRecord>): number | undefined {
	const masteryLineIndexes = lines.flatMap((line, index) => /^mastery:/.test(line) ? [index] : []);
	if (masteryLineIndexes.length === 0) return undefined;
	if (masteryLineIndexes.length > 1) throw new Error("Linked note has duplicate top-level mastery fields.");
	if (!/^mastery:[ \t]*$/.test(lines[masteryLineIndexes[0]])) {
		throw new Error("Linked note has unsupported mastery frontmatter; refusing to overwrite it.");
	}

	const start = masteryLineIndexes[0];
	const followingProperty = lines.findIndex((line, index) => index > start && line.length > 0 && !/^[ \t]/.test(line));
	const end = followingProperty < 0 ? lines.length : followingProperty;
	let conceptId: string | undefined;
	let fields: Record<string, unknown> | undefined;
	const commit = () => {
		if (!conceptId || !fields) return;
		if (records.has(conceptId)) throw new Error(`Linked note has duplicate mastery data for "${conceptId}".`);
		records.set(conceptId, validateMasteryRecord(conceptId, fields));
	};

	for (const line of lines.slice(start + 1, end)) {
		const conceptMatch = /^[ \t]{2}("(?:[^"\\]|\\.)*"|[A-Za-z0-9._-]+):[ \t]*$/.exec(line);
		if (conceptMatch) {
			commit();
			conceptId = conceptMatch[1].startsWith('"')
				? String(parseScalar(conceptMatch[1]))
				: conceptMatch[1];
			fields = {};
			continue;
		}
		if (!line.trim()) continue;
		const fieldMatch = /^[ \t]{4}([a-z_]+):[ \t]*(.*)$/.exec(line);
		if (!fieldMatch || !fields || !conceptId) throw new Error("Linked note has unsupported mastery frontmatter; refusing to overwrite it.");
		if (!["score", "evidence_count", "evidence_weight", "evidence_sum", "last_interaction_id", "confidence", "reasoning_summary"].includes(fieldMatch[1])) {
			throw new Error(`Linked note has unsupported mastery field "${fieldMatch[1]}"; refusing to overwrite it.`);
		}
		if (Object.hasOwn(fields, fieldMatch[1])) throw new Error(`Linked note repeats mastery field "${fieldMatch[1]}".`);
		fields[fieldMatch[1]] = parseScalar(fieldMatch[2]);
	}
	commit();
	return start;
}

export function readMasteryFrontmatter(markdown: string): Map<string, MasteryRecord> {
	const bounds = frontmatterBounds(markdown);
	if (!bounds) return new Map();
	const lines = markdown.slice(bounds.start, bounds.end).split(/\r?\n/);
	const records = new Map<string, MasteryRecord>();
	const legacyStart = readLegacyMastery(lines, records);
	const flatFields = new Map<string, Record<string, unknown>>();

	for (const line of lines) {
		const propertyMatch = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_%.-]+):[ \t]*(.*)$/.exec(line);
		if (!propertyMatch) continue;
		const propertyNameValue = parseScalar(propertyMatch[1]);
		if (typeof propertyNameValue !== "string" || !propertyNameValue.startsWith("mastery__")) continue;
		let foundField: MasteryField | undefined;
		for (const field of MASTERY_FIELDS) {
			if (propertyNameValue.endsWith(`__${field}`)) {
				foundField = field;
				break;
			}
		}
		if (!foundField) throw new Error(`Linked note has unsupported mastery property "${propertyNameValue}".`);
		const encodedConceptId = propertyNameValue.slice("mastery__".length, -(`__${foundField}`).length);
		let conceptId: string;
		try {
			conceptId = decodeURIComponent(encodedConceptId);
		} catch {
			throw new Error(`Linked note has an invalid encoded mastery property "${propertyNameValue}".`);
		}
		if (!conceptId) throw new Error(`Linked note has an empty mastery concept in "${propertyNameValue}".`);
		if (legacyStart !== undefined && records.has(conceptId)) {
			throw new Error(`Linked note mixes legacy and flattened mastery properties for "${conceptId}".`);
		}
		const fields = flatFields.get(conceptId) ?? {};
		const legacyFieldName: Record<MasteryField, string> = {
			score: "score",
			"evidence-count": "evidence_count",
			"evidence-weight": "evidence_weight",
			"evidence-sum": "evidence_sum",
			"last-interaction-id": "last_interaction_id",
			confidence: "confidence",
			"reasoning-summary": "reasoning_summary",
		};
		const fieldName = legacyFieldName[foundField];
		if (Object.hasOwn(fields, fieldName)) throw new Error(`Linked note repeats mastery property "${propertyNameValue}".`);
		fields[fieldName] = parseScalar(propertyMatch[2]);
		flatFields.set(conceptId, fields);
	}
	for (const [conceptId, fields] of flatFields) {
		if (records.has(conceptId)) throw new Error(`Linked note has duplicate mastery data for "${conceptId}".`);
		records.set(conceptId, validateMasteryRecord(conceptId, fields));
	}
	return records;
}

function renderMasteryFrontmatter(records: Map<string, MasteryRecord>): string {
	const lines: string[] = [];
	for (const [conceptId, record] of [...records].sort(([left], [right]) => left.localeCompare(right))) {
		const fields: Array<[MasteryField, number | string | undefined]> = [
			["score", record.score],
			["evidence-count", record.evidenceCount],
			["evidence-weight", record.evidenceWeight],
			["evidence-sum", record.evidenceSum],
			["last-interaction-id", record.lastInteractionId],
			["confidence", record.confidence],
			["reasoning-summary", record.reasoningSummary],
		];
		for (const [field, value] of fields) {
			if (value === undefined || value === "") continue;
			lines.push(`${JSON.stringify(masteryPropertyKey(conceptId, field))}: ${typeof value === "string" ? JSON.stringify(value) : value}`);
		}
	}
	return lines.join("\n");
}

export function updateMasteryFrontmatter(markdown: string, conceptId: string, record: MasteryRecord): string {
	if (!conceptId.trim()) throw new Error("conceptId must contain non-whitespace text.");
	const bounds = frontmatterBounds(markdown);
	const records = readMasteryFrontmatter(markdown);
	const current = records.get(conceptId);
	if (current && record.evidenceCount < current.evidenceCount) return markdown;
	if (current && record.evidenceCount === current.evidenceCount && record.lastInteractionId !== current.lastInteractionId) return markdown;
	records.set(conceptId, record);
	const rendered = renderMasteryFrontmatter(records);

	if (!rendered) return markdown;
	if (!bounds) return `---\n${rendered}\n---\n\n${markdown}`;
	const frontmatter = markdown.slice(bounds.start, bounds.end);
	const lines = frontmatter.split(/\r?\n/);
	const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
	const masteryIndex = lines.findIndex((line) => /^mastery:[ \t]*$/.test(line));
	const legacyEnd = masteryIndex < 0 ? -1 : lines.findIndex((line, index) =>
		index > masteryIndex && line.length > 0 && !/^[ \t]/.test(line),
	);
	const flatPropertyIndexes = lines.flatMap((line, index) => {
		const match = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_%.-]+):[ \t]*/.exec(line);
		if (!match) return [];
		const propertyName = parseScalar(match[1]);
		return typeof propertyName === "string" && propertyName.startsWith("mastery__") ? [index] : [];
	});
	const ownedIndexes = new Set(flatPropertyIndexes);
	if (masteryIndex >= 0) {
		for (let index = masteryIndex; index < (legacyEnd < 0 ? lines.length : legacyEnd); index++) ownedIndexes.add(index);
	}
	const insertionIndex = ownedIndexes.size > 0 ? Math.min(...ownedIndexes) : lines.length;
	const keptLines = lines.filter((_line, index) => !ownedIndexes.has(index));
	let outputIndex = 0;
	for (let index = 0; index < insertionIndex; index++) if (!ownedIndexes.has(index)) outputIndex++;
	keptLines.splice(outputIndex, 0, ...rendered.split("\n"));
	const updatedFrontmatter = keptLines.join(newline);
	return `${markdown.slice(0, bounds.start)}${updatedFrontmatter}${markdown.slice(bounds.end)}`;
}

export function removeMasteryFrontmatter(markdown: string, conceptId: string): string {
	const migrated = migrateMasteryFrontmatter(markdown);
	const bounds = frontmatterBounds(migrated);
	if (!bounds) return migrated;
	const frontmatter = migrated.slice(bounds.start, bounds.end);
	const lines = frontmatter.split(/\r?\n/);
	const ownedIndexes = new Set<number>();
	for (const [index, line] of lines.entries()) {
		const match = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_%.-]+):[ \t]*/.exec(line);
		if (!match) continue;
		const propertyName = parseScalar(match[1]);
		if (typeof propertyName !== "string" || !propertyName.startsWith("mastery__")) continue;
		for (const field of MASTERY_FIELDS) {
			const suffix = `__${field}`;
			if (!propertyName.endsWith(suffix)) continue;
			try {
				if (decodeURIComponent(propertyName.slice("mastery__".length, -suffix.length)) === conceptId) {
					ownedIndexes.add(index);
				}
			} catch {
				throw new Error(`Linked note has an invalid encoded mastery property "${propertyName}".`);
			}
			break;
		}
	}
	if (ownedIndexes.size === 0) return migrated;
	const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
	const updatedFrontmatter = lines.filter((_line, index) => !ownedIndexes.has(index)).join(newline);
	return `${migrated.slice(0, bounds.start)}${updatedFrontmatter}${migrated.slice(bounds.end)}`;
}

export function migrateMasteryFrontmatter(markdown: string): string {
	const bounds = frontmatterBounds(markdown);
	if (!bounds) return markdown;
	const frontmatter = markdown.slice(bounds.start, bounds.end);
	if (!/^mastery:[ \t]*$/m.test(frontmatter)) return markdown;
	const records = readMasteryFrontmatter(markdown);
	const rendered = renderMasteryFrontmatter(records);
	if (!rendered) return markdown;

	const lines = frontmatter.split(/\r?\n/);
	const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
	const masteryIndex = lines.findIndex((line) => /^mastery:[ \t]*$/.test(line));
	const masteryEnd = lines.findIndex((line, index) => index > masteryIndex && line.length > 0 && !/^[ \t]/.test(line));
	const end = masteryEnd < 0 ? lines.length : masteryEnd;
	const updatedLines = [
		...lines.slice(0, masteryIndex),
		...rendered.split("\n"),
		...lines.slice(end),
	];
	return `${markdown.slice(0, bounds.start)}${updatedLines.join(newline)}${markdown.slice(bounds.end)}`;
}

export function readLinkedNotePath(entriesValue: unknown): string | undefined {
	if (!Array.isArray(entriesValue)) return undefined;
	let linkedPath: string | undefined;
	for (const entry of entriesValue) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as Record<string, unknown>;
		if (candidate.type !== "custom" || candidate.customType !== "md-log" || typeof candidate.data !== "object" || candidate.data === null) continue;
		const file = (candidate.data as Record<string, unknown>).file;
		linkedPath = typeof file === "string" && file.trim() ? file : undefined;
	}
	return linkedPath;
}
