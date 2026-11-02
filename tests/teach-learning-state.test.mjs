import assert from "node:assert/strict";
import test from "node:test";
import {
	masteryEvidenceWeight,
	readMasteryFrontmatter,
	migrateMasteryFrontmatter,
	removeMasteryFrontmatter,
	readTeachingHistory,
	resolveTeachingResponse,
	updateMasteryFrontmatter,
	updateTeachingMastery,
} from "../lib/teach-learning-state.ts";

function responseEntry(id, parentId, interactionId, conceptId = "core-idea") {
	return {
		id,
		parentId,
		type: "custom",
		customType: "teach-free-response",
		data: {
			callId: `call-${interactionId}`,
			interactionId,
			question: "Explain the idea.",
			response: "A complete response.",
			conceptId,
		},
	};
}

function attemptEntry(id, parentId, interactionId, conceptId, outcome, previousMastery, newMastery) {
	return {
		id,
		parentId,
		type: "custom",
		customType: "teach-attempt",
		data: {
			callId: `attempt-${interactionId}`,
			interactionId,
			conceptId,
			outcome,
			explanation: "Recorded feedback.",
			previousMastery,
			newMastery,
			masteryState: {
				score: newMastery,
				evidenceCount: interactionId === "response-1" ? 2 : 3,
				evidenceWeight: 3,
				confidence: 5,
				lastInteractionId: interactionId,
			},
		},
	};
}

test("teaching history restores completed responses, one-time attempts, and latest mastery", () => {
	const history = readTeachingHistory([
		{ id: "root", type: "session" },
		responseEntry("response-1-entry", "root", "response-1"),
		attemptEntry("attempt-1-entry", "response-1-entry", "response-1", "core-idea", "partial", 0.2, 0.16),
		responseEntry("response-2-entry", "attempt-1-entry", "response-2"),
		attemptEntry("attempt-2-entry", "response-2-entry", "response-2", "core-idea", "correct", 0.16, 0.28),
		{ id: "unrelated", parentId: "attempt-2-entry", type: "custom", customType: "unrelated", data: {} },
	]);

	assert.equal(history.responses.get("response-1").response, "A complete response.");
	assert.ok(history.recordedInteractionIds.has("response-1"));
	assert.ok(history.recordedInteractionIds.has("response-2"));
	assert.equal(history.mastery.get("core-idea").score, 0.28);
	assert.equal(history.responses.size, 2);
});

test("teaching mastery waits for three samples, then caps each update at 25% of the remaining gap", () => {
	assert.equal(masteryEvidenceWeight(0), 0.8);
	assert.equal(masteryEvidenceWeight(5), 0.9);
	assert.equal(masteryEvidenceWeight(10), 1);
	const first = updateTeachingMastery(undefined, { interactionId: "first", score: 0, confidence: 5 });
	const second = updateTeachingMastery(first, { interactionId: "second", score: 10, confidence: 5 });
	assert.equal(first.score, undefined);
	assert.equal(second.score, undefined);
	assert.equal(second.evidenceCount, 2);
	const initialized = updateTeachingMastery(second, { interactionId: "third", score: 10, confidence: 5 });
	assert.equal(initialized.score, 6.67);
	assert.equal(initialized.evidenceCount, 3);
	assert.equal(initialized.evidenceWeight, 3);
	assert.throws(
		() => updateTeachingMastery(initialized, { interactionId: "third", score: 10, confidence: 5 }),
		/already the latest mastery sample/,
	);

	const updated = updateTeachingMastery({
		score: 2,
		evidenceCount: 3,
		evidenceWeight: 3,
		confidence: 5,
	}, { interactionId: "fourth", score: 10, confidence: 10 });
	assert.equal(updated.score, 4);
	assert.equal(Math.abs(updated.score - 2), (10 - 2) * 0.25);
	const nearTen = updateTeachingMastery({
		score: 9.99,
		evidenceCount: 3,
		evidenceWeight: 3,
		confidence: 5,
	}, { interactionId: "bounded", score: 0, confidence: 10 });
	assert.ok(nearTen.score <= 10);
	assert.ok(Math.abs(nearTen.score - 9.99) <= 9.99 * 0.25);
	assert.throws(() => updateTeachingMastery(undefined, { interactionId: "invalid", score: 11, confidence: 5 }), /score must be/);
	assert.throws(() => updateTeachingMastery(undefined, { interactionId: "invalid", score: 5, confidence: 11 }), /confidence must be/);
});

test("invalid session history is reported explicitly", () => {
	assert.throws(() => readTeachingHistory(null), /session entries were not an array/);
});

