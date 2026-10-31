import * as path from "node:path";
import { placementAnchorMarkerFromData } from "./placement-recovery.ts";

export const TRANSCRIPT_START = "%% pi-md-log:start v1 %%";
export const TRANSCRIPT_END = "%% pi-md-log:end v1 %%";
export const TEACH_ATTACH_IMAGE_TOOL = "teach_attach_generated_image";
export const TEACH_BREEZE_TTS_TOOL = "teach_breeze_tts";
export const TEACH_COMFYUI_PAINT_TOOL = "teach_comfyui_paint";
export const TEACH_VISUAL_TOOL = "teach_visual";
export const TEACH_IMAGE_ATTACHMENT_ENTRY = "teach-image-attachment";
export const TEACH_IMAGE_PLACEMENT_ENTRY = "teach-image-placement";
export const TEACH_BREEZE_TTS_PLACEMENT_ENTRY = "teach-breeze-tts-placement";
export const TEACH_VISUAL_PLACEMENT_ENTRY = "teach-visual-placement";
export const TEACH_ATTACH_VISUAL_TOOL = "teach_attach_generated_visual";

/** The two picture makers that publish into the vault and embed like an image. */
export type VisualKind = "mermaid" | "svg";
export const VISUAL_KINDS: Record<VisualKind, { folder: string; label: string }> = {
	mermaid: { folder: "~mermaid", label: "Mermaid diagram" },
	svg: { folder: "~svg", label: "SVG picture" },
};

export function isVisualKind(value: unknown): value is VisualKind {
	return value === "mermaid" || value === "svg";
}

export function visualMarker(kind: VisualKind, markerId: string): string {
	return `%%pi-visual:${kind}:${markerId}%%`;
}

