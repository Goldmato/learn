import * as path from "node:path";

export const TRANSCRIPT_START = "%% pi-md-log:start v1 %%";
export const TRANSCRIPT_END = "%% pi-md-log:end v1 %%";
export const TEACH_ATTACH_IMAGE_TOOL = "teach_attach_generated_image";
export const TEACH_IMAGE_ATTACHMENT_ENTRY = "teach-image-attachment";
export const TEACH_IMAGE_PLACEMENT_ENTRY = "teach-image-placement";
export const TEACH_BREEZE_TTS_PLACEMENT_ENTRY = "teach-breeze-tts-placement";

function quizScratchpadMarker(callId: string): string {
	return `<!-- pi-quiz-scratchpad:${encodeURIComponent(callId)} -->`;
}

export function extractQuizScratchpad(markdown: string, callId: string): string | undefined {
	const marker = quizScratchpadMarker(callId);
	const markerIndex = markdown.lastIndexOf(marker);
	if (markerIndex < 0) return undefined;

	const contentStart = markerIndex + marker.length;
	const nextMarker = markdown.indexOf("<!-- pi-quiz-scratchpad:", contentStart);
	const section = markdown.slice(contentStart, nextMarker < 0 ? undefined : nextMarker);
	const match = /^[ \t]*(?:\r?\n[ \t]*)+(`{3,})[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?=\r?\n|$)/.exec(section);
	const scratchpad = match?.[2]?.trim();
	return scratchpad || undefined;
}

export function appendQuizScratchpad(existing: string | undefined, addition: string | undefined): string | undefined {
	const parts = [existing?.trim(), addition?.trim()].filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);
export const TEACH_FREE_RESPONSE_TOOL = "teach_free_response";
export const TEACH_RECORD_ATTEMPT_TOOL = "teach_record_attempt";
const NON_MESSAGE_ENTRY_TYPES = new Set([
	"session",
	"branch_summary",
	"compaction",
	"model_change",
	"thinking_level_change",
	"custom_message",
	"session_info",
]);

export interface TranscriptOption {
	index: number;
	label: string;
}

export type TranscriptBlock =
	| { kind: "prose"; role: "user" | "assistant"; text: string }
	| { kind: "markdown"; file: string; markdown: string }
	| {
		kind: "quiz";
		callId: string;
		question: string;
		summaryTitle?: string;
		context?: string;
		options: TranscriptOption[];
		details?: Record<string, unknown>;
	}
	| {
		kind: "ask";
		callId: string;
		question: string;
		summaryTitle?: string;
		context?: string;
		options: TranscriptOption[];
		details?: Record<string, unknown>;
	}
	| {
		kind: "free_response";
		callId: string;
		interactionId: string;
		question: string;
		response: string;
		summaryTitle?: string;
		conceptId?: string;
	}
	| {
		kind: "attempt";
		callId: string;
		interactionId: string;
		conceptId: string;
		outcome: "correct" | "partial" | "incorrect";
		explanation: string;
		misconception?: string;
		previousMastery?: number;
		newMastery?: number;
		masteryState?: {
			score?: number;
			evidenceCount: number;
			evidenceWeight: number;
			evidenceSum?: number;
			lastInteractionId?: string;
			confidence: number;
			reasoningSummary?: string;
		};
		confidence?: number;
		evidenceScore?: number;
	}
	| {
		kind: "image";
		interactionId: string;
		sourcePath: string;
		filename: string;
	}
	| { kind: "group"; active: boolean; prefix?: string; title?: string };

export interface BackfillResult {
	blocks: TranscriptBlock[];
	entries: number;
	diagnostics: string[];
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function oneLineText(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

function normalizeHeadingTitle(value: string): string {
	const minorWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "off", "on", "or", "per", "so", "the", "to", "up", "via", "with", "yet"]);
	return oneLineText(value)
		.replace(/[-_]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.split(" ")
		.map((word, index) => {
			const lowercase = word.toLocaleLowerCase();
			if (/^[A-Z]{2,6}$/.test(word)) return word;
			if (index > 0 && minorWords.has(lowercase)) return lowercase;
			return word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
		})
		.join(" ");
}

function safeHighlightedLabel(label: string): string {
	return label.replace(/==/g, "&#61;&#61;").replace(/~~/g, "&#126;&#126;");
}

function optionList(options: TranscriptOption[], details?: Record<string, unknown>): string[] {
	const correctIndices = new Set(
		Array.isArray(details?.correctIndices)
			? details.correctIndices.filter((index): index is number => Number.isInteger(index))
			: [],
	);
	const selectedIndices = new Set(
		Array.isArray(details?.answers)
			? details.answers
				.filter((answer: unknown) => isRecord(answer) && Number.isInteger(answer.index))
				.map((answer: Record<string, any>) => answer.index as number)
			: [],
	);
	const answered = details?.status === "answered";
	const dontKnow = details?.dontKnow === true;

	return options.map(({ index, label }) => {
		const normalizedLabel = oneLineText(label);
		let rendered = normalizedLabel;
		if (answered && correctIndices.has(index)) rendered = `==🟢 ${safeHighlightedLabel(normalizedLabel)}==`;
		else if (answered && !dontKnow && selectedIndices.has(index)) rendered = `~~==🔴 ${safeHighlightedLabel(normalizedLabel)}==~~`;
		return `${index}. ${rendered}`;
	});
}

function callout(type: string, title: string, bodyLines: string[]): string {
	return [
		`> [!${type}] ${title}`,
		...bodyLines.flatMap((line) => line.split(/\r?\n/)).map((line) => line ? `> ${line}` : ">"),
	].join("\n");
}

function questionCallout(
	label: string,
	question: string,
	context: string | undefined,
	options: TranscriptOption[],
	details?: Record<string, unknown>,
): string {
	const body = question.split(/\r?\n/);
	if (context) body.push("", ...context.split(/\r?\n/));
	if (options.length > 0) body.push("", ...optionList(options, details));
	return callout("question", label, body);
}

function quizAnswerCallout(details: Record<string, unknown> | undefined): string {
	const status = details?.status;
	if (status === "cancelled") return callout("warning", "Quiz — cancelled", ["(user skipped)"]);
	if (status === "unavailable") return callout("warning", "Quiz — unavailable", [safeText(details?.message)]);
	if (status !== "answered") return callout("warning", "Quiz — feedback unavailable", ["Result metadata was incomplete."]);

	const dontKnow = details?.dontKnow === true;
	const correct = details?.correct === true;
	const type = dontKnow ? "question" : correct ? "success" : "failure";
	const title = dontKnow ? "Quiz — I don't know" : correct ? "Quiz — correct ✓" : "Quiz — incorrect ✗";
	const body: string[] = [];
	if (details?.note) body.push(`Note: ${safeText(details.note)}`);
	if (details?.explanation) {
		if (body.length > 0) body.push("");
		body.push(...safeText(details.explanation).split(/\r?\n/));
	}
	return callout(type, title, body.length > 0 ? body : [" "]);
}

function askAnswerCallout(details: Record<string, unknown> | undefined): string {
	if (details?.status === "cancelled") return callout("warning", "Question — cancelled", ["(user skipped)"]);
	if (details?.status === "unavailable") return callout("warning", "Question — unavailable", [safeText(details.message)]);

	const answers = Array.isArray(details?.answers) ? details.answers : [];
	const body = answers.filter(isRecord).map((answer) => {
		if (answer.type === "other") return `Other: ${safeText(answer.label)}`;
		if (answer.type === "text") return safeText(answer.label);
		return `${Number.isInteger(answer.index) ? answer.index : "?"}. ${safeText(answer.label)}`;
	});
	return callout("example", "Answer", body.length > 0 ? body : ["(no answer)"]);
}

function optionsFromUnknown(value: unknown): TranscriptOption[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((option, i) => {
		if (!isRecord(option) || typeof option.label !== "string") return [];
		const index = Number.isInteger(option.index) && option.index > 0 ? option.index : i + 1;
		return [{ index, label: option.label }];
	});
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function stripSkillBlocks(text: string): string {
	return text.replace(/<skill\b([^>]*)>[\s\S]*?<\/skill>/g, (_match, attrs: string) => {
		const name = /name="([^"]+)"/.exec(attrs)?.[1];
		return `> [!note] SKILL loaded: ${name ?? "(unknown)"}`;
	});
}

export function userBlock(text: string): string {
	const quotedText = text.split(/\r\n|\n|\r/).map((line) => line ? `> ${line}` : ">").join("\n");
	return `> [!quote] YOU\n\n${quotedText}`;
}

export function assistantBlock(text: string): string {
	const quotedText = text.split(/\r\n|\n|\r/).map((line) => line ? `> ${line}` : ">").join("\n");
	return `> [!abstract] PI\n\n${quotedText}`;
}

export function isNonSubstantiveAssistantUpdate(text: string): boolean {
	const sentences = text.trim().split(/(?<=[.!?])\s+/).filter(Boolean);
	if (sentences.length === 0) return true;
	const acknowledgements = /^(?:understood|got it|okay|ok|sure|sounds good|absolutely|certainly|noted|thanks|thank you)[.!]?$/i;
	const statusUpdates = /^(?:(?:i(?:'ve| have) (?:started|finished|completed|generated|placed|added|updated|saved|attached)\b)|(?:the (?:image|generation|job|file|lesson|plan|work)\b.*\b(?:generating|generated|finished|completed|ready|paused|waiting|background|checkpoint|linked note))|(?:it(?:'s| is) (?:generating|finished|ready)\b)|(?:i(?:'ll| will) (?:hold off|wait|continue)\b)|(?:say .+\bwhen you(?:'re| are) ready\b)|(?:let me know when you(?:'re| are) ready\b)).*$/i;
	return sentences.every((sentence) => acknowledgements.test(sentence.trim()) || statusUpdates.test(sentence.trim()));
}

export function formatImageNote(title: string, caption: string): string {
	const normalizedTitle = normalizeHeadingTitle(title);
	const safeCaption = caption.replace(/\s+/g, " ").trim().replace(/^>/, "\\>");
	if (!normalizedTitle || !safeCaption) throw new Error("Image note title and caption must contain text.");
	return `> [!quote] ${normalizedTitle}\n> *"${safeCaption}"*`;
}

function formatQuiz(block: Extract<TranscriptBlock, { kind: "quiz" }>, round: number): string {
	const pending = block.details === undefined;
	const question = questionCallout("Quiz", block.question, block.context, block.options, block.details);
	const scratchpad = typeof block.details?.scratchpad === "string" ? block.details.scratchpad : "";
	const backticks = Math.max(3, ...[...scratchpad.matchAll(/`+/g)].map((match) => match[0].length + 1));
	const fence = "`".repeat(backticks);
	const scratchpadBlock = [
		quizScratchpadMarker(block.callId),
		"",
		fence,
		scratchpad,
		fence,
	].join("\n");
	const answer = pending ? "" : quizAnswerCallout(block.details);
	const title = block.summaryTitle ? normalizeHeadingTitle(block.summaryTitle) : "";
	return [`## Round ${round}${title ? `: ${title}` : ""}`, question, scratchpadBlock, answer].filter(Boolean).join("\n\n");
}

