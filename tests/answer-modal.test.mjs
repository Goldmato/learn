import assert from "node:assert/strict";
import test from "node:test";
import {
	cancelAnswerModal,
	clearAnswerModal,
	resumeAnswerModal,
	suspendAnswerModal,
	trackAnswerModal,
} from "../lib/answer-modal.ts";

test("suspended answer modal can be explicitly resumed", () => {
	const calls = [];
	const handle = {
		setHidden(hidden) { calls.push(["hidden", hidden]); },
		focus() { calls.push(["focus"]); },
	};

	trackAnswerModal(handle);
	assert.equal(resumeAnswerModal(), false);
	assert.equal(suspendAnswerModal(handle), true);
	assert.equal(resumeAnswerModal(), true);
	assert.deepEqual(calls, [["hidden", true], ["hidden", false], ["focus"]]);
	assert.equal(resumeAnswerModal(), false);
	clearAnswerModal(handle);
});

test("suspension requires a live overlay handle and stale handles cannot clear a newer modal", () => {
	const calls = [];
	const first = { setHidden(hidden) { calls.push(["first", hidden]); }, focus() {} };
	const second = { setHidden(hidden) { calls.push(["second", hidden]); }, focus() {} };

	assert.equal(suspendAnswerModal(undefined), false);
	trackAnswerModal(first);
	assert.equal(suspendAnswerModal(first), true);
	trackAnswerModal(second);
	assert.equal(suspendAnswerModal(second), true);
	clearAnswerModal(first);
	assert.equal(resumeAnswerModal(), true);
	assert.deepEqual(calls, [["first", true], ["second", true], ["second", false]]);
	clearAnswerModal(second);
});

test("end-lesson captures an active dialog snapshot before cancelling it", () => {
	const calls = [];
	const handle = {
		setHidden(hidden) { calls.push(["hidden", hidden]); },
		focus() {},
	};
	trackAnswerModal(handle, {
		snapshot: () => JSON.stringify({ question: "Pending quiz", selected: ["Option B"] }),
		cancel() {
			calls.push(["cancel"]);
			clearAnswerModal(handle);
		},
	});

	assert.equal(cancelAnswerModal(), '{"question":"Pending quiz","selected":["Option B"]}');
	assert.deepEqual(calls, [["cancel"]]);
	assert.equal(cancelAnswerModal(), undefined);
});
