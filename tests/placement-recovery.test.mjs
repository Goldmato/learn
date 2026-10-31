import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	isPlacementAnchorReconciled,
	placementAnchorMarker,
	placementRecoveryAction,
	placementRecoveryChoices,
	removePlacementAnchorMarker,
	rawPlacementOutput,
} from "../lib/placement-recovery.ts";
import {
	insertImagePlaceholder,
	removeImagePlaceholder,
} from "../lib/teach-image-attachment.ts";
import {
	recoverUnresolvedPlacement,
	writePlacementDiagnostic,
} from "../lib/placement-recovery-ui.ts";

const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
const metadata = {
	markerId,
	generator: "image-maker",
	kind: "image",
	status: "unresolved",
	notePath: "C:\\vault\\lesson.md",
};

test("malformed or unrecognized output remains unresolved by default", async () => {
	const choices = [];
	let removed = false;
	const ctx = {
		ui: {
			notify() {},
			async select(_title, options) {
				choices.push(options);
				return "Keep marker unresolved";
			},
		},
	};
	const note = `Authored text. %%pi-comfyui-image:${markerId}%% More authored text.`;
	await recoverUnresolvedPlacement(ctx, metadata, { result: "not a recognized result block" }, {
		remove() { removed = true; },
		writeDiagnostic: () => "C:\\Temp\\diagnostic.json",
	});

	assert.equal(removed, false);
	assert.match(note, /Authored text\./);
	assert.match(rawPlacementOutput({ result: "not a recognized result block" }), /not a recognized result block/);
	assert.deepEqual(choices[0], placementRecoveryChoices(false));
	assert.equal(placementRecoveryAction(undefined, false), "keep");
	assert.equal(placementRecoveryAction("Retry this request", false), "keep");
});

test("explicit removal removes only the marker and preserves adjacent authored content", async () => {
	const notePath = path.join(os.tmpdir(), `placement-recovery-${markerId}.md`);
	fs.writeFileSync(notePath, `Before %%pi-comfyui-image:${markerId}%% after.`, "utf-8");
	try {
		const ctx = {
			ui: {
				notify() {},
				async select() { return "Remove this marker"; },
			},
		};
		await recoverUnresolvedPlacement(ctx, metadata, { result: "unrecognized output" }, {
			remove() {
				removeImagePlaceholder(notePath, markerId);
			},
			writeDiagnostic: () => "C:\\Temp\\diagnostic.json",
		});
		assert.equal(fs.readFileSync(notePath, "utf-8"), "Before  after.");
	} finally {
		fs.rmSync(notePath, { force: true });
	}
	fs.rmSync(notePath, { force: true });
});

test("diagnostic stores sanitized metadata and the complete returned output in OS temp", () => {
	const output = "unexpected output\nwith all returned text";
	const filePath = writePlacementDiagnostic({ ...metadata, markerId: `${markerId}\nunsafe` }, output);
	try {
		assert.equal(path.isAbsolute(filePath), true);
		assert.equal(path.dirname(filePath), os.tmpdir());
		const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		assert.equal(saved.metadata.markerId, `${markerId} unsafe`);
		assert.equal(saved.metadata.noteName, "lesson.md");
		assert.equal(saved.generatorOutput, output);
	} finally {
		fs.rmSync(filePath, { force: true });
	}
});

test("diagnostic write failure is reported without removing the marker", async () => {
	let selected = false;
	let removed = false;
	const notifications = [];
	const ctx = {
		ui: {
			notify(message) { notifications.push(message); },
			async select() { selected = true; return "Keep marker unresolved"; },
		},
	};
	await recoverUnresolvedPlacement(ctx, metadata, { result: "no output" }, {
		remove() { removed = true; },
		writeDiagnostic() { throw new Error("disk full"); },
	});
	assert.equal(selected, true);
	assert.equal(removed, false);
	assert.ok(notifications.some((message) => message.includes("Could not write the placement diagnostic")));
});

test("raw output is shown before returning to the recovery decision", async () => {
	const titles = [];
	const decisions = ["Show raw returned text", "Return to placement recovery", "Keep marker unresolved"];
	await recoverUnresolvedPlacement({
		ui: {
			notify() {},
			async select(title) {
				titles.push(title);
				return decisions.shift();
			},
		},
	}, metadata, { result: "complete raw generator text" }, {
		remove() {},
		writeDiagnostic: () => "C:\\Temp\\diagnostic.json",
	});
	assert.equal(titles.length, 3);
	assert.match(titles[1], /complete raw generator text/);
});