function formatAsk(block: Extract<TranscriptBlock, { kind: "ask" }>, round: number): string {
	const question = questionCallout("Question", block.question, block.context, block.options);
	const answer = block.details === undefined ? "" : askAnswerCallout(block.details);
	const title = block.summaryTitle ? normalizeHeadingTitle(block.summaryTitle) : "";
	return [`## Question ${round}${title ? `: ${title}` : ""}`, question, answer].filter(Boolean).join("\n\n");
}

function formatFreeResponse(block: Extract<TranscriptBlock, { kind: "free_response" }>): string {
	const lineBreak = /\r\n|\n|\r/.exec(block.response);
	const firstSection = lineBreak ? block.response.slice(0, lineBreak.index) : block.response;
	const continuation = lineBreak
		? block.response.slice(lineBreak.index + lineBreak[0].length)
		: "";
	const responseCallout = callout("idea", "Learner's response", [firstSection]);
	const continuationQuote = continuation
		? continuation.split(/\r\n|\n|\r/).map((line) => line ? `> ${line}` : ">").join("\n")
		: "";
	return [
		`## ${normalizeHeadingTitle(block.summaryTitle || "Free response")}`,
		questionCallout("Prompt", block.question, undefined, []),
		responseCallout,
		continuationQuote,
	].filter(Boolean).join("\n\n");
}