test("teaching history follows the active Pi branch rather than counting abandoned attempts", () => {
	const history = readTeachingHistory([
		{ id: "root", type: "session" },
		{ id: "old-response", parentId: "root", type: "custom", customType: "teach-free-response", data: {
			callId: "old-call",
			interactionId: "old-interaction",
			question: "Old question",
			response: "Old answer",
			conceptId: "core-idea",
		} },
		{ id: "old-attempt", parentId: "old-response", type: "custom", customType: "teach-attempt", data: {
			callId: "old-attempt-call",
			interactionId: "old-interaction",
			conceptId: "core-idea",
			outcome: "incorrect",
			explanation: "Old feedback.",
			previousMastery: 0.2,
			newMastery: 0.8,
		} },
		{ id: "active-response", parentId: "root", type: "custom", customType: "teach-free-response", data: {
			callId: "active-call",
			interactionId: "active-interaction",
			question: "Current question",
			response: "Current answer",
			conceptId: "core-idea",
		} },
	]);

	assert.equal(history.responses.size, 1);
	assert.ok(history.responses.has("active-interaction"));
	assert.equal(history.mastery.has("core-idea"), false);
	assert.equal(history.recordedInteractionIds.has("old-interaction"), false);
});

test("quiz results become mastery responses with their scratchpad and concept", () => {
	const history = readTeachingHistory([
		{ id: "root", type: "session" },
		{ id: "assistant", parentId: "root", type: "message", message: { role: "assistant", content: [{
			type: "toolCall",
			id: "quiz-call",
			name: "quiz",
			arguments: { question: "What is the principle?", conceptId: "core-idea", options: [{ label: "A" }, { label: "B" }] },
		}] } },
		{ id: "result", parentId: "assistant", type: "message", message: {
			role: "toolResult",
			toolName: "quiz",
			toolCallId: "quiz-call",
			details: {
				status: "answered",
				correct: false,
				conceptId: "core-idea",
				answers: [{ label: "B" }],
				scratchpad: "I was unsure whether B fit.",
			},
		} },
	]);
	const quiz = history.responses.get("quiz-call");
	assert.equal(quiz.source, "quiz");
	assert.equal(quiz.correct, false);
	assert.equal(quiz.conceptId, "core-idea");
	assert.equal(quiz.scratchpad, "I was unsure whether B fit.");
});

test("quiz interaction IDs resolve a unique Pi call prefix and reject ambiguous prefixes", () => {
	const interactionId = "call_mAlMvW6WvkPpYwOEi2PiUrZR|fc_07943d684e8d4e80016ae83621328887d1a7c8e7cdcad48dff";
	const first = {
		callId: interactionId,
		interactionId,
		source: "quiz",
		question: "What does the phrase mean?",
		response: "Option A",
	};
	const responses = new Map([[interactionId, first]]);

	assert.equal(resolveTeachingResponse(responses, interactionId), first);
	assert.equal(resolveTeachingResponse(responses, "call_mAlMvW6WvkPpYwOEi2PiUrZR"), first);
	assert.equal(resolveTeachingResponse(responses, "unrelated"), undefined);

	responses.set("call_mAlMvW6WvkPpYwOEi2PiUrZR|fc_another", {
		...first,
		callId: "call_mAlMvW6WvkPpYwOEi2PiUrZR|fc_another",
		interactionId: "call_mAlMvW6WvkPpYwOEi2PiUrZR|fc_another",
	});
	assert.throws(
		() => resolveTeachingResponse(responses, "call_mAlMvW6WvkPpYwOEi2PiUrZR"),
		/matches multiple quiz responses/,
	);
});

