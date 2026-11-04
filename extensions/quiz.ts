import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import {
	Editor,
	Key,
	Text,
	type OverlayHandle,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { clearAnswerModal, suspendAnswerModal, trackAnswerModal } from "../lib/answer-modal.ts";
import { appendQuizScratchpad, extractQuizScratchpad } from "../lib/md-log-format.ts";
import { normalizeQuizOptions, shuffleQuizOptions, type QuizOption } from "../lib/quiz-options.ts";
import {
	addQuestionModalWrappedLine as addWrapped,
	createQuestionEditorTheme as createEditorTheme,
	pushQuestionModalFooter,
	pushQuestionModalHeader,
} from "../lib/question-modal-ui.ts";

// ────────────────────────────────────────────────────────────────────────────
// quiz — a GRADED sibling of ask_user_question.
//
// Where ask_user_question collects a preference/decision with no notion of
// right or wrong, `quiz` poses a question that HAS a correct answer, grades the
// user's selection instantly, and shows tight feedback (✓/✗ + the correct
// answer + an optional explanation) to both the user and the agent.
//
// It is intentionally options-only: single-select or multi-select. There is no
// free-text mode and no "Other" option, because a free-text answer can't be
// graded against a correct index.
// ────────────────────────────────────────────────────────────────────────────

interface DisplayOption extends QuizOption {
	id: string;
	index: number;
	isSubmit?: boolean;
}

interface OptionAnswer {
	label: string;
	value: string;
	index: number; // 1-based, matches the number shown to the user
}

// The always-present "I don't know" choice. It is NOT a real option: it never
// participates in shuffling, has no correct-answer value, and produces a
// distinct signal (dontKnow) rather than a right/wrong grade — so an honest
// "I don't know" is never confused with a lucky or unlucky guess.
const DONT_KNOW_VALUE = "__dont_know__";
const DONT_KNOW_LABEL = "I don't know";
const DONT_KNOW_INDEX = 0; // real options are 1-based; submit uses -1

// Unified response from either ask* component. answers holds the real
// selections (empty when dontKnow); note is the optional free-text the user
// typed in the always-present note field, later appended to the md-log scratchpad.
interface QuizResponse {
	dontKnow: boolean;
	note?: string;
	answers: OptionAnswer[];
}

type QuizStatus = "answered" | "cancelled" | "unavailable";
type QuizMode = "single-select" | "multi-select";

interface DisplayedOption {
	index: number; // 1-based, in the final (possibly shuffled) display order
	label: string;
}

interface QuizResultDetails {
	status: QuizStatus;
	interactionId?: string;
	question: string;
	context?: string;
	conceptId?: string;
	mode: QuizMode;
	answers: OptionAnswer[];
	correctIndices: number[];
	options?: DisplayedOption[]; // full option list in display order, for the transcript
	correct?: boolean;
	dontKnow?: boolean; // user selected "I don't know" instead of guessing
	scratchpad?: string;
	explanation?: string;
	message?: string;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Display label for the answer option." }),
	value: Type.Optional(
		Type.String({ description: "Optional machine-readable value returned for the option. Defaults to the label." }),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const QuizParams = Type.Object({
	question: Type.String({
		description: "The single quiz question to ask. Ask exactly one question per tool call.",
	}),
	summaryTitle: Type.Optional(
		Type.String({ description: "Optional concise 3-6 word summary used as the md-log quiz heading." }),
	),
	conceptId: Type.Optional(
		Type.String({ description: "Stable concept identifier used for teaching mastery tracking. Supply this for graded teaching questions." }),
	),
	details: Type.Optional(
		Type.String({ description: "Optional extra context or instructions shown under the question." }),
	),
	options: Type.Array(OptionSchema, {
		description:
			"The answer options (4 to 8). Choose the smallest count that provides genuinely useful, parallel distractors; never target a fixed count or add filler. Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer.",
		minItems: 4,
		maxItems: 8,
	}),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set to true when more than one option is correct and the user must select all of them." }),
	),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			'REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. Single-select: a single string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]); the user is only correct if their selection matches this set exactly. Always pass the value, not a position number — this is self-checking and prevents miscounting.',
	}),
	explanation: Type.String({
		description:
			"REQUIRED. Explanation revealed AFTER the user answers (shown whether they got it right or wrong). Use it to reinforce why the correct answer is correct.",
	}),
});

// Resolve author-supplied option value(s) to 1-based indices. Keying by value
// (not position) makes the correct answer self-documenting: the author writes
// `correctAnswer: "mercury"` and a typo becomes a hard error instead of a
// silent wrong grade.
// The harness sometimes delivers a multi-select `correctAnswer` array as a
// JSON-stringified string (e.g. '["a", "b"]') instead of a real array, because
// the schema union lists String first. Detect that case and parse it back into
// an array so grading resolves against real option values. A plain single value
// is wrapped as-is.
function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
	if (Array.isArray(correctAnswer)) return correctAnswer;
	const trimmed = correctAnswer.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) return parsed.map((v) => String(v));
		} catch {
			// Not valid JSON — fall through and treat as a single literal value.
		}
	}
	return [correctAnswer];
}