function formatAttempt(block: Extract<TranscriptBlock, { kind: "attempt" }>): string {
	const type = block.outcome === "correct" ? "success" : block.outcome === "partial" ? "warning" : "failure";
	const title = block.outcome === "correct" ? "Correct" : block.outcome === "partial" ? "Partially correct" : "Incorrect";
	const body = [block.explanation];
	if (block.misconception) body.push("", `Misconception: ${block.misconception}`);
	if (block.masteryState?.score !== undefined) {
		const previous = block.previousMastery === undefined ? "Baseline" : block.previousMastery.toFixed(2);
		body.push("", `Mastery: ==🟣 ${previous} → ${block.masteryState.score.toFixed(2)} / 10==`);
	} else if (block.masteryState) {
		body.push("", `Mastery baseline: ${block.masteryState.evidenceCount}/3 questions — score withheld until the sample is sufficient.`);
	} else if (block.previousMastery !== undefined && block.newMastery !== undefined) {
		body.push("", `Legacy mastery (0–1 scale): ${block.previousMastery.toFixed(2)} → ${block.newMastery.toFixed(2)}`);
	}
	if (block.confidence !== undefined) body.push("", `Inferred confidence: ${block.confidence.toFixed(1)} / 10`);
	return [
		`## Attempt: ${normalizeHeadingTitle(block.conceptId)}`,
		callout(type, `Evaluation — ${title}`, body),
	].join("\n\n");
}