test("mastery frontmatter updates only its field and round-trips quoted keys and reasoning", () => {
	const original = [
		"---",
		"title: Learner note",
		"tags:",
		"  - study",
		"---",
		"",
		"Authored body remains untouched.",
	].join("\n");
	const record = {
		score: 6.67,
		evidenceCount: 3,
		evidenceWeight: 3,
		lastInteractionId: "attempt-1",
		confidence: 4,
		reasoningSummary: "I thought \"maybe\" because the evidence was unclear.",
	};
	const updated = updateMasteryFrontmatter(original, "core: idea", record);
	assert.match(updated, /^title: Learner note\n[\s\S]*^"mastery__core%3A%20idea__score": 6\.67$/m);
	assert.match(updated, /^"mastery__core%3A%20idea__reasoning-summary": "I thought \\"maybe\\" because the evidence was unclear\."$/m);
	assert.ok(updated.endsWith("Authored body remains untouched."));
	assert.deepEqual(readMasteryFrontmatter(updated).get("core: idea"), record);
	assert.equal(updateMasteryFrontmatter(updated, "core: idea", { ...record, evidenceCount: 2 }), updated);

	const existingMasteryNote = [
		"---",
		"title: Existing metadata",
		"mastery:",
		'  "core: idea":',
		"    score: 6",
		"    evidence_count: 3",
		"    evidence_weight: 3",
		"    confidence: 5",
		"other_field: preserve exactly",
		"---",
		"",
		"Body stays exactly the same.",
	].join("\n");
	const revisedMastery = updateMasteryFrontmatter(existingMasteryNote, "core: idea", {
		...record,
		score: 7.25,
		evidenceCount: 4,
		evidenceWeight: 3.9,
	});

	test("removing one mastery ID preserves other frontmatter and note content", () => {
		const original = [
			"---",
			"title: Keep this title",
			'"mastery__old-concept__score": 7',
			'"mastery__old-concept__evidence-count": 3',
			'"mastery__current-concept__score": 8',
			'"mastery__current-concept__evidence-count": 4',
			"tags:",
			"  - preserve",
			"---",
			"",
			"Authored note body stays unchanged.",
		].join("\n");
		const updated = removeMasteryFrontmatter(original, "old-concept");
		assert.doesNotMatch(updated, /mastery__old-concept__/);
		assert.match(updated, /mastery__current-concept__score": 8/);
		assert.match(updated, /^title: Keep this title$/m);
		assert.match(updated, /^  - preserve$/m);
		assert.ok(updated.endsWith("Authored note body stays unchanged."));
		assert.equal(removeMasteryFrontmatter(updated, "missing-concept"), updated);
	});
	assert.match(revisedMastery, /^title: Existing metadata\n"mastery__core%3A%20idea__score": 7\.25\n"mastery__core%3A%20idea__evidence-count": 4\n"mastery__core%3A%20idea__evidence-weight": 3\.9\n"mastery__core%3A%20idea__last-interaction-id": "attempt-1"\n"mastery__core%3A%20idea__confidence": 4\n"mastery__core%3A%20idea__reasoning-summary": "I thought \\"maybe\\" because the evidence was unclear\."\nother_field: preserve exactly$/m);
	assert.ok(revisedMastery.endsWith("\n\nBody stays exactly the same."));
	assert.equal(readMasteryFrontmatter(revisedMastery).get("core: idea").score, 7.25);

	const withoutFrontmatter = updateMasteryFrontmatter("# A note\n\nBody.", "core", {
		evidenceCount: 1,
		evidenceWeight: 0.9,
		evidenceSum: 4.5,
		confidence: 5,
	});
	assert.match(withoutFrontmatter, /^---\n"mastery__core__evidence-count": 1/);
	assert.ok(withoutFrontmatter.endsWith("# A note\n\nBody."));

	const crlf = "---\r\ntitle: CRLF note\r\naliases:\r\n  - First\r\n---\r\n\r\nBody.";
	const withMastery = updateMasteryFrontmatter(crlf, "science", {
		score: 7,
		evidenceCount: 3,
		evidenceWeight: 3,
		lastInteractionId: "crlf-attempt",
		confidence: 5,
	});
	assert.match(withMastery, /^title: CRLF note\r\naliases:\r\n  - First\r\n"mastery__science__score": 7/m);
	assert.ok(withMastery.endsWith("\r\n\r\nBody."));
});

test("legacy mastery frontmatter migrates to readable scalar Obsidian properties", () => {
	const original = [
		"---",
		"title: Bird notes",
		"mastery:",
		'  "bird-digestive-tract-order":',
		"    evidence_count: 1",
		"    evidence_weight: 0.9",
		"    evidence_sum: 0",
		"    last_interaction_id: call_example",
		"    confidence: 5",
		"    reasoning_summary: Selected the gizzard order.",
		"tags:",
		"  - biology",
		"---",
		"",
		"Authored note body.",
	].join("\n");
	const migrated = migrateMasteryFrontmatter(original);
	assert.match(migrated, /^title: Bird notes\n"mastery__bird-digestive-tract-order__evidence-count": 1/m);
	assert.match(migrated, /^"mastery__bird-digestive-tract-order__reasoning-summary": "Selected the gizzard order\."/m);
	assert.match(migrated, /^tags:\n  - biology$/m);
	assert.doesNotMatch(migrated, /^mastery:$/m);
	assert.deepEqual(readMasteryFrontmatter(migrated).get("bird-digestive-tract-order"), {
		evidenceCount: 1,
		evidenceWeight: 0.9,
		evidenceSum: 0,
		lastInteractionId: "call_example",
		confidence: 5,
		reasoningSummary: "Selected the gizzard order.",
	});
	assert.ok(migrated.endsWith("Authored note body."));
	assert.equal(migrateMasteryFrontmatter(migrated), migrated);

	const quotedConcept = updateMasteryFrontmatter("---\ntitle: Quoted\n---\nBody.", "core: idea", {
		evidenceCount: 1,
		evidenceWeight: 0.9,
		confidence: 5,
	});
	assert.deepEqual(readMasteryFrontmatter(quotedConcept).get("core: idea"), {
		evidenceCount: 1,
		evidenceWeight: 0.9,
		confidence: 5,
	});
});
