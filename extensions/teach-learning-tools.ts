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
	resolveTeachingResponse,
	updateTeachingMastery,
	type MasteryRecord,
	type TeachingOutcome,
	type TeachingResponse,
} from "../lib/teach-learning-state.ts";
import {
	findVaultRootForNote,
	scanVaultMastery,
	searchVaultMastery,
	searchVaultMasteryCandidates,
	previewMasteryConceptMerge,
	mergeMasteryConceptsAcrossVault,
	syncMasteryAcrossVault,
	type PersistedMasteryEvidence,
} from "../lib/mastery-vault.ts";
import {
	readMasteryConceptCatalog,
	registerMasteryConcept,
	resolveMasteryConceptId,
	searchMasteryConceptCatalog,
} from "../lib/mastery-concepts.ts";
import { withMdLogWriteLock } from "../lib/md-log-write-lock.ts";

interface AttemptEntry {
	callId: string;
	interactionId: string;
	conceptId: string;
	outcome: TeachingOutcome;
	evidenceType: "quiz" | "free_response";
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
			"The tool syncs only the resolved canonical concept ID. It replays stored unique evidence events; it never merges different concepts or guesses from timestamps.",
		],
		parameters: Type.Object({
			conceptId: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before syncing mastery.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			const vaultRoot = findVaultRootForNote(resolvedNotePath);
			const conceptId = resolveMasteryConceptId(readMasteryConceptCatalog(vaultRoot), params.conceptId.trim());
			const result = await withMdLogWriteLock(() =>
				syncMasteryAcrossVault(vaultRoot, resolvedNotePath, conceptId),
			);
			return {
				content: [{
					type: "text" as const,
					text: `Synchronized "${conceptId}" across ${result.files.length} changed note(s) using ${result.evidenceCount} unique evidence sample(s).`,
				}],
				details: { conceptId, files: result.files, evidenceCount: result.evidenceCount },
			};
		},
	});

	pi.registerTool({
		name: "teach_preview_mastery_merge",
		label: "Teaching: Preview Mastery Merge",
		description: "Preview the notes, evidence replay, and blockers for merging one registered concept into another without changing the vault.",
		promptSnippet: "Preview a proposed mastery concept merge",
		promptGuidelines: [
			"Call this before any merge. Explain the proposed canonical concept, affected notes, and evidence counts to the learner.",
			"Never merge concepts because their names are merely similar. Confirm that their learning goals and scope are equivalent.",
			"Ask the learner for explicit approval before calling teach_merge_mastery_concepts. Do not treat preview as approval.",
			"Legacy aggregate baselines without individual evidence cannot be safely replayed; respect merge blockers and do not bypass them.",
		],
		parameters: Type.Object({
			sourceId: Type.String({ minLength: 1 }),
			canonicalId: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before previewing a mastery merge.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			const preview = previewMasteryConceptMerge(
				findVaultRootForNote(resolvedNotePath),
				params.sourceId.trim(),
				params.canonicalId.trim(),
			);
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify(preview, null, 2),
				}],
				details: preview,
			};
		},
	});

	pi.registerTool({
		name: "teach_merge_mastery_concepts",
		label: "Teaching: Merge Mastery Concepts",
		description: "After explicit learner approval, merge fully replayable evidence into a canonical concept and rewrite affected note references.",
		promptSnippet: "Apply an approved, replayable mastery concept merge",
		promptGuidelines: [
			"Only call after previewing the same IDs and receiving explicit learner approval.",
			"Pass the exact previewToken from that preview. If the preview is stale or blocked, do not retry by weakening safeguards.",
			"Report the canonical record and changed notes after success. Do not edit unrelated note content.",
		],
		parameters: Type.Object({
			sourceId: Type.String({ minLength: 1 }),
			canonicalId: Type.String({ minLength: 1 }),
			previewToken: Type.String({ minLength: 1 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before merging mastery concepts.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			const vaultRoot = findVaultRootForNote(resolvedNotePath);
			const preview = previewMasteryConceptMerge(vaultRoot, params.sourceId.trim(), params.canonicalId.trim());
			if (preview.previewToken !== params.previewToken) {
				throw new Error("Mastery merge inputs changed after preview; no changes were made. Preview the merge again.");
			}
			if (!preview.canMerge) {
				throw new Error(`Mastery merge is blocked: ${preview.blockers.join("; ")}`);
			}
			if (!ctx.hasUI) throw new Error("Mastery merge requires interactive UI confirmation; no changes were made.");
			const mergeChoice = `Merge ${params.sourceId.trim()} into ${params.canonicalId.trim()}`;
			const confirmation = await withSharedUiLock(() => ctx.ui.select(
				`Confirm merge of ${preview.mergedEvidenceCount} evidence sample(s) across ${preview.affectedNotePaths.length} note(s)`,
				[mergeChoice, "Cancel"],
			));
			if (confirmation !== mergeChoice) {
				return {
					content: [{ type: "text" as const, text: "Mastery merge cancelled; no changes were made." }],
					details: { cancelled: true, sourceId: params.sourceId, canonicalId: params.canonicalId },
				};
			}
			const result = await withMdLogWriteLock(() =>
				mergeMasteryConceptsAcrossVault(
					vaultRoot,
					params.sourceId.trim(),
					params.canonicalId.trim(),
					params.previewToken,
				),
			);
			return {
				content: [{
					type: "text" as const,
					text: `Merged "${params.sourceId}" into "${params.canonicalId}" using ${result.preview.mergedEvidenceCount} replayed evidence sample(s); updated ${result.files.length} note(s).`,
				}],
				details: { ...result.preview, files: result.files },
			};
		},
	});

	pi.registerTool({
		name: "teach_register_mastery_concept",
		label: "Teaching: Register Mastery Concept",
		description: "Add a canonical learning concept to the vault catalogue without changing existing mastery IDs or records.",
		promptSnippet: "Register a canonical concept for consistent mastery tracking",
		promptGuidelines: [
			"Search teach_find_mastery_concepts first. Register only a genuinely distinct concept or an existing uncatalogued ID that represents the same learning goal.",
			"Use a stable lowercase kebab-case conceptId, a concise canonical name, a broad-to-specific subjectPath, and a definition that clearly bounds what is being assessed.",
			"Add aliases only for alternate names that mean the same learning goal. Do not list related or prerequisite concepts as aliases.",
			"Register a parent before its child. This tool never changes existing catalogue entries or merges mastery records.",
		],
		parameters: Type.Object({
			conceptId: Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
			name: Type.String({ minLength: 1, maxLength: 160 }),
			subjectPath: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8 }),
			definition: Type.String({ minLength: 1, maxLength: 2000 }),
			aliases: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 30 })),
			parentId: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before registering a mastery concept.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			if (!fs.existsSync(resolvedNotePath) || !fs.statSync(resolvedNotePath).isFile()) {
				throw new Error(`The linked md-log note is not readable: ${resolvedNotePath}`);
			}
			const root = findVaultRootForNote(resolvedNotePath);
			const result = await withMdLogWriteLock(() => registerMasteryConcept(root, {
				id: params.conceptId,
				name: params.name,
				subjectPath: params.subjectPath,
				definition: params.definition,
				aliases: params.aliases ?? [],
				parentId: params.parentId,
			}));
			return {
				content: [{
					type: "text" as const,
					text: `Registered "${result.concept.id}" in the vault catalogue at ${path.join(root, "mastery-concepts.json")}.`,
				}],
				details: { catalogPath: path.join(root, "mastery-concepts.json"), concept: result.concept },
			};
		},
	});

	pi.registerTool({
		name: "teach_find_mastery_concepts",
		label: "Teaching: Find Mastery Concepts",
		description: "Search the vault's canonical concept catalogue and existing mastery IDs with their note records.",
		promptSnippet: "Search the vault's existing mastery concept IDs",
		promptGuidelines: [
			"Before choosing a conceptId for a graded quiz or free response, search for the learning goal and reuse an exact existing ID when it matches.",
			"Use ranked names, definitions, aliases, subject paths, and note paths to find candidates; confirm that the actual learning goal and scope match before reusing an ID.",
			"If a candidate has mergedInto, use that target canonical ID rather than the retired ID.",
			"Similar wording is not permission to merge concepts; use the explicit preview/approval/merge workflow only for genuinely equivalent goals.",
			"If the selected existing mastery ID is not yet catalogued, register that same ID with its canonical name, subjectPath, definition, and true synonyms.",
			"If the search returns no suitable concept, register a concise stable lowercase kebab-case ID before using it for mastery.",
		],
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Search canonical names, definitions, aliases, subject paths, IDs, note titles, and paths. Results are suggestions; confirm the learning goal before reusing or merging an ID." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum concepts to return; defaults to 100." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const notePath = readLinkedNotePath(ctx.sessionManager.getEntries());
			if (!notePath) throw new Error("Link a note with /md-log before searching the vault mastery catalogue.");
			const resolvedNotePath = path.isAbsolute(notePath) ? notePath : path.resolve(ctx.cwd, notePath);
			if (!fs.existsSync(resolvedNotePath) || !fs.statSync(resolvedNotePath).isFile()) {
				throw new Error(`The linked md-log note is not readable: ${resolvedNotePath}`);
			}
			const vaultRoot = findVaultRootForNote(resolvedNotePath);
			const scan = scanVaultMastery(vaultRoot);
			const limit = params.limit ?? 100;
			const search = searchVaultMastery(scan, params.query, limit);
			const catalog = readMasteryConceptCatalog(vaultRoot);
			const catalogSearch = searchMasteryConceptCatalog(catalog, params.query, limit);
			const candidates = searchVaultMasteryCandidates(scan, vaultRoot, params.query ?? "", Math.min(limit, 100));
			return {
				content: [{
					type: "text" as const,
					text: JSON.stringify({
						suggestions: {
							returned: candidates.length,
							limit: Math.min(limit, 100),
							limitReached: candidates.length === Math.min(limit, 100),
							candidates,
							note: "Ranked candidates are not automatic matches. Confirm the learning goal and scope before reusing an ID or requesting a merge.",
						},
						mastery: {
							total: search.total,
							returned: search.concepts.length,
							truncated: search.total > search.concepts.length,
							concepts: search.concepts,
						},
						catalog: {
							total: catalogSearch.total,
							returned: catalogSearch.concepts.length,
							truncated: catalogSearch.total > catalogSearch.concepts.length,
							concepts: catalogSearch.concepts,
						},
						diagnostics: search.diagnostics,
					}, null, 2),
				}],
				details: {
					masteryTotal: search.total,
					catalogTotal: catalogSearch.total,
					returned: search.concepts.length + catalogSearch.concepts.length,
					suggestions: candidates.length,
				},
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
		description: "Record your evaluation of a completed quiz or teach_free_response interaction and update its concept mastery.",
		promptSnippet: "Record the learner's evaluated teaching attempt",
		promptGuidelines: [
			"Call this only after evaluating a completed quiz or teach_free_response interaction.",
			"Use the exact interactionId returned by teach_free_response and evidenceType free_response.",
			"Include a concise explanation of the correct answer and key reasoning. Include misconception when the answer was incorrect.",
			"For quiz results, use the returned interactionId exactly and evidenceType quiz. Do not remove any suffix. If only the prefix is supplied, the tool accepts it only when it uniquely identifies one quiz. Binary quiz evidence must be 10 when correct and 0 when incorrect or 'I don't know'.",
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
			const requestedConceptId = params.conceptId.trim();
			const explanation = params.explanation.trim();
			if (!interactionId || !requestedConceptId || !explanation) {
				throw new Error("interactionId, conceptId, and explanation must contain non-whitespace text.");
			}
			return serializeAttempts(async () => {
				const entries = ctx.sessionManager.getEntries();
				const linkedNotePath = readLinkedNotePath(entries);
				const notePath = linkedNotePath
					? path.isAbsolute(linkedNotePath) ? linkedNotePath : path.resolve(ctx.cwd, linkedNotePath)
					: null;
				if (notePath && (!fs.existsSync(notePath) || !fs.statSync(notePath).isFile())) {
					throw new Error(`The linked md-log note is not readable: ${notePath}`);
				}
				const vaultRoot = notePath ? findVaultRootForNote(notePath) : null;
				const catalog = vaultRoot ? readMasteryConceptCatalog(vaultRoot) : null;
				const conceptId = catalog ? resolveMasteryConceptId(catalog, requestedConceptId) : requestedConceptId;
				let persistedMastery = new Map<string, MasteryRecord>();
				if (notePath) {
					persistedMastery = readMasteryFrontmatter(fs.readFileSync(notePath, "utf-8"));
				}
				const history = readTeachingHistory(entries, persistedMastery);
				const response = resolveTeachingResponse(history.responses, interactionId);
				if (!response) throw new Error(`No completed teaching interaction found for "${interactionId}".`);
				const resolvedInteractionId = response.interactionId;
				if (history.recordedInteractionIds.has(resolvedInteractionId)) throw new Error(`An attempt is already recorded for interaction "${resolvedInteractionId}".`);
				const responseConceptId = response.conceptId && catalog
					? resolveMasteryConceptId(catalog, response.conceptId)
					: response.conceptId;
				if (responseConceptId && responseConceptId !== conceptId) {
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

				const sessionPreviousRecord = history.mastery.get(conceptId) ??
					(catalog
						? [...history.mastery]
							.filter(([id]) => resolveMasteryConceptId(catalog, id) === conceptId)
							.map(([, record]) => record)
							.sort((left, right) => right.evidenceCount - left.evidenceCount)[0]
						: undefined);
				let previousMastery = sessionPreviousRecord?.score;
				let masteryState = updateTeachingMastery(sessionPreviousRecord, {
					interactionId: resolvedInteractionId,
					score: params.evidenceScore,
					confidence: params.confidence,
					reasoningSummary: params.reasoningSummary,
				});
				const recordedAt = Date.now();
				if (notePath) {
					if (!vaultRoot) throw new Error("Could not resolve the linked note's Obsidian vault root.");
					const evidence: PersistedMasteryEvidence = {
						conceptId,
						interactionId: resolvedInteractionId,
						evidenceType: params.evidenceType,
						outcome: params.outcome,
						score: params.evidenceScore,
						confidence: params.confidence,
						reasoningSummary: params.reasoningSummary?.trim() || undefined,
						recordedAt,
					};
					const synced = await withMdLogWriteLock(() =>
						syncMasteryAcrossVault(vaultRoot, notePath, conceptId, {
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
					interactionId: resolvedInteractionId,
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