function groupHeading(prefix: string | undefined, title: string | undefined): string {
	const label = normalizeHeadingTitle(prefix?.trim() || "Section");
	const summary = title ? normalizeHeadingTitle(title) : "";
	return summary ? `# ${label}: ${summary}` : `# ${label}`;
}

export function renderTranscript(blocks: TranscriptBlock[]): string {
	const output: string[] = [];
	let explicitHeading: string | undefined;
	let autoQuizGroup = false;
	let quizRound = 0;
	let askRound = 0;

	for (const block of blocks) {
		if (block.kind === "group") {
			explicitHeading = block.active ? groupHeading(block.prefix, block.title) : undefined;
			autoQuizGroup = false;
			quizRound = 0;
			if (explicitHeading) output.push(explicitHeading);
			continue;
		}

		if (block.kind === "markdown") {
			if (block.markdown.trim()) output.push(block.markdown.trim());
			continue;
		}

		if (block.kind === "quiz") {
			if (!explicitHeading && !autoQuizGroup) {
				const title = block.summaryTitle ? normalizeHeadingTitle(block.summaryTitle) : "";
				output.push(title ? `# Quiz: ${title}` : "# Quiz");
				autoQuizGroup = true;
				quizRound = 0;
			}
			quizRound++;
			output.push(formatQuiz(block, quizRound));
			continue;
		}

		if (block.kind === "ask") {
			if (!explicitHeading) autoQuizGroup = false;
			askRound++;
			output.push(formatAsk(block, askRound));
			continue;
		}

		if (block.kind === "free_response") {
			const formatted = formatFreeResponse(block);
			if (formatted) output.push(formatted);
			continue;
		}

		if (block.kind === "attempt") {
			output.push(formatAttempt(block));
			continue;
		}

		if (block.kind === "image") {
			output.push(`![[${block.filename}]]`);
			continue;
		}

		if (block.role === "user" && !explicitHeading) autoQuizGroup = false;
		const text = block.role === "user" ? userBlock(block.text) : assistantBlock(block.text);
		if (text.trim()) output.push(text);
	}

	return output.filter(Boolean).join("\n\n");
}

