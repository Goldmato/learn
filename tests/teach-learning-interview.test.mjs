import assert from "node:assert/strict";
import test from "node:test";
import {
	hasCompletedSessionIntake,
	normalizeLearningInterviewQuestions,
} from "../lib/learning-interview.ts";

test("learning interview validates three to five distinct open-ended prompts", () => {
	assert.deepEqual(normalizeLearningInterviewQuestions([
		" What sparked your interest? ",
		"Which part are you most curious about?",
		"What would you like to understand or do?",
	]), [
		"What sparked your interest?",
		"Which part are you most curious about?",
		"What would you like to understand or do?",
	]);
	assert.equal(normalizeLearningInterviewQuestions([
		"One", "Two", "Three", "Four", "Five",
	]).length, 5);
	assert.throws(() => normalizeLearningInterviewQuestions(["One", "Two"]), /3 to 5 questions/);
	assert.throws(() => normalizeLearningInterviewQuestions(["One", "Two", "Three", "Four", "Five", "Six"]), /3 to 5 questions/);
	assert.throws(() => normalizeLearningInterviewQuestions(["One", " ", "Three"]), /non-whitespace text/);
	assert.throws(() => normalizeLearningInterviewQuestions(["One", " two ", "ONE"]), /must be distinct/);
});

test("only a completed session-intake interview prevents another intake", () => {
	assert.equal(hasCompletedSessionIntake([
		{ type: "custom", customType: "teach-learning-interview", data: { status: "answered", purpose: "session-intake" } },
	]), true);
	assert.equal(hasCompletedSessionIntake([
		{ type: "custom", customType: "teach-learning-interview", data: { status: "answered", purpose: "post-assessment" } },
		{ type: "custom", customType: "teach-learning-interview", data: { status: "cancelled", purpose: "session-intake" } },
	]), false);
	assert.equal(hasCompletedSessionIntake([
		{ type: "custom", customType: "teach-learning-interview", data: null },
		{ type: "message", text: "not an interview" },
	]), false);
});