const IGNORED_CUSTOM_METADATA_TYPES = new Set([
	"breeze-voice-preset",
	TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
	TEACH_IMAGE_PLACEMENT_ENTRY,
	TEACH_VISUAL_PLACEMENT_ENTRY,
	"subagents:record",
]);

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
	| { kind: "prose"; role: "user" | "assistant"; text: string; entryId?: string }
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
	| {
		kind: "image_placement";
		markerId: string;
		status: "pending" | "placed";
		captionTitle: string;
		caption: string;
		attachmentPath?: string;
	}
	| {
		kind: "visual_placement";
		visualKind: VisualKind;
		markerId: string;
		status: "pending" | "placed";
		captionTitle: string;
		caption: string;
		attachmentPath?: string;
	}
	| {
		kind: "audio";
		markerId: string;
		status: "pending" | "placed";
		attachmentPath?: string;
		transcriptDescription?: string;
		transcript?: string;
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

		if (block.kind === "image_placement") {
			const quote = formatImageNote(block.captionTitle, block.caption);
			output.push(block.status === "placed" && block.attachmentPath
				? `${quote}\n\n![[${block.attachmentPath}]]`
				: `${quote}\n\n%%pi-comfyui-image:${block.markerId}%%`);
			continue;
		}

		if (block.kind === "visual_placement") {
			const quote = formatImageNote(block.captionTitle, block.caption);
			output.push(block.status === "placed" && block.attachmentPath
				? `${quote}\n\n![[${block.attachmentPath}]]`
				: `${quote}\n\n${visualMarker(block.visualKind, block.markerId)}`);
			continue;
		}

		if (block.kind === "audio") {
			if (block.status === "placed" && block.attachmentPath) {
				const embed = `![[${block.attachmentPath}]]`;
				output.push(typeof block.transcriptDescription === "string" && typeof block.transcript === "string"
					? `${embed}\n\n${renderAudioTranscriptCallout(block.transcriptDescription, block.transcript)}`
					: embed);
			} else {
				output.push(`%%pi-breeze-tts:${block.markerId}%%`);
			}
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

interface ActiveChain {
	chain: Record<string, any>[];
	order: Map<string, number>;
}

function readActiveChain(entriesValue: unknown, purpose: string): ActiveChain {
	if (!Array.isArray(entriesValue)) throw new Error(`Session entries were not an array while ${purpose}.`);
	const entries = entriesValue.filter(isRecord);
	const byId = new Map<string, Record<string, any>>();
	for (const entry of entries) if (typeof entry.id === "string" && entry.id) byId.set(entry.id, entry);
	let leaf: Record<string, any> | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (typeof entries[index].id === "string" && entries[index].id) {
			leaf = entries[index];
			break;
		}
	}
	if (!leaf) throw new Error(`No active session entry was found while ${purpose}.`);
	const chain: Record<string, any>[] = [];
	// Identity, not id: a pruned entry can leave two entries sharing an id.
	const seen = new Set<Record<string, any>>();
	let current: Record<string, any> | undefined = leaf;
	while (current) {
		seen.add(current);
		chain.push(current);
		const parentId = current.parentId;
		const parent = typeof parentId === "string" && parentId ? byId.get(parentId) : undefined;
		// A pruned entry leaves a dangling or self-referencing parentId; fall back to
		// array order so the rest of the history stays reachable.
		const fallback = previousEntry(entries, current);
		current = parent && !seen.has(parent) ? parent : fallback && !seen.has(fallback) ? fallback : undefined;
	}
	chain.reverse();
	const order = new Map<string, number>();
	chain.forEach((entry, index) => order.set(entry.id, index));
	return { chain, order };
}

function previousEntry(entries: Record<string, any>[], current: Record<string, any>): Record<string, any> | undefined {
	const index = entries.indexOf(current);
	return index > 0 ? entries[index - 1] : undefined;
}

function placementTargetPath(data: Record<string, unknown>, resolvedNotePath: string): boolean {
	return typeof data.notePath === "string" && path.resolve(data.notePath) === resolvedNotePath;
}

function validAudioAttachmentPath(attachmentPath: string): string | undefined {
	const parts = attachmentPath.split(/[\\/]/);
	const filename = parts.at(-1) ?? "";
	if (
		parts.length !== 3 ||
		parts[0] !== "001-Attachments" ||
		parts[1] !== "~breezetts" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/i.test(filename)
	) return undefined;
	return parts.join("/");
}

function validImageAttachmentPath(attachmentPath: string): string | undefined {
	const parts = attachmentPath.split(/[\\/]/);
	const filename = parts.at(-1) ?? "";
	if (
		parts.some((part) => part !== "~comfyui" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|jpe?g|webp|gif)$/i.test(filename)
	) return undefined;
	return parts.join("/");
}

function validVisualAttachmentPath(kind: VisualKind, attachmentPath: string): string | undefined {
	const parts = attachmentPath.split(/[\\/]/);
	const filename = parts.at(-1) ?? "";
	const folder = VISUAL_KINDS[kind].folder;
	if (
		parts.some((part) => part !== folder && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(filename)
	) return undefined;
	return parts.join("/");
}

function audioTranscriptMetadata(
	placement: Record<string, unknown>,
	subagentRecords: Map<string, Record<string, unknown>>,
): { transcriptDescription?: string; transcript?: string } {
	let transcriptDescription = placement.transcriptDescription;
	let audioTranscript = placement.transcript;
	if (transcriptDescription !== undefined || audioTranscript !== undefined) {
		return {
			transcriptDescription: typeof transcriptDescription === "string" ? transcriptDescription : undefined,
			transcript: typeof audioTranscript === "string" ? audioTranscript : undefined,
		};
	}
	const agentId = placement.agentId;
	if (typeof agentId !== "string") return {};
	const job = subagentRecords.get(agentId);
	const result = job?.status === "completed" && typeof job.result === "string" ? job.result : "";
	if (!/^status:\s*success\s*$/m.test(result)) return {};
	transcriptDescription = /^audioDescription:\s*(.*)\s*$/m.exec(result)?.[1]?.trim();
	const transcriptJson = /^transcript:\s*(.*)\s*$/m.exec(result)?.[1];
	if (transcriptJson !== undefined) {
		try {
			audioTranscript = JSON.parse(transcriptJson);
		} catch {
			throw new Error(`Breeze TTS placement ${String(placement.markerId)} has an invalid JSON transcript in its subagent result.`);
		}
	}
	return {
		transcriptDescription: typeof transcriptDescription === "string" ? transcriptDescription : undefined,
		transcript: typeof audioTranscript === "string" ? audioTranscript : undefined,
	};
}

/**
 * Turn the session's placement entries into renderable blocks positioned by
 * session order. Placement entries are appended right after the message that
 * carried their anchor, so the entry chain itself is the durable anchor; the
 * recorded passage text is only a fallback for placements imported from a note
 * or an older session.
 *
 * Resolution never throws for a lost anchor: an unresolvable placement is
 * appended to the end of the transcript so already-generated audio can never be
 * dropped by a refresh.
 */
export function applyPlacements(
	blocks: TranscriptBlock[],
	entriesValue: unknown,
	notePath: string,
	durableMarkdown = "",
): TranscriptBlock[] {
	blocks = blocks.map((block) => ({ ...block }));
	const resolvedNotePath = path.resolve(notePath);
	const { chain, order } = readActiveChain(entriesValue, "applying placements");
	const subagentRecords = new Map<string, Record<string, unknown>>();
	const imagePlacements = new Map<string, { data: Record<string, unknown>; order: number }>();
	const visualPlacements = new Map<string, { data: Record<string, unknown>; order: number }>();
	const audioPlacements = new Map<string, { data: Record<string, unknown>; order: number }>();

	chain.forEach((entry, index) => {
		if (entry.type !== "custom" || !isRecord(entry.data)) return;
		const data = entry.data;
		if (entry.customType === "subagents:record" && typeof data.id === "string") {
			subagentRecords.set(data.id, data);
			return;
		}
		if (typeof data.markerId !== "string" || typeof data.status !== "string") return;
		if (!placementTargetPath(data, resolvedNotePath)) return;
		if (entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY) {
			imagePlacements.set(data.markerId, { data, order: index });
		} else if (entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY) {
			visualPlacements.set(data.markerId, { data, order: index });
		} else if (entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY) {
			audioPlacements.set(data.markerId, { data, order: index });
		}
	});
	if (imagePlacements.size === 0 && visualPlacements.size === 0 && audioPlacements.size === 0) return blocks;

	type AnchorMatch = { blockIndex: number; offset: number };
	function findAnchorMatches(anchor: string): AnchorMatch[] {
		const matches: AnchorMatch[] = [];
		blocks.forEach((block, blockIndex) => {
			const text = block.kind === "prose" ? block.text : block.kind === "markdown" ? block.markdown : "";
			for (let offset = text.indexOf(anchor); offset >= 0; offset = text.indexOf(anchor, offset + anchor.length)) {
				matches.push({ blockIndex, offset });
			}
		});
		return matches;
	}

	function durableAnchorOrdinal(anchor: string, anchorMarker: string): number | undefined {
		const markerIndex = durableMarkdown.indexOf(anchorMarker);
		if (markerIndex < 0 || durableMarkdown.indexOf(anchorMarker, markerIndex + anchorMarker.length) >= 0) {
			return undefined;
		}
		const startMarker = "%% pi-md-log:start v1 %%";
		const endMarker = "%% pi-md-log:end v1 %%";
		const managedStart = durableMarkdown.indexOf(startMarker);
		const contentStart = managedStart < 0 ? -1 : managedStart + startMarker.length;
		const managedEnd = contentStart < 0 ? -1 : durableMarkdown.indexOf(endMarker, contentStart);
		if (contentStart < 0 || managedEnd < 0 || markerIndex < contentStart || markerIndex >= managedEnd) return -1;
		const anchorIndex = durableMarkdown.lastIndexOf(anchor, markerIndex);
		if (anchorIndex < contentStart || anchorIndex + anchor.length > managedEnd ||
			durableMarkdown.slice(anchorIndex + anchor.length, markerIndex).trim()) return -1;
		let ordinal = 0;
		for (let index = durableMarkdown.indexOf(anchor, contentStart);
			index >= contentStart && index < anchorIndex;
			index = durableMarkdown.indexOf(anchor, index + anchor.length)) {
			ordinal++;
		}
		return ordinal;
	}

	const anchorTargets = new Map<string, number>();
	const stablePlacements = [
		...[...imagePlacements].map(([markerId, value]) => ({ markerId, data: value.data })),
		...[...visualPlacements].map(([markerId, value]) => ({ markerId, data: value.data })),
		...[...audioPlacements].map(([markerId, value]) => ({ markerId, data: value.data })),
	].filter(({ data }) => data.status !== "failed" && data.status !== "cancelled");
	const annotations = new Map<number, Array<{ end: number; marker: string }>>();
	for (const { markerId, data } of stablePlacements) {
		const anchorMarker = placementAnchorMarkerFromData(data, markerId);
		if (anchorMarker === undefined) continue;
		if (typeof data.anchor !== "string" || !data.anchor.trim()) {
			throw new Error(`Cannot safely reconcile Generated placement ${markerId} without its anchor text.`);
		}
		const matches = findAnchorMatches(data.anchor);
		let match: AnchorMatch | undefined;
		if (typeof anchorMarker === "string") {
			const ordinal = durableAnchorOrdinal(data.anchor, anchorMarker);
			if (ordinal === -1) {
				throw new Error(`Cannot safely reconcile Generated placement ${markerId}; its anchor ID marker moved away from its anchor.`);
			}
			match = ordinal === undefined
				? matches.length === 1 ? matches[0] : undefined
				: matches[ordinal];
		} else if (matches.length === 1) {
			match = matches[0];
		}
		if (!match) {
			throw new Error(`Cannot safely reconcile Generated placement ${markerId}; resolve or regenerate it before refreshing the note.`);
		}
		if (typeof anchorMarker !== "string") continue;
		const group = annotations.get(match.blockIndex) ?? [];
		group.push({ end: match.offset + data.anchor.length, marker: anchorMarker });
		annotations.set(match.blockIndex, group);
	}
	if (annotations.size > 0) {
		const annotatedBlocks: TranscriptBlock[] = [];
		blocks.forEach((block, blockIndex) => {
			const markers = annotations.get(blockIndex);
			const text = block.kind === "prose" ? block.text : block.kind === "markdown" ? block.markdown : "";
			if (!markers || (block.kind !== "prose" && block.kind !== "markdown")) {
				annotatedBlocks.push(block);
				return;
			}
			let cursor = 0;
			for (const boundary of [...new Set(markers.map((item) => item.end))].sort((a, b) => a - b)) {
				if (boundary <= cursor) continue;
				const ending = text.slice(cursor, boundary);
				const ids = markers.filter((item) => item.end === boundary).map((item) => item.marker);
				const separator = ending.endsWith(" ") || ending.endsWith("\n") ? "" : " ";
				const markedText = `${ending}${separator}${ids.join(" ")}`;
				annotatedBlocks.push(block.kind === "prose"
					? { ...block, text: markedText }
					: { ...block, markdown: markedText });
				for (const id of ids) anchorTargets.set(id, annotatedBlocks.length);
				cursor = boundary;
			}
			if (cursor < text.length) {
				const remainder = text.slice(cursor);
				annotatedBlocks.push(block.kind === "prose"
					? { ...block, text: remainder }
					: { ...block, markdown: remainder });
			}
		});
		blocks = annotatedBlocks;
	}

	const blockOrder = blocks.map((block) => {
		const entryId = block.kind === "prose" ? block.entryId : undefined;
		return entryId === undefined ? -1 : order.get(entryId) ?? -1;
	});
	const durableText = `${durableMarkdown}\n${blocks
		.map((block) => block.kind === "prose" || block.kind === "markdown" ? block.text ?? block.markdown : "")
		.join("\n")}`;
	const claimed = new Set<string>();
	// Anchors that already hold durable audio in the note. A pending marker for
	// one of these would only duplicate the embed that is already there, unless
	// the anchor carries more placements than durable embeds.
	const durableAudioCount = new Map<string, number>();
	for (const artifact of readNoteAudioArtifacts(durableMarkdown)) {
		if (!AUDIO_EMBED_LINE.test(artifact.key) || !artifact.anchor) continue;
		durableAudioCount.set(artifact.anchor, (durableAudioCount.get(artifact.anchor) ?? 0) + 1);
	}
	const placementCount = new Map<string, number>();
	for (const { data } of audioPlacements.values()) {
		if (data.status === "cancelled" || data.status === "failed" || typeof data.anchor !== "string") continue;
		const anchor = normalizeAnchorLine(data.anchor);
		placementCount.set(anchor, (placementCount.get(anchor) ?? 0) + 1);
	}
	const durableAudioAnchors = new Set(
		[...durableAudioCount].filter(([anchor, count]) => count >= (placementCount.get(anchor) ?? 0)).map(([anchor]) => anchor),
	);

	function targetIndex(anchor: unknown, entryOrder: number, anchorMarker?: string | null): number {
		if (typeof anchor === "string" && anchor.trim()) {
			const matches = findAnchorMatches(anchor);
			if (anchorMarker === undefined) {
				if (matches[0]) return matches[0].blockIndex + 1;
			} else if (typeof anchorMarker === "string") {
				const target = anchorTargets.get(anchorMarker);
				if (target !== undefined) return target;
				if (matches.length === 1) return matches[0].blockIndex + 1;
			} else if (matches.length === 1) {
				return matches[0].blockIndex + 1;
			}
		}
		if (entryOrder >= 0) {
			for (let index = blockOrder.length - 1; index >= 0; index--) {
				if (blockOrder[index] >= 0 && blockOrder[index] <= entryOrder) return index + 1;
			}
		}
		return blocks.length;
	}

	const insertions: Array<{ index: number; seq: number; block: TranscriptBlock }> = [];
	// Attachment paths this render will emit. Imported note prose still carries the
	// embeds from the previous render, so those copies are dropped below.
	const emittedPaths = new Set<string>();
	let sequence = 0;

	for (const [markerId, { data, order: entryOrder }] of imagePlacements) {
		if (data.status === "failed" || data.status === "cancelled") continue;
		const caption = typeof data.caption === "string" ? data.caption.replace(/\s+/g, " ").trim().replace(/^>/, "\\>") : "";
		if (!caption) throw new Error(`Image placement ${markerId} is missing its short explanatory caption.`);
		const title = typeof data.captionTitle === "string" ? data.captionTitle : "";
		const marker = `%%pi-comfyui-image:${markerId}%%`;
		const agentId = data.agentId;
		const job = typeof agentId === "string" ? subagentRecords.get(agentId) : undefined;
		let status: "pending" | "placed" = "pending";
		let attachmentPath: string | undefined;

		if (data.status === "placed" && typeof data.vaultRelativePath === "string") {
			attachmentPath = validImageAttachmentPath(data.vaultRelativePath);
			if (!attachmentPath) throw new Error(`Image placement ${markerId} returned an invalid vault-relative attachment path.`);
			status = "placed";
		} else if (job?.status === "completed") {
			const result = typeof job.result === "string" ? job.result : "";
			const jobStatus = /^status:\s*(success|failure)\s*$/m.exec(result)?.[1];
			if (jobStatus === "failure") continue;
			if (jobStatus !== "success") throw new Error(`Image-maker job ${agentId} completed without a recognized result status.`);
			const resultPath = /^attachmentPath:\s*(\S+)\s*$/m.exec(result)?.[1];
			if (!resultPath) throw new Error(`Image-maker job ${agentId} succeeded without returning its vault-relative attachment path.`);
			attachmentPath = validImageAttachmentPath(resultPath);
			if (!attachmentPath) throw new Error(`Image-maker job ${agentId} returned an invalid vault-relative attachment path.`);
			status = "placed";
		} else if (job?.status === "failed" || job?.status === "cancelled") {
			continue;
		}

		const durable = attachmentPath ? `![[${attachmentPath}]]` : marker;
		// Unlike audio, image embeds are not carried over from the note, so a copy already
		// in the note must still be re-emitted here or the rebuild would silently drop it.
		if (claimed.has(durable)) continue;
		claimed.add(durable);
		if (attachmentPath) emittedPaths.add(attachmentPath);
		insertions.push({
			index: targetIndex(data.anchor, entryOrder, placementAnchorMarkerFromData(data, markerId)),
			seq: sequence++,
			block: { kind: "image_placement", markerId, status, captionTitle: title || deriveImageNoteTitle(caption), caption, attachmentPath },
		});
	}

	for (const [markerId, { data, order: entryOrder }] of visualPlacements) {
		if (data.status === "failed" || data.status === "cancelled") continue;
		const visualKind = isVisualKind(data.visualKind) ? data.visualKind : undefined;
		if (!visualKind) throw new Error(`Visual placement ${markerId} is missing its diagram kind.`);
		const caption = typeof data.caption === "string" ? data.caption.replace(/\s+/g, " ").trim().replace(/^>/, "\\>") : "";
		if (!caption) throw new Error(`Visual placement ${markerId} is missing its short explanatory caption.`);
		const title = typeof data.captionTitle === "string" ? data.captionTitle : "";
		const marker = visualMarker(visualKind, markerId);
		const agentId = data.agentId;
		const job = typeof agentId === "string" ? subagentRecords.get(agentId) : undefined;
		let status: "pending" | "placed" = "pending";
		let attachmentPath: string | undefined;

		if (data.status === "placed" && typeof data.vaultRelativePath === "string") {
			attachmentPath = validVisualAttachmentPath(visualKind, data.vaultRelativePath);
			if (!attachmentPath) throw new Error(`Visual placement ${markerId} returned an invalid vault-relative attachment path.`);
			status = "placed";
		} else if (job?.status === "completed") {
			const result = typeof job.result === "string" ? job.result : "";
			const jobStatus = /^status:\s*(success|failure)\s*$/m.exec(result)?.[1];
			if (jobStatus === "failure") continue;
			if (jobStatus !== "success") throw new Error(`Visual-maker job ${agentId} completed without a recognized result status.`);
			const resultPath = /^attachmentPath:\s*(\S+)\s*$/m.exec(result)?.[1];
			if (!resultPath) throw new Error(`Visual-maker job ${agentId} succeeded without returning its vault-relative attachment path.`);
			attachmentPath = validVisualAttachmentPath(visualKind, resultPath);
			if (!attachmentPath) throw new Error(`Visual-maker job ${agentId} returned an invalid vault-relative attachment path.`);
			status = "placed";
		} else if (job?.status === "failed" || job?.status === "cancelled") {
			continue;
		}

		const durable = attachmentPath ? `![[${attachmentPath}]]` : marker;
		// Like images, a published picture is re-emitted on every rebuild so a refresh
		// cannot delete it from the note.
		if (claimed.has(durable)) continue;
		claimed.add(durable);
		if (attachmentPath) emittedPaths.add(attachmentPath);
		insertions.push({
			index: targetIndex(data.anchor, entryOrder, placementAnchorMarkerFromData(data, markerId)),
			seq: sequence++,
			block: { kind: "visual_placement", visualKind, markerId, status, captionTitle: title || deriveImageNoteTitle(caption), caption, attachmentPath },
		});
	}

	for (const [markerId, { data, order: entryOrder }] of audioPlacements) {
		if (data.status === "cancelled" || data.status === "failed") continue;
		const marker = `%%pi-breeze-tts:${markerId}%%`;
		let status: "pending" | "placed" = "pending";
		let attachmentPath: string | undefined;
		let transcriptDescription: string | undefined;
		let transcript: string | undefined;

		if (data.status === "placed") {
			attachmentPath = validAudioAttachmentPath(typeof data.vaultRelativePath === "string" ? data.vaultRelativePath : "");
			if (!attachmentPath) throw new Error(`Breeze TTS placement ${markerId} returned an invalid vault-relative attachment path.`);
			status = "placed";
			const metadata = audioTranscriptMetadata(data, subagentRecords);
			transcriptDescription = metadata.transcriptDescription;
			transcript = metadata.transcript;
			if ((transcriptDescription === undefined) !== (transcript === undefined)) {
				throw new Error(`Breeze TTS placement ${markerId} has incomplete transcript metadata.`);
			}
		}

		const durable = attachmentPath ? `![[${attachmentPath}]]` : marker;
		if (durableText.includes(durable) || claimed.has(durable)) continue;
		if (!attachmentPath && typeof data.anchor === "string" && durableAudioAnchors.has(normalizeAnchorLine(data.anchor))) continue;
		claimed.add(durable);
		if (attachmentPath) emittedPaths.add(attachmentPath);
		insertions.push({
			index: targetIndex(data.anchor, entryOrder, placementAnchorMarkerFromData(data, markerId)),
			seq: sequence++,
			block: { kind: "audio", markerId, status, attachmentPath, transcriptDescription, transcript },
		});
	}

	if (insertions.length === 0) return blocks;
	const output = [...blocks];
	if (emittedPaths.size > 0) {
		const isEmittedEmbed = (line: string): boolean => {
			const embed = /^!\[\[([^\]]+)\]\]$/.exec(line.trim());
			return Boolean(embed && emittedPaths.has(embed[1]));
		};
		// Imported prose is split on blank lines, so a caption callout usually lands in
		// its own block. Drop it when the next block is the embed that re-emits it.
		for (let index = 0; index < output.length; index++) {
			const block = output[index];
			if (block.kind !== "markdown") continue;
			const first = block.markdown.split(/\r?\n/)[0]?.trim() ?? "";
			if (!first.startsWith("> [!quote]") || first.startsWith("> [!quote]-")) continue;
			let next = index + 1;
			while (next < output.length && output[next].kind === "markdown" && !output[next].markdown.trim()) next++;
			const following = output[next];
			if (following?.kind === "markdown" && isEmittedEmbed(following.markdown.split(/\r?\n/)[0] ?? "")) block.markdown = "";
		}
		for (const block of output) {
			if (block.kind !== "markdown") continue;
			const lines = block.markdown.split(/\r?\n/);
			const kept: string[] = [];
			for (let index = 0; index < lines.length; index++) {
				if (!isEmittedEmbed(lines[index])) {
					kept.push(lines[index]);
					continue;
				}
				// An audio embed owns the transcript callout directly beneath it.
				if (AUDIO_EMBED_LINE.test(lines[index].trim())) {
					let cursor = index + 1;
					while (cursor < lines.length && !lines[cursor].trim()) cursor++;
					if (cursor < lines.length && AUDIO_CALLOUT_START.test(lines[cursor].trim())) {
						while (cursor < lines.length && lines[cursor].trim()) cursor++;
						index = cursor - 1;
					}
					continue;
				}
				// A picture embed owns the caption callout directly above it.
				let cursor = kept.length - 1;
				while (cursor >= 0 && !kept[cursor].trim()) cursor--;
				let header = cursor;
				while (header >= 0 && kept[header].trim().startsWith(">")) header--;
				if (header < cursor && kept[header + 1].trim().startsWith("> [!quote]")) {
					kept.length = header + 1;
					while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
				}
			}
			block.markdown = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
		}
	}

	// Insert from the end so earlier target indexes stay valid. Placements sharing a
	// target index are inserted last-first so they end up in session order.
	for (const insertion of insertions.sort((left, right) => right.index - left.index || right.seq - left.seq)) {
		output.splice(insertion.index, 0, insertion.block);
	}
	return output;
}

export function renderTranscriptWithPlacements(
	blocks: TranscriptBlock[],
	entriesValue: unknown,
	notePath: string,
	durableMarkdown = "",
): string {
	return renderTranscript(applyPlacements(blocks, entriesValue, notePath, durableMarkdown));
}
function escapeAudioTranscriptMarkdown(value: string): string {
	return value.replace(/[\\`*_{}\[\]()#+.!|>~-]/g, "\\$&");
}

export function renderAudioTranscriptCallout(description: string, transcript: string): string {
	if (!description.trim()) throw new Error("Audio transcript description must contain non-whitespace text.");
	if (!transcript.trim()) throw new Error("Audio transcript must contain non-whitespace text.");
	const title = escapeAudioTranscriptMarkdown(description.trim().replace(/\s+/g, " "));
	const text = escapeAudioTranscriptMarkdown(transcript.trim().replace(/\s+/g, " "));
	return [
		`> [!quote]- **Transcript**: ${title}`,
		">",
		`> "*${text}*"`,
	].join("\n");
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

interface MarkerLine {
	start: number;
	contentEnd: number;
	end: number;
}

function markerLines(markdown: string, marker: string): MarkerLine[] {
	const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const expression = new RegExp(`^(${escaped})[ \\t]*\\r?$`, "gm");
	const lines: MarkerLine[] = [];
	for (const match of markdown.matchAll(expression)) {
		const start = match.index!;
		const contentEnd = start + match[1].length;
		const newlineIndex = markdown.indexOf("\n", contentEnd);
		lines.push({ start, contentEnd, end: newlineIndex < 0 ? markdown.length : newlineIndex + 1 });
	}
	return lines;
}

export function extractManagedTranscript(markdown: string): string | undefined {
	const starts = markerLines(markdown, TRANSCRIPT_START);
	const ends = markerLines(markdown, TRANSCRIPT_END);
	for (let i = starts.length - 1; i >= 0; i--) {
		const start = starts[i];
		const end = ends.find((candidate) => candidate.start > start.start);
		if (!end) continue;
		let content = markdown.slice(start.contentEnd, end.start);
		content = content.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
		return content.trim() ? content : undefined;
	}
	return undefined;
}

const AUDIO_MARKER_LINE = /^%%pi-breeze-tts:[a-f0-9-]{36}%%$/i;
const AUDIO_EMBED_LINE = /^!\[\[001-Attachments\/~breezetts\/[A-Za-z0-9][A-Za-z0-9._-]*\.wav\]\]$/i;
const AUDIO_CALLOUT_START = /^> \[!quote\]- \*\*Transcript\*\*:/i;

interface NoteAudioArtifact {
	/** The durable text that identifies this artifact inside a transcript. */
	key: string;
	/** Marker or embed plus its transcript callout, as it should be re-emitted. */
	body: string;
	/** Normalized source line the artifact was attached to, if any. */
	anchor?: string;
}

function normalizeAnchorLine(line: string): string {
	return line
		.replace(/^\s*>\s?/, "")
		.trim()
		.replace(/^(?:\\?[*_~]{1,3})?["'“”‘’「」『』»]+/, "")
		.replace(/["'“”‘’「」『』»]+(?:\\?[*_~]{1,3})?$/, "")
		.replace(/\\[.!?]$/, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Collect the audio artifacts already written into the managed note section so a
 * transcript rebuild can re-emit them at the same place. The note is the durable
 * record: a rebuilt session transcript may not contain the source passage any
 * more, but generated audio must never be dropped.
 */
function readNoteAudioArtifacts(previous: string | undefined): NoteAudioArtifact[] {
	if (!previous) return [];
	const lines = previous.split(/\r?\n/);
	const artifacts: NoteAudioArtifact[] = [];
	let anchor: string | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (!line) continue;

		const isMarker = AUDIO_MARKER_LINE.test(line);
		const isEmbed = AUDIO_EMBED_LINE.test(line);
		if (!isMarker && !isEmbed) {
			const normalized = normalizeAnchorLine(line);
			if (normalized) anchor = normalized;
			continue;
		}

		const body = [line];
		if (isEmbed) {
			let cursor = index + 1;
			while (cursor < lines.length && !lines[cursor].trim()) cursor++;
			if (cursor < lines.length && AUDIO_CALLOUT_START.test(lines[cursor].trim())) {
				body.push("");
				while (cursor < lines.length && /^\s*>/.test(lines[cursor])) body.push(lines[cursor++].trimEnd());
				// Repair a callout left unterminated by an older sync.
				if (!body.at(-1)!.trimEnd().endsWith('*"')) body[body.length - 1] = `${body.at(-1)!.trimEnd()}*"`;
				index = cursor - 1;
			}
		}
		artifacts.push({ key: line, body: body.join("\n"), anchor });
	}
	return artifacts;
}

