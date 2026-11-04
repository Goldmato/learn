import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
	updateTeachingMastery,
	type MasteryRecord,
	type TeachingOutcome,
} from "./teach-learning-state.ts";

export type MasteryEvidenceType = "quiz" | "free_response";

export interface MasteryEvidenceSample {
	kind: "sample";
	conceptId: string;
	interactionId: string;
	evidenceType: MasteryEvidenceType;
	outcome: TeachingOutcome;
	score: number;
	confidence: number;
	evidenceWeight?: number;
	reasoningSummary?: string;
	recordedAt: number;
}

export interface MasteryEvidenceRoundAssessment {
	kind: "round_assessment";
	conceptId: string;
	interactionId: string;
	roundId: string;
	interactionIds: string[];
	outcome: TeachingOutcome;
	score: number;
	confidence: number;
	evidenceWeight: number;
	coverage: string[];
	rationale: string;
	recordedAt: number;
}

export interface MasteryEvidenceBaseline {
	kind: "baseline";
	conceptId: string;
	record: MasteryRecord;
	recordedAt: number;
}

export type MasteryEvidenceEvent = MasteryEvidenceSample | MasteryEvidenceRoundAssessment | MasteryEvidenceBaseline;

export interface MasteryEvidenceStore {
	version: 1;
	events: MasteryEvidenceEvent[];
}

const EVIDENCE_FILENAME = "mastery-evidence.json";