test("retry is offered only for durable Breeze state and is scoped to the current marker", async () => {
	assert.ok(placementRecoveryChoices(true).some((choice) => choice.startsWith("Retry")));
	assert.ok(!placementRecoveryChoices(false).some((choice) => choice.startsWith("Retry")));
	assert.equal(placementRecoveryAction("Retry this request", true), "retry");
	let retried = false;
	const decisions = ["Retry this request", "Keep marker unresolved"];
	await recoverUnresolvedPlacement({
		ui: { notify() {}, async select(_title, options) {
			const choice = decisions.shift();
			if (choice.startsWith("Retry")) assert.ok(options.some((option) => option.startsWith("Retry")));
			return choice;
		} },
	}, { ...metadata, generator: "breeze-tts", kind: "audio" }, { result: "malformed output" }, {
		canRetry: true,
		remove() {},
		async retry() {
			retried = true;
			await recoverUnresolvedPlacement({
				ui: { notify() {}, async select() { return decisions.shift(); } },
			}, { ...metadata, generator: "breeze-tts", kind: "audio" }, { result: "second malformed output" }, {
				canRetry: true,
				remove() {},
				retry() {},
				writeDiagnostic: () => "C:\\Temp\\diagnostic.json",
			});
		},
		writeDiagnostic: () => "C:\\Temp\\diagnostic.json",
	});
	assert.equal(retried, true);
});

test("anchor reconciliation rejects missing and displaced anchors", () => {
	const marker = `%%pi-comfyui-image:${markerId}%%`;
	const valid = `%% pi-md-log:start v1 %%\nAnchor sentence.\n${marker}\n%% pi-md-log:end v1 %%`;
	assert.equal(isPlacementAnchorReconciled(valid, "Anchor sentence.", marker), true);
	assert.equal(isPlacementAnchorReconciled(valid.replace("Anchor sentence.", "Changed sentence."), "Anchor sentence.", marker), false);
	const displaced = `%% pi-md-log:start v1 %%\n${marker}\nAnchor sentence.\n%% pi-md-log:end v1 %%`;
	assert.equal(isPlacementAnchorReconciled(displaced, "Anchor sentence.", marker), false);
});

test("stable anchor IDs distinguish repeated text and fall back only when text is unique", () => {
	const anchor = "Anchor sentence.";
	const anchorId = "64e2a2eb-5d4d-4987-89df-5bed565d0c87";
	const anchorMarker = placementAnchorMarker(anchorId, markerId);
	const marker = `%%pi-comfyui-image:${markerId}%%`;
	const start = "%% pi-md-log:start v1 %%";
	const end = "%% pi-md-log:end v1 %%";
	const valid = `${start}\n${anchor}\n\n${anchor} ${anchorMarker}\n${marker}\n${end}`;
	assert.equal(isPlacementAnchorReconciled(valid, anchor, marker, anchorMarker), true);

	const displaced = `${start}\n${anchor} ${anchorMarker}\n\n${anchor}\n${marker}\n${end}`;
	assert.equal(isPlacementAnchorReconciled(displaced, anchor, marker, anchorMarker), false);

	const missingIdUnique = `${start}\n${anchor}\n${marker}\n${end}`;
	assert.equal(isPlacementAnchorReconciled(missingIdUnique, anchor, marker, anchorMarker), true);
	const missingIdRepeated = `${start}\n${anchor}\n\n${anchor}\n${marker}\n${end}`;
	assert.equal(isPlacementAnchorReconciled(missingIdRepeated, anchor, marker, anchorMarker), false);

	const duplicatedIdUnique = `${start}\n${anchor} ${anchorMarker}\n${anchorMarker}\n${marker}\n${end}`;
	assert.equal(isPlacementAnchorReconciled(duplicatedIdUnique, anchor, marker, anchorMarker), true);
	assert.equal(removePlacementAnchorMarker(valid, markerId), valid.replace(anchorMarker, ""));
});

test("removing a generated placeholder also removes its anchor ID", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "placement-anchor-"));
	const notePath = path.join(root, "lesson.md");
	const anchor = "Anchor sentence.";
	const anchorId = "64e2a2eb-5d4d-4987-89df-5bed565d0c87";
	fs.writeFileSync(notePath, `%% pi-md-log:start v1 %%\n${anchor}\n%% pi-md-log:end v1 %%`, "utf-8");
	try {
		insertImagePlaceholder(notePath, markerId, anchor, anchorId);
		removeImagePlaceholder(notePath, markerId);
		const note = fs.readFileSync(notePath, "utf-8");
		assert.doesNotMatch(note, new RegExp(anchorId));
		assert.doesNotMatch(note, new RegExp(markerId));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
