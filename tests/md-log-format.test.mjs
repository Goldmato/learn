import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBackfill,
	appendQuizScratchpad,
	extractQuizScratchpad,
	extractManagedTranscript,
	isNonSubstantiveAssistantUpdate,
	renderTranscriptWithImagePlacements,
	replaceManagedTranscript,
	renderTranscript,
	TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
	TRANSCRIPT_END,
	TRANSCRIPT_START,
} from "../lib/md-log-format.ts";

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

test("user and assistant prose bodies stay inside their quote callouts", () => {
	const markdown = renderTranscript([
		{ kind: "prose", role: "user", text: "First line.\n\nSecond line." },
		{ kind: "prose", role: "assistant", text: "Explanation.\nMore detail." },
	]);

	assert.match(markdown, /> \[!quote\] YOU\n\n> First line\.\n>\n> Second line\./);
	assert.match(markdown, /> \[!abstract\] PI\n\n> Explanation\.\n> More detail\./);
});

test("quiz scratchpad templates are tied to their question and read only fenced content", () => {
	const markdown = renderTranscript([
		{ ...quizBlock("first", "First question?", 1, 1), details: undefined },
		{ ...quizBlock("second", "Second question?", 1, 1), details: undefined },
	]);
	const firstMarker = "<!-- pi-quiz-scratchpad:first -->";
	const secondMarker = "<!-- pi-quiz-scratchpad:second -->";
	assert.match(markdown, /First question\?[\s\S]*?<!-- pi-quiz-scratchpad:first -->\n\n```\n\n```/);
	assert.match(markdown, /Second question\?[\s\S]*?<!-- pi-quiz-scratchpad:second -->\n\n```\n\n```/);

	const edited = markdown
		.replace(`${firstMarker}\n\n\`\`\`\n\n\`\`\``, `${firstMarker}\n\n\`\`\`\nFirst reasoning.\n\`\`\`\nText outside the block.`)
		.replace(`${secondMarker}\n\n\`\`\`\n\n\`\`\``, `${secondMarker}\n\n\`\`\`\nSecond reasoning.\n\`\`\``);
	assert.equal(extractQuizScratchpad(edited, "first"), "First reasoning.");
	assert.equal(extractQuizScratchpad(edited, "second"), "Second reasoning.");
	assert.equal(extractQuizScratchpad(edited, "missing"), undefined);
	assert.equal(extractQuizScratchpad(markdown, "first"), undefined);
});

test("quiz note text appends to existing scratchpad content", () => {
	const combined = appendQuizScratchpad("Existing reasoning.", "Additional thought.");
	assert.equal(combined, "Existing reasoning.\n\nAdditional thought.");
	assert.equal(appendQuizScratchpad(undefined, "Popup thought."), "Popup thought.");
	assert.equal(appendQuizScratchpad("Existing reasoning.", undefined), "Existing reasoning.");
	assert.equal(appendQuizScratchpad("  ", "  "), undefined);

	const markdown = renderTranscript([quizBlock("combined", "Question?", 1, 1, { scratchpad: combined })]);
	assert.match(markdown, /<!-- pi-quiz-scratchpad:combined -->\n\n```\nExisting reasoning\.\n\nAdditional thought\.\n```/);
	assert.doesNotMatch(markdown, /Note: Additional thought\./);
});

test("rendered quiz scratchpads preserve content containing a triple-backtick run", () => {
	const markdown = renderTranscript([{
		...quizBlock("fenced", "Question?", 1, 1),
		details: { scratchpad: "I considered ```code``` while reasoning." },
	}]);
	assert.match(markdown, /<!-- pi-quiz-scratchpad:fenced -->\n\n````\nI considered ```code``` while reasoning\.\n````/);
	assert.equal(extractQuizScratchpad(markdown, "fenced"), "I considered ```code``` while reasoning.");
});

test("curriculum plan markers survive transcript generation and managed-note replacement", () => {
	const plan = [
		"%% curriculum-plan:start v1 %%",
		"# Curriculum: Foundations to Practice",
		"Start with the verified foundations, then connect each dependent step.",
		"%% curriculum-plan:end v1 %%",
	].join("\n");
	const transcript = renderTranscript([{ kind: "prose", role: "assistant", text: plan }]);
	const note = replaceManagedTranscript("# Learner note\n\nKeep this text.", transcript);

	assert.ok(note.startsWith("# Learner note\n\nKeep this text."));
	assert.ok(note.includes(plan.split("\n").map((line) => `> ${line}`).join("\n")));
	assert.match(note, /%% curriculum-plan:start v1 %%[\s\S]*%% curriculum-plan:end v1 %%/);
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
		summaryTitle: "Choosing a Direction",
		options: [{ index: 1, label: "A" }],
		details: { status: "answered", answers: [{ type: "option", index: 1, label: "A" }] },
	}]);
	assert.match(markdown, /^## Question 1: Choosing a Direction$/m);
	assert.match(markdown, /Which direction should we take\?/);
	assert.match(markdown, /> \[!example\] Answer/);
});