export function masteryEvidenceStorePath(vaultRoot: string): string {
	return path.join(vaultRoot, EVIDENCE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateMasteryRecord(value: unknown): MasteryRecord {
	if (!isRecord(value)) throw new Error("Mastery evidence baseline record must be an object.");
	const { score, evidenceCount, evidenceWeight, evidenceSum, lastInteractionId, confidence, reasoningSummary } = value;
	if (
		typeof evidenceCount !== "number" || !Number.isInteger(evidenceCount) || evidenceCount < 0 ||
		typeof evidenceWeight !== "number" || !Number.isFinite(evidenceWeight) || evidenceWeight < 0 ||
		typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 10 ||
		(score !== undefined && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10)) ||
		(evidenceSum !== undefined && (typeof evidenceSum !== "number" || !Number.isFinite(evidenceSum))) ||
		(lastInteractionId !== undefined && typeof lastInteractionId !== "string") ||
		(reasoningSummary !== undefined && typeof reasoningSummary !== "string")
	) throw new Error("Mastery evidence baseline contains invalid mastery values.");
	const record: MasteryRecord = {
		evidenceCount,
		evidenceWeight,
		confidence,
	};
	if (typeof score === "number") record.score = score;
	if (typeof evidenceSum === "number") record.evidenceSum = evidenceSum;
	if (typeof lastInteractionId === "string") record.lastInteractionId = lastInteractionId;
	if (typeof reasoningSummary === "string") record.reasoningSummary = reasoningSummary;
	return record;
}

function validateEvent(value: unknown): MasteryEvidenceEvent {
	if (!isRecord(value)) throw new Error("Mastery evidence events must be objects.");
	if (typeof value.conceptId !== "string" || !value.conceptId.trim()) throw new Error("Mastery evidence event conceptId must contain text.");
	if (typeof value.recordedAt !== "number" || !Number.isFinite(value.recordedAt) || value.recordedAt < 0) {
		throw new Error("Mastery evidence event recordedAt must be a non-negative finite number.");
	}
	if (value.kind === "baseline") {
		const unsupported = Object.keys(value).find((key) => !["kind", "conceptId", "record", "recordedAt"].includes(key));
		if (unsupported) throw new Error(`Mastery evidence baseline contains unsupported field "${unsupported}".`);
		return {
			kind: "baseline",
			conceptId: value.conceptId,
			record: validateMasteryRecord(value.record),
			recordedAt: value.recordedAt,
		};
	}
	if (value.kind === "round_assessment") {
		const unsupported = Object.keys(value).find((key) =>
			![
				"kind", "conceptId", "interactionId", "roundId", "interactionIds", "outcome",
				"score", "confidence", "evidenceWeight", "coverage", "rationale", "recordedAt",
			].includes(key),
		);
		if (unsupported) throw new Error(`Mastery round assessment contains unsupported field "${unsupported}".`);
		if (typeof value.interactionId !== "string" || !value.interactionId.trim()) throw new Error("Mastery round assessment interactionId must contain text.");
		if (typeof value.roundId !== "string" || !value.roundId.trim()) throw new Error("Mastery round assessment roundId must contain text.");
		if (value.interactionId !== value.roundId) throw new Error("Mastery round assessment interactionId must equal its full roundId.");
		if (!Array.isArray(value.interactionIds) || value.interactionIds.length === 0 ||
			value.interactionIds.some((id) => typeof id !== "string" || !id.trim()) ||
			new Set(value.interactionIds).size !== value.interactionIds.length) {
			throw new Error("Mastery round assessment interactionIds must be a non-empty list of unique IDs.");
		}
		if (value.outcome !== "correct" && value.outcome !== "partial" && value.outcome !== "incorrect") {
			throw new Error("Mastery round assessment has an invalid outcome.");
		}
		if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 10) {
			throw new Error("Mastery round assessment score must be a finite number from 0 to 10.");
		}
		if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 10) {
			throw new Error("Mastery round assessment confidence must be a finite number from 0 to 10.");
		}
		if (typeof value.evidenceWeight !== "number" || !Number.isFinite(value.evidenceWeight) ||
			value.evidenceWeight < 1 || value.evidenceWeight > 3) {
			throw new Error("Mastery round assessment evidenceWeight must be from 1 to 3.");
		}
		if (!Array.isArray(value.coverage) || value.coverage.length === 0 ||
			value.coverage.some((item) => typeof item !== "string" || !item.trim())) {
			throw new Error("Mastery round assessment coverage must be a non-empty list of non-empty strings.");
		}
		if (typeof value.rationale !== "string" || !value.rationale.trim()) {
			throw new Error("Mastery round assessment rationale must contain text.");
		}
		return {
			kind: "round_assessment",
			conceptId: value.conceptId,
			interactionId: value.interactionId,
			roundId: value.roundId,
			interactionIds: [...value.interactionIds],
			outcome: value.outcome,
			score: value.score,
			confidence: value.confidence,
			evidenceWeight: value.evidenceWeight,
			coverage: value.coverage.map((item) => item.trim()),
			rationale: value.rationale.trim(),
			recordedAt: value.recordedAt,
		};
	}
	if (value.kind !== "sample") throw new Error(`Unsupported mastery evidence event kind "${String(value.kind)}".`);
	const unsupported = Object.keys(value).find((key) =>
		!["kind", "conceptId", "interactionId", "evidenceType", "outcome", "score", "confidence", "evidenceWeight", "reasoningSummary", "recordedAt"].includes(key),
	);
	if (unsupported) throw new Error(`Mastery evidence sample contains unsupported field "${unsupported}".`);
	if (typeof value.interactionId !== "string" || !value.interactionId.trim()) throw new Error("Mastery evidence interactionId must contain text.");
	if (value.evidenceType !== "quiz" && value.evidenceType !== "free_response") throw new Error("Mastery evidence event has an invalid evidenceType.");
	if (value.outcome !== "correct" && value.outcome !== "partial" && value.outcome !== "incorrect") {
		throw new Error("Mastery evidence event has an invalid outcome.");
	}
	if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 10) {
		throw new Error("Mastery evidence score must be a finite number from 0 to 10.");
	}
	if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 10) {
		throw new Error("Mastery evidence confidence must be a finite number from 0 to 10.");
	}
	if (value.evidenceWeight !== undefined && (
		typeof value.evidenceWeight !== "number" || !Number.isFinite(value.evidenceWeight) ||
		value.evidenceWeight < 0.1 || value.evidenceWeight > 1
	)) {
		throw new Error("Mastery interaction evidenceWeight must be from 0.1 to 1.");
	}
	if (value.reasoningSummary !== undefined && typeof value.reasoningSummary !== "string") {
		throw new Error("Mastery evidence reasoningSummary must be a string.");
	}
	return {
		kind: "sample",
		conceptId: value.conceptId,
		interactionId: value.interactionId,
		evidenceType: value.evidenceType,
		outcome: value.outcome,
		score: value.score,
		confidence: value.confidence,
		evidenceWeight: typeof value.evidenceWeight === "number" ? value.evidenceWeight : undefined,
		reasoningSummary: typeof value.reasoningSummary === "string" ? value.reasoningSummary : undefined,
		recordedAt: value.recordedAt,
	};
}