function findUniqueAnchorLine(rendered: string, anchor: string | undefined): number | undefined {
	if (!anchor) return undefined;
	const lines = rendered.split(/\r?\n/);
	let found: number | undefined;
	for (let index = 0; index < lines.length; index++) {
		if (normalizeAnchorLine(lines[index]) !== anchor) continue;
		if (found !== undefined) return undefined;
		found = index;
	}
	return found;
}

export function carryOverNoteAudio(previous: string | undefined, rendered: string): string {
	const artifacts = readNoteAudioArtifacts(previous);
	if (artifacts.length === 0) return rendered;

	const lines = rendered.split(/\r?\n/);
	const pendingByAnchor = new Map<number, string[]>();
	const appended: string[] = [];

	for (const artifact of artifacts) {
		const existingIndex = lines.findIndex((line) => line.trim() === artifact.key);
		if (existingIndex >= 0) {
			// Keep a durable embed's transcript callout attached to it.
			if (!AUDIO_EMBED_LINE.test(artifact.key)) continue;
			let cursor = existingIndex + 1;
			while (cursor < lines.length && !lines[cursor].trim()) cursor++;
			if (cursor < lines.length && AUDIO_CALLOUT_START.test(lines[cursor].trim())) continue;
			const callout = artifact.body.split("\n").slice(1).join("\n");
			if (callout) lines.splice(existingIndex + 1, 0, "", ...callout.split("\n"), "");
			continue;
		}

		const anchorIndex = findUniqueAnchorLine(lines.join("\n"), artifact.anchor);
		if (anchorIndex === undefined) {
			appended.push(artifact.body);
			continue;
		}
		const bucket = pendingByAnchor.get(anchorIndex);
		if (bucket) bucket.push(artifact.body);
		else pendingByAnchor.set(anchorIndex, [artifact.body]);
	}

	const output: string[] = [];
	lines.forEach((line, index) => {
		output.push(line);
		// A trailing blank line keeps the callout from swallowing the next block:
		// without it the following prose continues the blockquote.
		for (const body of pendingByAnchor.get(index) ?? []) output.push("", ...body.split("\n"), "");
	});
	for (const body of appended) output.push("", ...body.split("\n"), "");
	return output.join("\n").replace(/\n{3,}/g, "\n\n");
}
/**
 * The managed section owns everything inside its markers, so prose written above
 * them can never be a placement anchor. On link, move the start marker above that
 * prose: it then renders once inside the section instead of twice.
 */
