import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mdLog from "../extensions/md-log.ts";
import { clearAnswerModal, trackAnswerModal } from "../lib/answer-modal.ts";
import { TRANSCRIPT_END, TRANSCRIPT_START } from "../lib/md-log-format.ts";
import { updateMasteryFrontmatter } from "../lib/teach-learning-state.ts";

test("session start reminds about detected empty or md-log notes only", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-reminder-"));
	const notePath = path.join(directory, "active-note.md");
	const contextPath = path.join(directory, "termy-context.json");
	const previousContextPath = process.env.TERMY_CONTEXT_PATH;

	try {
		for (const testCase of [
			{ name: "empty note", content: "", shouldRemind: true },
			{ name: "frontmatter-only note", content: "---\ntitle: New lesson\ntags:\n  - biology\n---\n", shouldRemind: true },
			{ name: "frontmatter with body text", content: "---\ntitle: Existing lesson\n---\nA note with existing content.\n", shouldRemind: false },
			{ name: "existing md-log note", content: `# Lesson\n\n${TRANSCRIPT_START}\n${TRANSCRIPT_END}\n`, shouldRemind: true },
			{ name: "unrelated populated note", content: "# A note unrelated to this session.\n", shouldRemind: false },
			{ name: "non-Markdown active file", filename: "active.txt", content: "", shouldRemind: false },
			{ name: "explicitly unlinked session", content: "", shouldRemind: false, explicitlyUnlinked: true },
		]) {
			const activePath = path.join(directory, testCase.filename ?? "active-note.md");
			fs.writeFileSync(activePath, testCase.content, "utf-8");
			fs.writeFileSync(contextPath, JSON.stringify({ activeFile: { filePath: activePath } }), "utf-8");
			process.env.TERMY_CONTEXT_PATH = contextPath;

			const handlers = new Map();
			const notifications = [];
			const statuses = new Map();
			const entries = [{ id: "session", type: "session" }];
			if (testCase.explicitlyUnlinked) {
				entries.push({ id: "unlinked", parentId: "session", type: "custom", customType: "md-log", data: { file: null } });
			}
			const pi = {
				on(name, handler) { handlers.set(name, handler); },
				registerCommand() {},
				registerTool() {},
				appendEntry() {},
			};
			mdLog(pi);
			const ctx = {
				cwd: directory,
				sessionManager: { getEntries: () => entries },
				ui: {
					theme: { fg: (_color, text) => text },
					async select(title, options) {
						assert.equal(title, "md-log status");
						assert.equal(options.length, 3);
						return options[1];
					},
					setStatus(key, value) { statuses.set(key, value); },
					notify(message, level) { notifications.push({ message, level }); },
				},
			};

			await handlers.get("session_start")({}, ctx);
			const reminders = notifications.filter(({ message }) => message.includes("Active note detected"));
			assert.equal(reminders.length, testCase.shouldRemind ? 1 : 0, testCase.name);
			assert.equal(Boolean(statuses.get("md-log")?.includes("/md-log")), testCase.shouldRemind, testCase.name);
			if (testCase.shouldRemind) assert.match(reminders[0].message, /Run \/md-log/);
		}
	} finally {
		if (previousContextPath === undefined) delete process.env.TERMY_CONTEXT_PATH;
		else process.env.TERMY_CONTEXT_PATH = previousContextPath;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("session start can link a selected active note without running /md-log manually", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-confirm-"));
	const notePath = path.join(directory, "new-lesson.md");
	const contextPath = path.join(directory, "termy-context.json");
	const previousContextPath = process.env.TERMY_CONTEXT_PATH;
	fs.writeFileSync(notePath, "", "utf-8");
	fs.writeFileSync(contextPath, JSON.stringify({ activeFile: { filePath: notePath } }), "utf-8");
	process.env.TERMY_CONTEXT_PATH = contextPath;

	try {
		const handlers = new Map();
		const entries = [{ id: "session", type: "session" }];
		const notifications = [];
		const statuses = new Map();
		const selections = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({ id: `custom-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
			},
		};
		mdLog(pi);
		const ctx = {
			cwd: directory,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				async select(title, options) {
					selections.push({ title, options });
					return options[0];
				},
				setStatus(key, value) { statuses.set(key, value); },
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await handlers.get("session_start")({ reason: "new" }, ctx);
		assert.equal(selections.length, 1);
		assert.equal(selections[0].title, "md-log status");
		assert.match(selections[0].options[0], /new-lesson\.md/);
		assert.match(selections[0].options[2], /Other/);
		assert.ok(entries.some((entry) => entry.customType === "md-log" && entry.data.file === notePath));
		assert.ok(notifications.some(({ message, level }) => level === "success" && message.startsWith("Linked:")));
		assert.ok(notifications.some(({ message }) => message.includes(`md-log status: linked to ${notePath}`)));
		assert.doesNotMatch(statuses.get("md-log"), /\/md-log/);
	} finally {
		if (previousContextPath === undefined) delete process.env.TERMY_CONTEXT_PATH;
		else process.env.TERMY_CONTEXT_PATH = previousContextPath;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("session start Other choice links a validated Markdown note", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-other-note-"));
	const detectedPath = path.join(root, "detected.md");
	const chosenPath = path.join(root, "chosen.md");
	fs.writeFileSync(detectedPath, "", "utf-8");
	fs.writeFileSync(chosenPath, "# Chosen note\n", "utf-8");
	const contextPath = path.join(root, "termy-context.json");
	const previousContextPath = process.env.TERMY_CONTEXT_PATH;
	fs.writeFileSync(contextPath, JSON.stringify({ activeFile: { filePath: detectedPath } }), "utf-8");
	process.env.TERMY_CONTEXT_PATH = contextPath;

	try {
		const handlers = new Map();
		const entries = [{ id: "session", type: "session" }];
		const notifications = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({ id: `custom-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
			},
			async sendMessage() {},
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				async select(_title, options) { return options[2]; },
				async input() { return chosenPath; },
				setStatus() {},
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await handlers.get("session_start")({ reason: "fork" }, ctx);
		assert.ok(entries.some((entry) => entry.customType === "md-log" && entry.data.file === chosenPath));
		assert.ok(notifications.some(({ message }) => message.startsWith(`Linked: ${chosenPath}`)));
	} finally {
		if (previousContextPath === undefined) delete process.env.TERMY_CONTEXT_PATH;
		else process.env.TERMY_CONTEXT_PATH = previousContextPath;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("forking an explicitly unlinked session rechecks the active note", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-fork-unlinked-"));
	const notePath = path.join(root, "active.md");
	const contextPath = path.join(root, "termy-context.json");
	fs.writeFileSync(notePath, "", "utf-8");
	fs.writeFileSync(contextPath, JSON.stringify({ activeFile: { filePath: notePath } }), "utf-8");
	const previousContextPath = process.env.TERMY_CONTEXT_PATH;
	process.env.TERMY_CONTEXT_PATH = contextPath;

	try {
		const handlers = new Map();
		const entries = [
			{ id: "session", type: "session" },
			{ id: "unlinked", parentId: "session", type: "custom", customType: "md-log", data: { file: null } },
		];
		const choices = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
			appendEntry() {},
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				async select(_title, options) {
					choices.push(options);
					return options[1];
				},
				setStatus() {},
				notify() {},
			},
		};
		await handlers.get("session_start")({ reason: "fork" }, ctx);
		assert.equal(choices.length, 1);
		assert.match(choices[0][0], /active\.md/);
	} finally {
		if (previousContextPath === undefined) delete process.env.TERMY_CONTEXT_PATH;
		else process.env.TERMY_CONTEXT_PATH = previousContextPath;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("resume-agent triggers a hidden custom continuation without appending user prose", async () => {
	const handlers = new Map();
	const commands = new Map();
	const entries = [{ id: "session", type: "session" }];
	const messages = [];
	const notifications = [];
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, definition) { commands.set(name, definition.handler); },
		registerTool() {},
		appendEntry(type, data) { entries.push({ type, data }); },
		sendMessage(message, options) { messages.push({ message, options }); },
	};
	mdLog(pi);
	const ctx = {
		isIdle: () => true,
		ui: { notify(message, level) { notifications.push({ message, level }); } },
	};

	await commands.get("resume-agent")("", ctx);
	assert.equal(messages.length, 1);
	assert.equal(messages[0].message.customType, "md-log-resume-agent");
	assert.equal(messages[0].message.display, false);
	assert.equal(messages[0].options.triggerTurn, true);
	assert.match(messages[0].message.content, /skills\/teach\/SKILL\.md/);
	assert.match(messages[0].message.content, /do not use shell, grep, find, or file tools/);
	assert.match(messages[0].message.content, /ask the learner to run \/md-log/);
	assert.match(messages[0].message.content, /do not start a new quiz, interview, or replacement activity/);
	assert.match(messages[0].message.content, /cancelled or skipped question is a learner choice/);
	assert.match(messages[0].message.content, /wait for the learner's next request/);
	assert.match(messages[0].message.content, /No md-log note is linked/);
	assert.equal(entries.length, 1);
	assert.ok(notifications.some(({ message }) => message.includes("continuation started")));
});

test("/rename lists vault note filenames and renames only the linked lesson log", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-rename-"));
	const vaultRoot = path.join(root, "vault");
	const lessonDirectory = path.join(vaultRoot, "200-Reviewing");
	const notePath = path.join(lessonDirectory, "lesson-log.md");
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(lessonDirectory, { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, ".pi"), { recursive: true });
	fs.writeFileSync(notePath, "# Lesson\n\nTranscript content.\n", "utf-8");
	fs.writeFileSync(path.join(vaultRoot, "chinese-word-review-2026-11-03.md"), "# Existing lesson\n", "utf-8");
	fs.writeFileSync(path.join(vaultRoot, ".pi", "internal-note.md"), "# Hidden internal note\n", "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const tools = new Map();
		const entries = [{ id: "session", type: "session" }];
		const messages = [];
		const notifications = [];
		const statuses = new Map();
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool(definition) { tools.set(definition.name, definition); },
			appendEntry(customType, data) {
				entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data });
			},
			async sendMessage(message, options) { messages.push({ message, options }); },
		};
		mdLog(pi);
		const ctx = {
			cwd: vaultRoot,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus(key, value) { statuses.set(key, value); },
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await commands.get("md-log")(notePath, ctx);
		await commands.get("rename")("", ctx);
		const renameMessage = messages.find(({ message }) => message.customType === "md-log-rename");
		assert.ok(renameMessage);
		assert.match(renameMessage.message.content, /teach_list_vault_note_names/);
		assert.equal(renameMessage.options.triggerTurn, true);

		const listResult = await tools.get("teach_list_vault_note_names").execute("list", {}, undefined, undefined, ctx);
		assert.match(listResult.content[0].text, /chinese-word-review-2026-11-03\.md/);
		assert.match(listResult.content[0].text, /200-Reviewing\/lesson-log\.md/);
		assert.doesNotMatch(listResult.content[0].text, /internal-note\.md/);
		assert.equal(listResult.details.total, 2);

		const contentBeforeRename = fs.readFileSync(notePath, "utf-8");
		const newPath = path.join(lessonDirectory, "Chinese Word Review - Lesson 3.md");
		const renameResult = await tools.get("teach_rename_md_log").execute(
			"rename",
			{ fileName: "Chinese Word Review - Lesson 3" },
			undefined,
			undefined,
			ctx,
		);
		assert.equal(renameResult.details.status, "renamed");
		assert.equal(fs.existsSync(notePath), false);
		assert.equal(fs.readFileSync(newPath, "utf-8"), contentBeforeRename);
		assert.equal(entries.at(-1).customType, "md-log");
		assert.equal(entries.at(-1).data.file, newPath);
		assert.match(statuses.get("md-log"), /Chinese Word Review - Lesson 3\.md/);

		fs.writeFileSync(path.join(lessonDirectory, "Already Taken.md"), "Keep this note.\n", "utf-8");
		await assert.rejects(
			tools.get("teach_rename_md_log").execute("collision", { fileName: "Already Taken" }, undefined, undefined, ctx),
			/already exists/,
		);
		await assert.rejects(
			tools.get("teach_rename_md_log").execute("path", { fileName: "..\\outside" }, undefined, undefined, ctx),
			/basename, not a path/,
		);
		assert.ok(fs.existsSync(newPath));
		assert.ok(notifications.some(({ message, level }) => level === "success" && message.includes("Renamed lesson log")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("new or forked session reports the restored md-log target", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-status-"));
	const notePath = path.join(root, "lesson.md");
	fs.writeFileSync(notePath, "# Lesson\n", "utf-8");
	fs.writeFileSync(path.join(root, "breeze-voices.json"), "{ invalid json", "utf-8");
	try {
		const handlers = new Map();
		const notifications = [];
		const statuses = new Map();
		const entries = [
			{ id: "session", type: "session" },
			{ id: "linked", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus(key, value) { statuses.set(key, value); },
				notify(message, level) { notifications.push({ message, level }); },
			},
		};
		await handlers.get("session_start")({ reason: "fork" }, ctx);
		assert.equal(statuses.get("md-log"), "🗒 lesson.md");
		assert.ok(notifications.some(({ message }) => message === `md-log status: linked to ${notePath}`));
		assert.ok(!notifications.some(({ message }) => message.includes("Breeze TTS could not load its voice manifest")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("linking a fresh note defers Breeze voice selection until audio is requested", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-breeze-voice-"));
	const notePath = path.join(root, "lesson.md");
	const wavs = path.join(root, "voice", "wavs");
	const transcripts = path.join(root, "voice", "transcripts");
	fs.mkdirSync(wavs, { recursive: true });
	fs.mkdirSync(transcripts);
	fs.writeFileSync(notePath, "", "utf-8");
	const audio = Buffer.alloc(128);
	audio.write("RIFF", 0, "ascii");
	audio.writeUInt32LE(audio.length - 8, 4);
	audio.write("WAVE", 8, "ascii");
	audio.write("fmt ", 12, "ascii");
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(24_000, 24);
	audio.writeUInt32LE(48_000, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36, "ascii");
	audio.writeUInt32LE(audio.length - 44, 40);
	fs.writeFileSync(path.join(wavs, "123456.wav"), audio);
	fs.writeFileSync(path.join(transcripts, "123456-transcript.txt"), "A matching reference transcript.");
	fs.writeFileSync(path.join(root, "breeze-voices.json"), JSON.stringify({
		version: 1,
		presets: [{ id: "narrator", name: "Warm Narrator", wavsDirectory: wavs, transcriptsDirectory: transcripts }],
	}));

	try {
		const handlers = new Map();
		const entries = [
			{ id: "session", type: "session" },
			{ id: "linked", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		];
		const selections = [];
		const notifications = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand() {},
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({ id: `entry-${entries.length}`, type: "custom", customType, data });
			},
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				async select(title, options) {
					selections.push({ title, options });
					return options[1];
				},
				setStatus() {},
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await handlers.get("session_start")({ reason: "new" }, ctx);
		await handlers.get("session_start")({ reason: "new" }, ctx);
		assert.equal(selections.length, 0);
		const voiceEntries = entries.filter((entry) => entry.customType === "breeze-voice-preset");
		assert.equal(voiceEntries.length, 0);
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /breeze-voice-preset:/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("linking a mastery note adds related wikilinks and sends vault mastery context", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-mastery-context-"));
	const notePath = path.join(root, "Lessons", "active.md");
	const relatedPath = path.join(root, "References", "related.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	fs.mkdirSync(path.dirname(notePath), { recursive: true });
	fs.mkdirSync(path.dirname(relatedPath), { recursive: true });
	const masteryRecord = {
		score: 7,
		evidenceCount: 3,
		evidenceWeight: 3,
		lastInteractionId: "attempt-3",
		confidence: 5,
	};
	fs.writeFileSync(notePath, updateMasteryFrontmatter("---\ntitle: Active lesson\n---\nActive body.", "shared-concept", masteryRecord));
	fs.writeFileSync(relatedPath, updateMasteryFrontmatter("---\ntitle: Related lesson\n---\nRelated body.", "shared-concept", {
		...masteryRecord,
		score: 6,
	}));

	try {
		const handlers = new Map();
		const commands = new Map();
		const entries = [{ id: "session", type: "session" }];
		const messages = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({ id: `custom-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
			},
			async sendMessage(message, options) { messages.push({ message, options }); },
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify() {},
			},
		};

		await commands.get("md-log")(notePath, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /related:\n  - "\[\[References\/related\]\]"/);
		assert.match(fs.readFileSync(relatedPath, "utf-8"), /related:\n  - "\[\[Lessons\/active\]\]"/);
		// Linking also imports the note's own prose as context, so pick the mastery message.
		const mastery = messages.filter(({ message }) => /shared-concept/.test(message.content));
		assert.equal(mastery.length, 1);
		assert.equal(mastery[0].options.triggerTurn, false);
		assert.match(mastery[0].message.content, /Related lesson/);
		assert.match(mastery[0].message.content, /"score":6/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("extension links a note, updates live quiz rounds, and preserves note content", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-extension-"));
	const notePath = path.join(directory, "existing-note.md");
	const initialNote = "# Existing note\n\nKeep this text.\n";
	fs.writeFileSync(notePath, initialNote, "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const tools = new Map();
		const entries = [];
		const notifications = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool(definition) { tools.set(definition.name, definition); },
			appendEntry(customType, data) {
				entries.push({
					id: `custom-${entries.length}`,
					parentId: entries.at(-1)?.id,
					type: "custom",
					customType,
					data,
				});
			},
		};
		mdLog(pi);

		const ctx = {
			cwd: directory,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await commands.get("md-log")(notePath, ctx);
		const repeatedRequest = "Please explain how the wing pattern forms.";
		for (let attempt = 0; attempt < 2; attempt++) {
			await handlers.get("message_end")({
				message: { role: "user", content: repeatedRequest },
			}, ctx);
		}
		const afterRepeatedRequest = fs.readFileSync(notePath, "utf-8");
		assert.equal((afterRepeatedRequest.match(/Please explain how the wing pattern forms\./g) || []).length, 1);

		await handlers.get("message_end")({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The image has finished generating and is in your linked note. The lesson is still paused until you say go ahead." }],
			},
		}, ctx);
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /finished generating|lesson is still paused/);
		await handlers.get("message_end")({
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The lesson's central point is that careful observation connects visible wing patterns to the microscopic structures beneath them." }],
			},
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /careful observation connects visible wing patterns/);
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz",
			args: { question: "Which answer is right?", summaryTitle: "Choosing the Right Answer" },
			partialResult: { details: { options: [
				{ index: 1, label: "Right" },
				{ index: 2, label: "Wrong" },
			] } },
		}, ctx);
		const pending = fs.readFileSync(notePath, "utf-8");
		assert.match(pending, /Which answer is right\?/);
		assert.doesNotMatch(pending, /==🟢|~~==🔴|The first option is right/);
		await handlers.get("tool_result")({
			toolName: "quiz",
			toolCallId: "live-quiz",
			details: {
				status: "answered",
				correct: false,
				correctIndices: [1],
				answers: [{ index: 2, label: "Wrong" }],
				explanation: "The first option is right.",
				scratchpad: "I compared the two causes before choosing.",
			},
		}, ctx);

		const persisted = fs.readFileSync(notePath, "utf-8");
		// The managed section moves above authored prose so that prose is addressable
		// as a placement anchor, and it renders once inside the section.
		assert.ok(persisted.startsWith(TRANSCRIPT_START));
		assert.equal((persisted.match(/# Existing note/g) || []).length, 1);
		assert.match(persisted, /Keep this text\./);
		assert.match(persisted, /^# Quiz: Choosing the Right Answer/m);
		assert.match(persisted, /## Round 1: Choosing the Right Answer/);
		assert.match(persisted, /1\. ==🟢 Right==/);
		assert.match(persisted, /2\. ~~==🔴 Wrong==~~/);
		assert.match(persisted, /<!-- pi-quiz-scratchpad:live-quiz -->\n\n```\nI compared the two causes before choosing\.\n```/);
		assert.doesNotMatch(persisted, /Your answer:|Correct answer:/);
		assert.ok(notifications.some((notification) => notification.level === "success"));

		await handlers.get("tool_result")({
			toolName: "teach_free_response",
			toolCallId: "live-free-response",
			details: {
				status: "answered",
				interactionId: "teach-free-123",
				question: "Write the reply, then explain your choices.",
				summaryTitle: "Writing A Clear Reply",
				response: "I would reply plainly.\nI chose not to manage their reaction.",
			},
		}, ctx);
		await handlers.get("tool_result")({
			toolName: "teach_learning_interview",
			toolCallId: "live-learning-interview",
			details: {
				status: "answered",
				interviewId: "teach-interview-123",
				purpose: "session-intake",
				summaryTitle: "Clarifying Learning Goals",
				questions: [
					{ question: "What sparked your interest?", answer: "I want to understand the mechanism." },
					{ question: "Which aspect matters most?", answer: "How the ideas connect." },
					{ question: "What would you like to be able to do?", answer: "Explain it from first principles." },
				],
				responseTimeMs: 14_000,
			},
		}, ctx);
		await handlers.get("tool_result")({
			toolName: "teach_record_attempt",
			toolCallId: "live-attempt",
			details: {
				interactionId: "teach-free-123",
				conceptId: "clear-boundaries",
				outcome: "partial",
				explanation: "The reply is clear; explain why the boundary is yours to set.",
				evidenceScore: 5,
				confidence: 5,
				previousMastery: 5,
				masteryState: {
					score: 5.2,
					evidenceCount: 4,
					evidenceWeight: 3.9,
					lastInteractionId: "teach-free-123",
					confidence: 5,
					reasoningSummary: "The learner identified the boundary but was unsure why it was theirs to set.",
				},
			},
		}, ctx);
		const withFreeResponse = fs.readFileSync(notePath, "utf-8");
		assert.match(withFreeResponse, /^"mastery__clear-boundaries__score": 5\.2$/m);
		assert.match(withFreeResponse, /^"mastery__clear-boundaries__evidence-count": 4$/m);
		assert.match(withFreeResponse, /> \[!example\] Answer\n> I would reply plainly\./);
		assert.match(withFreeResponse, /> I chose not to manage their reaction\./);
		assert.match(withFreeResponse, /> \[!warning\] Evaluation — Partially correct/);
		assert.match(withFreeResponse, /Mastery: ==🟣 5\.00 → 5\.20 \/ 10==/);
		assert.match(withFreeResponse, /^## Writing a Clear Reply$/m);
		assert.match(withFreeResponse, /> \[!note\]- Learning goals and interview answers/);
		assert.match(withFreeResponse, /> > \[!example\] Learner's answer\n> > I want to understand the mechanism\./);
		assert.doesNotMatch(withFreeResponse, /teach_free_response|interaction teach-free-123/);

		await commands.get("quiz-start")("Manual set", ctx);
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz-2",
			args: { question: "Second question?" },
			partialResult: { details: { options: [{ index: 1, label: "Answer" }] } },
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^# Quiz: Manual Set$/m);
		await commands.get("quiz-end")("", ctx);
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz-3",
			args: { question: "Question after the explicit group?" },
			partialResult: { details: { options: [{ index: 1, label: "Answer" }] } },
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^# Quiz$/m);

		await commands.get("md-section-start")("Lesson: How Cells Divide", ctx);
		await handlers.get("message_end")({
			message: { role: "assistant", content: [{ type: "text", text: "Cells divide through a sequence of steps." }] },
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^# Lesson: How Cells Divide$/m);
		await commands.get("md-section-end")("", ctx);
		assert.ok(entries.some((entry) =>
			entry.type === "custom" && entry.customType === "md-log-section" && entry.data.prefix === "Lesson",
		));

		fs.unlinkSync(notePath);
		await handlers.get("message_end")({ message: { role: "user", content: "The file was removed." } }, ctx);
		assert.equal(fs.existsSync(notePath), false);
		assert.ok(notifications.some((notification) => notification.level === "error" && notification.message.includes("could not update")));
	} finally {
		if (fs.existsSync(notePath)) fs.unlinkSync(notePath);
		fs.rmdirSync(directory);
	}
});

test("image attachment tool results persist a single embed in md-log", async () => {
	const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-images-"));
	const notePath = path.join(vaultRoot, "lesson.md");
	const attachmentDir = path.join(vaultRoot, "001-Attachments");
	const comfyAttachmentDir = path.join(attachmentDir, "~comfyui");
	const filename = "comfyui-energy-flow-1.png";
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"));
	fs.mkdirSync(comfyAttachmentDir, { recursive: true });
	fs.writeFileSync(path.join(comfyAttachmentDir, filename), Buffer.from("image bytes"));
	fs.writeFileSync(notePath, "# Lesson\n\nKeep authored text.\n", "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const entries = [{ id: "session", type: "session" }];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({
					id: `custom-${entries.length}`,
					parentId: entries.at(-1)?.id,
					type: "custom",
					customType,
					data,
				});
			},
		};
		mdLog(pi);
		const ctx = {
			cwd: vaultRoot,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify() {},
			},
		};
		await commands.get("md-log")(notePath, ctx);

		const interactionId = "teach-image-123";
		const sourcePath = path.join(vaultRoot, ".pi", "paint-jobs", "job-123", "outputs", "image.png");
		pi.appendEntry("teach-image-attachment", { interactionId, sourcePath, filename });
		const event = {
			toolName: "teach_attach_generated_image",
			toolCallId: "attach-1",
			details: { status: "attached", interactionId, sourcePath, filename },
		};
		await handlers.get("tool_result")(event, ctx);
		await handlers.get("tool_result")(event, ctx);
		const persisted = fs.readFileSync(notePath, "utf-8");
		assert.ok(persisted.includes(`![[${filename}]]`));
		assert.equal((persisted.match(new RegExp(`!\\[\\[${filename}\\]\\]`, "g")) || []).length, 1);
		assert.ok(persisted.startsWith(TRANSCRIPT_START));
		assert.match(persisted, /# Lesson\n\n> \[!note\] Notes\n> Keep authored text\./);
	} finally {
		fs.rmSync(vaultRoot, { recursive: true, force: true });
	}
});

test("linking a note imports its managed transcript once and keeps it in the managed section", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-import-"));
	const notePath = path.join(directory, "prior-session.md");
	const notes = [
		"my personal learning notes so far:",
		"+ triggers set the threshold for revisiting a proposal.",
		"\t- Keep practicing how to balance the bounds.",
	].join("\n");
	const initialNote = [
		"# Learning note",
		"",
		"Authored introduction.",
		"%% pi-md-log:start v1 %%",
		"# Prior session",
		"",
		"Work already completed.",
		"",
		notes,
		"",
		notes,
		"",
		notes,
		"%% pi-md-log:end v1 %%",
		"",
		"<!-- pi-end-lesson:v1",
		"Next: Continue after the completed question.",
		"-->"
	].join("\n");
	fs.writeFileSync(notePath, initialNote, "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const entries = [{ id: "root", type: "session" }];
		const contextMessages = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool() {},
			appendEntry(customType, data) {
				const parentId = entries.at(-1)?.id;
				entries.push({
					id: `custom-${entries.length}`,
					parentId,
					type: "custom",
					customType,
					data,
				});
			},
			async sendMessage(message, options) { contextMessages.push({ message, options }); },
		};
		mdLog(pi);
		const ctx = {
			cwd: directory,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify() {},
			},
		};

		await commands.get("md-log")(notePath, ctx);
		const firstWrite = fs.readFileSync(notePath, "utf-8");
		const transcriptContext = contextMessages.find(({ message }) => message.customType === "md-log-context");
		assert.ok(transcriptContext);
		assert.equal(transcriptContext.options.triggerTurn, false);
		assert.match(transcriptContext.message.content, /Work already completed\./);
		assert.match(transcriptContext.message.content, /now included in the agent's conversation context/);
		assert.match(transcriptContext.message.content, /do not use shell, grep, find, or file-reading tools/);
		assert.equal((transcriptContext.message.content.match(/my personal learning notes so far:/g) || []).length, 1);
		assert.doesNotMatch(transcriptContext.message.content, /pi-end-lesson/);
		assert.match(firstWrite, /Authored introduction\./);
		assert.match(firstWrite, /# Prior session[\s\S]*Work already completed\./);
		assert.match(firstWrite, /> \[!note\] Notes\n> my personal learning notes so far:/);
		assert.match(firstWrite, /> \+ triggers set the threshold for revisiting a proposal\./);
		assert.equal((firstWrite.match(/my personal learning notes so far:/g) || []).length, 1);
		assert.equal((firstWrite.match(/Work already completed\./g) || []).length, 1);

		await commands.get("md-log")(notePath, ctx);
		const secondWrite = fs.readFileSync(notePath, "utf-8");
		assert.equal(contextMessages.filter(({ message }) => message.customType === "md-log-context").length, 1);
		assert.equal((secondWrite.match(/Work already completed\./g) || []).length, 1);
		assert.equal((secondWrite.match(/my personal learning notes so far:/g) || []).length, 1);
	} finally {
		if (fs.existsSync(notePath)) fs.unlinkSync(notePath);
		fs.rmdirSync(directory);
	}
});

test("relinking after md-unlog does not copy imports from previously linked notes", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-relink-"));
	const firstNote = path.join(directory, "first.md");
	const secondNote = path.join(directory, "second.md");
	const thirdNote = path.join(directory, "third.md");
	fs.writeFileSync(firstNote, "# First note\n\nFirst note-only transcript.\n", "utf-8");
	fs.writeFileSync(secondNote, "# Second note\n\nSecond note authored text.\n", "utf-8");
	fs.writeFileSync(thirdNote, "# Third note\n\nThird note authored text.\n", "utf-8");

	try {
		const commands = new Map();
		const entries = [{ id: "root", type: "session" }];
		const statuses = new Map();
		const pi = {
			on() {},
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool() {},
			appendEntry(customType, data) {
				entries.push({
					id: `custom-${entries.length}`,
					parentId: entries.at(-1)?.id,
					type: "custom",
					customType,
					data,
				});
			},
			async sendMessage() {},
		};
		mdLog(pi);
		const ctx = {
			cwd: directory,
			isIdle: () => true,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus(key, value) { statuses.set(key, value); },
				notify() {},
			},
		};

		await commands.get("md-log")(firstNote, ctx);
		assert.match(fs.readFileSync(firstNote, "utf-8"), /First note-only transcript\./);

		await commands.get("md-log")(secondNote, ctx);
		const secondContents = fs.readFileSync(secondNote, "utf-8");
		assert.match(secondContents, /Second note authored text\./);
		assert.doesNotMatch(secondContents, /First note-only transcript\./);

		await commands.get("md-unlog")("", ctx);
		assert.equal(entries.at(-1).customType, "md-log");
		assert.equal(entries.at(-1).data.file, null);
		assert.equal(statuses.get("md-log"), undefined);

		await commands.get("md-log")(thirdNote, ctx);
		const thirdContents = fs.readFileSync(thirdNote, "utf-8");
		assert.match(thirdContents, /Third note authored text\./);
		assert.doesNotMatch(thirdContents, /First note-only transcript\./);
		assert.doesNotMatch(thirdContents, /Second note authored text\./);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("/end-lesson saves a hidden resume marker and restores the latest state as context", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-end-lesson-"));
	const notePath = path.join(root, "lesson.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	fs.writeFileSync(notePath, [
		"# Lesson",
		"",
		"<!-- pi-end-lesson:v1",
		"Older resume point.",
		"-->",
		"",
	].join("\n"), "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const tools = new Map();
		const messages = [];
		const notifications = [];
		const entries = [{ id: "session", type: "session" }];
		let agentIdle = true;
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			registerTool(definition) { tools.set(definition.name, definition); },
			appendEntry(customType, data) {
				entries.push({
					id: `custom-${entries.length}`,
					parentId: entries.at(-1)?.id,
					type: "custom",
					customType,
					data,
				});
			},
			async sendMessage(message, options) { messages.push({ message, options }); },
		};
		mdLog(pi);
		const ctx = {
			cwd: root,
			isIdle: () => agentIdle,
			sessionManager: { getEntries: () => entries },
			ui: {
				theme: { fg: (_color, text) => text },
				setStatus() {},
				notify(message, level) { notifications.push({ message, level }); },
			},
		};

		await commands.get("md-log")(notePath, ctx);
		const olderMarker = "<!-- pi-end-lesson:v1\nOlder resume point.\n-->";
		if (!fs.readFileSync(notePath, "utf-8").includes(olderMarker)) {
			fs.appendFileSync(notePath, `\n${olderMarker}\n`, "utf-8");
		}
		agentIdle = false;
		const modalHandle = { setHidden() {}, focus() {} };
		trackAnswerModal(modalHandle, {
			snapshot: () => JSON.stringify({
				kind: "multi-choice-quiz",
				question: "Which molecules carry energy?",
				selected: [{ label: "ATP", value: "atp" }],
				note: "ATP transfers energy.",
			}),
			cancel() { clearAnswerModal(modalHandle); },
		});
		await commands.get("end-lesson")("", ctx);
		const endMessage = messages.find(({ message }) => message.customType === "md-log-end-lesson");
		assert.ok(endMessage);
		assert.equal(endMessage.options.triggerTurn, true);
		assert.match(endMessage.message.content, /active unanswered question/);
		assert.match(endMessage.message.content, /lesson ended with no interaction pending/);
		assert.match(endMessage.message.content, /A cancelled\/skipped dialog is not an unanswered question/);
		assert.match(endMessage.message.content, /under 300 characters/);
		assert.match(endMessage.message.content, /"selected":\[\{"label":"ATP","value":"atp"\}\]/);
		assert.ok(notifications.some(({ message }) => message.includes("Lesson wrap-up requested")));

		const state = "Next: Resume the unanswered \"Which molecules carry energy?\" quiz; no option is selected in the saved dialog.";
		const tool = tools.get("teach_end_lesson");
		assert.ok(tool);
		assert.equal(tool.parameters.properties.state.maxLength, 300);
		await assert.rejects(
			tool.execute("too-long", { state: "x".repeat(301) }, undefined, undefined, ctx),
			/1-300/,
		);
		const result = await tool.execute("end", { state }, undefined, undefined, ctx);
		assert.equal(result.details.status, "recorded");
		assert.equal(result.details.replacedPrevious, true);
		const marker = `<!-- pi-end-lesson:v1\n${state}\n-->`;
		assert.ok(fs.readFileSync(notePath, "utf-8").endsWith(`${marker}\n`));
		assert.equal((fs.readFileSync(notePath, "utf-8").match(/<!-- pi-end-lesson:v1/g) || []).length, 1);
		const duplicate = await tool.execute("end-again", { state }, undefined, undefined, ctx);
		assert.equal(duplicate.details.status, "recorded");
		assert.equal((fs.readFileSync(notePath, "utf-8").match(/<!-- pi-end-lesson:v1/g) || []).length, 1);

		await handlers.get("message_end")({
			message: { role: "assistant", content: [{ type: "text", text: "The lesson is paused. Here is the resume summary." }] },
		}, ctx);
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /Here is the resume summary/);
		handlers.get("agent_end")();
		assert.ok(fs.readFileSync(notePath, "utf-8").includes(marker));

		const restoredMessages = [];
		const restoreHandlers = new Map();
		const restoreCommands = new Map();
		const restorePi = {
			on(name, handler) { restoreHandlers.set(name, handler); },
			registerCommand(name, definition) { restoreCommands.set(name, definition.handler); },
			registerTool() {},
			appendEntry(customType, data) { entries.push({ id: `restore-${entries.length}`, type: "custom", customType, data }); },
			async sendMessage(message, options) { restoredMessages.push({ message, options }); },
		};
		mdLog(restorePi);
		agentIdle = true;
		await restoreCommands.get("md-log")(notePath, ctx);
		const restoredState = restoredMessages.find(({ message }) => message.customType === "md-log-end-lesson-context");
		assert.ok(restoredState, JSON.stringify(notifications));
		assert.equal(restoredState.options.triggerTurn, false);
		assert.match(restoredState.message.content, /Resume the unanswered/);
		assert.match(restoredState.message.content, /do not infer a new quiz from transcript teasers/);
		assert.ok(fs.readFileSync(notePath, "utf-8").endsWith(`${marker}\n`));

		agentIdle = true;
		await restoreCommands.get("resume-agent")("", ctx);
		const continuation = restoredMessages.find(({ message }) => message.customType === "md-log-resume-agent");
		assert.ok(continuation);
		assert.match(continuation.message.content, /Resume the unanswered/);
		assert.match(continuation.message.content, /skills\/teach\/SKILL\.md/);
		assert.match(continuation.message.content, /linked md-log transcript is already supplied in conversation context/);
		assert.match(continuation.message.content, /instead of searching for, opening, or shell-reading the note/);
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /pi-end-lesson/);
		assert.match(fs.readFileSync(notePath, "utf-8"), /\*\*Agent resumed: \d{4}-\d{2}-\d{2}:\d{2}-\d{2}\*\*/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