function resolveCorrect(
	correctAnswer: string | string[] | undefined,
	options: QuizOption[],
): { indices: number[]; error?: string } {
	if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
	const arr = coerceCorrectAnswer(correctAnswer);
	if (arr.length === 0) return { indices: [], error: "correctAnswer is required" };
	const byValue = new Map(options.map((o, i) => [o.value, i + 1]));
	const indices: number[] = [];
	for (const raw of arr) {
		const v = typeof raw === "string" ? raw.trim() : raw;
		const idx = byValue.get(v);
		if (idx === undefined) {
			const known = options.map((o) => `"${o.value}"`).join(", ");
			return { indices: [], error: `correctAnswer "${v}" does not match any option value (${known})` };
		}
		indices.push(idx);
	}
	return { indices: Array.from(new Set(indices)).sort((a, b) => a - b) };
}

function addWrappedWithPrefix(lines: string[], text: string, width: number, prefix: string, prefixWidth: number): void {
	const continuationPrefix = " ".repeat(prefixWidth);
	const contentWidth = Math.max(1, width - prefixWidth);
	for (const [index, line] of wrapTextWithAnsi(text, contentWidth).entries()) {
		lines.push(truncateToWidth(`${index === 0 ? prefix : continuationPrefix}${line}`, width));
	}
}

function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
	if (selectedIndices.length !== correctIndices.length) return false;
	const a = [...selectedIndices].sort((x, y) => x - y);
	const b = [...correctIndices].sort((x, y) => x - y);
	return a.every((v, i) => v === b[i]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLinkedQuizScratchpad(
	ctx: { sessionManager: { getEntries(): unknown }; ui: { notify(message: string, level: "warning"): void } },
	callId: string,
): string | undefined {
	let entries: unknown;
	try {
		entries = ctx.sessionManager.getEntries();
	} catch (error) {
		ctx.ui.notify(
			`Quiz scratchpad could not read session history: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
	if (!Array.isArray(entries)) {
		ctx.ui.notify("Quiz scratchpad could not read session history: entries were not an array.", "warning");
		return undefined;
	}

	let linkedFile: string | null = null;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "md-log" || !isRecord(entry.data)) continue;
		linkedFile = typeof entry.data.file === "string" && entry.data.file ? entry.data.file : null;
	}
	if (!linkedFile) return undefined;

	let markdown: string;
	try {
		markdown = fs.readFileSync(linkedFile, "utf-8");
	} catch (error) {
		ctx.ui.notify(
			`Quiz scratchpad could not read the linked md-log note: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return undefined;
	}
	return extractQuizScratchpad(markdown, callId);
}

function buildStructuredResult(
	status: QuizStatus,
	question: string,
	mode: QuizMode,
	answers: OptionAnswer[],
	correctIndices: number[],
	correct: boolean | undefined,
	explanation: string | undefined,
	context?: string,
	message?: string,
	options?: DisplayedOption[],
	dontKnow?: boolean,
	scratchpad?: string,
): QuizResultDetails {
	return { status, question, context, mode, answers, correctIndices, options, correct, dontKnow, scratchpad, explanation, message };
}

function cancelledResult(question: string, mode: QuizMode, correctIndices: number[], context?: string) {
	const message = "User cancelled the quiz";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function unavailableResult(question: string, mode: QuizMode, message: string, correctIndices: number[], context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], correctIndices, undefined, undefined, context, message),
	};
}

function formatOptionRef(options: QuizOption[], index: number): string {
	const opt = options.find((o, i) => i + 1 === index);
	return `${index}. ${opt ? opt.label : "(unknown)"}`;
}

function buildResult(
	interactionId: string,
	conceptId: string | undefined,
	question: string,
	context: string | undefined,
	mode: QuizMode,
	options: QuizOption[],
	response: QuizResponse,
	correctIndices: number[],
	explanation: string | undefined,
	scratchpad: string | undefined,
) {
	const { dontKnow, answers } = response;
	const selectedIndices = answers.map((a) => a.index);
	// "I don't know" is never counted as correct — it's a distinct outcome.
	const correct = dontKnow ? false : isCorrect(selectedIndices, correctIndices);
	const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
	const displayedOptions: DisplayedOption[] = options.map((o, i) => ({ index: i + 1, label: o.label }));

	let text: string;
	if (dontKnow) {
		// Make the signal explicit for the agent: the user did NOT guess, so this
		// is a genuine knowledge gap, not a wrong answer to correct against.
		text = `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`;
		text += `\nCorrect: ${correctStr}`;
	} else {
		const verdict = correct ? "correctly" : "incorrectly";
		const selectedStr = answers.map((a) => `${a.index}. ${a.label}`).join(", ");
		text = `User answered ${verdict}.\nSelected: ${selectedStr}\nCorrect: ${correctStr}`;
	}
	if (scratchpad) text += `\nLearner's scratchpad (user-authored):\n${scratchpad}`;
	if (explanation) text += `\nExplanation: ${explanation}`;
	text += `\n(interaction ${interactionId})`;

	return {
		content: [{ type: "text" as const, text }],
		details: {
			...buildStructuredResult(
				"answered",
				question,
				mode,
				answers,
				correctIndices,
				correct,
				explanation,
				context,
				undefined,
				displayedOptions,
				dontKnow,
				scratchpad,
			),
			interactionId,
			conceptId,
		},
	};
}

