import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuizOptions, shuffleQuizOptions } from "../lib/quiz-options.ts";

test("quiz options accept counts from four through eight", () => {
	for (const count of [4, 5, 6, 7, 8]) {
		const options = Array.from({ length: count }, (_value, index) => ({ label: `Option ${index + 1}` }));
		assert.equal(normalizeQuizOptions(options).length, count);
	}
});

test("quiz options reject counts outside four through eight after empty labels are removed", () => {
	for (const count of [0, 3, 9]) {
		const options = Array.from({ length: count }, (_value, index) => ({ label: `Option ${index + 1}` }));
		assert.throws(() => normalizeQuizOptions(options), /between 4 and 8/);
	}
	assert.throws(() => normalizeQuizOptions([
		{ label: "Option 1" },
		{ label: "Option 2" },
		{ label: "Option 3" },
		{ label: " " },
	]), /between 4 and 8/);
});

test("quiz option normalization rejects duplicate values", () => {
	assert.throws(() => normalizeQuizOptions([
		{ label: "One", value: "same" },
		{ label: "Two", value: "same" },
		{ label: "Three" },
		{ label: "Four" },
	]), /duplicate option value/);
});

test("quiz options shuffle without mutating the authored order", () => {
	const options = normalizeQuizOptions(Array.from({ length: 4 }, (_value, index) => ({ label: `Option ${index + 1}` })));
	const originalValues = options.map((option) => option.value);
	const previousRandom = Math.random;
	try {
		Math.random = () => 0;
		const shuffled = shuffleQuizOptions(options);
		assert.deepEqual(shuffled.map((option) => option.value).sort(), [...originalValues].sort());
		assert.notDeepEqual(shuffled.map((option) => option.value), originalValues);
		assert.deepEqual(options.map((option) => option.value), originalValues);
	} finally {
		Math.random = previousRandom;
	}
});
