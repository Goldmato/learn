/**
 * Mirror reading-relevant session content to an Obsidian Markdown note.
 * Generated content is isolated between hidden markers so relinking/backfill
 * never replaces the learner's own note text.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildBackfill,
	replaceManagedTranscript,
	renderTranscript,
	stripSkillBlocks,
	type TranscriptBlock,
	type TranscriptOption,
} from "./md-log-format.ts";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTermyActiveFilePath(): { filePath: string | null; error?: string } {
	const contextFilePath = process.env.TERMY_CONTEXT_PATH;
	if (!contextFilePath) return { filePath: null };
	try {
		const snapshot: unknown = JSON.parse(fs.readFileSync(contextFilePath, "utf-8"));
		if (!isRecord(snapshot)) return { filePath: null, error: "Termy context snapshot is not a JSON object." };
		const activeFile = snapshot.activeFile;
		if (activeFile === null || activeFile === undefined) return { filePath: null };
		if (!isRecord(activeFile) || typeof activeFile.filePath !== "string" || !activeFile.filePath.trim()) {
			return { filePath: null, error: "Termy context has an invalid activeFile value." };
		}
		return { filePath: activeFile.filePath.trim() };
	} catch (error) {
		return {
			filePath: null,
			error: `Could not read Termy context at ${contextFilePath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let transcriptBlocks: TranscriptBlock[] = [];
	let writeLock: Promise<void> = Promise.resolve();

	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const previous = writeLock;
		let release!: () => void;
		writeLock = new Promise<void>((resolve) => { release = resolve; });
		return previous.then(fn).finally(() => release());
	}

	function notifyWriteFailure(ctx: any, error: unknown): void {
		ctx.ui.notify(`md-log could not update the linked note: ${errorMessage(error)}`, "error");
	}

	function writeTranscript(): void {
		if (!logFile) return;
		const stat = fs.statSync(logFile);
		if (!stat.isFile()) throw new Error(`Not a file: ${logFile}`);
		const existing = fs.readFileSync(logFile, "utf-8");
		const updated = replaceManagedTranscript(existing, renderTranscript(transcriptBlocks));
		fs.writeFileSync(logFile, updated, "utf-8");
	}

	function syncTranscript(ctx: any): Promise<void> {
		return withLock(() => {
			try {
				writeTranscript();
			} catch (error) {
				notifyWriteFailure(ctx, error);
			}
		});
	}

	function loadBackfill(ctx: any): { entries: number; diagnostics: string[] } {
		let entries: unknown;
		try {
			entries = ctx.sessionManager.getEntries();
		} catch (error) {
			throw new Error(`Could not read session history: ${errorMessage(error)}`);
		}
		const result = buildBackfill(entries);
		transcriptBlocks = result.blocks;
		return { entries: result.entries, diagnostics: result.diagnostics };
	}

	function lastExplicitGroupActive(): boolean {
		let active = false;
		for (const block of transcriptBlocks) if (block.kind === "group") active = block.active;
		return active;
	}

	pi.on("session_start", async (_event, ctx) => {
		let lastLinkData: unknown;
		let sessionEntries: unknown;
		try {
			sessionEntries = ctx.sessionManager.getEntries();
		} catch (error) {
			ctx.ui.notify(`md-log could not restore its link: ${errorMessage(error)}`, "error");
			return;
		}
		if (!Array.isArray(sessionEntries)) {
			ctx.ui.notify("md-log could not restore its link: session history was not an array.", "error");
			return;
		}
		for (const entry of sessionEntries) {
			if (isRecord(entry) && entry.type === "custom" && entry.customType === "md-log") {
				lastLinkData = entry.data;
			}
		}
		const result = buildBackfill(sessionEntries);
		transcriptBlocks = result.blocks;
		if (!isRecord(lastLinkData) || typeof lastLinkData.file !== "string" || !lastLinkData.file) return;

		logFile = lastLinkData.file;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("md-log", theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(logFile)));
		await syncTranscript(ctx);
		for (const diagnostic of result.diagnostics) ctx.ui.notify(`md-log backfill: ${diagnostic}`, "warning");
	});

	pi.on("message_end", async (event, ctx) => {
		if (!logFile) return;
		const message = event.message;
		if (!isRecord(message)) return;
		if (message.role === "user") {
			const text = stripSkillBlocks(
				(typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.filter((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string")
							.map((part: Record<string, any>) => part.text).join("\n")
						: "").trim(),
			);
			if (text) {
				transcriptBlocks.push({ kind: "prose", role: "user", text });
				await syncTranscript(ctx);
			}
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			const text = message.content
				.filter((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string")
				.map((part: Record<string, any>) => part.text.trim())
				.filter(Boolean)
				.join("\n\n");
			if (text) {
				transcriptBlocks.push({ kind: "prose", role: "assistant", text });
				await syncTranscript(ctx);
			}
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!logFile || !isRecord(event) || event.toolName !== "ask_user_question") return;
		const input = isRecord(event.input) ? event.input : {};
		const options: TranscriptOption[] = Array.isArray(input.options)
			? input.options.flatMap((option: unknown, index: number) =>
				isRecord(option) && typeof option.label === "string" ? [{ index: index + 1, label: option.label }] : [])
			: [];
		transcriptBlocks.push({
			kind: "ask",
			callId: typeof event.toolCallId === "string" ? event.toolCallId : "",
			question: typeof input.question === "string" ? input.question : "(Question unavailable)",
			context: typeof input.details === "string" ? input.details.trim() || undefined : undefined,
			options,
		});
		await syncTranscript(ctx);
	});

	pi.on("tool_execution_update", async (event, ctx) => {
		if (!logFile || !isRecord(event) || event.toolName !== "quiz") return;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		if (!callId || transcriptBlocks.some((block) => block.kind === "quiz" && block.callId === callId)) return;
		const partialResult = isRecord(event.partialResult) ? event.partialResult : {};
		const details = isRecord(partialResult.details) ? partialResult.details : {};
		if (!Array.isArray(details.options) || details.options.length === 0) return;
		const input = isRecord(event.args) ? event.args : {};
		const options = details.options.flatMap((option: unknown, index: number) =>
			isRecord(option) && typeof option.label === "string"
				? [{ index: Number.isInteger(option.index) ? option.index : index + 1, label: option.label }]
				: []);
		transcriptBlocks.push({
			kind: "quiz",
			callId,
			question: typeof input.question === "string" ? input.question : "(Question unavailable)",
			context: typeof input.details === "string" ? input.details.trim() || undefined : undefined,
			options,
		});
		await syncTranscript(ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!logFile || !isRecord(event) || !QA_TOOLS.has(event.toolName)) return;
		const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
		const kind = event.toolName === "quiz" ? "quiz" : "ask";
		const block = transcriptBlocks.find((item) => item.kind === kind && item.callId === callId);
		if (!block || (block.kind !== "quiz" && block.kind !== "ask")) return;
		block.details = isRecord(event.details) ? event.details : { status: "unavailable", message: "Question result metadata was missing." };
		await syncTranscript(ctx);
	});

	pi.registerCommand("md-log", {
		description: "Mirror the session to a markdown file; in Termy, defaults to the active note",
		handler: async (args, ctx: any) => {
			let filepath = args.trim();
			if (!filepath) {
				const termyContext = getTermyActiveFilePath();
				if (termyContext.error) {
					ctx.ui.notify(termyContext.error, "error");
					return;
				}
				filepath = termyContext.filePath ?? "";
			}
			if (!filepath) {
				ctx.ui.notify("Usage: /md-log <filepath> or open a note in Obsidian first", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the agent to finish before linking.", "warning");
				return;
			}

			const resolved = path.isAbsolute(filepath) ? filepath : path.resolve(ctx.cwd, filepath);
			if (!fs.existsSync(resolved)) {
				ctx.ui.notify(`File does not exist: ${resolved}`, "error");
				return;
			}
			if (!fs.statSync(resolved).isFile()) {
				ctx.ui.notify(`Not a file: ${resolved}`, "error");
				return;
			}

			logFile = resolved;
			pi.appendEntry("md-log", { file: resolved });
			try {
				const result = loadBackfill(ctx);
				await withLock(writeTranscript);
				const theme = ctx.ui.theme;
				ctx.ui.setStatus("md-log", theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(resolved)));
				ctx.ui.notify(`Linked: ${resolved} (${result.entries} entries backfilled)`, "success");
				for (const diagnostic of result.diagnostics) ctx.ui.notify(`md-log backfill: ${diagnostic}`, "warning");
			} catch (error) {
				ctx.ui.notify(`md-log could not backfill ${resolved}: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("md-unlog", {
		description: "Stop mirroring the session to a markdown file",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("No file linked", "warning");
				return;
			}
			const name = path.basename(logFile);
			logFile = null;
			pi.appendEntry("md-log", { file: null });
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`Unlinked: ${name}`, "info");
		},
	});

	pi.registerCommand("quiz-start", {
		description: "Start an explicit quiz group in md-log",
		handler: async (args, ctx: any) => {
			if (lastExplicitGroupActive()) {
				ctx.ui.notify("A quiz group is already open; use /quiz-end first.", "warning");
				return;
			}
			const title = args.trim().replace(/[\r\n#]+/g, " ").trim() || "Quiz";
			const boundary = { active: true, title };
			pi.appendEntry("md-log-quiz-group", boundary);
			transcriptBlocks.push({ kind: "group", ...boundary });
			if (logFile) await syncTranscript(ctx);
			ctx.ui.notify(`Quiz group started: ${title}`, "success");
		},
	});

	pi.registerCommand("quiz-end", {
		description: "End an explicit quiz group in md-log",
		handler: async (_args, ctx: any) => {
			if (!lastExplicitGroupActive()) {
				ctx.ui.notify("No explicit quiz group is open.", "warning");
				return;
			}
			pi.appendEntry("md-log-quiz-group", { active: false });
			transcriptBlocks.push({ kind: "group", active: false });
			if (logFile) await syncTranscript(ctx);
			ctx.ui.notify("Quiz group ended.", "success");
		},
	});
}
