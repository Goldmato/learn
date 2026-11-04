import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { EditorTheme } from "@mariozechner/pi-tui";

export function createQuestionEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

export function addQuestionModalWrappedLine(
	lines: string[],
	text: string,
	width: number,
	indent = " ",
): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

export function pushQuestionModalHeader(
	lines: string[],
	theme: any,
	width: number,
	question: string,
	context?: string,
): void {
	lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
	addQuestionModalWrappedLine(lines, theme.fg("text", question), width);
	if (context) {
		lines.push("");
		addQuestionModalWrappedLine(lines, theme.fg("muted", context), width);
	}
}

export function pushQuestionModalFooter(lines: string[], theme: any, width: number, hint: string): void {
	lines.push("");
	lines.push(truncateToWidth(theme.fg("dim", ` ${hint}`), width));
	lines.push(truncateToWidth(theme.fg("accent", "─".repeat(width)), width));
}
