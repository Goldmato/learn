import assert from "node:assert/strict";
import test from "node:test";
import {
	buildBackfill,
	appendQuizScratchpad,
	applyPlacements,
	extractQuizScratchpad,
	extractManagedTranscript,
	isNonSubstantiveAssistantUpdate,
	placeManagedSectionAtTop,
	renderAudioTranscriptCallout,
	replaceManagedTranscript,
	renderTranscript,
	TEACH_IMAGE_PLACEMENT_ENTRY,
	TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
	TRANSCRIPT_END,
	TRANSCRIPT_START,
} from "../lib/md-log-format.ts";
import { placementAnchorMarker } from "../lib/placement-recovery.ts";

/**
 * Split a rendered transcript back into blocks so placement tests can exercise
 * the real block pipeline. Callout paragraphs become prose blocks; anything else
 * is kept verbatim as a markdown block.
 */
function blocksFromTranscript(markdown) {
	const chunks = markdown.split(/\n\n/);
	const blocks = [];
	for (let index = 0; index < chunks.length; index++) {
		const header = /^> \[!(quote|abstract)\] (?:YOU|PI)$/.exec(chunks[index]);
		if (header) {
			const body = chunks[++index] ?? "";
			blocks.push({
				kind: "prose",
				role: header[1] === "quote" ? "user" : "assistant",
				text: body.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n"),
			});
			continue;
		}
		blocks.push({ kind: "markdown", file: "", markdown: chunks[index] });
	}
	return blocks;
}

function renderPlacements(transcript, entries, notePath, durableMarkdown = "") {
	return renderTranscript(applyPlacements(blocksFromTranscript(transcript), entries, notePath, durableMarkdown));
}

test("stable image placement stays with its repeated anchor through transcript refresh", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const anchorId = "64e2a2eb-5d4d-4987-89df-5bed565d0c87";
	const anchor = "Repeat this sentence.";
	const anchorMarker = placementAnchorMarker(anchorId, markerId);
	const imageMarker = `%%pi-comfyui-image:${markerId}%%`;
	const entries = [
		{ id: "session", type: "session" },
		{
			id: "placement-pending",
			parentId: "session",
			type: "custom",
			customType: TEACH_IMAGE_PLACEMENT_ENTRY,
			data: {
				markerId,
				anchorId,
				status: "pending",
				notePath,
				anchor,
				captionTitle: "Repeated passage",
				caption: "A generated image belongs after this passage.",
			},
		},
	];
	const transcript = `> [!quote] YOU\n\n${anchor} Some other text. ${anchor}`;
	const durableMarkdown = `${TRANSCRIPT_START}\n${anchor} Some other text. ${anchor} ${anchorMarker}\n${imageMarker}\n${TRANSCRIPT_END}`;
	const rendered = renderPlacements(transcript, entries, notePath, durableMarkdown);

	assert.ok(rendered.indexOf(anchorMarker) > rendered.lastIndexOf(anchor));
	assert.ok(rendered.indexOf(imageMarker) > rendered.indexOf(anchorMarker));
	assert.equal(rendered.indexOf(imageMarker) > rendered.lastIndexOf(anchor), true);

	assert.throws(
		() => renderPlacements(transcript, entries, notePath),
		/Cannot safely reconcile Generated placement/,
	);
	const uniqueTranscript = `> [!quote] YOU\n\n${anchor}`;
	const uniqueFallback = renderPlacements(uniqueTranscript, entries, notePath);
	assert.match(uniqueFallback, new RegExp(anchorMarker));

	const cancelledEntries = entries.concat({
		id: "placement-cancelled",
		parentId: "placement-pending",
		type: "custom",
		customType: TEACH_IMAGE_PLACEMENT_ENTRY,
		data: { ...entries[1].data, status: "cancelled" },
	});
	const cancelled = renderPlacements(transcript, cancelledEntries, notePath);
	assert.doesNotMatch(cancelled, /pi-placement-anchor/);
	assert.doesNotMatch(cancelled, /pi-comfyui-image:/);
});

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

