import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyBreezeCompletion,
	isTerminalBreezeCompletionStatus,
} from "../lib/breeze-completion.ts";

function successResult(fields = {}) {
	const values = {
		status: "success",
		handoffPath: "C:\\temp\\breeze\\speech.wav",
		audioDescription: "Sound Travels Through Moving Air",
		voiceName: "Standard Breeze",
		referenceId: "123456",
		transcript: JSON.stringify("First sentence.\n第二句."),
		...fields,
	};
	return [
		"Generator completed.",
		"RESULT:",
		...Object.entries(values)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => `${key}: ${value}`),
	].join("\n");
}

test("Breeze completion parses the text contract and preserves the exact transcript", () => {
	const completion = classifyBreezeCompletion({
		status: "completed",
		result: successResult(),
	});

	assert.deepEqual(completion, {
		kind: "success",
		handoffPath: "C:\\temp\\breeze\\speech.wav",
		audioDescription: "Sound Travels Through Moving Air",
		voiceName: "Standard Breeze",
		referenceId: "123456",
		transcript: "First sentence.\n第二句.",
	});
});

test("Breeze completion accepts omitted optional voice metadata", () => {
	const completion = classifyBreezeCompletion({
		status: "completed",
		result: successResult({ voiceName: "", referenceId: "" }),
	});

	assert.equal(completion.kind, "success");
	if (completion.kind === "success") {
		assert.equal("voiceName" in completion, false);
		assert.equal("referenceId" in completion, false);
	}
});

test("Breeze completion normalizes explicit and terminal failures", () => {
	const result = "RESULT:\nstatus: failure\nerror: engine unavailable";
	assert.deepEqual(classifyBreezeCompletion({ status: "completed", result }), {
		kind: "failure",
		error: "status: failure\nerror: engine unavailable",
	});
	assert.deepEqual(classifyBreezeCompletion({ status: "stopped", error: "Stopped by user." }), {
		kind: "failure",
		error: "Stopped by user.",
	});
	assert.equal(isTerminalBreezeCompletionStatus("completed"), true);
	assert.equal(isTerminalBreezeCompletionStatus("aborted"), true);
	assert.equal(isTerminalBreezeCompletionStatus("running"), false);
});

test("malformed success payloads become explicit retryable failures", () => {
	const cases = [
		["missing handoff path", { handoffPath: "" }, /no audio handoff path/],
		["missing transcript", { transcript: undefined }, /no transcript/],
		["invalid transcript JSON", { transcript: "not JSON" }, /invalid JSON transcript/],
		["empty transcript", { transcript: JSON.stringify("  ") }, /empty or invalid transcript/],
		["invalid description", { audioDescription: "Only four words" }, /exactly five words/],
	];

	for (const [label, fields, expectedError] of cases) {
		const completion = classifyBreezeCompletion({ status: "completed", result: successResult(fields) });
		assert.equal(completion.kind, "failure", label);
		if (completion.kind === "failure") assert.match(completion.error, expectedError, label);
	}
});
