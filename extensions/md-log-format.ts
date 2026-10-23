export const TRANSCRIPT_START = "%% pi-md-log:start v1 %%";
export const TRANSCRIPT_END = "%% pi-md-log:end v1 %%";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);
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
	| {
		kind: "quiz";
		callId: string;
		question: string;
		context?: string;
		options: TranscriptOption[];
		details?: Record<string, unknown>;
	}
	| {
		kind: "ask";
		callId: string;
		question: string;
		context?: string;
		options: TranscriptOption[];
		details?: Record<string, unknown>;
	}
	| { kind: "group"; active: boolean; title?: string };

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
	return `> [!quote] YOU\n\n${text}`;
}

export function assistantBlock(text: string): string {
	return `> [!abstract] PI\n\n${text}`;
}

function formatQuiz(block: Extract<TranscriptBlock, { kind: "quiz" }>, round: number): string {
	const pending = block.details === undefined;
	const question = questionCallout("Quiz", block.question, block.context, block.options, block.details);
	const answer = pending ? "" : quizAnswerCallout(block.details);
	return [`## Round ${round}`, question, answer].filter(Boolean).join("\n\n");
}

function formatAsk(block: Extract<TranscriptBlock, { kind: "ask" }>, round: number): string {
	const question = questionCallout("Question", block.question, block.context, block.options);
	const answer = block.details === undefined ? "" : askAnswerCallout(block.details);
	return [`## Question ${round}`, question, answer].filter(Boolean).join("\n\n");
}

export function renderTranscript(blocks: TranscriptBlock[]): string {
	const output: string[] = [];
	let explicitTitle: string | undefined;
	let autoQuizGroup = false;
	let quizRound = 0;
	let askRound = 0;

	for (const block of blocks) {
		if (block.kind === "group") {
			explicitTitle = block.active ? (block.title?.trim() || "Quiz") : undefined;
			autoQuizGroup = false;
			quizRound = 0;
			if (explicitTitle) output.push(`# ${explicitTitle}`);
			continue;
		}

		if (block.kind === "quiz") {
			if (!explicitTitle && !autoQuizGroup) {
				output.push("# Quiz");
				autoQuizGroup = true;
				quizRound = 0;
			}
			quizRound++;
			output.push(formatQuiz(block, quizRound));
			continue;
		}

		if (block.kind === "ask") {
			if (!explicitTitle) autoQuizGroup = false;
			askRound++;
			output.push(formatAsk(block, askRound));
			continue;
		}

		if (block.role === "user" && !explicitTitle) autoQuizGroup = false;
		const text = block.role === "user" ? userBlock(block.text) : assistantBlock(block.text);
		if (text.trim()) output.push(text);
	}

	return output.filter(Boolean).join("\n\n");
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
	if (entry.type !== "custom" || entry.customType !== "md-log-quiz-group" || !isRecord(entry.data)) return undefined;
	return { kind: "group", active: entry.data.active === true, title: safeText(entry.data.title) };
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
					blocks.push({ kind: "prose", role: "assistant", text: part.text.trim() });
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

	return { blocks, entries: processed, diagnostics };
}