function validateStore(value: unknown): MasteryEvidenceStore {
	if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)) {
		throw new Error("Mastery evidence store must be a version 1 object with an events array.");
	}
	const unsupported = Object.keys(value).find((key) => !["version", "events"].includes(key));
	if (unsupported) throw new Error(`Mastery evidence store contains unsupported field "${unsupported}".`);
	const events = value.events.map(validateEvent);
	const seenBaselines = new Set<string>();
	const seenInteractions = new Set<string>();
	const seenRounds = new Set<string>();
	const seenSamples = new Map<string, Set<string>>();
	for (const event of events) {
		if (event.kind === "baseline") {
			if (seenBaselines.has(event.conceptId)) throw new Error(`Mastery evidence has duplicate baseline records for "${event.conceptId}".`);
			seenBaselines.add(event.conceptId);
		} else {
			const key = `${event.conceptId}\u0000${event.interactionId}`;
			if (seenInteractions.has(key)) throw new Error(`Mastery evidence repeats interaction "${event.interactionId}" for "${event.conceptId}".`);
			seenInteractions.add(key);
			if (event.kind === "round_assessment") {
				const sourceSamples = seenSamples.get(event.conceptId) ?? new Set<string>();
				const missingSource = event.interactionIds.find((interactionId) => !sourceSamples.has(interactionId));
				if (missingSource) {
					throw new Error(`Mastery round "${event.roundId}" references interaction "${missingSource}" without a prior sample event.`);
				}
				const roundKey = `${event.conceptId}\u0000${event.roundId}`;
				if (seenRounds.has(roundKey)) throw new Error(`Mastery evidence repeats round "${event.roundId}" for "${event.conceptId}".`);
				seenRounds.add(roundKey);
			} else {
				const sourceSamples = seenSamples.get(event.conceptId) ?? new Set<string>();
				sourceSamples.add(event.interactionId);
				seenSamples.set(event.conceptId, sourceSamples);
			}
		}
	}
	return { version: 1, events };
}

