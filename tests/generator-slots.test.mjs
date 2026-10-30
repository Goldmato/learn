import assert from "node:assert/strict";
import test from "node:test";
import registerGeneratorSlots from "../extensions/generator-slots.ts";
import {
	acquireGeneratorSlot,
	generatorLimit,
	generatorSlotStatus,
	isGeneratorAgentType,
} from "../lib/generator-slots.ts";

function createFixture() {
	const handlers = new Map();
	const eventHandlers = new Map();
	const notifications = [];
	const pi = {
		events: {
			on(event, handler) { eventHandlers.set(event, handler); return () => eventHandlers.delete(event); },
			emit(event, payload) { return eventHandlers.get(event)?.(payload); },
		},
		on(event, handler) { handlers.set(event, handler); },
		registerCommand(name, options) { handlers.set(`command:${name}`, options.handler); },
	};
	registerGeneratorSlots(pi);
	const ctx = { signal: undefined, ui: { notify: (message) => notifications.push(message) } };
	const call = (toolCallId, subagent_type, extra = {}) =>
		handlers.get("tool_call")({ type: "tool_call", toolName: "Agent", toolCallId, input: { subagent_type, ...extra } }, ctx);
	const result = (toolCallId, subagent_type, extra = {}, isError = false) =>
		handlers.get("tool_result")({ type: "tool_result", toolName: "Agent", toolCallId, input: { subagent_type, ...extra }, isError });
	const reset = () => handlers.get("session_shutdown")();
	return { handlers, eventHandlers, notifications, call, result, reset };
}

/** Drain the microtask queue so queued acquisitions settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("generator limit defaults to two and honours the environment override", () => {
	const previous = process.env.PI_GENERATOR_CONCURRENCY;
	try {
		delete process.env.PI_GENERATOR_CONCURRENCY;
		assert.equal(generatorLimit(), 2);
		process.env.PI_GENERATOR_CONCURRENCY = "5";
		assert.equal(generatorLimit(), 5);
		process.env.PI_GENERATOR_CONCURRENCY = "0";
		assert.equal(generatorLimit(), 1);
		process.env.PI_GENERATOR_CONCURRENCY = "99";
		assert.equal(generatorLimit(), 8);
		process.env.PI_GENERATOR_CONCURRENCY = "nonsense";
		assert.equal(generatorLimit(), 2);
	} finally {
		if (previous === undefined) delete process.env.PI_GENERATOR_CONCURRENCY;
		else process.env.PI_GENERATOR_CONCURRENCY = previous;
	}
});

test("only generator subagent types are gated", () => {
	for (const type of ["breeze-tts-maker", "comfyui-image-maker", "mermaid-maker", "svg-maker"]) {
		assert.ok(isGeneratorAgentType(type), type);
	}
	for (const type of ["researcher", "mastery-critic-google", "curriculum-orchestrator"]) {
		assert.ok(!isGeneratorAgentType(type), type);
	}
	assert.ok(!isGeneratorAgentType(undefined));
});

test("a third generator waits until a slot frees, and non-generators never wait", async () => {
	process.env.PI_GENERATOR_CONCURRENCY = "2";
	const fixture = createFixture();
	try {
		await fixture.call("a", "breeze-tts-maker");
		await fixture.call("b", "comfyui-image-maker");
		assert.equal(generatorSlotStatus().active, 2);

		let thirdDone = false;
		const third = fixture.call("c", "mermaid-maker").then(() => { thirdDone = true; });
		await settle();
		assert.equal(thirdDone, false, "the third generator is queued");
		assert.equal(generatorSlotStatus().waiting, 1);
		assert.match(fixture.notifications.join("\n"), /Waiting for a free generator slot \(mermaid-maker\)/);

		// A non-generator dispatch is never gated.
		await fixture.call("d", "researcher");
		assert.equal(generatorSlotStatus().active, 2);

		// Completing one generator frees exactly one slot.
		fixture.eventHandlers.get("subagents:completed")({ type: "breeze-tts-maker", id: "job-a" });
		await third;
		assert.equal(thirdDone, true);
		assert.equal(generatorSlotStatus().active, 2);
	} finally {
		fixture.reset();
		delete process.env.PI_GENERATOR_CONCURRENCY;
	}
});

test("an errored dispatch releases its slot immediately", async () => {
	const fixture = createFixture();
	try {
		await fixture.call("a", "svg-maker");
		assert.equal(generatorSlotStatus().active, 1);
		fixture.result("a", "svg-maker", {}, true);
		assert.equal(generatorSlotStatus().active, 0);
	} finally {
		fixture.reset();
	}
});

test("a foreground dispatch releases on its result, a background one on completion", async () => {
	const fixture = createFixture();
	try {
		await fixture.call("fg", "svg-maker", { run_in_background: false });
		fixture.result("fg", "svg-maker", { run_in_background: false });
		assert.equal(generatorSlotStatus().active, 0);

		await fixture.call("bg", "breeze-tts-maker", { run_in_background: true });
		fixture.result("bg", "breeze-tts-maker", { run_in_background: true });
		assert.equal(generatorSlotStatus().active, 1, "a background job keeps its slot");
		fixture.eventHandlers.get("subagents:failed")({ type: "breeze-tts-maker", id: "job-bg" });
		assert.equal(generatorSlotStatus().active, 0);
	} finally {
		fixture.reset();
	}
});

test("shutdown releases every held slot", async () => {
	const fixture = createFixture();
	try {
		await fixture.call("a", "mermaid-maker");
		await fixture.call("b", "svg-maker");
		assert.equal(generatorSlotStatus().active, 2);
		fixture.handlers.get("session_shutdown")();
		assert.equal(generatorSlotStatus().active, 0);
	} finally {
		fixture.reset();
	}
});

test("an aborted waiter leaves the queue without consuming a slot", async () => {
	process.env.PI_GENERATOR_CONCURRENCY = "1";
	try {
		const release = await acquireGeneratorSlot();
		const controller = new AbortController();
		const queued = acquireGeneratorSlot(controller.signal);
		assert.equal(generatorSlotStatus().waiting, 1);
		controller.abort();
		await assert.rejects(queued, /Cancelled while waiting/);
		assert.equal(generatorSlotStatus().waiting, 0);
		release();
		assert.equal(generatorSlotStatus().active, 0);
	} finally {
		delete process.env.PI_GENERATOR_CONCURRENCY;
	}
});

test("the status command reports usage and the configured limit", async () => {
	process.env.PI_GENERATOR_CONCURRENCY = "3";
	const fixture = createFixture();
	try {
		await fixture.call("a", "svg-maker");
		fixture.handlers.get("command:generator-slots")({ ui: { notify: (message) => fixture.notifications.push(message) } });
		assert.match(fixture.notifications.at(-1), /Generator slots: 1\/3 in use\./);
	} finally {
		fixture.reset();
		delete process.env.PI_GENERATOR_CONCURRENCY;
	}
});
