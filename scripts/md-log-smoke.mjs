import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildBackfill,
	replaceManagedTranscript,
	renderTranscript,
} from "../lib/md-log-format.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-smoke-"));
const notePath = path.join(directory, "existing-note.md");
try {
	const existingNote = "# Existing vault note\n\nAn intentionally unfinished ``` fence.\n";
	fs.writeFileSync(notePath, existingNote, "utf-8");
	const history = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "call", parentId: "root", type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "quiz-1", name: "quiz", arguments: { question: "Smoke question?", options: [{ label: "Right" }, { label: "Wrong" }] } },
		] } },
		{ id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolName: "quiz", toolCallId: "quiz-1", details: {
			status: "answered", correct: false, correctIndices: [1], answers: [{ index: 2, label: "Wrong" }],
			options: [{ index: 1, label: "Right" }, { index: 2, label: "Wrong" }],
		} } },
	]);
	const transcript = renderTranscript(history.blocks);
	const first = replaceManagedTranscript(fs.readFileSync(notePath, "utf-8"), transcript);
	fs.writeFileSync(notePath, first, "utf-8");
	const rerun = replaceManagedTranscript(fs.readFileSync(notePath, "utf-8"), transcript);
	fs.writeFileSync(notePath, rerun, "utf-8");
	const persisted = fs.readFileSync(notePath, "utf-8");

	assert.equal(persisted, first);
	assert.ok(persisted.startsWith(existingNote));
	assert.match(persisted, /^# Quiz/m);
	assert.match(persisted, /2\. ~~==🔴 Wrong==~~/);
	console.log("md-log smoke test passed: preserved existing note, backfilled a quiz, and updated its section idempotently.");
} finally {
	fs.unlinkSync(notePath);
	fs.rmdirSync(directory);
}