test("inline and quoted marker mentions do not shadow managed transcript boundaries", () => {
	const prompt = `> The literal marker is "${TRANSCRIPT_START}" and must not open a section.\n> ${TRANSCRIPT_START}`;
	const note = `# Note\n\n${TRANSCRIPT_START}\n\nAnchor paragraph.\n\n${TRANSCRIPT_END}\n\n${prompt}\n`;
	assert.equal(extractManagedTranscript(note), "Anchor paragraph.");

	const rendered = replaceManagedTranscript(note, "Anchor paragraph.\n\nGenerated output.");
	assert.equal(extractManagedTranscript(rendered), "Anchor paragraph.\n\nGenerated output.");
	assert.ok(rendered.includes(prompt), "prompt marker mentions remain outside the managed section");
	assert.equal(replaceManagedTranscript(rendered, "Anchor paragraph.\n\nGenerated output."), rendered);
	assert.equal((rendered.match(/Anchor paragraph\./g) || []).length, 1);
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
	assert.ok(missingParent.diagnostics.some((diagnostic) => diagnostic.includes("Unreachable parent")));

	const cyclic = buildBackfill([
		{ id: "a", parentId: "b", type: "message", message: { role: "user", content: "A" } },
		{ id: "b", parentId: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "B" }] } },
	]);
	assert.equal(cyclic.blocks.filter((block) => block.kind === "prose").length, 2);
	assert.ok(cyclic.diagnostics.some((diagnostic) => diagnostic.includes("Unreachable parent")));
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
	const systemOnly = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "system", parentId: "root", type: "message", message: { role: "system", content: "Internal prompt text." } },
	]);
	assert.deepEqual(systemOnly.diagnostics, []);
	assert.equal(renderTranscript(systemOnly.blocks), "");
});

