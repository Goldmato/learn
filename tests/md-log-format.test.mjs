import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBackfill,
	replaceManagedTranscript,
	renderTranscript,
	TRANSCRIPT_END,
	TRANSCRIPT_START,
} from "../extensions/md-log-format.ts";

function quizBlock(callId, question, selectedIndex, correctIndex, overrides = {}) {
	return {
		kind: "quiz",
		callId,
		question,
		options: [
			{ index: 1, label: "Correct option" },
			{ index: 2, label: "Selected misconception" },
		],
		details: {
			status: "answered",
			correct: selectedIndex === correctIndex,
			correctIndices: [correctIndex],
			answers: [{ index: selectedIndex, label: selectedIndex === 1 ? "Correct option" : "Selected misconception" }],
			explanation: "Why the answer is right.",
			...overrides,
		},
	};
}

test("quiz rounds have H1/H2 headings and style correct and wrong choices inline", () => {
	const markdown = renderTranscript([
		quizBlock("one", "First question?", 2, 1),
		{ kind: "prose", role: "assistant", text: "Use the same idea on the next round." },
		quizBlock("two", "Second question?", 1, 1),
	]);

	assert.equal((markdown.match(/^# Quiz$/gm) || []).length, 1);
	assert.match(markdown, /^## Round 1$/m);
	assert.match(markdown, /^## Round 2$/m);
	assert.match(markdown, /1\. ==🟢 Correct option==/);
	assert.match(markdown, /2\. ~~==🔴 Selected misconception==~~/);
	assert.doesNotMatch(markdown, /Your answer:|Correct answer:/);
	assert.equal((markdown.match(/Why the answer is right\./g) || []).length, 2);
});

test("I don't know highlights the key without treating an unselected answer as a wrong guess", () => {
	const markdown = renderTranscript([quizBlock("idk", "Question?", 0, 1, {
		dontKnow: true,
		correct: false,
		answers: [],
	})]);
	assert.match(markdown, /1\. ==🟢 Correct option==/);
	assert.doesNotMatch(markdown, /~~==🔴/);
	assert.match(markdown, /Quiz — I don't know/);
});

test("non-graded question and answer round is contained by an H2", () => {
	const markdown = renderTranscript([{
		kind: "ask",
		callId: "ask-1",
		question: "Which direction should we take?",
		options: [{ index: 1, label: "A" }],
		details: { status: "answered", answers: [{ type: "option", index: 1, label: "A" }] },
	}]);
	assert.match(markdown, /^## Question 1$/m);
	assert.match(markdown, /Which direction should we take\?/);
	assert.match(markdown, /> \[!example\] Answer/);
});

test("explicit quiz group spans user prose and resumes automatic grouping after it ends", () => {
	const markdown = renderTranscript([
		{ kind: "group", active: true, title: "Practice set" },
		quizBlock("one", "First?", 1, 1),
		{ kind: "prose", role: "user", text: "A clarification." },
		quizBlock("two", "Second?", 2, 1),
		{ kind: "group", active: false },
		quizBlock("three", "Third?", 1, 1),
	]);

	assert.equal((markdown.match(/^# Practice set$/gm) || []).length, 1);
	assert.equal((markdown.match(/^# Quiz$/gm) || []).length, 1);
	assert.match(markdown, /## Round 2/);
	assert.match(markdown, /## Round 1/);
});

test("managed transcript replacement preserves note text and is idempotent", () => {
	const original = `# Existing note\n\nMalformed \`\`\` code fence\n${TRANSCRIPT_START}\nold content\n${TRANSCRIPT_END}\n\nAuthored ending.`;
	const first = replaceManagedTranscript(original, "# Quiz\n\n## Round 1");
	const second = replaceManagedTranscript(first, "# Quiz\n\n## Round 1");

	assert.equal(second, first);
	assert.match(second, /^# Existing note/);
	assert.match(second, /Malformed ``` code fence/);
	assert.match(second, /Authored ending\.$/);
	assert.match(second, /## Round 1/);
});

test("malformed or duplicate markers are preserved and a fresh section is appended", () => {
	const malformed = `# Keep this\n${TRANSCRIPT_START}\nNever erase me`;
	const repaired = replaceManagedTranscript(malformed, "# Quiz");
	assert.match(repaired, /Never erase me/);
	assert.match(repaired, /# Quiz/);
	assert.ok(repaired.endsWith(`${TRANSCRIPT_END}\n`));
	assert.equal(replaceManagedTranscript(repaired, "# Quiz updated"), repaired.replace("# Quiz", "# Quiz updated"));
});

test("backfill pairs shuffled quiz options with results and tolerates missing metadata", () => {
	const entries = [
		{ id: "root", type: "session" },
		{ id: "call", parentId: "root", type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "Why?", options: [{ label: "wrong" }, { label: "right" }] } },
		] } },
		{ id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolName: "quiz", toolCallId: "quiz-call", details: {
			status: "answered", correctIndices: [2], answers: [{ index: 1, label: "wrong" }], correct: false,
			options: [{ index: 1, label: "wrong" }, { index: 2, label: "right" }],
		} } },
		{ id: "ask", parentId: "result", type: "message", message: { role: "toolResult", toolName: "ask_user_question", toolCallId: "missing" } },
	];
	const result = buildBackfill(entries);
	const markdown = renderTranscript(result.blocks);
	assert.match(markdown, /1\. ~~==🔴 wrong==~~/);
	assert.match(markdown, /2\. ==🟢 right==/);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("unmatched")));
});

test("backfill retains an unanswered question without inventing its answer", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "call", parentId: "root", type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "pending", name: "quiz", arguments: { question: "Still unanswered?", options: [{ label: "A" }] } },
		] } },
	]);
	const markdown = renderTranscript(result.blocks);
	assert.match(markdown, /Still unanswered\?/);
	assert.doesNotMatch(markdown, /Quiz — correct|Quiz — incorrect|==🟢/);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("no result")));
});

test("backfill does not apply shuffled answer indices to pre-shuffle options when display order is missing", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "call", parentId: "root", type: "message", message: { role: "assistant", content: [
			{ type: "toolCall", id: "old-quiz", name: "quiz", arguments: { question: "Old result?", options: [{ label: "Original A" }, { label: "Original B" }] } },
		] } },
		{ id: "result", parentId: "call", type: "message", message: { role: "toolResult", toolName: "quiz", toolCallId: "old-quiz", details: {
			status: "answered", correct: false, correctIndices: [1], answers: [{ index: 2, label: "Original B" }],
		} } },
	]);
	const markdown = renderTranscript(result.blocks);
	assert.doesNotMatch(markdown, /Original A|Original B|==🟢|~~==🔴/);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("display order")));
});