// Shared feedback block, rendered after the user submits.
function renderFeedback(
	lines: string[],
	theme: any,
	width: number,
	options: QuizOption[],
	selectedIndices: number[],
	correctIndices: number[],
	explanation: string | undefined,
	dontKnow = false,
	note?: string,
): void {
	const add = (text: string) => lines.push(truncateToWidth(text, width));
	const correct = !dontKnow && isCorrect(selectedIndices, correctIndices);
	const selectedSet = new Set(selectedIndices);
	const correctSet = new Set(correctIndices);

	lines.push("");
	for (let i = 0; i < options.length; i++) {
		const index = i + 1;
		const opt = options[i];
		const isSelected = selectedSet.has(index);
		const isKey = correctSet.has(index);
		let marker: string;
		let color: string;
		if (dontKnow) {
			// No guess was made — only reveal the correct answer(s); never show ✗.
			marker = isKey ? "✓" : " ";
			color = isKey ? "success" : "dim";
		} else if (isSelected && isKey) {
			marker = "✓";
			color = "success";
		} else if (isSelected && !isKey) {
			marker = "✗";
			color = "error";
		} else if (!isSelected && isKey) {
			// correct answer the user missed
			marker = "✓";
			color = "success";
		} else {
			marker = " ";
			color = "dim";
		}
		add(theme.fg(color, ` ${marker} ${index}. ${opt.label}`));
	}

	lines.push("");
	if (dontKnow) {
		add(theme.fg("warning", " · You said: I don't know"));
		const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
		addWrapped(lines, theme.fg("muted", `Correct answer: ${correctStr}`), width, " ");
	} else if (correct) {
		add(theme.fg("success", " ✓ Correct!"));
	} else {
		add(theme.fg("error", " ✗ Incorrect."));
		const correctStr = correctIndices.map((i) => formatOptionRef(options, i)).join(", ");
		addWrapped(lines, theme.fg("muted", `Correct answer: ${correctStr}`), width, " ");
	}
	if (note) {
		addWrapped(lines, theme.fg("muted", `Your note: ${note}`), width, " ");
	}
	if (explanation) {
		lines.push("");
		addWrapped(lines, theme.fg("text", explanation), width, " ");
	}
	lines.push("");
	add(theme.fg("dim", " Enter/Esc to continue"));
}

// The "I don't know" row in the selection list — visually separated and dimmed
// so it reads as distinct from the real, gradable options.
function pushDontKnowRow(lines: string[], theme: any, width: number, focused: boolean): void {
	lines.push("");
	const prefix = focused ? theme.fg("accent", "> ") : "  ";
	const styled = focused ? theme.fg("accent", DONT_KNOW_LABEL) : theme.fg("dim", DONT_KNOW_LABEL);
	lines.push(truncateToWidth(`${prefix}${styled}`, width));
}

// Persistent, always-present note field rendered under the options during the
// select phase. Applies to ANY answer (including "I don't know") and is only
// surfaced to the agent when non-empty.
function pushNoteField(lines: string[], theme: any, width: number, editor: Editor, focused: boolean): void {
	lines.push("");
	const label = focused ? theme.fg("accent", "Note (optional):") : theme.fg("muted", "Note (optional):");
	addWrapped(lines, label, width, " ");
	for (const line of editor.render(width)) lines.push(line);
}

// Build the note Editor. `disableSubmit` is set because Enter must NOT submit
// here: the editor's submit path clears the buffer, which would wipe the note.
// Instead the host intercepts Enter to return focus to the options while
// keeping the text. Ctrl+J still inserts a newline (pi convention), so
// multi-line notes work.
function makeNoteEditor(tui: any, theme: any): Editor {
	const editor = new Editor(tui, createEditorTheme(theme));
	editor.focused = false;
	editor.disableSubmit = true;
	return editor;
}

function isPrintableInput(data: string): boolean {
	return data.length > 0 && data.charCodeAt(0) >= 32;
}

