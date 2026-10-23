import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import mdLog from "../extensions/md-log.ts";

test("extension links a note, updates live quiz rounds, and preserves note content", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-extension-"));
	const notePath = path.join(directory, "existing-note.md");
	const initialNote = "# Existing note\n\nKeep this text.\n";
	fs.writeFileSync(notePath, initialNote, "utf-8");

	try {
		const handlers = new Map();
		const commands = new Map();
		const entries = [];
		const notifications = [];
		const pi = {
			on(name, handler) { handlers.set(name, handler); },
			registerCommand(name, definition) { commands.set(name, definition.handler); },
			appendEntry(customType, data) {
				entries.push({ id: `custom-${entries.length}`, type: "custom", customType, data });
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
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz",
			args: { question: "Which answer is right?" },
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
			},
		}, ctx);

		const persisted = fs.readFileSync(notePath, "utf-8");
		assert.ok(persisted.startsWith(initialNote));
		assert.match(persisted, /^# Quiz/m);
		assert.match(persisted, /## Round 1/);
		assert.match(persisted, /1\. ==🟢 Right==/);
		assert.match(persisted, /2\. ~~==🔴 Wrong==~~/);
		assert.doesNotMatch(persisted, /Your answer:|Correct answer:/);
		assert.ok(notifications.some((notification) => notification.level === "success"));

		await commands.get("quiz-start")("Manual set", ctx);
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz-2",
			args: { question: "Second question?" },
			partialResult: { details: { options: [{ index: 1, label: "Answer" }] } },
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^# Manual set$/m);
		await commands.get("quiz-end")("", ctx);
		await handlers.get("tool_execution_update")({
			toolName: "quiz",
			toolCallId: "live-quiz-3",
			args: { question: "Question after the explicit group?" },
			partialResult: { details: { options: [{ index: 1, label: "Answer" }] } },
		}, ctx);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^# Quiz$/m);

		fs.unlinkSync(notePath);
		await handlers.get("message_end")({ message: { role: "user", content: "The file was removed." } }, ctx);
		assert.equal(fs.existsSync(notePath), false);
		assert.ok(notifications.some((notification) => notification.level === "error" && notification.message.includes("could not update")));
	} finally {
		if (fs.existsSync(notePath)) fs.unlinkSync(notePath);
		fs.rmdirSync(directory);
	}
});