export function renderTranscriptWithImagePlacements(
	transcript: string,
	entriesValue: unknown,
	notePath: string,
): string {
	if (!Array.isArray(entriesValue)) throw new Error("Session entries were not an array while rendering image placements.");
	const placements = new Map<string, Record<string, unknown>>();
	const audioPlacements = new Map<string, Record<string, unknown>>();
	const subagentRecords = new Map<string, Record<string, unknown>>();
	const resolvedNotePath = path.resolve(notePath);
	const entries = entriesValue.filter(isRecord);
	const byId = new Map<string, Record<string, any>>();
	for (const entry of entries) if (typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
	let current: Record<string, any> | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (typeof entries[index].id === "string" && entries[index].id) {
			current = entries[index];
			break;
		}
	}
	if (!current) throw new Error("No active session entry was found while rendering image placements.");
	const activeEntries: Record<string, any>[] = [];
	const seen = new Set<string>();
	while (current && typeof current.id === "string") {
		if (seen.has(current.id)) throw new Error(`Cycle detected in active session history at "${current.id}".`);
		seen.add(current.id);
		activeEntries.push(current);
		const parentId = current.parentId;
		current = typeof parentId === "string" && parentId ? byId.get(parentId) : undefined;
	}
	activeEntries.reverse();

	for (const entry of activeEntries) {
		if (!isRecord(entry) || entry.type !== "custom" || !isRecord(entry.data)) continue;
		if (entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY) {
			const data = entry.data;
			if (
				typeof data.markerId === "string" &&
				typeof data.status === "string" &&
				typeof data.notePath === "string" &&
				path.resolve(data.notePath) === resolvedNotePath
			) {
				placements.set(data.markerId, data);
			}
		} else if (entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY) {
			const data = entry.data;
			if (
				typeof data.markerId === "string" &&
				typeof data.status === "string" &&
				typeof data.notePath === "string" &&
				path.resolve(data.notePath) === resolvedNotePath
			) {
				audioPlacements.set(data.markerId, data);
			}
		} else if (entry.customType === "subagents:record" && typeof entry.data.id === "string") {
			subagentRecords.set(entry.data.id, entry.data);
		}
	}

	const insertions: Array<{ index: number; text: string }> = [];
	for (const [markerId, placement] of placements) {
		if (placement.status === "failed" || typeof placement.anchor !== "string" || !placement.anchor.trim()) continue;
		const caption = typeof placement.caption === "string"
			? placement.caption.replace(/\s+/g, " ").trim().replace(/^>/, "\\>")
			: "";
		if (!caption) throw new Error(`Image placement ${markerId} is missing its short explanatory caption.`);
		const attachmentPath = typeof placement.vaultRelativePath === "string" ? placement.vaultRelativePath : undefined;
		const title = typeof placement.captionTitle === "string" ? placement.captionTitle : "";
		const quote = formatImageNote(title || deriveImageNoteTitle(caption), caption);
		let replacement = `${quote}\n\n%%pi-comfyui-image:${markerId}%%`;
		const agentId = placement.agentId;
		const job = typeof agentId === "string" ? subagentRecords.get(agentId) : undefined;
		if (placement.status === "placed" && attachmentPath) {
			const parts = attachmentPath.split(/[\\/]/);
			const filename = parts.at(-1) ?? "";
			if (
				parts.some((part) => part !== "~comfyui" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(filename)
			) throw new Error(`Image placement ${markerId} returned an invalid vault-relative attachment path.`);
			replacement = `${quote}\n\n![[${parts.join("/")}]]`;
		} else if (job?.status === "completed") {
			const result = typeof job.result === "string" ? job.result : "";
			const status = /^status:\s*(success|failure)\s*$/m.exec(result)?.[1];
			if (status === "failure") continue;
			if (status !== "success") throw new Error(`Image-maker job ${agentId} completed without a recognized result status.`);
			const attachmentPath = /^attachmentPath:\s*(\S+)\s*$/m.exec(result)?.[1];
			if (!attachmentPath) throw new Error(`Image-maker job ${agentId} succeeded without returning its vault-relative attachment path.`);
			const parts = attachmentPath.split(/[\\/]/);
			const filename = parts.at(-1) ?? "";
			if (
				parts.some((part) => part !== "~comfyui" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(filename)
			) {
				throw new Error(`Image-maker job ${agentId} returned an invalid vault-relative attachment path.`);
			}
			replacement = `${quote}\n\n![[${parts.join("/")}]]`;
		} else if (job?.status === "failed" || job?.status === "cancelled") {
			continue;
		}

		const anchor = placement.anchor;
		const index = transcript.indexOf(anchor);
		if (index < 0) throw new Error(`Image insertion anchor for ${markerId} is no longer present in the rendered transcript.`);
		if (transcript.indexOf(anchor, index + anchor.length) >= 0) {
			throw new Error(`Image insertion anchor for ${markerId} is no longer unique in the rendered transcript.`);
		}
		insertions.push({ index: index + anchor.length, text: replacement });
	}

	for (const [markerId, placement] of audioPlacements) {
		if (placement.status === "cancelled" || typeof placement.anchor !== "string" || !placement.anchor.trim()) continue;
		let replacement = `%%pi-breeze-tts:${markerId}%%`;
		if (placement.status === "placed") {
			const attachmentPath = typeof placement.vaultRelativePath === "string" ? placement.vaultRelativePath : "";
			const parts = attachmentPath.split(/[\\/]/);
			const filename = parts.at(-1) ?? "";
			if (
				parts.length !== 3 ||
				parts[0] !== "001-Attachments" ||
				parts[1] !== "~breezetts" ||
				!/^[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/i.test(filename)
			) throw new Error(`Breeze TTS placement ${markerId} returned an invalid vault-relative attachment path.`);
			replacement = `![[${parts.join("/")}]]`;
		}

		const anchor = placement.anchor;
		const index = transcript.indexOf(anchor);
		if (index < 0) throw new Error(`Breeze TTS insertion anchor for ${markerId} is no longer present in the rendered transcript.`);
		if (transcript.indexOf(anchor, index + anchor.length) >= 0) {
			throw new Error(`Breeze TTS insertion anchor for ${markerId} is no longer unique in the rendered transcript.`);
		}
		insertions.push({ index: index + anchor.length, text: replacement });
	}

	let rendered = transcript;
	insertions.sort((left, right) => right.index - left.index);
	for (const insertion of insertions) {
		const before = rendered.slice(0, insertion.index);
		const after = rendered.slice(insertion.index);
		const separator = before.endsWith("\n") ? "\n" : "\n\n";
		const trailingNewline = after.startsWith("\n") ? "" : "\n";
		rendered = `${before}${separator}${insertion.text}${trailingNewline}${after}`;
	}
	return rendered;
}

function deriveImageNoteTitle(caption: string): string {
	const ignoredWords = new Set(["a", "an", "and", "are", "as", "by", "for", "from", "how", "in", "into", "is", "it", "of", "on", "that", "the", "this", "to", "what", "which", "with"]);
	const normalized = caption
		.replace(/\b(?:shows?|illustrates?|depicts?|reveals?|demonstrates?|explains?|represents?|captures?|highlights?)\b/gi, " ")
		.replace(/[^\p{L}\p{N}\s-]/gu, " ")
		.split(/\s+/)
		.filter((word) => word && !ignoredWords.has(word.toLocaleLowerCase()))
		.slice(0, 5)
		.join(" ");
	return normalized || "Visual Description";
}

export function extractManagedTranscript(markdown: string): string | undefined {
	const starts = [...markdown.matchAll(new RegExp(TRANSCRIPT_START, "g"))].map((match) => match.index!);
	const ends = [...markdown.matchAll(new RegExp(TRANSCRIPT_END, "g"))].map((match) => match.index!);
	for (let i = starts.length - 1; i >= 0; i--) {
		const start = starts[i];
		const end = ends.find((candidate) => candidate > start);
		if (end === undefined) continue;
		let content = markdown.slice(start + TRANSCRIPT_START.length, end);
		content = content.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
		return content.trim() ? content : undefined;
	}
	return undefined;
}

export function replaceManagedTranscript(existing: string, transcript: string): string {
	if (!transcript.trim()) return existing;
	const starts = [...existing.matchAll(new RegExp(TRANSCRIPT_START, "g"))].map((match) => match.index!);
	const ends = [...existing.matchAll(new RegExp(TRANSCRIPT_END, "g"))].map((match) => match.index!);
	const section = `${TRANSCRIPT_START}\n${transcript.trim()}\n${TRANSCRIPT_END}`;

	for (let i = starts.length - 1; i >= 0; i--) {
		const start = starts[i];
		const end = ends.find((candidate) => candidate > start);
		if (end !== undefined) {
			const afterEnd = end + TRANSCRIPT_END.length;
			return `${existing.slice(0, start)}${section}${existing.slice(afterEnd)}`;
		}
	}

	const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : existing.length > 0 ? "\n" : "";
	return `${existing}${prefix}${section}\n`;
}

function readBoundary(entry: Record<string, any>): TranscriptBlock | undefined {
	if (entry.type !== "custom" || !isRecord(entry.data)) return undefined;
	if (entry.customType === "md-log-quiz-group") {
		return {
			kind: "group",
			active: entry.data.active === true,
			prefix: "Quiz",
			title: safeText(entry.data.title),
		};
	}
	if (entry.customType === "md-log-section") {
		return {
			kind: "group",
			active: entry.data.active === true,
			prefix: safeText(entry.data.prefix) || "Teaching",
			title: safeText(entry.data.title),
		};
	}
	return undefined;
}

export function buildBackfill(entriesValue: unknown): BackfillResult {
	const diagnostics: string[] = [];
	if (!Array.isArray(entriesValue)) {
		return { blocks: [], entries: 0, diagnostics: ["Session entries were not an array."] };
	}
	const entries = entriesValue.filter(isRecord);
	if (entries.length !== entriesValue.length) diagnostics.push("Ignored malformed session entries.");

	const byId = new Map<string, Record<string, any>>();
	for (const entry of entries) if (typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
	let leaf: Record<string, any> | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (typeof entries[i].id === "string" && entries[i].id) {
			leaf = entries[i];
			break;
		}
	}
	if (!leaf) return { blocks: [], entries: 0, diagnostics: [...diagnostics, "No session entry with an id was found."] };

	const chain: Record<string, any>[] = [];
	const seen = new Set<string>();
	let current: Record<string, any> | undefined = leaf;
	let cycleAt: string | undefined;
	while (current && typeof current.id === "string") {
		if (seen.has(current.id)) {
			cycleAt = current.id;
			break;
		}
		seen.add(current.id);
		chain.push(current);
		const parentId = current.parentId;
		if (typeof parentId !== "string" || !parentId) break;
		const parent = byId.get(parentId);
		if (!parent) {
			diagnostics.push(`Missing parent session entry "${parentId}"; backfilled the reachable branch.`);
			break;
		}
		current = parent;
	}
	if (cycleAt) {
		diagnostics.push(`Cycle detected at session entry "${cycleAt}"; backfilled each reachable entry once.`);
	}
	chain.reverse();

	const blocks: TranscriptBlock[] = [];
	const importedMarkdown: Extract<TranscriptBlock, { kind: "markdown" }>[] = [];
	const toolCalls = new Map<string, {
		name: string;
		args: Record<string, any>;
		blockIndex: number;
		resultSeen: boolean;
	}>();
	let processed = 0;

	for (const entry of chain) {
		processed++;
		const boundary = readBoundary(entry);
		if (boundary) {
			blocks.push(boundary);
			continue;
		}
		if (entry.type === "custom") {
			if (entry.customType === "md-log-import" && isRecord(entry.data) && typeof entry.data.markdown === "string") {
				importedMarkdown.push({
					kind: "markdown",
					file: safeText(entry.data.file),
					markdown: entry.data.markdown,
				});
				continue;
			}
			if (entry.customType === "teach-free-response" && isRecord(entry.data)) {
				const { callId, interactionId, question, response, conceptId, summaryTitle } = entry.data;
				if ([callId, interactionId, question, response].every((value) => typeof value === "string")) {
					blocks.push({
						kind: "free_response",
						callId,
						interactionId,
						question,
						response,
						summaryTitle: typeof summaryTitle === "string" ? summaryTitle : undefined,
						conceptId: typeof conceptId === "string" ? conceptId : undefined,
					});
				} else {
					diagnostics.push("Ignored a malformed teaching free-response entry.");
				}
				continue;
			}
			if (entry.customType === "teach-attempt" && isRecord(entry.data)) {
				const data = entry.data;
				if (
					typeof data.callId === "string" &&
					typeof data.interactionId === "string" &&
					typeof data.conceptId === "string" &&
					(data.outcome === "correct" || data.outcome === "partial" || data.outcome === "incorrect") &&
					typeof data.explanation === "string" &&
					(data.previousMastery === undefined || (typeof data.previousMastery === "number" && Number.isFinite(data.previousMastery))) &&
					(data.newMastery === undefined || (typeof data.newMastery === "number" && Number.isFinite(data.newMastery)))
				) {
					const masteryState = isRecord(data.masteryState) &&
						Number.isInteger(data.masteryState.evidenceCount) &&
						typeof data.masteryState.evidenceWeight === "number" &&
						typeof data.masteryState.confidence === "number"
						? {
							score: typeof data.masteryState.score === "number" ? data.masteryState.score : undefined,
							evidenceCount: data.masteryState.evidenceCount,
							evidenceWeight: data.masteryState.evidenceWeight,
							evidenceSum: typeof data.masteryState.evidenceSum === "number" ? data.masteryState.evidenceSum : undefined,
							lastInteractionId: typeof data.masteryState.lastInteractionId === "string" ? data.masteryState.lastInteractionId : undefined,
							confidence: data.masteryState.confidence,
							reasoningSummary: typeof data.masteryState.reasoningSummary === "string" ? data.masteryState.reasoningSummary : undefined,
						}
						: undefined;
					blocks.push({
						kind: "attempt",
						callId: data.callId,
						interactionId: data.interactionId,
						conceptId: data.conceptId,
						outcome: data.outcome,
						explanation: data.explanation,
						misconception: typeof data.misconception === "string" ? data.misconception : undefined,
						previousMastery: data.previousMastery,
						newMastery: data.newMastery,
						masteryState,
						confidence: typeof data.confidence === "number" ? data.confidence : undefined,
						evidenceScore: typeof data.evidenceScore === "number" ? data.evidenceScore : undefined,
					});
				} else {
					diagnostics.push("Ignored a malformed teaching attempt entry.");
				}
				continue;
			}
			if (entry.customType === "teach-image-attachment" && isRecord(entry.data)) {
				const { interactionId, sourcePath, filename } = entry.data;
				if (
					typeof interactionId === "string" &&
					typeof sourcePath === "string" &&
					typeof filename === "string" &&
					/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(filename)
				) {
					blocks.push({ kind: "image", interactionId, sourcePath, filename });
				} else {
					diagnostics.push("Ignored a malformed teaching image attachment entry.");
				}
				continue;
			}
			if (entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY || entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY) continue;
			if (entry.customType !== "md-log") diagnostics.push(`Ignored unsupported custom entry "${safeText(entry.customType) || "(unknown)"}".`);
			continue;
		}
		if (typeof entry.type === "string" && NON_MESSAGE_ENTRY_TYPES.has(entry.type)) continue;
		if (entry.type !== "message") {
			diagnostics.push(`Ignored session entry with unsupported type "${safeText(entry.type) || "(missing)"}".`);
			continue;
		}
		if (!isRecord(entry.message)) {
			diagnostics.push(`Ignored malformed message entry "${safeText(entry.id) || "(unknown)"}".`);
			continue;
		}
		const message = entry.message;
		if (message.role === "user") {
			const text = stripSkillBlocks(contentText(message.content).trim());
			if (text) blocks.push({ kind: "prose", role: "user", text });
			continue;
		}
		if (message.role === "assistant") {
			if (!Array.isArray(message.content)) {
				diagnostics.push(`Ignored malformed assistant content in entry "${safeText(entry.id) || "(unknown)"}".`);
				continue;
			}
			for (const part of message.content) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					if (!isNonSubstantiveAssistantUpdate(part.text)) {
						blocks.push({ kind: "prose", role: "assistant", text: part.text.trim() });
					}
					continue;
				}
				if (part.type === "toolCall" && QA_TOOLS.has(part.name)) {
					if (typeof part.id !== "string" || !isRecord(part.arguments)) {
						diagnostics.push("Ignored a malformed question tool call.");
						continue;
					}
					if (toolCalls.has(part.id)) {
						diagnostics.push(`Ignored duplicate question tool call id "${part.id}".`);
						continue;
					}
					const options = part.name !== "quiz" || part.arguments.shuffle === false
						? optionsFromUnknown(part.arguments.options)
						: [];
					const common = {
						callId: part.id,
						question: safeText(part.arguments.question).trim() || "(Question unavailable)",
						summaryTitle: safeText(part.arguments.summaryTitle).trim() || undefined,
						context: safeText(part.arguments.details).trim() || undefined,
						options,
					};
					const block: TranscriptBlock = part.name === "quiz"
						? { kind: "quiz", ...common }
						: { kind: "ask", ...common };
					const blockIndex = blocks.push(block) - 1;
					toolCalls.set(part.id, { name: part.name, args: part.arguments, blockIndex, resultSeen: false });
				}
			}
			continue;
		}
		if (message.role !== "toolResult") {
			diagnostics.push(`Ignored message with unsupported role "${safeText(message.role) || "(missing)"}".`);
			continue;
		}
		if (!QA_TOOLS.has(message.toolName)) continue;

		const callId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const call = toolCalls.get(callId);
		if (!call) {
			diagnostics.push(`Ignored unmatched ${message.toolName} result${callId ? ` "${callId}"` : ""}.`);
			continue;
		}
		if (call.name !== message.toolName) {
			diagnostics.push(`Ignored mismatched ${message.toolName} result for "${call.name}" tool call "${callId}".`);
			continue;
		}
		call.resultSeen = true;
		const details = isRecord(message.details) ? message.details as Record<string, unknown> : undefined;
		if (!details) diagnostics.push(`Question result "${callId || "(unknown)"}" has missing or malformed details.`);
		const displayedOptions = optionsFromUnknown(details?.options);
		const optionsAreKnown = call.name !== "quiz" || call.args.shuffle === false;
		const options = displayedOptions.length > 0
			? displayedOptions
			: optionsAreKnown
				? optionsFromUnknown(call.args.options)
				: [];
		if (call.name === "quiz" && details?.status === "answered" && displayedOptions.length === 0 && call.args.shuffle !== false) {
			diagnostics.push(`Quiz result "${callId}" has no saved display order; omitted options to avoid marking the wrong labels.`);
		}
		const question = safeText(call.args.question).trim();
		const common = {
			callId,
			question: question || "(Question unavailable)",
			summaryTitle: safeText(call.args.summaryTitle).trim() || undefined,
			context: safeText(call.args.details).trim() || undefined,
			options,
			details: details ?? { status: "unavailable", message: "Question result metadata was missing." },
		};
		blocks[call.blockIndex] = call.name === "quiz" ? { kind: "quiz", ...common } : { kind: "ask", ...common };
	}

	for (const [callId, call] of toolCalls) {
		if (call.resultSeen) continue;
		if (call.name === "quiz" && call.args.shuffle !== false) {
			diagnostics.push(`Unanswered quiz "${callId}" has no saved display order; omitted options rather than assuming their order.`);
		}
		diagnostics.push(`Question tool call "${callId}" has no result; included its unanswered prompt.`);
	}

	return { blocks: [...importedMarkdown, ...blocks], entries: processed, diagnostics };
}
