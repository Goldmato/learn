/**
 * Mirror reading-relevant session content to an Obsidian Markdown note.
 * Generated content is isolated between hidden markers so relinking/backfill
 * never replaces the learner's own note text.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	buildBackfill,
	extractManagedTranscript,
	renderTranscriptWithPlacements,
	replaceManagedTranscript,
	renderTranscript,
	hasRecentTranscriptBlock,
	isNonSubstantiveAssistantUpdate,
	stripSkillBlocks,
	TRANSCRIPT_END,
	placeManagedSectionAtTop,
	TRANSCRIPT_START,
	TEACH_ATTACH_IMAGE_TOOL,
	TEACH_BREEZE_TTS_TOOL,
	TEACH_COMFYUI_PAINT_TOOL,
	TEACH_VISUAL_TOOL,
	TEACH_FREE_RESPONSE_TOOL,
	TEACH_LEARNING_INTERVIEW_TOOL,
	TEACH_RECORD_ATTEMPT_TOOL,
	type TranscriptBlock,
	type TranscriptOption,
} from "../lib/md-log-format.ts";
import { withMdLogWriteLock } from "../lib/md-log-write-lock.ts";
import { updateMasteryFrontmatter, type MasteryRecord } from "../lib/teach-learning-state.ts";
import {
	findRelatedMasteryNotes,
	findVaultRootForNote,
	scanVaultMastery,
	updateRelatedFrontmatter,
} from "../lib/mastery-vault.ts";
import { cancelAnswerModal } from "../lib/answer-modal.ts";

const QA_TOOLS = new Set(["quiz", "ask_user_question"]);
const VAULT_NOTE_SKIP_DIRECTORIES = new Set([".obsidian", ".git", ".pi", ".trash", "node_modules"]);

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

function latestEndLessonState(markdown: string): string | undefined {
	const marker = /<!-- pi-end-lesson:v1\r?\n([\s\S]*?)\r?\n-->/g;
	let latest: string | undefined;
	for (const match of markdown.matchAll(marker)) {
		const state = match[1].trim();
		if (state) latest = state;
	}
	return latest;
}

function stripEndLessonMarkers(markdown: string): string {
	const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
	return markdown
		.replace(/<!-- pi-end-lesson:v1\r?\n[\s\S]*?\r?\n-->/g, "")
		.replace(/(?:\r?\n[ \t]*){3,}/g, `${newline}${newline}`);
}

function listVaultMarkdownPaths(vaultRoot: string): string[] {
	const paths: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!VAULT_NOTE_SKIP_DIRECTORIES.has(entry.name.toLowerCase())) visit(entryPath);
			} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
				paths.push(path.relative(vaultRoot, entryPath));
			}
		}
	};
	visit(vaultRoot);
	return paths.sort((left, right) => left.localeCompare(right));
}

function noteBodyIsEmpty(markdown: string): boolean {
	const withoutFrontmatter = markdown.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
	return withoutFrontmatter.trim().length === 0;
}

function getUnlinkedNoteCandidate(cwd: string): { filePath: string; error?: string } | undefined {
	const activeNote = getTermyActiveFilePath();
	if (!activeNote.filePath) return undefined;
	const filePath = path.isAbsolute(activeNote.filePath) ? activeNote.filePath : path.resolve(cwd, activeNote.filePath);
	if (path.extname(filePath).toLowerCase() !== ".md") return undefined;
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return undefined;
		const content = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
		const isEmpty = noteBodyIsEmpty(content);
		const markerStart = content.indexOf(TRANSCRIPT_START);
		const hasManagedMarkers = markerStart >= 0 && content.indexOf(TRANSCRIPT_END, markerStart + TRANSCRIPT_START.length) >= 0;
		return isEmpty || hasManagedMarkers ? { filePath } : undefined;
	} catch (error) {
		return {
			filePath,
			error: `Could not inspect the active note: ${errorMessage(error)}`,
		};
	}
}

export default function mdLog(pi: ExtensionAPI) {
	let logFile: string | null = null;
	let transcriptBlocks: TranscriptBlock[] = [];
	let endLessonTurnActive = false;

	function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		return withMdLogWriteLock(fn);
	}

	function notifyWriteFailure(ctx: any, error: unknown): void {
		ctx.ui.notify(`md-log could not update the linked note: ${errorMessage(error)}`, "error");
	}

	function writeTranscript(ctx: any): void {
		if (!logFile) return;
		const stat = fs.statSync(logFile);
		if (!stat.isFile()) throw new Error(`Not a file: ${logFile}`);
		const existing = fs.readFileSync(logFile, "utf-8");
		const entries = ctx.sessionManager.getEntries();
		const rendered = renderTranscriptWithPlacements(transcriptBlocks, entries, logFile, existing);
		const updated = replaceManagedTranscript(existing, rendered);
		fs.writeFileSync(logFile, updated, "utf-8");
	}

	function syncTranscript(ctx: any): Promise<void> {
		return withLock(() => {
			try {
				writeTranscript(ctx);
			} catch (error) {
				notifyWriteFailure(ctx, error);
			}
		});
	}

	function appendProseBlock(role: "user" | "assistant", text: string, ctx: any): Promise<void> {
		return withLock(() => {
			if (!logFile) return;
			try {
				const existing = fs.readFileSync(logFile, "utf-8");
				if (hasRecentTranscriptBlock(existing, role, text)) return;
				transcriptBlocks.push({ kind: "prose", role, text });
				writeTranscript(ctx);
			} catch (error) {
				notifyWriteFailure(ctx, error);
			}
		});
	}

	function syncMastery(conceptId: string, masteryState: MasteryRecord, ctx: any): Promise<void> {
		return withLock(() => {
			if (!logFile) return;
			try {
				const existing = fs.readFileSync(logFile, "utf-8");
				const updated = updateMasteryFrontmatter(existing, conceptId, masteryState);
				if (updated !== existing) fs.writeFileSync(logFile, updated, "utf-8");
				writeTranscript(ctx);
			} catch (error) {
				notifyWriteFailure(ctx, error);
			}
		});
	}

	function syncBackfilledMastery(ctx: any): Promise<void> {
		return withLock(() => {
			if (!logFile) return;
			try {
				let existing = fs.readFileSync(logFile, "utf-8");
				let updated = existing;
				const latest = new Map<string, MasteryRecord>();
				for (const block of transcriptBlocks) {
					if (block.kind !== "attempt" || !block.masteryState) continue;
					const previous = latest.get(block.conceptId);
					if (!previous || block.masteryState.evidenceCount >= previous.evidenceCount) {
						latest.set(block.conceptId, block.masteryState);
					}
				}
				for (const [conceptId, masteryState] of latest) {
					updated = updateMasteryFrontmatter(updated, conceptId, masteryState);
				}
				if (updated !== existing) fs.writeFileSync(logFile, updated, "utf-8");
				writeTranscript(ctx);
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

	async function importPriorTranscript(filePath: string, ctx: any): Promise<boolean> {
		if (typeof pi.appendEntry !== "function") return false;
		if (transcriptBlocks.some((block) =>
			block.kind === "markdown" && path.resolve(block.file) === filePath)) return false;

		const noteContents = fs.readFileSync(filePath, "utf-8");
		const previousTranscript = extractManagedTranscript(noteContents);
		// Prose the user wrote outside the managed section is part of the note's
		// content, so it must be addressable as placement anchors too. Import it
		// once, on link, and let the renderer own it from then on.
		const withoutFrontmatter = noteContents.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
		const managedStart = withoutFrontmatter.indexOf(TRANSCRIPT_START);
		const managedEnd = withoutFrontmatter.indexOf(TRANSCRIPT_END);
		const outsideProse = (managedStart >= 0 && managedEnd > managedStart
			? `${withoutFrontmatter.slice(0, managedStart)}\n\n${withoutFrontmatter.slice(managedEnd + TRANSCRIPT_END.length)}`
			: withoutFrontmatter).trim();
		const imported = [
			previousTranscript ? stripEndLessonMarkers(previousTranscript).trim() : "",
			stripEndLessonMarkers(outsideProse).trim(),
		].filter(Boolean).join("\n\n");
		if (!imported || imported === renderTranscript(transcriptBlocks).trim()) return false;
		const previousTranscriptText = imported;

		if (typeof pi.sendMessage === "function") {
			await pi.sendMessage({
				customType: "md-log-context",
				content: [
					`The following is the prior transcript from the linked note "${path.basename(filePath)}".`,
					"This transcript is now included in the agent's conversation context. Use it directly; do not use shell, grep, find, or file-reading tools to retrieve the linked note again.",
					"Treat it as context, not as a request to rewrite or replace the note.",
					"",
					previousTranscriptText,
				].join("\n"),
			}, { triggerTurn: false });
		}
		pi.appendEntry("md-log-import", { file: filePath, markdown: previousTranscriptText });
		loadBackfill(ctx);
		return true;
	}

	async function importEndLessonState(filePath: string, ctx: any): Promise<void> {
		const state = latestEndLessonState(fs.readFileSync(filePath, "utf-8"));
		if (!state) return;
		if (typeof pi.sendMessage !== "function") {
			ctx.ui.notify("A saved lesson-end marker exists in the linked note, but agent context delivery is unavailable.", "warning");
			return;
		}
		try {
			await pi.sendMessage({
				customType: "md-log-end-lesson-context",
				content: [
					`Latest saved lesson-end state from "${path.basename(filePath)}":`,
					state,
					"Read skills/teach/SKILL.md, then reconcile this handoff with the transcript already supplied in conversation context and the session history. Do not search for or reread the linked note using shell or file tools. Resume only an explicitly unanswered interaction. If none is pending, the lesson is ended; do not infer a new quiz from transcript teasers or create another activity.",
				].join("\n\n"),
				display: false,
			}, { triggerTurn: false });
		} catch (error) {
			ctx.ui.notify(`md-log could not deliver the saved lesson-end state: ${errorMessage(error)}`, "warning");
		}
	}

	function lastExplicitGroupActive(): boolean {
		let active = false;
		for (const block of transcriptBlocks) if (block.kind === "group") active = block.active;
		return active;
	}

	async function linkNote(filePath: string, ctx: any): Promise<void> {
		logFile = filePath;
		pi.appendEntry("md-log", { file: filePath });
		try {
			// Prose above the managed markers is unreachable as an anchor, so pull the
			// section above it before importing. The import then reads it as managed
			// content and the renderer emits it once.
			const existingNote = fs.readFileSync(filePath, "utf-8");
			const placedNote = placeManagedSectionAtTop(existingNote);
			if (placedNote !== existingNote) fs.writeFileSync(filePath, placedNote, "utf-8");
			let result = loadBackfill(ctx);
			if (await importPriorTranscript(filePath, ctx)) result = loadBackfill(ctx);
			await importEndLessonState(filePath, ctx);
			await syncBackfilledMastery(ctx);
			await refreshMasteryContext(filePath, ctx);
			const theme = ctx.ui.theme;
			ctx.ui.setStatus("md-log", theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(filePath)));
			ctx.ui.notify(`Linked: ${filePath} (${result.entries} entries backfilled)`, "success");
			ctx.ui.notify(`md-log status: linked to ${filePath}`, "info");
			for (const diagnostic of result.diagnostics) ctx.ui.notify(`md-log backfill: ${diagnostic}`, "warning");
		} catch (error) {
			logFile = null;
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`md-log could not backfill ${filePath}: ${errorMessage(error)}`, "error");
		}
	}

	async function refreshMasteryContext(filePath: string, ctx: any): Promise<void> {
		try {
			const vaultRoot = findVaultRootForNote(filePath);
			const scan = scanVaultMastery(vaultRoot);
			for (const diagnostic of scan.diagnostics) ctx.ui.notify(`Mastery vault scan: ${diagnostic}`, "warning");
			const { current, related } = findRelatedMasteryNotes(scan, filePath);
			await withLock(() => {
				const currentMarkdown = fs.readFileSync(filePath, "utf-8");
				const linkedCurrent = updateRelatedFrontmatter(currentMarkdown, related.map((note) => note.linkTarget));
				const staged = [{ filePath, original: currentMarkdown, updated: linkedCurrent }];

				if (current) {
					const reciprocalTarget = current.linkTarget;
					for (const relatedNote of related) {
						const markdown = fs.readFileSync(relatedNote.filePath, "utf-8");
						const updated = updateRelatedFrontmatter(markdown, [reciprocalTarget]);
						staged.push({ filePath: relatedNote.filePath, original: markdown, updated });
					}
				}
				for (const item of staged) {
					if (item.updated !== item.original) fs.writeFileSync(item.filePath, item.updated, "utf-8");
				}
			});

			const concepts = new Map<string, Array<{ title: string; path: string; record: MasteryRecord }>>();
			for (const note of scan.notes) {
				for (const [conceptId, record] of note.mastery) {
					const matches = concepts.get(conceptId) ?? [];
					matches.push({ title: note.title, path: note.relativePath, record });
					concepts.set(conceptId, matches);
				}
			}
			const catalogue = [...concepts].sort(([left], [right]) => left.localeCompare(right));
			const cataloguePreview = catalogue.slice(0, 100).map(([conceptId]) => conceptId);
			const relatedContext = related.map((note) => ({
				title: note.title,
				path: note.relativePath,
				sharedConcepts: [...note.mastery]
					.filter(([conceptId]) => current?.mastery.has(conceptId))
					.map(([conceptId, record]) => ({ conceptId, record })),
			}));
			const content = [
				"Current Obsidian vault mastery context for selecting stable concept IDs and avoiding duplicate concepts.",
				"Before inventing a conceptId for a graded interaction, use teach_find_mastery_concepts to search the full vault catalogue and reuse an exact existing ID when it matches the learning goal. IDs are exact, case-sensitive identifiers.",
				`Vault mastery concept IDs: ${catalogue.length} total; previewing ${cataloguePreview.length}.`,
				JSON.stringify(cataloguePreview),
				"Related notes sharing exact concept IDs with the currently linked note:",
				JSON.stringify(relatedContext),
			].join("\n\n");
			if (typeof pi.sendMessage === "function") {
				await pi.sendMessage({ customType: "md-log-mastery-context", content }, { triggerTurn: false });
			}
		} catch (error) {
			ctx.ui.notify(`md-log could not refresh vault mastery context: ${errorMessage(error)}`, "warning");
		}
	}

	function showUnlinkedReminder(filePath: string, ctx: any): void {
		const name = path.basename(filePath);
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("md-log", theme.fg("warning", "⚠ ") + theme.fg("dim", `/md-log • ${name}`));
		ctx.ui.notify(`md-log status: not linked. Active note detected: ${name}. Run /md-log to link it later.`, "warning");
	}

	function showUnlinkedStatus(ctx: any, detail: string): void {
		ctx.ui.setStatus("md-log", ctx.ui.theme.fg("warning", "⚠ ") + ctx.ui.theme.fg("dim", "md-log • not linked"));
		ctx.ui.notify(`md-log status: not linked. ${detail}`, "warning");
	}

	async function promptToLinkNote(candidatePath: string, ctx: any): Promise<{ filePath?: string; declined: boolean }> {
		const name = path.basename(candidatePath);
		if (typeof ctx.ui.select === "function") {
			const choice = await ctx.ui.select(
				"md-log status",
				[`Yes — link ${name}`, "No — keep this session unlinked", "Other — choose a different note"],
			);
			if (choice?.startsWith("Yes")) return { filePath: candidatePath, declined: false };
			if (choice?.startsWith("Other")) {
				if (typeof ctx.ui.input !== "function") {
					ctx.ui.notify("md-log cannot choose another note because text input is unavailable.", "error");
					return { declined: false };
				}
				return { filePath: (await ctx.ui.input("Choose a Markdown note", candidatePath))?.trim() || undefined, declined: false };
			}
			return { declined: choice?.startsWith("No") ?? false };
		}

		if (typeof ctx.ui.confirm === "function") {
			const confirmed = await ctx.ui.confirm(
				"Link active note to md-log?",
				`Termy detected "${name}". Link this session and mirror its transcript to that note?`,
			);
			return confirmed ? { filePath: candidatePath, declined: false } : { declined: true };
		}
		return { declined: false };
	}

	pi.on("session_start", async (event, ctx) => {
		logFile = null;
		ctx.ui.setStatus("md-log", undefined);
		let lastLinkData: unknown;
		let sessionEntries: unknown;
		try {
			sessionEntries = ctx.sessionManager.getEntries();
		} catch (error) {
			ctx.ui.notify(`md-log could not restore its link: ${errorMessage(error)}`, "error");
			return;
		}
		if (!Array.isArray(sessionEntries)) {
			showUnlinkedStatus(ctx, "Session history was not an array.");
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
		if (!isRecord(lastLinkData) || typeof lastLinkData.file !== "string" || !lastLinkData.file) {
			if (isRecord(lastLinkData) && lastLinkData.file === null && event.reason !== "new" && event.reason !== "fork") {
				showUnlinkedStatus(ctx, "This session was explicitly left unlinked.");
				return;
			}
			const candidate = getUnlinkedNoteCandidate(ctx.cwd);
			if (candidate?.error) {
				showUnlinkedStatus(ctx, candidate.error);
				ctx.ui.notify(`md-log could not check the active note: ${candidate.error}`, "warning");
				return;
			}
			if (candidate) {
				try {
					const selection = await promptToLinkNote(candidate.filePath, ctx);
					if (selection.filePath) {
						const resolved = path.isAbsolute(selection.filePath) ? selection.filePath : path.resolve(ctx.cwd, selection.filePath);
						if (path.extname(resolved).toLowerCase() !== ".md") {
							ctx.ui.notify("md-log can only link Markdown (.md) notes.", "error");
							showUnlinkedStatus(ctx, "The selected file was not a Markdown note.");
							return;
						}
						if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
							ctx.ui.notify(`md-log note does not exist or is not a file: ${resolved}`, "error");
							showUnlinkedStatus(ctx, "The selected note could not be opened.");
							return;
						}
						await linkNote(resolved, ctx);
						return;
					}
					if (selection.declined) pi.appendEntry("md-log", { file: null });
				} catch (error) {
					ctx.ui.notify(`md-log could not show the link prompt: ${errorMessage(error)}`, "warning");
				}
				showUnlinkedReminder(candidate.filePath, ctx);
				return;
			}
			showUnlinkedStatus(ctx, "No empty or active md-log note was detected.");
			return;
		}

		logFile = lastLinkData.file;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("md-log", theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(logFile)));
		try {
			const imported = await importPriorTranscript(logFile, ctx);
			await importEndLessonState(logFile, ctx);
			await syncBackfilledMastery(ctx);
			await refreshMasteryContext(logFile, ctx);
			for (const diagnostic of (imported ? loadBackfill(ctx) : result).diagnostics) {
				ctx.ui.notify(`md-log backfill: ${diagnostic}`, "warning");
			}
			if (event.reason !== "reload") ctx.ui.notify(`md-log status: linked to ${logFile}`, "info");
		} catch (error) {
			const failedFile = logFile;
			logFile = null;
			ctx.ui.setStatus("md-log", undefined);
			ctx.ui.notify(`md-log could not restore ${failedFile}: ${errorMessage(error)}`, "error");
			showUnlinkedStatus(ctx, `Could not restore ${failedFile}.`);
		}
	});

	pi.registerCommand("resume-agent", {
		description: "Resume explicit unfinished work without adding a user message or starting a new activity",
		handler: async (_args, ctx) => {
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before resuming.", "warning");
				return;
			}
			if (typeof pi.sendMessage !== "function") {
				ctx.ui.notify("The agent cannot be resumed because custom message delivery is unavailable.", "error");
				return;
			}
			try {
				let savedState: string | undefined;
				if (logFile) {
					const target = logFile;
					await withLock(() => {
						if (logFile !== target) throw new Error("The linked md-log note changed before its resume state could be read.");
						const note = fs.readFileSync(target, "utf-8");
						savedState = latestEndLessonState(note);
						const cleanedNote = stripEndLessonMarkers(note);
						if (cleanedNote !== note) fs.writeFileSync(target, cleanedNote, "utf-8");
						transcriptBlocks = transcriptBlocks.map((block) =>
							block.kind === "markdown"
								? { ...block, markdown: stripEndLessonMarkers(block.markdown) }
								: block);
						if (cleanedNote !== note) writeTranscript(ctx);
					});
				}
				await pi.sendMessage({
					customType: "md-log-resume-agent",
					content: [
						"Resume this learning session carefully.",
						[
							"First read the complete teaching instructions in skills/teach/SKILL.md.",
							logFile
								? "The linked md-log transcript is already supplied in conversation context by md-log; use that context and the session history directly instead of searching for, opening, or shell-reading the note."
								: "No md-log note is linked. Use the existing conversation and session history; do not use shell, grep, find, or file tools to guess which transcript to open.",
							"If the expected linked transcript is missing from context, say so and ask the learner to run /md-log rather than searching for it.",
						].join(" "),
						"Resume only work that is explicitly still unfinished. If the saved handoff says the lesson ended or no interaction is pending, briefly confirm that state and wait for the learner's next request; do not treat an earlier assistant offer or teaser as a task. If there is no handoff and the transcript has no unanswered interaction, report that the lesson is paused and wait—do not start a new quiz, interview, or replacement activity.",
						"If a question dialog is explicitly unanswered, resume that same question rather than creating another. A cancelled or skipped question is a learner choice, not an unanswered question; do not regenerate an equivalent question unless the learner asks. Never repeat a completed question or round.",
						"Use recent session history to resolve ambiguity, but do not ask the learner to restate information already in the transcript. If no explicit unfinished work can be established, say so briefly and stop.",
						savedState
							? `Saved handoff (the note marker has been consumed):\n${savedState}`
							: "No saved lesson-end handoff was present; continue only an explicitly unfinished interaction or task found in the transcript and session history.",
					].join("\n\n"),
					display: false,
				}, { triggerTurn: true });
				ctx.ui.notify("Agent continuation started from the existing session context.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not resume the agent: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("rename", {
		description: "Rename the linked lesson log based on its transcript and vault naming conventions",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("Link an md-log note with /md-log before renaming it.", "warning");
				return;
			}
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent run to finish before renaming the lesson log.", "warning");
				return;
			}
			if (typeof pi.sendMessage !== "function") {
				ctx.ui.notify("The lesson log cannot be renamed because custom message delivery is unavailable.", "error");
				return;
			}
			try {
				await pi.sendMessage({
					customType: "md-log-rename",
					content: [
						"The user invoked /rename for the currently linked lesson log.",
						"Review the complete lesson transcript and recent session context to identify its actual subject and focus. First call teach_list_vault_note_names and use the returned relative Markdown paths to infer the vault's existing filename conventions.",
						"Then choose one concise, descriptive filename that follows those conventions and call teach_rename_md_log with its basename (with or without .md). Do not rename any other file. If the transcript does not support a clear title, do not rename it; explain briefly.",
					].join("\n\n"),
					display: false,
				}, { triggerTurn: true });
				ctx.ui.notify("Lesson log rename requested; the agent will compare its transcript with vault note names.", "info");
			} catch (error) {
				ctx.ui.notify(`Could not start lesson log renaming: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerCommand("end-lesson", {
		description: "Ask the agent to stop teaching and save a hidden resume marker in the linked md-log note",
		handler: async (_args, ctx) => {
			if (!logFile) {
				ctx.ui.notify("Link an md-log note with /md-log before ending the lesson.", "warning");
				return;
			}
			if (typeof pi.sendMessage !== "function") {
				ctx.ui.notify("The lesson cannot be ended because custom message delivery is unavailable.", "error");
				return;
			}
			try {
				const activeDialogState = cancelAnswerModal();
				endLessonTurnActive = true;
				await pi.sendMessage({
					customType: "md-log-end-lesson",
					content: [
						"The user invoked /end-lesson. End the current learning session now; do not continue teaching, ask another question, or start a replacement interaction.",
						"Write only the single direct action or tool call the next agent should take, plus the minimum state or arguments required to do it (for example, the active unanswered question and that no option was selected). Omit topic recaps, goals, established knowledge, explanations, and later plans unless needed to execute that immediate action.",
						"If no live question dialog is active, state that the lesson ended with no interaction pending and the next agent must wait for the learner's next request. Do not turn a prior assistant offer or teaser into a task. A cancelled/skipped dialog is not an unanswered question.",
						"Do not guess any selection or draft that is not visible in the conversation. Keep the handoff under 300 characters. Call teach_end_lesson with that state so it is appended as a hidden marker to the linked md-log note. After the tool succeeds, give only a brief confirmation.",
						...(activeDialogState
							? ["Live answer-dialog state captured before it was closed:", activeDialogState]
							: []),
					].join("\n\n"),
					display: false,
				}, { triggerTurn: true });
				ctx.ui.notify("Lesson wrap-up requested; the agent will save a hidden resume state to the linked note.", "info");
			} catch (error) {
				endLessonTurnActive = false;
				ctx.ui.notify(`Could not start lesson wrap-up: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "teach_end_lesson",
		label: "Teaching: Save Lesson Resume State",
		description: "Append a concise hidden resume marker to the linked md-log note when /end-lesson is invoked.",
		promptSnippet: "Record the current teaching state for a future lesson",
		promptGuidelines: [
			"Use only to complete /end-lesson; do not use during ordinary teaching.",
			"Record only an explicitly unanswered live interaction to resume, with minimum context/arguments. If no live interaction is pending, say the lesson ended and the next agent must wait for the learner's next request.",
			"Do not infer a new quiz or task from a prior assistant offer or teaser. A cancelled/skipped dialog is not unanswered.",
			"Omit general lesson summaries, learning goals, established knowledge, explanations, and future plans. Keep the state under 300 characters and never invent an answer.",
		],
		parameters: Type.Object({
			state: Type.String({ minLength: 1, maxLength: 300 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params) {
			const state = params.state.trim();
			if (!state || state.length > 300) throw new Error("Lesson resume state must contain 1-300 non-whitespace characters.");
			if (state.includes("<!--") || state.includes("-->")) {
				throw new Error("Lesson resume state must not contain HTML comment delimiters.");
			}
			const target = logFile;
			if (!target) throw new Error("No md-log note is linked; run /md-log before saving lesson state.");

			return withLock(() => {
				if (logFile !== target) throw new Error("The linked md-log note changed before the lesson state could be saved.");
				const stat = fs.statSync(target);
				if (!stat.isFile()) throw new Error(`Not a file: ${target}`);
				const existing = fs.readFileSync(target, "utf-8");
				const cleanedExisting = stripEndLessonMarkers(existing);
				const marker = `<!-- pi-end-lesson:v1\n${state}\n-->`;
				const separator = !cleanedExisting ? "" : cleanedExisting.endsWith("\n\n") ? "" : cleanedExisting.endsWith("\n") ? "\n" : "\n\n";
				fs.writeFileSync(target, `${cleanedExisting}${separator}${marker}\n`, "utf-8");
				return {
					content: [{ type: "text" as const, text: "Hidden lesson resume state recorded at the end of the linked note." }],
					details: { status: "recorded", notePath: target, state, replacedPrevious: cleanedExisting !== existing },
				};
			});
		},
	});

	pi.registerTool({
		name: "teach_list_vault_note_names",
		label: "Teaching: List Vault Note Names",
		description: "List Markdown note paths in the linked lesson's Obsidian vault to help infer its filename conventions.",
		promptSnippet: "Inspect vault Markdown filenames before renaming the linked lesson log",
		promptGuidelines: [
			"Use only when the user invokes /rename.",
			"Inspect the returned relative paths to match the vault's existing naming convention.",
			"The list contains filenames only; do not infer note contents from names.",
		],
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute() {
			const target = logFile;
			if (!target) throw new Error("No md-log note is linked; run /md-log before listing vault note names.");
			const vaultRoot = findVaultRootForNote(target);
			const notePaths = listVaultMarkdownPaths(vaultRoot);
			const limit = 300;
			const listedPaths = notePaths.slice(0, limit).map((notePath) => notePath.replace(/\\/g, "/"));
			const omitted = notePaths.length - listedPaths.length;
			return {
				content: [{
					type: "text" as const,
					text: [
						`Markdown notes in the linked note's vault (${notePaths.length} total; ${listedPaths.length} shown):`,
						...listedPaths,
						...(omitted ? [`${omitted} additional note paths omitted.`] : []),
					].join("\n"),
				}],
				details: { total: notePaths.length, listed: listedPaths.length, omitted },
			};
		},
	});

	pi.registerTool({
		name: "teach_rename_md_log",
		label: "Teaching: Rename Lesson Log",
		description: "Rename only the currently linked lesson Markdown file within its existing vault folder.",
		promptSnippet: "Rename the linked lesson log to a descriptive, convention-matching filename",
		promptGuidelines: [
			"Use only after /rename and after inspecting teach_list_vault_note_names.",
			"Choose a concise basename grounded in the lesson transcript and matching the vault's existing note filenames.",
			"Pass a filename only, not a path; the current folder and .md extension are preserved.",
			"Never rename another note or overwrite an existing file.",
		],
		parameters: Type.Object({
			fileName: Type.String({ minLength: 1, maxLength: 160 }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const requestedName = params.fileName.trim();
			if (!requestedName || requestedName.includes("/") || requestedName.includes("\\")) {
				throw new Error("The new lesson-log name must be a basename, not a path.");
			}
			const basename = requestedName.replace(/\.md$/i, "").trim();
			if (
				!basename
				|| basename === "."
				|| basename === ".."
				|| /[<>:"/\\|?*\x00-\x1f]/.test(basename)
				|| /[. ]$/.test(basename)
				|| /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(basename)
			) {
				throw new Error("The new lesson-log name contains characters or a reserved name that is not valid for a Windows Markdown filename.");
			}

			const target = logFile;
			if (!target) throw new Error("No md-log note is linked; run /md-log before renaming it.");
			return withLock(() => {
				if (logFile !== target) throw new Error("The linked md-log note changed before it could be renamed.");
				const sourcePath = path.resolve(target);
				const sourceStat = fs.lstatSync(sourcePath);
				if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`Not a regular file: ${sourcePath}`);
				if (path.extname(sourcePath).toLowerCase() !== ".md") throw new Error(`The linked lesson log is not a Markdown file: ${sourcePath}`);

				const vaultRoot = findVaultRootForNote(sourcePath);
				const relativeSource = path.relative(vaultRoot, sourcePath);
				if (relativeSource.startsWith(`..${path.sep}`) || relativeSource === ".." || path.isAbsolute(relativeSource)) {
					throw new Error("The linked lesson log is outside its detected Obsidian vault.");
				}

				const destination = path.join(path.dirname(sourcePath), `${basename}.md`);
				if (destination.toLowerCase() === sourcePath.toLowerCase()) {
					return {
						content: [{ type: "text" as const, text: `The linked lesson log is already named ${path.basename(sourcePath)}.` }],
						details: { status: "unchanged", notePath: sourcePath },
					};
				}
				if (fs.existsSync(destination)) throw new Error(`A note already exists at the requested filename: ${destination}`);

				fs.renameSync(sourcePath, destination);
				logFile = destination;
				transcriptBlocks = transcriptBlocks.map((block) =>
					block.kind === "markdown" && path.resolve(block.file) === sourcePath
						? { ...block, file: destination }
						: block);
				pi.appendEntry("md-log", { file: destination });
				const theme = ctx.ui.theme;
				ctx.ui.setStatus("md-log", theme.fg("accent", "🗒 ") + theme.fg("dim", path.basename(destination)));
				ctx.ui.notify(`Renamed lesson log to ${path.basename(destination)}`, "success");
				return {
					content: [{ type: "text" as const, text: `Renamed the linked lesson log to ${path.basename(destination)}.` }],
					details: { status: "renamed", previousPath: sourcePath, notePath: destination },
				};
			});
		},
	});

	pi.on("message_end", async (event, ctx) => {
		if (!logFile) return;
		const message = event.message;
		if (!isRecord(message)) return;
		if (endLessonTurnActive && message.role === "assistant") return;
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
				await appendProseBlock("user", text, ctx);
			}
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			const text = message.content
				.filter((part: unknown) => isRecord(part) && part.type === "text" && typeof part.text === "string")
				.map((part: Record<string, any>) => part.text.trim())
				.filter(Boolean)
				.join("\n\n");
			if (text && !isNonSubstantiveAssistantUpdate(text)) {
				await appendProseBlock("assistant", text, ctx);
			}
		}
	});

	pi.on("agent_end", () => {
		endLessonTurnActive = false;
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
			summaryTitle: typeof input.summaryTitle === "string" ? input.summaryTitle.trim() || undefined : undefined,
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
			summaryTitle: typeof input.summaryTitle === "string" ? input.summaryTitle.trim() || undefined : undefined,
			context: typeof input.details === "string" ? input.details.trim() || undefined : undefined,
			options,
		});
		await syncTranscript(ctx);
	});

	// Placement markers are rendered from the transcript, so a dispatch has to
	// re-sync for the pending marker to become visible.
	const PLACEMENT_TOOLS = new Set([TEACH_BREEZE_TTS_TOOL, TEACH_COMFYUI_PAINT_TOOL, TEACH_VISUAL_TOOL]);

	pi.on("tool_result", async (event, ctx) => {
		if (!logFile || !isRecord(event)) return;
		if (typeof event.toolName === "string" && PLACEMENT_TOOLS.has(event.toolName)) {
			await syncTranscript(ctx);
			return;
		}
		if (event.toolName === TEACH_ATTACH_IMAGE_TOOL) {
			const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const details = isRecord(event.details) ? event.details : {};
			if (
				!callId ||
				details.status !== "attached" ||
				typeof details.interactionId !== "string" ||
				typeof details.sourcePath !== "string" ||
				typeof details.filename !== "string" ||
				transcriptBlocks.some((block) =>
					block.kind === "image" && block.interactionId === details.interactionId)
			) return;
			transcriptBlocks.push({
				kind: "image",
				interactionId: details.interactionId,
				sourcePath: details.sourcePath,
				filename: details.filename,
			});
			await syncTranscript(ctx);
			return;
		}
		if (event.toolName === TEACH_FREE_RESPONSE_TOOL) {
			const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const details = isRecord(event.details) ? event.details : {};
			if (
				!callId ||
				details.status !== "answered" ||
				typeof details.interactionId !== "string" ||
				typeof details.question !== "string" ||
				typeof details.response !== "string" ||
				transcriptBlocks.some((block) => block.kind === "free_response" && block.callId === callId)
			) return;
			transcriptBlocks.push({
				kind: "free_response",
				callId,
				interactionId: details.interactionId,
				question: details.question,
				response: details.response,
				summaryTitle: typeof details.summaryTitle === "string" ? details.summaryTitle : undefined,
				conceptId: typeof details.conceptId === "string" ? details.conceptId : undefined,
			});
			await syncTranscript(ctx);
			return;
		}
		if (event.toolName === TEACH_LEARNING_INTERVIEW_TOOL) {
			const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const details = isRecord(event.details) ? event.details : {};
			if (
				!callId ||
				details.status !== "answered" ||
				typeof details.interviewId !== "string" ||
				(details.purpose !== "session-intake" && details.purpose !== "post-assessment") ||
				typeof details.summaryTitle !== "string" ||
				!Array.isArray(details.questions) ||
				details.questions.length < 3 ||
				details.questions.length > 5 ||
				!details.questions.every((item: unknown) =>
					isRecord(item) && typeof item.question === "string" && typeof item.answer === "string") ||
				transcriptBlocks.some((block) => block.kind === "learning_interview" && block.callId === callId)
			) return;
			transcriptBlocks.push({
				kind: "learning_interview",
				callId,
				interviewId: details.interviewId,
				purpose: details.purpose,
				summaryTitle: details.summaryTitle,
				questions: details.questions.map((item: Record<string, string>) => ({
					question: item.question,
					answer: item.answer,
				})),
				responseTimeMs: typeof details.responseTimeMs === "number" ? details.responseTimeMs : undefined,
			});
			await syncTranscript(ctx);
			return;
		}
		if (event.toolName === TEACH_RECORD_ATTEMPT_TOOL) {
			const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
			const details = isRecord(event.details) ? event.details : {};
			if (
				!callId ||
				typeof details.interactionId !== "string" ||
				typeof details.conceptId !== "string" ||
				(details.outcome !== "correct" && details.outcome !== "partial" && details.outcome !== "incorrect") ||
				typeof details.explanation !== "string" ||
				!isRecord(details.masteryState) ||
				typeof details.masteryState.evidenceCount !== "number" ||
				typeof details.masteryState.evidenceWeight !== "number" ||
				typeof details.masteryState.confidence !== "number" ||
				transcriptBlocks.some((block) => block.kind === "attempt" && block.callId === callId)
			) return;
			const masteryState: MasteryRecord = {
				score: typeof details.masteryState.score === "number" ? details.masteryState.score : undefined,
				evidenceCount: details.masteryState.evidenceCount,
				evidenceWeight: details.masteryState.evidenceWeight,
				evidenceSum: typeof details.masteryState.evidenceSum === "number" ? details.masteryState.evidenceSum : undefined,
				lastInteractionId: typeof details.masteryState.lastInteractionId === "string" ? details.masteryState.lastInteractionId : undefined,
				confidence: details.masteryState.confidence,
				reasoningSummary: typeof details.masteryState.reasoningSummary === "string" ? details.masteryState.reasoningSummary : undefined,
			};
			transcriptBlocks.push({
				kind: "attempt",
				callId,
				interactionId: details.interactionId,
				conceptId: details.conceptId,
				outcome: details.outcome,
				explanation: details.explanation,
				misconception: typeof details.misconception === "string" ? details.misconception : undefined,
				previousMastery: typeof details.previousMastery === "number" ? details.previousMastery : undefined,
				newMastery: masteryState.score,
				masteryState,
				confidence: typeof details.confidence === "number" ? details.confidence : undefined,
				evidenceScore: typeof details.evidenceScore === "number" ? details.evidenceScore : undefined,
			});
			await syncMastery(details.conceptId, masteryState, ctx);
			return;
		}
		if (!QA_TOOLS.has(event.toolName)) return;
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

			await linkNote(resolved, ctx);
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
		description: "Start an explicit quiz group in md-log; use a concise 3-6 word title when practical",
		handler: async (args, ctx: any) => {
			if (lastExplicitGroupActive()) {
				ctx.ui.notify("A quiz group is already open; use /quiz-end first.", "warning");
				return;
			}
			const title = args.trim().replace(/[\r\n#]+/g, " ").trim() || "Quiz";
			const boundary = { active: true, prefix: "Quiz", title };
			pi.appendEntry("md-log-quiz-group", boundary);
			transcriptBlocks.push({ kind: "group", ...boundary });
			if (logFile) await syncTranscript(ctx);
			ctx.ui.notify(`Quiz group started: ${title}`, "success");
		},
	});

	pi.registerCommand("md-section-start", {
		description: "Start a named md-log section; syntax: [prefix:] 3-6 word summary title",
		handler: async (args, ctx: any) => {
			if (lastExplicitGroupActive()) {
				ctx.ui.notify("A section is already open; use /md-section-end first.", "warning");
				return;
			}
			const raw = args.trim().replace(/[\r\n#]+/g, " ").trim();
			const separator = raw.indexOf(":");
			const prefix = separator > 0 ? raw.slice(0, separator).trim() : "Teaching";
			const title = (separator > 0 ? raw.slice(separator + 1) : raw).trim();
			const titleWordCount = title.split(/\s+/).filter(Boolean).length;
			if (!title || titleWordCount < 3 || titleWordCount > 6) {
				ctx.ui.notify("Usage: /md-section-start [prefix:] <3-6 word summary title>", "warning");
				return;
			}
			const boundary = { active: true, prefix: prefix || "Teaching", title };
			pi.appendEntry("md-log-section", boundary);
			transcriptBlocks.push({ kind: "group", ...boundary });
			if (logFile) await syncTranscript(ctx);
			ctx.ui.notify(`Section started: ${boundary.prefix}: ${title}`, "success");
		},
	});

	pi.registerCommand("md-section-end", {
		description: "End the active named section in md-log",
		handler: async (_args, ctx: any) => {
			if (!lastExplicitGroupActive()) {
				ctx.ui.notify("No named section is open.", "warning");
				return;
			}
			pi.appendEntry("md-log-section", { active: false });
			transcriptBlocks.push({ kind: "group", active: false });
			if (logFile) await syncTranscript(ctx);
			ctx.ui.notify("Section ended.", "success");
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