async function askSingleChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	correctIndices: number[],
	explanation: string | undefined,
): Promise<QuizResponse | null> {
	const allOptions: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const dontKnowNav = allOptions.length; // nav index of the "I don't know" row

	let overlayHandle: OverlayHandle | undefined;
	let cancelModal: (() => void) | undefined;
	let snapshotModal: (() => string) | undefined;
	return ctx.ui.custom<QuizResponse | null>(
		(tui: any, theme: any, _kb: any, done: (result: QuizResponse | null) => void) => {
			const finish = (result: QuizResponse | null) => {
				clearAnswerModal(overlayHandle);
				done(result);
			};
			let optionIndex = 0;
			let phase: "select" | "feedback" = "select";
			let focus: "options" | "note" = "options";
			let chosen: OptionAnswer | null = null;
			let dontKnow = false;
			const editor = makeNoteEditor(tui, theme);
			cancelModal = () => finish(null);
			snapshotModal = () => JSON.stringify({
				kind: "single-choice-quiz",
				question,
				context,
				options: allOptions.map(({ label, value }) => ({ label, value })),
				phase,
				highlightedOption: optionIndex === dontKnowNav ? DONT_KNOW_LABEL : allOptions[optionIndex]?.label,
				answer: chosen ? { label: chosen.label, value: chosen.value } : dontKnow ? DONT_KNOW_LABEL : undefined,
				note: noteText(),
				focus,
			});
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function noteText(): string | undefined {
				const t = editor.getText().trim();
				return t.length ? t : undefined;
			}

			function toOptions() {
				focus = "options";
				editor.focused = false;
				refresh();
			}

			function response(): QuizResponse {
				const note = noteText();
				return dontKnow
					? { dontKnow: true, note, answers: [] }
					: { dontKnow: false, note, answers: chosen ? [chosen] : [] };
			}

			function handleInput(data: string) {
				if (matchesKey(data, "f6")) {
					if (suspendAnswerModal(overlayHandle)) {
						ctx.ui.notify("Answer paused. Press F6 again to stash the editor draft, run your command, then use /answer-resume.", "info");
					}
					return;
				}
				if (phase === "feedback") {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						finish(response());
					}
					return;
				}

				// Tab toggles focus between the options list and the note field.
				if (matchesKey(data, Key.tab)) {
					focus = focus === "options" ? "note" : "options";
					editor.focused = focus === "note";
					refresh();
					return;
				}

				if (focus === "note") {
					// Enter and Esc both return to the options and keep the note text.
					// (Enter must be intercepted here: the editor's own submit clears
					// the buffer. Ctrl+J still reaches the editor as a newline.)
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						toOptions();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				// focus === "options"
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(dontKnowNav, optionIndex + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter)) {
					if (optionIndex === dontKnowNav) {
						dontKnow = true;
						chosen = null;
					} else {
						const selected = allOptions[optionIndex];
						chosen = { label: selected.label, value: selected.value, index: selected.index };
						dontKnow = false;
					}
					phase = "feedback";
					refresh();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					finish(null);
					return;
				}
				if (isPrintableInput(data)) {
					focus = "note";
					editor.focused = true;
					editor.handleInput(data);
					refresh();
				}
			}

			function render(width: number): string[] {
				// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
				// invalidate() on terminal resize, so render() can be re-entered with a
				// new width. Returning stale wider lines trips the TUI width guard and
				// crashes the process.
				if (cachedLines && cachedWidth === width) return cachedLines;

				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				pushQuestionModalHeader(lines, theme, width, question, context);

				if (phase === "feedback") {
					renderFeedback(
						lines,
						theme,
						width,
						options,
						chosen ? [chosen.index] : [],
						correctIndices,
						explanation,
						dontKnow,
						noteText(),
					);
					pushQuestionModalFooter(lines, theme, width, "F6 pause • press again for Interlude • /answer-resume return");
					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				lines.push("");
				for (let i = 0; i < allOptions.length; i++) {
					const option = allOptions[i];
					const selected = focus === "options" && i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = `${option.index}. ${option.label}`;
					const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
					add(`${prefix}${styled}`);
					if (option.description) {
						addWrapped(lines, theme.fg("muted", option.description), width, "     ");
					}
				}

				pushDontKnowRow(lines, theme, width, focus === "options" && optionIndex === dontKnowNav);

				pushNoteField(lines, theme, width, editor, focus === "note");

				if (focus === "note") {
					pushQuestionModalFooter(lines, theme, width, "Type note • Ctrl+J newline • Enter back to options • Tab options • Esc back");
				} else {
					pushQuestionModalFooter(lines, theme, width, "↑↓ navigate • Enter answer • type note/Tab • F6 pause • Esc cancel");
				}
				// Not cached when the note is focused: the editor renders a live cursor.
				if (focus !== "note") {
					cachedLines = lines;
					cachedWidth = width;
				}
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
					editor.invalidate();
				},
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-center" },
			onHandle(handle) {
				overlayHandle = handle;
				trackAnswerModal(handle, { cancel: cancelModal, snapshot: snapshotModal });
			},
		},
	);
}