test("backfill ignores known non-transcript metadata entries", () => {
	const result = buildBackfill([
		{ id: "root", type: "session" },
		{ id: "preset", parentId: "root", type: "custom", customType: "breeze-voice-preset", data: { preset: { name: "Cave Johnson" } } },
		{ id: "placement", parentId: "preset", type: "custom", customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY, data: { markerId: "95998fb0-77f4-4eaa-b018-7090312120a7" } },
		{ id: "subagent", parentId: "placement", type: "custom", customType: "subagents:record", data: { id: "breeze-job" } },
	]);
	assert.deepEqual(result.diagnostics, []);
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
	const pending = renderPlacements(transcript, entries, notePath);
	assert.match(pending, /Mushrooms release spores to restart the cycle\.\n\n> \[!quote\] Mushroom Spore Cycle\n> \*"The cycle illustrates how a mature mushroom releases spores that begin new growth\."\*\n\n%%pi-comfyui-image:91accc63-53db-4d7f-9f04-790f6879ee2a%%/);
	assert.ok(pending.indexOf("%%pi-comfyui-image:") < pending.indexOf("Now let's review."));

	const completed = renderPlacements(transcript, [
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
	const failed = renderPlacements("Exact anchor.", [
		placement,
		{
			id: "subagent-failed",
			type: "custom",
			customType: "subagents:record",
			data: { id: "image-job-1", status: "completed", result: "RESULT:\nstatus: failure\nerror: ComfyUI unavailable" },
		},
	], notePath);
	assert.equal(failed, "Exact anchor.");
	// A lost anchor is no longer fatal: the placement is appended so already
	// generated audio can never be dropped by a refresh.
	assert.match(renderPlacements("No match.", [placement], notePath), /%%pi-comfyui-image:91accc63-53db-4d7f-9f04-790f6879ee2a%%$/);
	// A repeated anchor resolves to its first occurrence instead of failing.
	const repeated = renderPlacements("Exact anchor.\n\nExact anchor.", [placement], notePath);
	assert.ok(repeated.indexOf("%%pi-comfyui-image:") < repeated.lastIndexOf("Exact anchor."));
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
	assert.equal(renderPlacements(transcript, entries, notePath), renderTranscript(blocksFromTranscript(transcript)));
});

test("Breeze TTS placement tolerates missing or repeated anchors when note audio is already durable", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "95998fb0-77f4-4eaa-b018-7090312120a7";
	const anchor = "科学嘛，有时就是这样——你以为已经见过一切，接着萝卜开口了。";
	const embed = "![[001-Attachments/~breezetts/breeze-test-1.wav]]";
	const placement = {
		id: "audio-placement",
		parentId: "session",
		type: "custom",
		customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
		data: { markerId, notePath, anchor, status: "placed", vaultRelativePath: "001-Attachments/~breezetts/breeze-test-1.wav" },
	};
	const entries = [{ id: "session", type: "session" }, placement];
	const existing = `%% pi-md-log:start v1 %%\n${anchor}\n\n${embed}\n%% pi-md-log:end v1 %%`;
	// The session transcript no longer contains the passage: the embed is kept
	// (appended) rather than lost.
	assert.equal(renderPlacements("New unrelated session text.", entries, notePath), `New unrelated session text.\n\n${embed}`);
	// A repeated passage resolves to its first occurrence.
	const repeated = renderPlacements(`${anchor}\n\n${anchor}`, entries, notePath);
	assert.ok(repeated.indexOf(embed) > repeated.indexOf(anchor));
	assert.ok(repeated.indexOf(embed) < repeated.lastIndexOf(anchor));
});

test("Breeze TTS placement uses the first anchor when the imported note is repeated in the new session", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "dc15e1be-98bd-4128-b54b-e0c3c20b63b1";
	const anchor = "The quoted statement ends here.";
	const transcript = `> [!abstract] PI\n\n${anchor}\n\n> [!quote] YOU\n\n${anchor}`;
	const rendered = renderPlacements(transcript, [
		{ id: "session", type: "session" },
		{
			id: "audio-placement",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: {
				markerId,
				notePath,
				anchor,
				status: "placed",
				vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-1.wav",
			},
		},
	], notePath);

	const audioIndex = rendered.indexOf("![[001-Attachments/~breezetts/breeze-foundations-1.wav]]");
	assert.ok(audioIndex > rendered.indexOf(anchor));
	assert.ok(audioIndex < rendered.lastIndexOf(anchor));
	assert.ok(rendered.slice(audioIndex).startsWith("![[001-Attachments/~breezetts/breeze-foundations-1.wav]]"));
	const lostAnchor = renderPlacements("The anchor disappeared.", [
		{ id: "session", type: "session" },
		{ id: "missing-anchor", parentId: "session", type: "custom", customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY, data: { markerId, notePath, anchor, status: "placed", vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-1.wav" } },
	], notePath);
	assert.match(lostAnchor, /!\[\[001-Attachments\/~breezetts\/breeze-foundations-1\.wav\]\]$/);
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
	const pending = renderPlacements(
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

	const completedSubagent = renderPlacements(
		"> [!abstract] PI\n\nA concept depends on its foundation.",
		[
			{ id: "session", type: "session" },
			{
				id: "dispatched",
				parentId: "session",
				type: "custom",
				customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
				data: {
					...base,
					status: "dispatched",
					agentId: "breeze-job-1",
				},
			},
			{
				id: "subagent-completed",
				parentId: "dispatched",
				type: "custom",
				customType: "subagents:record",
				data: {
					id: "breeze-job-1",
					status: "completed",
					result: "RESULT:\nstatus: success\nattachmentPath: 001-Attachments/~breezetts/breeze-foundations-1.wav",
				},
			},
		],
		notePath,
	);
	assert.match(completedSubagent, /A concept depends on its foundation\.\n\n%%pi-breeze-tts:e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7%%/);
	assert.doesNotMatch(completedSubagent, /!\[\[001-Attachments\/~breezetts\//);

	const completed = renderPlacements(
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
				transcriptDescription: "Foundations reveal hidden conceptual structure",
				transcript: "The complete spoken transcript.",
			},
		}],
		notePath,
	);
	assert.match(completed, /A concept depends on its foundation\.\n\n!\[\[001-Attachments\/~breezetts\/breeze-foundations-1\.wav\]\]/);
	assert.ok(completed.includes(renderAudioTranscriptCallout(
		"Foundations reveal hidden conceptual structure",
		"The complete spoken transcript.",
	)));
	assert.match(completed, /!\[\[001-Attachments\/~breezetts\/breeze-foundations-1\.wav\]\]\n\n> \[!quote\]- \*\*Transcript\*\*: Foundations reveal hidden conceptual structure/);

	const quotedAnchor = renderPlacements(
		'The quoted statement ends here. ”',
		[{ id: "session", type: "session" }, {
			id: "quoted-audio",
			parentId: "session",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: {
				...base,
				anchor: "The quoted statement ends here.",
				status: "placed",
				vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-2.wav",
				transcriptDescription: "Foundations reveal hidden conceptual structure",
				transcript: "The complete spoken transcript.",
			},
		}],
		notePath,
	);
	assert.ok(quotedAnchor.indexOf("”") < quotedAnchor.indexOf("![[001-Attachments/~breezetts/breeze-foundations-2.wav]]"));

	const legacyCompleted = renderPlacements(
		'The quoted statement ends here. ”',
		[
			{ id: "session", type: "session" },
			{
				id: "dispatched",
				parentId: "session",
				type: "custom",
				customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
				data: { ...base, status: "dispatched", agentId: "breeze-job-1" },
			},
			{
				id: "completed",
				parentId: "dispatched",
				type: "custom",
				customType: "subagents:record",
				data: {
					id: "breeze-job-1",
					status: "completed",
					result: 'RESULT:\nstatus: success\naudioDescription: Foundations reveal hidden conceptual structure\ntranscript: "The restored spoken transcript."',
				},
			},
			{
				id: "placed-legacy",
				parentId: "completed",
				type: "custom",
				customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
				data: {
					...base,
					anchor: "The quoted statement ends here.",
					status: "placed",
					agentId: "breeze-job-1",
					vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-3.wav",
				},
			},
		],
		notePath,
	);
	assert.ok(legacyCompleted.indexOf("”") < legacyCompleted.indexOf("![[001-Attachments/~breezetts/breeze-foundations-3.wav]]"));
	assert.ok(legacyCompleted.includes(renderAudioTranscriptCallout(
		"Foundations reveal hidden conceptual structure",
		"The restored spoken transcript.",
	)));

	const durableAudio = "![[001-Attachments/~breezetts/breeze-foundations-1.wav]]";
	const durableCallout = renderAudioTranscriptCallout(
		"Foundations reveal hidden conceptual structure",
		"The complete spoken transcript.",
	);
	const oldManaged = [
		"%% pi-md-log:start v1 %%",
		"A concept depends on its foundation.",
		"",
		durableAudio,
		"",
		durableCallout,
		"%% pi-md-log:end v1 %%",
	].join("\n");
	const regeneratedWithPendingMarker = replaceManagedTranscript(
		oldManaged,
		"A concept depends on its foundation.\n\n%%pi-breeze-tts:e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7%%",
	);
	assert.ok(regeneratedWithPendingMarker.includes(durableAudio));
	assert.ok(regeneratedWithPendingMarker.includes(durableCallout));
	// replaceManagedTranscript cannot tell a stale marker from a brand-new request,
	// so it keeps the marker; applyPlacements drops it when the request is known.
	assert.match(regeneratedWithPendingMarker, /%%pi-breeze-tts:e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7%%/);

	const regeneratedWithoutCallout = replaceManagedTranscript(
		oldManaged,
		`A concept depends on its foundation.\n\n${durableAudio}`,
	);
	assert.ok(regeneratedWithoutCallout.includes(durableCallout), "md-log sync must preserve a durable transcript callout next to its audio embed");

	const stalePrevious = [
		"%% pi-md-log:start v1 %%",
		"An older concept sentence.",
		"",
		durableAudio,
		"",
		durableCallout,
		"%% pi-md-log:end v1 %%",
	].join("\n");
	const regeneratedAfterAnchorDisappears = replaceManagedTranscript(stalePrevious, "A new unrelated session transcript.");
	assert.ok(regeneratedAfterAnchorDisappears.includes(durableAudio));
	assert.ok(regeneratedAfterAnchorDisappears.includes(durableCallout), "durable audio and transcript are retained when source passage disappears");

	const cancelled = renderPlacements(
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

test("note audio carry-over keeps order, repairs a broken callout, and is idempotent", () => {
	const notePath = "C:\\vault\\lesson.md";
	const anchor = "Second test passage: “A single shared passage.”";
	const first = "![[001-Attachments/~breezetts/first-clip-1.wav]]";
	const second = "![[001-Attachments/~breezetts/second-clip-1.wav]]";
	const firstCallout = "> [!quote]- **Transcript**: First clip\n>\n> \"*First spoken text\\.*\"";
	// The second callout lost its closing emphasis/quote in an older sync.
	const secondCallout = "> [!quote]- **Transcript**: Second clip\n>\n> \"*Second spoken text\\.";
	const previous = [
		TRANSCRIPT_START,
		anchor,
		"",
		first,
		"",
		firstCallout,
		"",
		second,
		"",
		secondCallout,
		"*\"",
		TRANSCRIPT_END,
	].join("\n");

	const transcript = `> [!abstract] PI\n\n> ${anchor}`;
	const once = replaceManagedTranscript(previous, transcript);
	const managed = extractManagedTranscript(once);
	assert.ok(managed.indexOf(first) < managed.indexOf(second), "shared anchors keep their original order");
	assert.match(managed, /Second spoken text\\\.\*"/, "an unterminated callout is repaired");
	assert.equal(managed.split("\n").filter((line) => line.trim() === '*"').length, 0, "the orphaned closing marker is absorbed");
	assert.equal(replaceManagedTranscript(once, transcript), once, "carry-over is idempotent");
});

test("a pending marker is dropped once the note already holds that request's audio", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	const anchor = "A concept depends on its foundation.";
	const embed = "![[001-Attachments/~breezetts/breeze-foundations-1.wav]]";
	const previous = `${TRANSCRIPT_START}\n${anchor}\n\n${embed}\n${TRANSCRIPT_END}`;
	const entries = [
		{ id: "session", type: "session" },
		{ id: "msg", parentId: "session", type: "message", message: { role: "assistant", content: [{ type: "text", text: anchor }] } },
		{
			id: "placement",
			parentId: "msg",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { markerId, notePath, anchor, status: "dispatched" },
		},
	];
	const rendered = renderTranscript(applyPlacements(buildBackfill(entries).blocks, entries, notePath, previous));
	assert.doesNotMatch(rendered, /pi-breeze-tts:/);
	// The marker is gone, but the durable embed is carried back from the note.
	assert.equal(extractManagedTranscript(replaceManagedTranscript(previous, rendered)), `${rendered}\n\n${embed}`);
});

test("a placement entry anchors by session position, not by passage text", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	const entries = [
		{ id: "session", type: "session" },
		{ id: "first", parentId: "session", type: "message", message: { role: "assistant", content: [{ type: "text", text: "First passage." }] } },
		{ id: "second", parentId: "first", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Second passage." }] } },
		{
			id: "placement",
			parentId: "second",
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			// The recorded anchor text is stale and no longer matches the session.
			data: { markerId, notePath, anchor: "A passage that no longer exists.", status: "placed", vaultRelativePath: "001-Attachments/~breezetts/breeze-foundations-1.wav" },
		},
	];
	const blocks = buildBackfill(entries).blocks;
	const rendered = renderTranscript(applyPlacements(blocks, entries, notePath));
	assert.ok(rendered.indexOf("Second passage.") < rendered.indexOf("![[001-Attachments/~breezetts/breeze-foundations-1.wav]]"));
});

test("a new pending request keeps its marker next to an older embed on the same passage", () => {
	const notePath = "C:\\vault\\lesson.md";
	const anchor = "A concept depends on its foundation.";
	const embed = "![[001-Attachments/~breezetts/breeze-foundations-1.wav]]";
	const callout = "> [!quote]- **Transcript**: Foundations\n>\n> \"*Spoken text\\.*\"";
	const previous = `${TRANSCRIPT_START}\n${anchor}\n\n${embed}\n\n${callout}\n${TRANSCRIPT_END}`;
	const pendingId = "11111111-2222-3333-4444-555555555555";
	const transcript = `> [!abstract] PI\n\n> ${anchor}\n\n%%pi-breeze-tts:${pendingId}%%`;
	const updated = replaceManagedTranscript(previous, transcript);
	assert.ok(updated.includes(embed), "the durable embed survives");
	assert.ok(updated.includes(`%%pi-breeze-tts:${pendingId}%%`), "the pending marker survives");
});

test("a note-resident image embed survives a transcript rebuild", () => {
	const notePath = "C:\\vault\\lesson.md";
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const agentId = "image-job-1";
	const embed = "![[001-Attachments/~comfyui/comfyui-mushroom-cycle-1.png]]";
	const anchor = "Mushrooms release spores to restart the cycle.";
	const entries = [
		{ id: "session", type: "session" },
		{ id: "msg", parentId: "session", type: "message", message: { role: "assistant", content: [{ type: "text", text: anchor }] } },
		{
			id: "placement",
			parentId: "msg",
			type: "custom",
			customType: "teach-image-placement",
			data: { markerId, status: "dispatched", agentId, notePath, anchor, captionTitle: "Mushroom Spore Cycle", caption: "The cycle illustrates how a mature mushroom releases spores that begin new growth." },
		},
		{
			id: "subagent-complete",
			parentId: "placement",
			type: "custom",
			customType: "subagents:record",
			data: { id: agentId, status: "completed", result: "RESULT:\nstatus: success\nattachmentPath: 001-Attachments/~comfyui/comfyui-mushroom-cycle-1.png" },
		},
	];
	const quote = '> [!quote] Mushroom Spore Cycle\n> *"The cycle illustrates how a mature mushroom releases spores that begin new growth."*';
	const previous = `${TRANSCRIPT_START}\n${anchor}\n\n${quote}\n\n${embed}\n${TRANSCRIPT_END}`;

	// The image-maker writes its embed straight into the note, so the rebuild must
	// re-emit it rather than treating the note copy as a reason to skip the block.
	const rendered = renderPlacements(anchor, entries, notePath, previous);
	assert.match(rendered, new RegExp(`${anchor}\\n\\n> \\[!quote\\] Mushroom Spore Cycle`));
	assert.equal(rendered.match(/comfyui-mushroom-cycle-1\.png/g)?.length, 1);
	const updated = replaceManagedTranscript(previous, rendered);
	assert.equal(extractManagedTranscript(updated)?.match(/comfyui-mushroom-cycle-1\.png/g)?.length, 1);
	assert.equal(extractManagedTranscript(replaceManagedTranscript(updated, renderPlacements(anchor, entries, notePath, updated))), extractManagedTranscript(updated));
});

test("placements sharing one anchor render in session order", () => {
	const notePath = "C:\\vault\\lesson.md";
	const anchor = "A concept depends on its foundation.";
	const entries = [
		{ id: "session", type: "session" },
		{ id: "msg", parentId: "session", type: "message", message: { role: "assistant", content: [{ type: "text", text: anchor }] } },
	];
	const ids = [
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333",
	];
	let parentId = "msg";
	for (const markerId of ids) {
		entries.push({
			id: `placement-${markerId}`,
			parentId,
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { markerId, status: "dispatched", notePath, anchor },
		});
		parentId = `placement-${markerId}`;
	}

	const rendered = renderPlacements(anchor, entries, notePath);
	const positions = ids.map((markerId) => rendered.indexOf(`%%pi-breeze-tts:${markerId}%%`));
	assert.ok(positions.every((position) => position >= 0), "every placement renders");
	assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test("managed transcript replacement leaves a blank line before the end marker", () => {
	const note = `# Lesson\n\n${TRANSCRIPT_START}\nOld body\n${TRANSCRIPT_END}\n`;
	const updated = replaceManagedTranscript(note, "New body");
	assert.ok(updated.includes(`New body\n\n${TRANSCRIPT_END}`));
	assert.equal(extractManagedTranscript(updated), "New body");
});

test("linking pulls the managed section above authored prose so it can anchor placements", () => {
	const authored = ["---", "title: x", "---", "", "Alpha.", "", "Bravo.", "", TRANSCRIPT_START, "", TRANSCRIPT_END, "", "Trailing note.", ""].join("\n");
	const placed = placeManagedSectionAtTop(authored);
	assert.ok(placed.startsWith("---\ntitle: x\n---\n"));
	assert.ok(placed.indexOf(TRANSCRIPT_START) < placed.indexOf("Alpha."));
	assert.ok(placed.indexOf("Bravo.") < placed.indexOf(TRANSCRIPT_END));
	assert.ok(placed.indexOf(TRANSCRIPT_END) < placed.indexOf("Trailing note."));
	assert.equal((placed.match(/Alpha\./g) || []).length, 1);
	assert.equal(placeManagedSectionAtTop(placed), placed);

	const bare = placeManagedSectionAtTop("# Lesson\n\nKeep this.\n");
	assert.ok(bare.startsWith(TRANSCRIPT_START));
	assert.match(bare, /Keep this\.\n\n%% pi-md-log:end v1 %%/);
});

test("a carried-over transcript callout keeps a blank line before the next block", () => {
	const callout = renderAudioTranscriptCallout("Alpha read aloud", "Alpha.");
	const previous = [TRANSCRIPT_START, "", "Alpha.", "", "![[001-Attachments/~breezetts/a.wav]]", "", callout, "", TRANSCRIPT_END].join("\n");
	const rendered = ["Alpha.", "", "Bravo."].join("\n");
	const updated = replaceManagedTranscript(previous, rendered);
	const lines = updated.split("\n");
	const lastCallout = lines.findIndex((line) => line.startsWith("> \"*"));
	assert.ok(lastCallout > 0);
	assert.equal(lines[lastCallout + 1], "");
	assert.equal(lines[lastCallout + 2], "Bravo.");
	assert.equal(replaceManagedTranscript(updated, rendered), updated);
});

test("an imported note embed is not duplicated by the placement that re-emits it", () => {
	const notePath = "C:\\vault\\lesson.md";
	const anchor = "A caveat belongs next to the claim it qualifies.";
	const path = "001-Attachments/~comfyui/comfyui-caveat-1.png";
	const imported = [
		anchor,
		"",
		"> [!quote] Caveat",
		'> *"A caveat beside its claim."*',
		"",
		`![[${path}]]`,
	].join("\n");
	const entries = [
		{ id: "session", type: "session" },
		{ id: "import", parentId: "session", type: "custom", customType: "md-log-import", data: { file: notePath, markdown: imported } },
		{
			id: "placement",
			parentId: "import",
			type: "custom",
			customType: "teach-image-placement",
			data: { markerId: "m1", notePath, anchor, status: "placed", captionTitle: "Caveat", caption: "A caveat beside its claim.", vaultRelativePath: path },
		},
	];
	const rendered = renderTranscript(applyPlacements(buildBackfill(entries).blocks, entries, notePath));
	assert.equal((rendered.match(new RegExp(`!\\[\\[${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\]`, "g")) || []).length, 1);
	assert.equal((rendered.match(/> \[!quote\] Caveat/g) || []).length, 1);
	assert.ok(rendered.indexOf(anchor) < rendered.indexOf("![["));
});