export function placeManagedSectionAtTop(markdown: string): string {
	const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown)?.[0] ?? "";
	const rest = markdown.slice(frontmatter.length);
	const start = markerLines(rest, TRANSCRIPT_START)[0];
	const end = start ? markerLines(rest, TRANSCRIPT_END).find((candidate) => candidate.start > start.start) : undefined;
	const hasSection = Boolean(start && end);
	const before = (hasSection ? rest.slice(0, start!.start) : rest).trim();
	const after = (hasSection ? rest.slice(end!.contentEnd) : "").trim();
	const inner = (hasSection ? rest.slice(start!.contentEnd, end!.start) : "").trim();
	const merged = [before, inner].filter(Boolean).join("\n\n");
	const section = merged ? `${TRANSCRIPT_START}\n\n${merged}\n\n${TRANSCRIPT_END}` : `${TRANSCRIPT_START}\n\n${TRANSCRIPT_END}`;
	return `${frontmatter}${section}${after ? `\n\n${after}` : ""}\n`;
}

export function replaceManagedTranscript(existing: string, transcript: string): string {
	if (!transcript.trim()) return existing;
	const previousTranscript = extractManagedTranscript(existing);
	const safeTranscript = carryOverNoteAudio(previousTranscript, transcript.trim());
	const starts = markerLines(existing, TRANSCRIPT_START);
	const ends = markerLines(existing, TRANSCRIPT_END);
	const body = safeTranscript.endsWith("\n") ? safeTranscript : `${safeTranscript}\n`;
	const section = `${TRANSCRIPT_START}\n${body}\n${TRANSCRIPT_END}`;

	for (let i = starts.length - 1; i >= 0; i--) {
		const start = starts[i];
		const end = ends.find((candidate) => candidate.start > start.start);
		if (end) {
			return `${existing.slice(0, start.start)}${section}${existing.slice(end.contentEnd)}`;
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

/**
 * Split imported note prose into paragraph blocks so each passage is separately
 * addressable as a placement anchor. Fenced code blocks are kept whole.
 */
export function splitMarkdownBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	let current: string[] = [];
	let fence: string | undefined;
	const flush = () => {
		const text = current.join("\n").trim();
		if (text) blocks.push(text);
		current = [];
	};
	for (const line of markdown.split(/\r?\n/)) {
		const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			current.push(line);
			if (fenceMatch && line.trim().startsWith(fence)) fence = undefined;
			continue;
		}
		if (fenceMatch) {
			fence = fenceMatch[1];
			current.push(line);
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		current.push(line);
	}
	flush();
	return blocks;
}

/**
 * Whether an anchor appears in the rendered transcript. Placement resolves to
 * the first matching block, so a passage quoted again later still works.
 */
export function transcriptContainsAnchor(entriesValue: unknown, anchor: string): boolean {
	const needle = anchor.trim();
	if (!needle) return false;
	return buildBackfill(entriesValue).blocks.some((block) =>
		(block.kind === "prose" && block.text.includes(needle)) ||
		(block.kind === "markdown" && block.markdown.includes(needle)));
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
	const seen = new Set<Record<string, any>>();
	let current: Record<string, any> | undefined = leaf;
	while (current) {
		seen.add(current);
		chain.push(current);
		const parentId = current.parentId;
		const parent = typeof parentId === "string" && parentId ? byId.get(parentId) : undefined;
		const fallback = previousEntry(entries, current);
		if (parent && !seen.has(parent)) {
			current = parent;
			continue;
		}
		if (typeof parentId === "string" && parentId) {
			diagnostics.push(`Unreachable parent session entry "${parentId}"; fell back to array order.`);
		}
		if (fallback && !seen.has(fallback)) {
			current = fallback;
			continue;
		}
		break;
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
				const file = safeText(entry.data.file);
				for (const markdown of splitMarkdownBlocks(entry.data.markdown)) {
					importedMarkdown.push({ kind: "markdown", file, markdown });
				}
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
			if (
				entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY ||
				entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY ||
				entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY
			) continue;
			if (entry.customType !== "md-log" && !IGNORED_CUSTOM_METADATA_TYPES.has(entry.customType)) {
				diagnostics.push(`Ignored unsupported custom entry "${safeText(entry.customType) || "(unknown)"}".`);
			}
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
		if (message.role === "system" || message.role === "developer") continue;
		if (message.role === "user") {
			const text = stripSkillBlocks(contentText(message.content).trim());
			if (text) blocks.push({ kind: "prose", role: "user", text, entryId: entry.id });
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
						blocks.push({ kind: "prose", role: "assistant", text: part.text.trim(), entryId: entry.id });
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