async function askMultiChoice(
	ctx: any,
	question: string,
	context: string | undefined,
	options: QuizOption[],
	correctIndices: number[],
	explanation: string | undefined,
): Promise<QuizResponse | null> {
	const DONT_KNOW_ID = "dont-know";
	const choiceItems: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const dontKnowItem: DisplayOption = {
		id: DONT_KNOW_ID,
		label: DONT_KNOW_LABEL,
		value: DONT_KNOW_VALUE,
		index: DONT_KNOW_INDEX,
	};
	const submitItem: DisplayOption = { id: "submit", label: "Submit", value: "__submit__", index: -1, isSubmit: true };
	const allItems: DisplayOption[] = [...choiceItems, dontKnowItem, submitItem];

	let overlayHandle: OverlayHandle | undefined;
	let cancelModal: (() => void) | undefined;
	let snapshotModal: (() => string) | undefined;
	return ctx.ui.custom<QuizResponse | null>(
		(tui: any, theme: any, _kb: any, done: (result: QuizResponse | null) => void) => {
			const finish = (result: QuizResponse | null) => {
				clearAnswerModal(overlayHandle);
				done(result);
			};
			let optionIndex = 0;
			let phase: "select" | "feedback" = "select";
			let focus: "options" | "note" = "options";
			const editor = makeNoteEditor(tui, theme);
			let cachedLines: string[] | undefined;
			let cachedWidth = -1;
			const selected = new Map<string, OptionAnswer>();
			cancelModal = () => finish(null);
			snapshotModal = () => JSON.stringify({
				kind: "multi-choice-quiz",
				question,
				context,
				options: options.map(({ label, value }) => ({ label, value })),
				selected: Array.from(selected.values(), ({ label, value }) => ({ label, value })),
				dontKnow: selected.has(DONT_KNOW_ID),
				phase,
				highlightedOption: allItems[optionIndex]?.label,
				note: noteText(),
				focus,
			});

			function refresh() {
				cachedLines = undefined;
				tui.requestRender();
			}

			function noteText(): string | undefined {
				const t = editor.getText().trim();
				return t.length ? t : undefined;
			}

			function toOptions() {
				focus = "options";
				editor.focused = false;
				refresh();
			}

			const choseDontKnow = () => selected.has(DONT_KNOW_ID);
			const realAnswers = () =>
				sortAnswers(Array.from(selected.values()).filter((a) => a.index !== DONT_KNOW_INDEX));

			function response(): QuizResponse {
				const note = noteText();
				return choseDontKnow()
					? { dontKnow: true, note, answers: [] }
					: { dontKnow: false, note, answers: realAnswers() };
			}

			// "I don't know" is exclusive: choosing it clears real selections, and
			// choosing any real option clears "I don't know".
			function toggleOption(item: DisplayOption) {
				if (item.id === DONT_KNOW_ID) {
					if (selected.has(DONT_KNOW_ID)) {
						selected.delete(DONT_KNOW_ID);
					} else {
						selected.clear();
						selected.set(DONT_KNOW_ID, { label: item.label, value: item.value, index: item.index });
					}
				} else {
					selected.delete(DONT_KNOW_ID);
					if (selected.has(item.id)) {
						selected.delete(item.id);
					} else {
						selected.set(item.id, { label: item.label, value: item.value, index: item.index });
					}
				}
				refresh();
			}

			function submit() {
				if (selected.size === 0) return;
				phase = "feedback";
				refresh();
			}

			function handleInput(data: string) {
				if (matchesKey(data, "f6")) {
					if (suspendAnswerModal(overlayHandle)) {
						ctx.ui.notify("Answer paused. Press F6 again to stash the editor draft, run your command, then use /answer-resume.", "info");
					}
					return;
				}
				if (phase === "feedback") {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						finish(response());
					}
					return;
				}

				// Tab toggles focus between the options list and the note field.
				if (matchesKey(data, Key.tab)) {
					focus = focus === "options" ? "note" : "options";
					editor.focused = focus === "note";
					refresh();
					return;
				}

				if (focus === "note") {
					// Enter and Esc both return to the options and keep the note text.
					// (Enter must be intercepted here: the editor's own submit clears
					// the buffer. Ctrl+J still reaches the editor as a newline.)
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						toOptions();
						return;
					}
					editor.handleInput(data);
					refresh();
					return;
				}

				// focus === "options"
				if (matchesKey(data, Key.up)) {
					optionIndex = Math.max(0, optionIndex - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
					refresh();
					return;
				}

				const current = allItems[optionIndex];
				if (matchesKey(data, Key.space)) {
					if (current.isSubmit) return;
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.enter)) {
					if (current.isSubmit) {
						submit();
						return;
					}
					toggleOption(current);
					return;
				}

				if (matchesKey(data, Key.escape)) {
					finish(null);
					return;
				}
				if (isPrintableInput(data)) {
					focus = "note";
					editor.focused = true;
					editor.handleInput(data);
					refresh();
				}
			}

			function render(width: number): string[] {
				// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
				// invalidate() on terminal resize, so render() can be re-entered with a
				// new width. Returning stale wider lines trips the TUI width guard and
				// crashes the process.
				if (cachedLines && cachedWidth === width) return cachedLines;

				const lines: string[] = [];
				const add = (text: string) => lines.push(truncateToWidth(text, width));
				pushQuestionModalHeader(lines, theme, width, question, context);

				if (phase === "feedback") {
					renderFeedback(
						lines,
						theme,
						width,
						options,
						realAnswers().map((a) => a.index),
						correctIndices,
						explanation,
						choseDontKnow(),
						noteText(),
					);
					pushQuestionModalFooter(lines, theme, width, "F6 pause • press again for Interlude • /answer-resume return");
					cachedLines = lines;
					cachedWidth = width;
					return lines;
				}

				lines.push("");
				for (let i = 0; i < allItems.length; i++) {
					const item = allItems[i];
					const isFocused = focus === "options" && i === optionIndex;
					const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

					if (item.isSubmit) {
						const label = selected.size > 0 ? `✓ ${item.label} (${selected.size} selected)` : `○ ${item.label}`;
						const styled = isFocused
							? theme.fg("accent", label)
							: theme.fg(selected.size > 0 ? "success" : "dim", label);
						add(`${prefix}${styled}`);
						continue;
					}

					if (item.id === DONT_KNOW_ID) {
						lines.push(""); // visual separation from the real options
						const checked = selected.has(item.id);
						const label = `${checked ? "[x]" : "[ ]"} ${item.label}`;
						const styled = isFocused ? theme.fg("accent", label) : theme.fg(checked ? "warning" : "dim", label);
						addWrappedWithPrefix(lines, styled, width, prefix, 2);
						continue;
					}

					const checked = selected.has(item.id);
					const marker = checked ? "[x]" : "[ ]";
					const label = `${marker} ${item.index}. ${item.label}`;
					const styled = isFocused ? theme.fg("accent", label) : theme.fg(checked ? "success" : "text", label);
					addWrappedWithPrefix(lines, styled, width, prefix, 2);
					if (item.description) {
						addWrapped(lines, theme.fg("muted", item.description), width, "     ");
					}
				}

				pushNoteField(lines, theme, width, editor, focus === "note");

				if (selected.size === 0) {
					add(theme.fg("warning", " Select at least one answer before submitting."));
				}
				if (focus === "note") {
					pushQuestionModalFooter(lines, theme, width, "Type note • Ctrl+J newline • Enter back to options • Tab options • Esc back");
				} else {
					pushQuestionModalFooter(lines, theme, width, "↑↓ navigate • Space toggle • Enter submit • type note/Tab • F6 pause • Esc cancel");
				}
				// Not cached when the note is focused: the editor renders a live cursor.
				if (focus !== "note") {
					cachedLines = lines;
					cachedWidth = width;
				}
				return lines;
			}

			return {
				render,
				invalidate: () => {
					cachedLines = undefined;
					editor.invalidate();
				},
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: { anchor: "bottom-center" },
			onHandle(handle) {
				overlayHandle = handle;
				trackAnswerModal(handle, { cancel: cancelModal, snapshot: snapshotModal });
			},
		},
	);
}