test("malformed quiz result metadata is not presented as an incorrect answer", () => {
	const markdown = renderTranscript([{
		kind: "quiz",
		callId: "malformed",
		question: "Incomplete result?",
		options: [{ index: 1, label: "Option" }],
		details: { answers: [{ index: 1, label: "Option" }] },
	}]);
	assert.match(markdown, /Quiz — feedback unavailable/);
	assert.doesNotMatch(markdown, /Quiz — incorrect/);
	assert.doesNotMatch(markdown, /==🟢|~~==🔴/);
});

test("backfill reports broken parent chains and cycles while returning reachable entries", () => {
	const missingParent = buildBackfill([
		{ id: "child", parentId: "absent", type: "message", message: { role: "user", content: "Reachable text" } },
	]);
	assert.match(renderTranscript(missingParent.blocks), /Reachable text/);
	assert.ok(missingParent.diagnostics.some((diagnostic) => diagnostic.includes("Missing parent")));

	const cyclic = buildBackfill([
		{ id: "a", parentId: "b", type: "message", message: { role: "user", content: "A" } },
		{ id: "b", parentId: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "B" }] } },
	]);
	assert.equal(cyclic.blocks.filter((block) => block.kind === "prose").length, 2);
	assert.ok(cyclic.diagnostics.some((diagnostic) => diagnostic.includes("Cycle detected")));
});

test("backfill diagnoses malformed and unknown session entry shapes without throwing", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "malformed", parentId: "root", type: "message", message: null },
		{ id: "unknown", parentId: "malformed", type: "unexpected" },
	]);
	assert.equal(result.entries, 3);
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("malformed message")));
	assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("unsupported type")));
});
