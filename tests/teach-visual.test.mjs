import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerVisualTool from "../extensions/teach-visual.ts";
import registerVisualAttachment from "../agents/extensions/teach-visual-attachment.ts";
import {
	applyPlacements,
	buildBackfill,
	renderTranscript,
	TEACH_VISUAL_PLACEMENT_ENTRY,
	visualMarker,
} from "../lib/md-log-format.ts";
import {
	insertVisualPlaceholder,
	removeVisualPlaceholder,
	replaceVisualPlaceholder,
	validatePublishedVisual,
} from "../lib/teach-visual-attachment.ts";

const MARKER_ID = "3f2a1b40-9c8d-4e7f-8a1b-2c3d4e5f6a7b";

function createVisualFixture(agentOutcome = {
	isError: false,
	result: {
		content: [{ type: "text", text: "Agent started" }],
		details: { status: "background", agentId: "visual-job-1" },
	},
}, executeError) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-visual-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const entries = [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		{ id: "anchor", parentId: "mdlog", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Existing note text." }] } },
	];
	const toolCalls = [];
	const registeredTools = new Map();
	const handlers = new Map();
	const pi = {
		on(event, handler) { handlers.set(event, handler); },
		registerTool(definition) { registeredTools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nExisting note text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	registerVisualTool(pi);
	const ctx = {
		cwd: root,
		sessionManager: { getEntries: () => entries },
		executeTool: async (name, args, options) => {
			toolCalls.push({ name, args, options });
			if (executeError) throw executeError;
			const blocked = handlers.get("tool_call")?.({
				toolName: name,
				input: args,
				toolCallId: "visual/1",
				parentToolCallId: "visual",
			});
			if (blocked?.block) return { isError: true, result: { content: [{ type: "text", text: blocked.reason }] } };
			return agentOutcome;
		},
	};
	return { root, vaultRoot, notePath, entries, toolCalls, registeredTools, handlers, ctx };
}

function params(overrides = {}) {
	return {
		kind: "mermaid",
		brief: "Show how a condition gates a claim.",
		captionTitle: "Condition Gate",
		caption: "The flow shows the condition standing between the claim and its conclusion.",
		insertAfter: "Existing note text.",
		...overrides,
	};
}

test("teach_visual places a marker, records the placement, and dispatches the matching maker", async () => {
	const fixture = createVisualFixture();
	try {
		const tool = fixture.registeredTools.get("teach_visual");
		assert.ok(tool);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["kind", "brief", "captionTitle", "caption", "insertAfter"]);
		assert.equal(tool.parameters.additionalProperties, false);

		const result = await tool.execute("visual", params(), undefined, undefined, fixture.ctx);
		const note = fs.readFileSync(fixture.notePath, "utf-8");
		const markerId = /%%pi-visual:mermaid:([a-f0-9-]{36})%%/.exec(note)?.[1];
		assert.ok(markerId, "the note should carry a visible marker while the maker runs");
		assert.ok(note.indexOf(markerId) > note.indexOf("Existing note text."));
		assert.equal(result.details.status, "dispatched");
		assert.deepEqual(fixture.toolCalls.map((call) => call.name), ["Agent"]);
		const dispatch = fixture.toolCalls[0].args;
		assert.equal(dispatch.subagent_type, "mermaid-maker");
		assert.equal(dispatch.run_in_background, true);
		assert.equal(dispatch.inherit_context, false);
		assert.match(dispatch.prompt, new RegExp(`markerId: ${markerId}`));
		assert.match(dispatch.prompt, /teach_attach_generated_visual/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY &&
			entry.data.markerId === markerId &&
			entry.data.visualKind === "mermaid" &&
			entry.data.status === "dispatched" &&
			entry.data.anchor === "Existing note text.",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("teach_visual routes svg to the svg-maker", async () => {
	const fixture = createVisualFixture();
	try {
		await fixture.registeredTools.get("teach_visual").execute("visual", params({ kind: "svg" }), undefined, undefined, fixture.ctx);
		assert.equal(fixture.toolCalls[0].args.subagent_type, "svg-maker");
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /%%pi-visual:svg:/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("teach_visual blocks direct Agent launches of both makers", () => {
	const fixture = createVisualFixture();
	try {
		for (const type of ["mermaid-maker", "svg-maker"]) {
			assert.equal(fixture.handlers.get("tool_call")({
				toolName: "Agent",
				input: { subagent_type: type },
				toolCallId: "direct",
			}).block, true, type);
		}
		assert.equal(fixture.handlers.get("tool_call")({
			toolName: "Agent",
			input: { subagent_type: "researcher" },
			toolCallId: "research",
		}), undefined);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("teach_visual rejects an anchor that is not in the transcript without leaving a marker", async () => {
	const fixture = createVisualFixture();
	try {
		await assert.rejects(
			fixture.registeredTools.get("teach_visual").execute("visual", params({ insertAfter: "Absent sentence." }), undefined, undefined, fixture.ctx),
			/Visual insertion anchor must be exact text/,
		);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-visual:/);
		assert.deepEqual(fixture.toolCalls, []);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("teach_visual clears its marker when the dispatch fails", async () => {
	const fixture = createVisualFixture({
		isError: true,
		result: { content: [{ type: "text", text: "Agent unavailable" }] },
	});
	try {
		await assert.rejects(
			fixture.registeredTools.get("teach_visual").execute("visual", params(), undefined, undefined, fixture.ctx),
			/Agent unavailable/,
		);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /%%pi-visual:/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY && entry.data.status === "failed",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

function createAttachFixture(kind = "mermaid") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-visual-attach-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const folder = kind === "svg" ? "~svg" : "~mermaid";
	const publishedPath = path.join(vaultRoot, "001-Attachments", folder, `${kind}-topic-1.png`);
	const entries = [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		{
			id: "placement",
			parentId: "mdlog",
			type: "custom",
			customType: TEACH_VISUAL_PLACEMENT_ENTRY,
			data: { markerId: MARKER_ID, visualKind: kind, status: "dispatched", notePath, anchor: "Existing note text." },
		},
	];
	const tools = new Map();
	const pi = {
		registerTool(definition) { tools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(path.dirname(publishedPath), { recursive: true });
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nExisting note text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	fs.writeFileSync(publishedPath, Buffer.from("png bytes"));
	insertVisualPlaceholder(notePath, kind, MARKER_ID, "Existing note text.");
	registerVisualAttachment(pi);
	const ctx = { cwd: root, sessionManager: { getEntries: () => entries } };
	return { root, vaultRoot, notePath, publishedPath, folder, entries, tools, ctx };
}

test("the attach tool replaces the marker with a captioned embed", async () => {
	const fixture = createAttachFixture();
	try {
		const result = await fixture.tools.get("teach_attach_generated_visual").execute("attach", {
			kind: "mermaid",
			sourcePath: fixture.publishedPath,
			captionTitle: "Condition Gate",
			caption: "The flow shows the condition standing between the claim and its conclusion.",
			markerId: MARKER_ID,
			notePath: fixture.notePath,
		}, undefined, undefined, fixture.ctx);

		const note = fs.readFileSync(fixture.notePath, "utf-8");
		const relative = `001-Attachments/~mermaid/mermaid-topic-1.png`;
		assert.ok(note.includes(`![[${relative}]]`));
		assert.ok(note.includes("> [!quote] Condition Gate\n> *\"The flow shows the condition standing between the claim and its conclusion.\"*"));
		assert.doesNotMatch(note, /pi-visual:/);
		assert.equal(result.details.status, "placed");
		assert.equal(result.details.vaultRelativePath, relative);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY &&
			entry.data.status === "placed" &&
			entry.data.vaultRelativePath === relative &&
			entry.data.anchor === "Existing note text.",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("the attach tool is idempotent for an already placed picture", async () => {
	const fixture = createAttachFixture();
	try {
		const tool = fixture.tools.get("teach_attach_generated_visual");
		const args = {
			kind: "mermaid",
			sourcePath: fixture.publishedPath,
			captionTitle: "Condition Gate",
			caption: "The flow shows the condition.",
			markerId: MARKER_ID,
			notePath: fixture.notePath,
		};
		await tool.execute("attach", args, undefined, undefined, fixture.ctx);
		const once = fs.readFileSync(fixture.notePath, "utf-8");
		const again = await tool.execute("attach", args, undefined, undefined, fixture.ctx);
		assert.equal(fs.readFileSync(fixture.notePath, "utf-8"), once);
		assert.equal(again.details.status, "placed");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("the attach tool clears the marker when authoring failed", async () => {
	const fixture = createAttachFixture();
	try {
		await fixture.tools.get("teach_attach_generated_visual").execute("attach", {
			kind: "mermaid",
			markerId: MARKER_ID,
			notePath: fixture.notePath,
			error: "the brief is self-contradictory",
		}, undefined, undefined, fixture.ctx);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-visual:/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY && entry.data.status === "failed",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("the attach tool rejects a picture outside the maker's own attachment folder", async () => {
	const fixture = createAttachFixture();
	try {
		const stray = path.join(fixture.vaultRoot, "001-Attachments", "~svg", "stray.png");
		fs.mkdirSync(path.dirname(stray), { recursive: true });
		fs.writeFileSync(stray, Buffer.from("png"));
		await assert.rejects(
			fixture.tools.get("teach_attach_generated_visual").execute("attach", {
				kind: "mermaid",
				sourcePath: stray,
				captionTitle: "Stray",
				caption: "A stray picture.",
				markerId: MARKER_ID,
				notePath: fixture.notePath,
			}, undefined, undefined, fixture.ctx),
			/outside ~mermaid/,
		);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("placeholder helpers reject a non-PNG and an unknown kind", () => {
	const fixture = createAttachFixture();
	try {
		const txt = path.join(fixture.vaultRoot, "001-Attachments", "~mermaid", "note.txt");
		fs.writeFileSync(txt, "text");
		assert.throws(() => validatePublishedVisual(txt, fixture.vaultRoot, "mermaid"), /must be a PNG/);
		assert.throws(() => validatePublishedVisual(fixture.publishedPath, fixture.vaultRoot, "canvas"), /Unknown visual kind/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("removeVisualPlaceholder leaves the note untouched when the marker is gone", () => {
	const fixture = createAttachFixture();
	try {
		const before = fs.readFileSync(fixture.notePath, "utf-8");
		removeVisualPlaceholder(fixture.notePath, "mermaid", MARKER_ID);
		const after = fs.readFileSync(fixture.notePath, "utf-8");
		assert.doesNotMatch(after, /pi-visual:/);
		assert.ok(after.includes("Existing note text."));
		removeVisualPlaceholder(fixture.notePath, "mermaid", MARKER_ID);
		assert.equal(fs.readFileSync(fixture.notePath, "utf-8"), after);
		assert.notEqual(before, after);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("replaceVisualPlaceholder rejects a path outside the attachment folder", () => {
	const fixture = createAttachFixture();
	try {
		assert.throws(
			() => replaceVisualPlaceholder(fixture.notePath, "mermaid", MARKER_ID, "001-Attachments/~svg/x.png", "T", "C"),
			/Invalid published picture path/,
		);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

function placementEntries(notePath, data) {
	return [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		{ id: "anchor", parentId: "mdlog", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Anchor paragraph." }] } },
		{ id: "placement", parentId: "anchor", type: "custom", customType: TEACH_VISUAL_PLACEMENT_ENTRY, data },
	];
}

test("a placed visual renders as a callout and embed under its anchor", () => {
	const notePath = path.join(os.tmpdir(), "vault", "lesson.md");
	const blocks = [{ kind: "prose", role: "assistant", text: "Anchor paragraph.", entryId: "anchor" }];
	const entries = placementEntries(notePath, {
		markerId: MARKER_ID,
		visualKind: "mermaid",
		status: "placed",
		notePath,
		anchor: "Anchor paragraph.",
		captionTitle: "Condition Gate",
		caption: "The flow shows the condition.",
		vaultRelativePath: "001-Attachments/~mermaid/mermaid-topic-1.png",
	});
	const rendered = renderTranscript(applyPlacements(blocks, entries, notePath));
	assert.match(rendered, /Anchor paragraph\./);
	assert.match(rendered, /> \[!quote\] Condition Gate\n> \*"The flow shows the condition\."\*/);
	assert.match(rendered, /!\[\[001-Attachments\/~mermaid\/mermaid-topic-1\.png\]\]/);
	assert.ok(rendered.indexOf("Anchor paragraph.") < rendered.indexOf("Condition Gate"));
});

test("a pending visual renders its marker so the note shows work in progress", () => {
	const notePath = path.join(os.tmpdir(), "vault", "lesson.md");
	const blocks = [{ kind: "prose", role: "assistant", text: "Anchor paragraph.", entryId: "anchor" }];
	const entries = placementEntries(notePath, {
		markerId: MARKER_ID,
		visualKind: "svg",
		status: "dispatched",
		notePath,
		anchor: "Anchor paragraph.",
		captionTitle: "Triangle",
		caption: "A labelled triangle.",
	});
	const rendered = renderTranscript(applyPlacements(blocks, entries, notePath));
	assert.ok(rendered.includes(visualMarker("svg", MARKER_ID)));
});

test("failed and cancelled visual placements render nothing", () => {
	const notePath = path.join(os.tmpdir(), "vault", "lesson.md");
	const blocks = [{ kind: "prose", role: "assistant", text: "Anchor paragraph.", entryId: "anchor" }];
	for (const status of ["failed", "cancelled"]) {
		const entries = placementEntries(notePath, {
			markerId: MARKER_ID,
			visualKind: "mermaid",
			status,
			notePath,
			anchor: "Anchor paragraph.",
			captionTitle: "Gate",
			caption: "A gate.",
		});
		const rendered = renderTranscript(applyPlacements(blocks, entries, notePath));
		assert.doesNotMatch(rendered, /pi-visual:/, status);
		assert.doesNotMatch(rendered, /Gate/, status);
	}
});

test("visual placement entries are not echoed as metadata blocks", () => {
	const backfill = buildBackfill([
		{ id: "session", type: "session" },
		{ id: "placement", parentId: "session", type: "custom", customType: TEACH_VISUAL_PLACEMENT_ENTRY, data: { markerId: MARKER_ID, status: "placed" } },
	]);
	assert.deepEqual(backfill.diagnostics, []);
	assert.equal(backfill.blocks.length, 0);
});

test("both makers declare the attach tool and a status-shaped result block", () => {
	for (const [file, kind, folder] of [["mermaid-maker.md", "mermaid", "~mermaid"], ["svg-maker.md", "svg", "~svg"]]) {
		const source = fs.readFileSync(new URL(`../agents/${file}`, import.meta.url), "utf-8");
		const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
		assert.ok(frontmatter, file);
		assert.match(frontmatter, /ext:teach-visual-attachment\/teach_attach_generated_visual/, file);
		assert.match(frontmatter, /^inherit_context: false$/m, file);
		assert.match(source, new RegExp(`attachmentPath: 001-Attachments/${folder}/`), file);
		assert.match(source, /^status: success \| failure$/m, file);
		assert.match(source, new RegExp(`kind: "${kind}"`), file);
	}
});