function sortAnswers(answers: OptionAnswer[]): OptionAnswer[] {
	return [...answers].sort((a, b) => a.index - b.index);
}

// Shared UI mutex. ctx.ui.custom()/editor can only handle one active call at
// a time, so ALL pop-up-style tools (quiz, ask_user_question, ...) must
// serialize against each other, not just against themselves. We stash one
// mutex on globalThis so separate extension files can share it without
// importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T> };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

export default function quiz(pi: ExtensionAPI) {
	pi.registerTool({
		name: "quiz",
		label: "quiz",
		description:
			"Ask the user a GRADED question with a known correct answer, then instantly grade and give feedback. Unlike ask_user_question (which collects preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks the user's selection right/wrong (✓/✗), reveals the correct answer, and can show an explanation. Use it to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining, or probe understanding whenever you're unsure they've got it. Options-only: multi-choice or multi-select, plus an automatic 'I don't know' choice so the user can signal a genuine gap instead of guessing. An always-present optional note field (Tab to focus it) appends to the linked md-log scratchpad for ANY answer; the combined scratchpad reaches you as learner reasoning. No free-text answers — for non-graded questions use ask_user_question instead.",
		promptSnippet:
			"Use the quiz tool to test the user with a graded multiple-choice or multi-select question (required correct answer + required explanation). For non-graded questions, use ask_user_question.",
		promptGuidelines: [
			"quiz is GRADED; ask_user_question is not. If the question has a correct answer, use quiz. If you just need a preference, decision, or open-ended input, use ask_user_question.",
			"For most quiz questions, include a concise 3-6 word summaryTitle for the md-log heading; omit it when a title would be repetitive or awkward.",
			"When teaching a concept, include a stable `conceptId` on each graded quiz so attempts contribute to that concept's mastery history.",
			'correctAnswer is REQUIRED and is the option value, not a position number. Single-select: one string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]).',
			"Always pass the option's `value` string as correctAnswer — it is self-checking and prevents miscounting positions. A value that matches no option is a hard error.",
			"explanation is REQUIRED — always say why the correct answer is correct.",
			"Multi-select is graded as an exact-set match: the user is correct only if they select every correct option and no incorrect ones.",
			"There is no free-text mode. An 'I don't know' choice is ALWAYS added automatically — provide ONLY 4 to 8 real, gradable options. Never add your own uncertainty/opt-out option like 'I don't know', 'I'm not sure', or 'Not sure'; that is handled for you and a manual one would be redundant or gradable-as-wrong.",
			"If a result comes back as dontKnow, the user honestly did not know and did NOT guess — treat it as a genuine knowledge gap to teach into, not as a wrong answer.",
			"After an answer, a non-empty `scratchpad` is returned from the fenced block immediately after that question in the linked md-log. The optional note field is appended to any existing scratchpad text and included in this combined value; treat the whole scratchpad as the learner's reasoning and use it to adapt the next question. If absent, continue normally without asking for it.",
			"Treat each wrong answer (distractor) as a diagnostic probe, not just filler: make it a specific, believable mistake the user might actually hold — a common misconception, or an adjacent/easily-confused concept — so that WHICH wrong answer they pick reveals WHICH nuance of their understanding is off. You learn far more from a targeted wrong choice than from a binary right/wrong, and the choice tells you exactly which gap to teach into next (and what the explanation should address).",
			"Guardrail: every distractor must be unambiguously wrong on the intended reading — tempting, but a real error, not a defensible alternative. Don't drift into trick questions.",
			"Anti-guessing hygiene: don't let the correct answer stand out by form (longest, most precise, most hedged, or the only one in the right format). Keep options similar in length, specificity, and phrasing so it can't be picked from shape alone.",
			"Set multiSelect: true only when more than one option is correct.",
			"Choose 4–8 real answer options based on question complexity and the number of genuinely useful, parallel distractors. Prefer the smallest set that distinguishes the important misconceptions; never target a fixed count or pad with filler. The tool automatically randomizes option order before display, so use stable values and never depend on positions.",
			"Do not make every item the same 'what does this word mean in this sentence?' recognition format. Before a practice sequence, identify the skill being assessed and vary the task when useful: contextual inference, close-meaning contrast, clause/relationship interpretation, sentence repair, transfer to a new context, or a constructed explanation. Use free response when options would cue the answer or when production/translation itself is the target.",
			"Make distractors plausible competitors, not unrelated wrong facts. Use the learner's observed confusions and near-neighbor concepts where available; vary the dimension being tested and keep every option parallel in grammar, specificity, length, and register. If a target answer remains obvious without understanding, rebuild the options or choose a different assessment format.",
			"A correct selected option is evidence only for that narrowly tested recognition decision. If the learner's scratchpad or translation reveals a separate misunderstanding, preserve it as an open gap and probe that subskill later; do not let an easy correct selection stand in for broad comprehension.",
			"At the start of a multi-item round, plan a small but meaningful mix of assessment formats and cognitive demands from the learner's goals/evidence; adapt later items to errors and uncertainty instead of repeating one template. Do not vary formats mechanically when one focused retrieval sequence is more useful.",
			"After feedback, make an explicit modality decision. For language learning, consider reading, listening, and production separately: if the learner requested listening or chose a mixed language-practice round, include at least one useful spoken-language activity with Breeze rather than silently treating all practice as reading. For a partially understood spoken-language target or demonstrated listening gap, prepare a short, target-language audio replay before the next relevant probe. Keep the written transcript/translation concealed until the learner has attempted listening; if the available placement cannot preserve that separation, use audio only as post-answer reinforcement and do not call it a listening assessment. Generate only useful media, not one asset per question.",
			"After feedback, consider whether ComfyUI imagery would materially clarify a structure or relationship. Generate only useful visuals, not one image per question; never let media reveal the answer before submission.",
			"Don't leak the answer through formatting: keep option phrasing/length even and don't hint which is correct.",
			"For explanations and tutoring prose, use Obsidian 1.14+ color highlights sparingly and consistently: ==🟢...== for correct answers/key takeaways, ==🔴...== for misconceptions/incorrect claims, ==🟡...== for cautions or important caveats, ==🔵...== for definitions/context, ==🟣...== for relationships/connections, and ==🟠...== for actions/next steps. Highlight only the shortest useful phrase or sentence; never mark an option before the user answers.",
		],
		parameters: QuizParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const context = params.details?.trim() || undefined;
			const explanation = params.explanation.trim();
			const mode: QuizMode = params.multiSelect ? "multi-select" : "single-select";

			let options: QuizOption[];
			try {
				options = normalizeQuizOptions(params.options);
			} catch (e) {
				return unavailableResult(params.question, mode, `quiz ${(e as Error).message}`, [], context);
			}

			options = shuffleQuizOptions(options);

			// Emit the true (post-shuffle) display order immediately, before the UI
			// blocks on the user's answer. Listeners such as md-log rely on this to
			// show the question in the SAME order the user actually sees it, instead
			// of the pre-shuffle order the agent originally wrote in its tool call.
			// Deliberately omits correctIndices/explanation — this fires before the
			// user has answered and must not leak the answer.
			onUpdate?.({
				content: [{ type: "text", text: "Awaiting user response..." }],
				details: { options: options.map((o, i) => ({ index: i + 1, label: o.label })) },
			});

			const { indices: correctIndices, error: correctError } = resolveCorrect(
				params.correctAnswer as string | string[],
				options,
			);

			if (signal?.aborted) {
				return cancelledResult(params.question, mode, correctIndices, context);
			}

			if (correctError) {
				return unavailableResult(params.question, mode, `quiz ${correctError}`, correctIndices, context);
			}

			if (!ctx.hasUI) {
				return unavailableResult(params.question, mode, "quiz requires interactive mode UI", correctIndices, context);
			}

			return withUILock(async () => {
				const response =
					mode === "single-select"
						? await askSingleChoice(ctx, params.question, context, options, correctIndices, explanation)
						: await askMultiChoice(ctx, params.question, context, options, correctIndices, explanation);
				if (!response) {
					return cancelledResult(params.question, mode, correctIndices, context);
				}
				const scratchpad = appendQuizScratchpad(readLinkedQuizScratchpad(ctx, _toolCallId), response.note);
				return buildResult(
					_toolCallId,
					params.conceptId?.trim() || undefined,
					params.question,
					context,
					mode,
					options,
					response,
					correctIndices,
					explanation,
					scratchpad,
				);
			});
		},

		renderCall(args, theme) {
			// NOTE: never render correctAnswer or explanation here — it would leak
			// the answer into the transcript before the user responds. We also do NOT
			// enumerate the options here: they are shuffled at execute time, so any
			// order shown during streaming would be stale/misleading. The full option
			// list is rendered — in its true display order — by renderResult after the
			// user answers.
			const options = Array.isArray(args.options) ? args.options : [];
			let text = theme.fg("toolTitle", theme.bold("quiz ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const noun = options.length === 1 ? "option" : "options";
				text += theme.fg("dim", ` (${options.length} ${noun})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuizResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}
			if (details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "quiz unavailable"), 0, 0);
			}

			const correctSet = new Set(details.correctIndices);
			const selectedSet = new Set(details.answers.map((a) => a.index));
			const lines: string[] = [];

			// Full option list in the true (shuffled) display order, with ✓/✗ marks.
			// Falls back to just the selected answers for older results that predate
			// details.options.
			const displayed =
				details.options && details.options.length > 0
					? details.options
					: details.answers.map((a) => ({ index: a.index, label: a.label }));

			for (const opt of displayed) {
				const isSelected = selectedSet.has(opt.index);
				const isKey = correctSet.has(opt.index);
				let mark: string;
				let body: string;
				if (details.dontKnow) {
					// No guess — only reveal the correct answer(s); never show ✗.
					mark = isKey ? theme.fg("success", "✓ ") : "  ";
					body = isKey ? theme.fg("success", `${opt.index}. ${opt.label}`) : theme.fg("dim", `${opt.index}. ${opt.label}`);
				} else if (isSelected && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("accent", `${opt.index}. ${opt.label}`);
				} else if (isSelected && !isKey) {
					mark = theme.fg("error", "✗ ");
					body = theme.fg("error", `${opt.index}. ${opt.label}`);
				} else if (!isSelected && isKey) {
					mark = theme.fg("success", "✓ ");
					body = theme.fg("success", `${opt.index}. ${opt.label}`);
				} else {
					mark = "  ";
					body = theme.fg("dim", `${opt.index}. ${opt.label}`);
				}
				lines.push(`${mark}${body}`);
			}

			lines.push("");
			const verdict = details.dontKnow
				? theme.fg("warning", "I don't know")
				: details.correct
					? theme.fg("success", "Correct!")
					: theme.fg("error", "Incorrect");
			lines.push(verdict);

			if (details.note) {
				lines.push(theme.fg("muted", `Note: ${details.note}`));
			}

			if (details.explanation) {
				lines.push(theme.fg("muted", details.explanation));
			}

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
