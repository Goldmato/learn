import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	readLinkedNotePath,
	readMasteryFrontmatter,
	readTeachingHistory,
	updateTeachingMastery,
	type MasteryRecord,
	type TeachingOutcome,
	type TeachingResponse,
} from "../lib/teach-learning-state.ts";
import {
	findVaultRootForNote,
	scanVaultMastery,
	searchVaultMastery,
	syncMasteryAcrossVault,
	type PersistedMasteryEvidence,
} from "../lib/mastery-vault.ts";
import { withMdLogWriteLock } from "../lib/md-log-write-lock.ts";

interface AttemptEntry {
	callId: string;
	interactionId: string;
	conceptId: string;
	outcome: TeachingOutcome;
	evidenceType: "free_response";
	explanation: string;
	misconception?: string;
	evidenceScore: number;
	confidence: number;
	previousMastery?: number;
	masteryState: MasteryRecord;
	persistedToLinkedNote: boolean;
	recordedAt: number;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UI_LOCK_KEY = "__piSharedUiLock";
let attemptQueue: Promise<void> = Promise.resolve();

function serializeAttempts<T>(fn: () => Promise<T>): Promise<T> {
	const previous = attemptQueue;
	let release!: () => void;
	attemptQueue = new Promise<void>((resolve) => { release = resolve; });
	return previous.then(fn).finally(() => release());
}

function withSharedUiLock<T>(fn: () => Promise<T>): Promise<T> {
	const g = globalThis as any;
	if (!g[UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[UI_LOCK_KEY] = {
			withLock<U>(work: () => U | Promise<U>): Promise<U> {
				const previous = chain;
				let release!: () => void;
				chain = new Promise<void>((resolve) => { release = resolve; });
				return previous.then(work).finally(() => release());
			},
		};
	}
	return g[UI_LOCK_KEY].withLock(fn) as Promise<T>;
}

function cancelledResponse(question: string) {
	return {
		content: [{ type: "text" as const, text: "Free response cancelled." }],
		details: { status: "cancelled" as const, question },
	};
}

function unavailableResponse(question: string) {
	return {
		content: [{ type: "text" as const, text: "Free response requires interactive Pi UI." }],
		details: { status: "unavailable" as const, question },
	};
}

function responseTitle(question: string, requestedTitle?: string): string {
	const candidate = requestedTitle?.trim().replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ");
	if (candidate && candidate.split(" ").length >= 3 && candidate.split(" ").length <= 5) return candidate;
	const words = question
		.replace(/[?!.,:;()[\]{}]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
	const title = words.slice(0, 5);
	const fallbackWords = ["Response", "Check"];
	while (title.length < 3) title.push(fallbackWords[title.length - 1]);
	return title.join(" ");
}

export default function teachLearningTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "teach_sync_related_mastery",
		label: "Teaching: Sync Related Mastery",
		description: "Reconcile a mastery concept across every vault note that uses the exact same conceptId. Unique recorded evidence is merged and replayed; ambiguous conflicts without sufficient evidence are reported without overwriting notes.",
		promptSnippet: "Safely reconcile matching mastery records across vault notes",
		promptGuidelines: [
			"Use this to retry or explicitly reconcile related-note mastery after a reported conflict.",
			"The tool only merges notes with the exact same conceptId. It unions unique evidence markers and recomputes the score; it never guesses from timestamps or overwrites conflicting records with incomplete evidence.",
		],
		parameters: Type.Object({
			conceptId: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before syncing mastery.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			const result = await withMdLogWriteLock(() =>
				syncMasteryAcrossVault(findVaultRootForNote(resolvedNotePath), resolvedNotePath, params.conceptId.trim()),
			);
			return {
				content: [{
					type: "text" as const,
					text: `Synchronized "${params.conceptId}" across ${result.files.length} changed note(s) using ${result.evidenceCount} unique evidence sample(s).`,
				}],
				details: { conceptId: params.conceptId, files: result.files, evidenceCount: result.evidenceCount },
			};
		},
	});

	pi.registerTool({
		name: "teach_find_mastery_concepts",
		label: "Teaching: Find Mastery Concepts",
		description: "Search the current Obsidian vault for existing mastery concept IDs and their note records. Use this before assigning a conceptId so matching concepts reuse their established ID.",
		promptSnippet: "Search the vault's existing mastery concept IDs",
		promptGuidelines: [
			"Before choosing a conceptId for a graded quiz or free response, search this tool for the learning goal and reuse an exact existing ID when it matches.",
			"Do not merge distinct concepts merely because their names are similar; concept IDs are exact, case-sensitive identifiers.",
			"If the search returns no suitable concept, create a concise stable kebab-case ID.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Optional case-insensitive search over concept IDs, note titles, and vault-relative paths. Omit to list all indexed concepts." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum concepts to return; defaults to 100." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before searching the vault mastery catalogue.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			if (!fs.existsSync(resolvedNotePath) || !fs.statSync(resolvedNotePath).isFile()) {
				throw new Error(`The linked md-log note is not readable: ${resolvedNotePath}`);
			}
			const scan = scanVaultMastery(findVaultRootForNote(resolvedNotePath));
			const limit = params.limit ?? 100;
			const search = searchVaultMastery(scan, params.query, limit);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						total: search.total,
						returned: search.concepts.length,
						truncated: search.total > search.concepts.length,
						concepts: search.concepts,
						diagnostics: search.diagnostics,
					}, null, 2),
				}],
				details: { total: search.total, returned: search.concepts.length, truncated: search.total > search.concepts.length },
			};
		},
	});

	pi.registerTool({
		name: "teach_free_response",
		label: "Teaching: Free Response",
		description: "Ask the learner an open-ended question and capture their typed answer as a structured teaching interaction.",
		promptSnippet: "Ask for a typed free response to a teaching question",
		promptGuidelines: [
			"Use teach_free_response for an open-ended answer that you will evaluate as evidence of understanding; do not use the global learning_ask_free_response tool.",
			"Include all needed context in the question itself. Supply a stable conceptId and question-specific 3-5 word summaryTitle.",
			"After evaluating the answer, call teach_record_attempt once with the same interactionId, the concept, outcome, evidenceType free_response, evidenceScore 0-10, inferred confidence 0-10, and a concise learner-facing explanation.",
			"Do not record an attempt for a cancelled or unavailable response.",
		],
		parameters: Type.Object({
			question: Type.String({ minLength: 1 }),
			conceptId: Type.Optional(Type.String({ minLength: 1 })),
			summaryTitle: Type.Optional(Type.String({ minLength: 1, description: "Question-specific 3-5 word md-log heading." })),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const question = params.question.trim();
			if (!question) throw new Error("question must contain non-whitespace text.");
			if (signal?.aborted) return cancelledResponse(question);
			if (!ctx.hasUI) return unavailableResponse(question);

			return withSharedUiLock(async () => {
				if (signal?.aborted) return cancelledResponse(question);
				const startedAt = Date.now();
				const response = await ctx.ui.editor(question);
				if (response === undefined) return cancelledResponse(question);

				const details: TeachingResponse & { status: "answered"; responseTimeMs: number } = {
					status: "answered",
					callId: toolCallId,
					interactionId: `teach-${randomUUID()}`,
					question,
					response,
					conceptId: params.conceptId?.trim() || undefined,
					summaryTitle: responseTitle(question, params.summaryTitle),
					responseTimeMs: Math.max(0, Date.now() - startedAt),
				};
				pi.appendEntry("teach-free-response", details);
				return {
					content: [{
						type: "text" as const,
						text: `Learner submitted this free response:\n${response}\n(interaction ${details.interactionId})`,
					}],
					details,
				};
			});
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("free response ")) + theme.fg("muted", args.question),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = isRecord(result.details) ? result.details : {};
			if (details.status === "cancelled") return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (details.status === "unavailable") return new Text(theme.fg("warning", "Unavailable: interactive UI required"), 0, 0);
			const response = typeof details.response === "string" ? details.response : "";
			const lineCount = response.split(/\r\n|\n|\r/).length;
			return new Text(theme.fg("success", `✓ Response submitted (${lineCount} ${lineCount === 1 ? "line" : "lines"})`), 0, 0);
		},
	});

	pi.registerTool({
		name: "teach_record_attempt",
		label: "Teaching: Record Attempt",
		description: "Record your evaluation of a completed teach_free_response interaction and update its concept mastery.",
		promptSnippet: "Record the learner's evaluated free-response attempt",
		promptGuidelines: [
			"Call this only after evaluating a completed teach_free_response answer.",
			"Use the exact interactionId returned by teach_free_response and evidenceType free_response.",
			"Include a concise explanation of the correct answer and key reasoning. Include misconception when the answer was incorrect.",
			"For quiz results, use the returned interactionId exactly. Binary quiz evidence must be 10 when correct and 0 when incorrect or 'I don't know'.",
			"Set evidenceScore from 0 to 10. Binary questions use 0 or 10; nuanced responses are graded against the learning goal and relevant curriculum context.",
			"Infer confidence from learner-authored scratchpad/note reasoning, especially evidence of doubt or second-guessing. Use 5 if confidence genuinely cannot be inferred; confidence only lightly adjusts evidence weight.",
		],
		parameters: Type.Object({
			interactionId: Type.String({ minLength: 1 }),
			conceptId: Type.String({ minLength: 1 }),
			outcome: Type.Union([Type.Literal("correct"), Type.Literal("partial"), Type.Literal("incorrect")]),
			evidenceType: Type.Union([Type.Literal("quiz"), Type.Literal("free_response")]),
			evidenceScore: Type.Number({ minimum: 0, maximum: 10 }),
			confidence: Type.Number({ minimum: 0, maximum: 10 }),
			explanation: Type.String({ minLength: 1, pattern: "\\S" }),
			misconception: Type.Optional(Type.String({ minLength: 1 })),
			reasoningSummary: Type.Optional(Type.String({ minLength: 1 })),
		}),

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const interactionId = params.interactionId.trim();
			const conceptId = params.conceptId.trim();
			const explanation = params.explanation.trim();
			if (!interactionId || !conceptId || !explanation) {
				throw new Error("interactionId, conceptId, and explanation must contain non-whitespace text.");
			}
			return serializeAttempts(async () => {
				const entries = ctx.sessionManager.getEntries();
				const linkedNotePath = readLinkedNotePath(entries);
				const notePath = linkedNotePath
					? path.isAbsolute(linkedNotePath) ? linkedNotePath : path.resolve(ctx.cwd, linkedNotePath)
					: null;
				let persistedMastery = new Map<string, MasteryRecord>();
				if (notePath) {
					if (!fs.existsSync(notePath) || !fs.statSync(notePath).isFile()) {
						throw new Error(`The linked md-log note is not readable: ${notePath}`);
					}
					persistedMastery = readMasteryFrontmatter(fs.readFileSync(notePath, "utf-8"));
				}
				const history = readTeachingHistory(entries, persistedMastery);
				const response = history.responses.get(interactionId);
				if (!response) throw new Error(`No completed teach_free_response interaction found for "${interactionId}".`);
				if (history.recordedInteractionIds.has(interactionId)) throw new Error(`An attempt is already recorded for interaction "${interactionId}".`);
				if (response.conceptId && response.conceptId !== conceptId) {
					throw new Error(`Interaction "${interactionId}" belongs to concept "${response.conceptId}", not "${conceptId}".`);
				}
				if (response.source !== params.evidenceType) {
					throw new Error(`Interaction "${interactionId}" is a ${response.source} interaction, not ${params.evidenceType}.`);
				}
				if (response.source === "quiz") {
					if (!response.conceptId) throw new Error(`Quiz "${interactionId}" has no conceptId; it cannot be recorded for mastery.`);
					const expectedOutcome = response.correct ? "correct" : "incorrect";
					const expectedScore = response.correct ? 10 : 0;
					if (params.outcome !== expectedOutcome || params.evidenceScore !== expectedScore) {
						throw new Error(`Quiz "${interactionId}" is ${expectedOutcome}; its evidenceScore must be ${expectedScore}.`);
					}
				}

				const sessionPreviousRecord = history.mastery.get(conceptId);
				let previousMastery = sessionPreviousRecord?.score;
				let masteryState = updateTeachingMastery(sessionPreviousRecord, {
					interactionId,
					score: params.evidenceScore,
					confidence: params.confidence,
					reasoningSummary: params.reasoningSummary,
				});
				const recordedAt = Date.now();
				if (notePath) {
					const evidence: PersistedMasteryEvidence = {
						conceptId,
						interactionId,
						score: params.evidenceScore,
						confidence: params.confidence,
						reasoningSummary: params.reasoningSummary?.trim() || undefined,
						recordedAt,
					};
					const synced = await withMdLogWriteLock(() =>
						syncMasteryAcrossVault(findVaultRootForNote(notePath), notePath, conceptId, {
							previousRecord: sessionPreviousRecord,
							nextRecord: masteryState,
							evidence,
						}),
					);
					previousMastery = synced.previousRecord?.score;
					masteryState = synced.record;
				}
				const details: AttemptEntry = {
					callId: toolCallId,
					interactionId,
					conceptId,
					outcome: params.outcome,
					evidenceType: params.evidenceType,
					explanation,
					misconception: params.misconception?.trim() || undefined,
					evidenceScore: params.evidenceScore,
					confidence: params.confidence,
					previousMastery,
					masteryState,
					persistedToLinkedNote: Boolean(notePath),
					recordedAt,
				};
				pi.appendEntry("teach-attempt", details);
				return {
					content: [{
						type: "text" as const,
						text: `${masteryState.score === undefined
							? `Recorded ${params.outcome} evidence for ${conceptId} (${masteryState.evidenceCount}/3 baseline questions). No mastery score is initialized yet.`
							: `Recorded ${params.outcome} evidence for ${conceptId}: ${previousMastery === undefined ? "baseline" : `${previousMastery.toFixed(2)} → `}${masteryState.score.toFixed(2)} / 10 mastery.`}` +
							(notePath ? "" : " This attempt is session-only until a linked md-log note is available."),
					}],
					details,
				};
			});
		},

		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("record attempt ")) +
					theme.fg("muted", `${args.conceptId} · ${args.outcome}`),
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = isRecord(result.details) ? result.details : {};
			const outcome = typeof details.outcome === "string" ? details.outcome : "Attempt";
			const conceptId = typeof details.conceptId === "string" ? details.conceptId : "concept";
			const masteryState = isRecord(details.masteryState) ? details.masteryState : undefined;
			if (!masteryState || typeof masteryState.evidenceCount !== "number") {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "Attempt could not be recorded.", 0, 0);
			}
			const explanation = typeof details.explanation === "string" ? details.explanation : "";
			const scoreLine = typeof masteryState.score === "number"
				? `${typeof details.previousMastery === "number" ? `${details.previousMastery.toFixed(2)} → ` : "Baseline → "}${masteryState.score.toFixed(2)} / 10 mastery`
				: `Baseline ${masteryState.evidenceCount}/3 · score not initialized`;
			return new Text(
				`${theme.fg("accent", `${outcome} · ${conceptId}`)}\n` +
					`${theme.fg("dim", scoreLine)}\n` +
					theme.fg("muted", explanation),
				0,
				0,
			);
		},
	});
}