export function readMasteryEvidenceStore(vaultRoot: string): MasteryEvidenceStore {
	const filePath = masteryEvidenceStorePath(vaultRoot);
	if (!fs.existsSync(filePath)) return { version: 1, events: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		throw new Error(`Could not read mastery evidence store "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		return validateStore(parsed);
	} catch (error) {
		throw new Error(`Invalid mastery evidence store "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writeMasteryEvidenceStore(vaultRoot: string, store: MasteryEvidenceStore): void {
	const validated = validateStore(store);
	const filePath = masteryEvidenceStorePath(vaultRoot);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, `${JSON.stringify(validated, null, "\t")}\n`, { flag: "wx" });
		fs.renameSync(temporaryPath, filePath);
	} catch (error) {
		if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
		throw new Error(`Could not write mastery evidence store "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function replayMasteryEvidence(events: MasteryEvidenceEvent[], conceptId: string): MasteryRecord | undefined {
	const matching = events.filter((event) => event.conceptId === conceptId);
	const baselines = matching.filter((event): event is MasteryEvidenceBaseline => event.kind === "baseline");
	if (baselines.length > 1) throw new Error(`Mastery evidence has multiple baselines for "${conceptId}".`);
	let record = baselines[0]?.record;
	const evidence = matching.filter((event): event is MasteryEvidenceSample | MasteryEvidenceRoundAssessment =>
		event.kind !== "baseline",
	);
	for (const event of evidence) {
		record = updateTeachingMastery(record, {
			interactionId: event.interactionId,
			score: event.score,
			confidence: event.confidence,
			evidenceWeight: event.evidenceWeight,
			reasoningSummary: event.kind === "sample" ? event.reasoningSummary : event.rationale,
		});
	}
	return record;
}

export function appendMasteryEvidenceSample(
	store: MasteryEvidenceStore,
	sample: Omit<MasteryEvidenceSample, "kind">,
): MasteryEvidenceStore {
	const duplicate = store.events.find((event) =>
		event.kind === "sample" && event.conceptId === sample.conceptId && event.interactionId === sample.interactionId,
	);
	if (duplicate) throw new Error(`Interaction "${sample.interactionId}" is already stored as mastery evidence for "${sample.conceptId}".`);
	return validateStore({ version: 1, events: [...store.events, { kind: "sample", ...sample }] });
}

export function appendMasteryEvidenceRoundAssessment(
	store: MasteryEvidenceStore,
	assessment: Omit<MasteryEvidenceRoundAssessment, "kind">,
): MasteryEvidenceStore {
	const duplicateRound = store.events.find((event) =>
		event.kind === "round_assessment" && event.conceptId === assessment.conceptId &&
		event.roundId === assessment.roundId,
	);
	if (duplicateRound) {
		throw new Error(`Round "${assessment.roundId}" is already stored as mastery evidence for "${assessment.conceptId}".`);
	}
	const alreadyReviewed = new Set(store.events.flatMap((event) =>
		event.kind === "round_assessment" && event.conceptId === assessment.conceptId
			? event.interactionIds
			: [],
	));
	const repeatedInteraction = assessment.interactionIds.find((interactionId) => alreadyReviewed.has(interactionId));
	if (repeatedInteraction) {
		throw new Error(`Interaction "${repeatedInteraction}" already contributes to a mastery round assessment for "${assessment.conceptId}".`);
	}
	return validateStore({ version: 1, events: [...store.events, { kind: "round_assessment", ...assessment }] });
}

export function mergeMasteryEvidenceEvents(
	store: MasteryEvidenceStore,
	sourceId: string,
	canonicalId: string,
): MasteryEvidenceStore {
	const relevant = store.events.filter((event) => event.conceptId === sourceId || event.conceptId === canonicalId);
	if (relevant.some((event) => event.kind === "baseline")) {
		throw new Error("Cannot merge concepts with legacy aggregate baselines: their original answer-level evidence is unavailable.");
	}
	const byInteraction = new Map<string, MasteryEvidenceSample | MasteryEvidenceRoundAssessment>();
	for (const event of relevant) {
		if (event.kind === "baseline") continue;
		const existing = byInteraction.get(event.interactionId);
		if (existing) {
			const sameEvidence = JSON.stringify({ ...existing, conceptId: canonicalId }) ===
				JSON.stringify({ ...event, conceptId: canonicalId });
			if (!sameEvidence) throw new Error(`Interaction "${event.interactionId}" has conflicting evidence across the concepts; no merge was applied.`);
			continue;
		}
		byInteraction.set(event.interactionId, { ...event, conceptId: canonicalId });
	}
	const unrelated = store.events.filter((event) => event.conceptId !== sourceId && event.conceptId !== canonicalId);
	return validateStore({
		version: 1,
		events: [...unrelated, ...byInteraction.values()],
	});
}