test("quiz and question summaries appear after their heading prefixes", () => {
	const markdown = renderTranscript([
		{ ...quizBlock("quiz", "How do cells divide?", 1, 1), summaryTitle: "How Cells Divide" },
		{
			kind: "ask",
			callId: "ask",
			question: "What should we explore next?",
			summaryTitle: "Choosing Our Next Topic",
			options: [],
			details: { status: "answered", answers: [{ type: "text", label: "Cell signaling" }] },
		},
	]);
	assert.match(markdown, /^# Quiz: How Cells Divide$/m);
	assert.match(markdown, /^## Round 1: How Cells Divide$/m);
	assert.match(markdown, /^## Question 1: Choosing Our Next Topic$/m);
});

test("generated headings normalize separators, capitalization, and concept IDs", () => {
	const markdown = renderTranscript([
		{ ...quizBlock("slug-title", "Question?", 1, 1), summaryTitle: "bIrD-digestive_tract-order" },
		{
			kind: "attempt",
			callId: "attempt-slug",
			interactionId: "interaction",
			conceptId: "DNA_replication-basics",
			outcome: "correct",
			explanation: "Correct.",
		},
		{ kind: "group", active: true, prefix: "course_notes", title: "aPpLy_the_Method" },
	]);
	assert.match(markdown, /^# Quiz: Bird Digestive Tract Order$/m);
	assert.match(markdown, /^## Round 1: Bird Digestive Tract Order$/m);
	assert.match(markdown, /^## Attempt: DNA Replication Basics$/m);
	assert.match(markdown, /^# Course Notes: Apply the Method$/m);
});

test("explicit quiz group spans user prose and resumes automatic grouping after it ends", () => {
	const markdown = renderTranscript([
		{ kind: "group", active: true, prefix: "Quiz", title: "Practice set" },
		quizBlock("one", "First?", 1, 1),
		{ kind: "prose", role: "user", text: "A clarification." },
		quizBlock("two", "Second?", 2, 1),
		{ kind: "group", active: false },
		quizBlock("three", "Third?", 1, 1),
	]);

	assert.equal((markdown.match(/^# Quiz: Practice Set$/gm) || []).length, 1);
	assert.equal((markdown.match(/^# Quiz$/gm) || []).length, 1);
	assert.match(markdown, /## Round 2/);
	assert.match(markdown, /## Round 1/);
});

test("named section boundaries survive backfill and contain teaching content", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "start", parentId: "root", type: "custom", customType: "md-log-section", data: {
			active: true,
			prefix: "Teaching",
			title: "How Cells Divide",
		} },
		{ id: "lesson", parentId: "start", type: "message", message: { role: "assistant", content: [
			{ type: "text", text: "Cells divide through a sequence of steps." },
		] } },
		{ id: "end", parentId: "lesson", type: "custom", customType: "md-log-section", data: { active: false } },
	]);
	const markdown = renderTranscript(result.blocks);
	assert.match(markdown, /^# Teaching: How Cells Divide$/m);
	assert.match(markdown, /Cells divide through a sequence of steps\./);
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

test("managed transcript extraction only returns content from a complete marker pair", () => {
	const managed = `# Note\n${TRANSCRIPT_START}\nPrior content\n${TRANSCRIPT_END}\nKeep this.`;
	assert.equal(extractManagedTranscript(managed), "Prior content");
	assert.equal(extractManagedTranscript(`# Note\n${TRANSCRIPT_START}\nUnclosed content`), undefined);
});

test("backfill places imported note content before the current session transcript", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "user", parentId: "root", type: "message", message: { role: "user", content: "Continue this lesson." } },
		{ id: "import", parentId: "user", type: "custom", customType: "md-log-import", data: {
			file: "prior-session.md",
			markdown: "# Prior lesson\n\nCompleted work.",
		} },
	]);
	const markdown = renderTranscript(result.blocks);
	assert.ok(markdown.indexOf("# Prior lesson") < markdown.indexOf("Continue this lesson."));
	assert.match(markdown, /Completed work\./);
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

test("backfill omits assistant acknowledgments and progress updates but keeps lesson content", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "status-one", parentId: "root", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I've started a natural-history illustration. It's generating in the background, and I'll hold off on the lesson until you approve the plan." }] } },
		{ id: "status-two", parentId: "status-one", type: "message", message: { role: "assistant", content: [{ type: "text", text: "The image has finished generating and is in your linked note. The lesson is still paused at the plan checkpoint; say “go ahead” when you're ready." }] } },
		{ id: "ack", parentId: "status-two", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Understood." }] } },
		{ id: "lesson", parentId: "ack", type: "message", message: { role: "assistant", content: [{ type: "text", text: "A butterfly's wing color can arise from microscopic structures that selectively reflect particular wavelengths." }] } },
	]);
	const markdown = renderTranscript(result.blocks);
	assert.equal(result.blocks.filter((block) => block.kind === "prose" && block.role === "assistant").length, 1);
	assert.match(markdown, /microscopic structures that selectively reflect/);
	assert.doesNotMatch(markdown, /natural-history illustration|finished generating|Understood/);
	assert.equal(isNonSubstantiveAssistantUpdate("I can clarify the lesson: the wing reflects blue light."), false);
});

test("teaching interaction backfill renders the response and recorded attempt", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "response", parentId: "root", type: "custom", customType: "teach-free-response", data: {
			callId: "free-call",
			interactionId: "teach-free-123",
			question: "Write the reply, then briefly explain your choices.",
			summaryTitle: "Writing A Clear Reply",
			response: "I would reply plainly.\n\nI chose not to manage their reaction.",
			conceptId: "clear-boundaries",
		} },
		{ id: "attempt", parentId: "response", type: "custom", customType: "teach-attempt", data: {
			callId: "attempt-call",
			interactionId: "teach-free-123",
			conceptId: "clear-boundaries",
			outcome: "partial",
			explanation: "The reply is clear; explain why the boundary is yours to set.",
			previousMastery: 5,
			masteryState: {
				score: 5.2,
				evidenceCount: 4,
				evidenceWeight: 3.9,
				lastInteractionId: "teach-free-123",
				confidence: 5,
			},
			confidence: 5,
		} },
	]);
	const markdown = renderTranscript(result.blocks);

	assert.match(markdown, /^## Writing a Clear Reply$/m);
	assert.match(markdown, /> \[!question\] Prompt\n> Write the reply, then briefly explain your choices\./);
	assert.match(markdown, /> \[!idea\] Learner's response\n> I would reply plainly\./);
	assert.match(markdown, /\n>\n> I chose not to manage their reaction\./);
	assert.match(markdown, /^## Attempt: Clear Boundaries$/m);
	assert.match(markdown, /> \[!warning\] Evaluation — Partially correct/);
	assert.match(markdown, /Mastery: ==🟣 5\.00 → 5\.20 \/ 10==/);
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

test("image attachment backfill persists only the Obsidian wikilink", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{
			id: "image",
			parentId: "root",
			type: "custom",
			customType: "teach-image-attachment",
			data: {
				interactionId: "teach-image-123",
				sourcePath: "C:\\private\\paint-jobs\\image.png",
				filename: "comfyui-energy-flow-1.png",
			},
		},
	]);

	assert.equal(renderTranscript(result.blocks), "![[comfyui-energy-flow-1.png]]");
	assert.equal(result.blocks[0].sourcePath, "C:\\private\\paint-jobs\\image.png");
});

test("async image placements stay after their exact note anchor through transcript refresh and completion", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const agentId = "image-job-1";
	const entries = [
		{ id: "session", type: "session" },
		{
			id: "placement-pending",
			parentId: "session",
			type: "custom",
			customType: "teach-image-placement",
			data: { markerId, status: "pending", notePath, anchor: "Mushrooms release spores to restart the cycle.", captionTitle: "Mushroom Spore Cycle", caption: "The cycle illustrates how a mature mushroom releases spores that begin new growth." },
		},
		{
			id: "placement-dispatched",
			parentId: "placement-pending",
			type: "custom",
			customType: "teach-image-placement",
			data: { markerId, status: "dispatched", agentId, notePath, anchor: "Mushrooms release spores to restart the cycle.", captionTitle: "Mushroom Spore Cycle", caption: "The cycle illustrates how a mature mushroom releases spores that begin new growth." },
		},
	];
	const transcript = "> [!quote] YOU\n\nMushrooms release spores to restart the cycle.\n\n> [!abstract] PI\n\nNow let's review.";
	const pending = renderTranscriptWithImagePlacements(transcript, entries, notePath);
	assert.match(pending, /Mushrooms release spores to restart the cycle\.\n\n> \[!quote\] Mushroom Spore Cycle\n> \*"The cycle illustrates how a mature mushroom releases spores that begin new growth\."\*\n\n%%pi-comfyui-image:91accc63-53db-4d7f-9f04-790f6879ee2a%%/);
	assert.ok(pending.indexOf("%%pi-comfyui-image:") < pending.indexOf("Now let's review."));

	const completed = renderTranscriptWithImagePlacements(transcript, [
		...entries,
		{
			id: "subagent-complete",
			parentId: "placement-dispatched",
			type: "custom",
			customType: "subagents:record",
			data: {
				id: agentId,
				status: "completed",
				result: "RESULT:\nstatus: success\nattachmentPath: 001-Attachments/~comfyui/comfyui-mushroom-cycle-1.png",
			},
		},
	], notePath);
	assert.match(completed, /Mushrooms release spores to restart the cycle\.\n\n> \[!quote\] Mushroom Spore Cycle\n> \*"The cycle illustrates how a mature mushroom releases spores that begin new growth\."\*\n\n!\[\[001-Attachments\/~comfyui\/comfyui-mushroom-cycle-1\.png\]\]/);
	assert.doesNotMatch(completed, /pi-comfyui-image:/);
});

test("async image placements ignore failures and reject missing or ambiguous anchors", () => {
	const notePath = "C:\\vault\\lesson.md";
	const placement = {
		id: "placement",
		type: "custom",
		customType: "teach-image-placement",
		data: { markerId: "91accc63-53db-4d7f-9f04-790f6879ee2a", status: "dispatched", agentId: "image-job-1", notePath, anchor: "Exact anchor.", captionTitle: "Visual Summary", caption: "A visual summary of this idea." },
	};
	const failed = renderTranscriptWithImagePlacements("Exact anchor.", [
		placement,
		{
			id: "subagent-failed",
			type: "custom",
			customType: "subagents:record",
			data: { id: "image-job-1", status: "completed", result: "RESULT:\nstatus: failure\nerror: ComfyUI unavailable" },
		},
	], notePath);
	assert.equal(failed, "Exact anchor.");
	assert.throws(
		() => renderTranscriptWithImagePlacements("No match.", [placement], notePath),
		/Image insertion anchor/,
	);
	assert.throws(
		() => renderTranscriptWithImagePlacements("Exact anchor. Exact anchor.", [placement], notePath),
		/Image insertion anchor/,
	);
});

test("async image placement backfill ignores placements from abandoned session branches", () => {
	const notePath = "C:\\vault\\lesson.md";
	const entries = [
		{ id: "root", type: "session" },
		{ id: "abandoned", parentId: "root", type: "message", message: { role: "user", content: "Branch-specific explanation." } },
		{
			id: "abandoned-placement",
			parentId: "abandoned",
			type: "custom",
			customType: "teach-image-placement",
			data: { markerId: "91accc63-53db-4d7f-9f04-790f6879ee2a", status: "pending", notePath, anchor: "Branch-specific explanation.", caption: "A visual summary." },
		},
		{ id: "active", parentId: "root", type: "message", message: { role: "user", content: "Current explanation." } },
	];
	const transcript = "> [!quote] YOU\n\nBranch-specific explanation.\n\n> [!quote] YOU\n\nCurrent explanation.";
	assert.equal(renderTranscriptWithImagePlacements(transcript, entries, notePath), transcript);
});

test("Breeze TTS placeholders and audio embeds survive managed transcript refreshes", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	const base = {
		markerId,
		notePath,
		anchor: "A concept depends on its foundation.",
		conceptText: "A concept depends on its foundation.",
	};
	const pending = renderTranscriptWithImagePlacements(
		"> [!abstract] PI\n\nA concept depends on its foundation.",
		[{ id: "session", type: "session" }, {
			id: "pending",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { ...base, status: "dispatched" },
		}],
		notePath,
	);
	assert.match(pending, /A concept depends on its foundation\.\n\n%%pi-breeze-tts:e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7%%/);

	const completed = renderTranscriptWithImagePlacements(
		"> [!abstract] PI\n\nA concept depends on its foundation.",
		[{ id: "session", type: "session" }, {
			id: "placed",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: {
				...base,
				status: "placed",
				vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-1.wav",
			},
		}],
		notePath,
	);
	assert.match(completed, /A concept depends on its foundation\.\n\n!\[\[001-Attachments\/~breezetts\/breeze-foundations-1\.wav\]\]/);

	const cancelled = renderTranscriptWithImagePlacements(
		"A concept depends on its foundation.",
		[{ id: "session", type: "session" }, {
			id: "cancelled",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { ...base, status: "cancelled" },
		}],
		notePath,
	);
	assert.equal(cancelled, "A concept depends on its foundation.");
	assert.deepEqual(buildBackfill([
		{ id: "session", type: "session" },
		{
			id: "placed",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { ...base, status: "placed", vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-1.wav" },
		},
	]).diagnostics, []);
});
