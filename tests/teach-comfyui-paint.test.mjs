import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerPaintTool from "../extensions/teach-comfyui-paint.ts";
import { TEACH_IMAGE_PLACEMENT_ENTRY } from "../lib/md-log-format.ts";

function createPaintFixture(agentOutcome = {
	isError: false,
	result: {
		content: [{ type: "text", text: "Agent started" }],
		details: { status: "background", agentId: "image-job-1" },
	},
}, executeError) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-comfyui-paint-"));
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
	const eventHandlers = new Map();
	const notifications = [];
	const pi = {
		events: {
			on(event, handler) { eventHandlers.set(event, handler); },
			emit(event, payload) { return eventHandlers.get(event)?.(payload); },
		},
		on(event, handler) { handlers.set(event, handler); },
		registerTool(definition) { registeredTools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nExisting note text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	registerPaintTool(pi);
	const ctx = {
		cwd: root,
		sessionManager: { getEntries: () => entries },
		ui: {
			notify(message) { notifications.push(message); },
			async select() { return "Keep marker unresolved"; },
		},
		executeTool: async (name, args, options) => {
			toolCalls.push({ name, args, options });
			if (executeError) throw executeError;
			const blocked = handlers.get("tool_call")?.({
				toolName: name,
				input: args,
				toolCallId: "paint/1",
				parentToolCallId: "paint",
			});
			if (blocked?.block) {
				return {
					isError: true,
					result: { content: [{ type: "text", text: blocked.reason }] },
				};
			}
			return agentOutcome;
		},
	};
	return { root, notePath, entries, toolCalls, registeredTools, handlers, eventHandlers, notifications, pi, ctx };
}

test("main paint tool accepts an image prompt and exact note anchor, then dispatches in background", async () => {
	const fixture = createPaintFixture();
	try {
		const tool = fixture.registeredTools.get("teach_comfyui_paint");
		assert.ok(tool);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["prompt", "captionTitle", "caption", "insertAfter"]);
		assert.equal(tool.parameters.additionalProperties, false);

		const result = await tool.execute("paint", {
			prompt: "An intricate, translucent 2.5D illustration of a plant cell",
			captionTitle: "Inside a Plant Cell",
			caption: "The cutaway shows how the membrane, nucleus, and chloroplasts support the cell's work.",
			insertAfter: "Existing note text.",
		}, undefined, undefined, fixture.ctx);

		const note = fs.readFileSync(fixture.notePath, "utf-8");
		const markerId = /%%pi-comfyui-image:([a-f0-9-]{36})%%/.exec(note)?.[1];
		assert.ok(markerId, "the note should contain a visible marker while the subagent runs");
		assert.ok(note.indexOf(markerId) > note.indexOf("Existing note text."));
		assert.match(note, new RegExp(`%%pi-placement-anchor:[a-f0-9-]{36}:${markerId}%%`));
		assert.ok(note.indexOf(`%%pi-comfyui-image:${markerId}%%`) > note.indexOf("Existing note text."));
		assert.equal(result.details.status, "dispatched");
		assert.deepEqual(fixture.toolCalls.map((call) => call.name), ["Agent"]);
		const dispatch = fixture.toolCalls[0].args;
		assert.equal(dispatch.subagent_type, "comfyui-image-maker");
		assert.equal(dispatch.run_in_background, true);
		assert.equal(dispatch.inherit_context, false);
		assert.equal(dispatch.model, undefined);
		assert.equal(result.details.agentId, "image-job-1");
		assert.equal(fixture.handlers.get("tool_call")({
			toolName: "Agent",
			input: { subagent_type: "comfyui-image-maker" },
			toolCallId: "direct-agent-call",
		}).block, true);
		assert.equal(fixture.handlers.get("tool_call")({
			toolName: "Agent",
			input: { subagent_type: "researcher" },
			toolCallId: "research-call",
		}), undefined);
		assert.match(dispatch.prompt, new RegExp(`markerId: ${markerId}`));
		assert.match(dispatch.prompt, new RegExp(`notePath: ${fixture.notePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(dispatch.prompt, /teach_attach_generated_image/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
			entry.data.markerId === markerId &&
			entry.data.status === "dispatched" &&
			typeof entry.data.anchorId === "string" &&
			entry.data.anchor === "Existing note text." &&
			entry.data.captionTitle === "Inside a Plant Cell" &&
			entry.data.caption === "The cutaway shows how the membrane, nucleus, and chloroplasts support the cell's work.",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("an unrecognized image-agent result keeps the marker and presents recovery", async () => {
	const fixture = createPaintFixture();
	let diagnosticPath;
	try {
		const result = await fixture.registeredTools.get("teach_comfyui_paint").execute(
			"paint",
			{ prompt: "A glowing leaf", captionTitle: "Photosynthesis", caption: "The leaf collects light.", insertAfter: "Existing note text." },
			undefined,
			undefined,
			fixture.ctx,
		);
		await fixture.pi.events.emit("subagents:completed", {
			id: result.details.agentId,
			type: "comfyui-image-maker",
			status: "completed",
			result: { content: [{ type: "text", text: "unrecognized generator output" }] },
		});
		const note = fs.readFileSync(fixture.notePath, "utf-8");
		const markerId = /%%pi-comfyui-image:([a-f0-9-]{36})%%/.exec(note)?.[1];
		assert.ok(markerId);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
			entry.data.markerId === markerId &&
			entry.data.status === "failed",
		));
		diagnosticPath = /Placement diagnostic saved to: (.+?)\. Forward/.exec(fixture.notifications.join("\n"))?.[1];
		assert.ok(diagnosticPath && fs.existsSync(diagnosticPath));
		assert.match(fs.readFileSync(diagnosticPath, "utf-8"), /unrecognized generator output/);
	} finally {
		if (diagnosticPath) fs.rmSync(diagnosticPath, { force: true });
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main paint tool rejects a note anchor that is not present before creating a marker or starting a job", async () => {
	const fixture = createPaintFixture();
	try {
		const tool = fixture.registeredTools.get("teach_comfyui_paint");
		await assert.rejects(
			tool.execute("paint", {
				prompt: "A glowing leaf",
				captionTitle: "Photosynthesis",
				caption: "The leaf collects light to power photosynthesis.",
				insertAfter: "This sentence is not in the note.",
			}, undefined, undefined, fixture.ctx),
			/Image insertion anchor must be exact text/,
		);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-comfyui-image:/);
		assert.deepEqual(fixture.toolCalls, []);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main paint tool preserves its marker and reports a subagent dispatch error", async () => {
	const fixture = createPaintFixture({
		isError: true,
		result: { content: [{ type: "text", text: "Agent unavailable" }] },
	});
	try {
		const tool = fixture.registeredTools.get("teach_comfyui_paint");
		await assert.rejects(
			tool.execute("paint", { prompt: "A glowing leaf", captionTitle: "Photosynthesis", caption: "The leaf collects light to power photosynthesis.", insertAfter: "Existing note text." }, undefined, undefined, fixture.ctx),
			/Agent unavailable/,
		);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /%%pi-comfyui-image:[a-f0-9-]{36}%%/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
			entry.data.status === "failed" &&
			entry.data.error === "Agent unavailable",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main paint tool preserves its marker if nested Agent execution rejects", async () => {
	const fixture = createPaintFixture(undefined, new Error("Agent runtime failed"));
	try {
		const tool = fixture.registeredTools.get("teach_comfyui_paint");
		await assert.rejects(
			tool.execute("paint", { prompt: "A glowing leaf", captionTitle: "Photosynthesis", caption: "The leaf collects light to power photosynthesis.", insertAfter: "Existing note text." }, undefined, undefined, fixture.ctx),
			/Agent runtime failed/,
		);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /%%pi-comfyui-image:[a-f0-9-]{36}%%/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
			entry.data.status === "failed" &&
			entry.data.error === "Agent runtime failed",
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main paint tool rejects success-shaped Agent responses without a background task id", async () => {
	const fixture = createPaintFixture({
		isError: false,
		result: { content: [{ type: "text", text: "Unknown agent type" }] },
	});
	try {
		const tool = fixture.registeredTools.get("teach_comfyui_paint");
		await assert.rejects(
			tool.execute("paint", { prompt: "A glowing leaf", captionTitle: "Photosynthesis", caption: "The leaf collects light to power photosynthesis.", insertAfter: "Existing note text." }, undefined, undefined, fixture.ctx),
			/Unknown agent type/,
		);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /%%pi-comfyui-image:[a-f0-9-]{36}%%/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("image maker is model-pinned and has only generation, status, and attachment tools", () => {
	const source = fs.readFileSync(new URL("../agents/comfyui-image-maker.md", import.meta.url), "utf-8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
	assert.ok(frontmatter);
	assert.match(frontmatter, /^model: explabs\/claude-haiku-5\.5$/m);
	assert.match(frontmatter, /^skills: false$/m);
	assert.match(frontmatter, /^tools: ext:comfyui-image\/teach_comfyui_generate, ext:comfyui-image\/teach_comfyui_job_status, ext:teach-image-attachment\/teach_attach_generated_image$/m);
	assert.match(frontmatter, /^extensions: \.pi\\agents\\extensions\\comfyui-image\.ts, \.pi\\agents\\extensions\\teach-image-attachment\.ts$/m);
});

test("ComfyUI Paint package is not loaded globally into the main agent", () => {
	const settingsUrl = new URL("../settings.json", import.meta.url);
	if (fs.existsSync(settingsUrl)) {
		const settings = JSON.parse(fs.readFileSync(settingsUrl, "utf-8"));
		const paintPackage = settings.packages?.some((entry) =>
			(typeof entry === "string" ? entry : entry?.source)?.startsWith("npm:pi-comfyui-paint"),
		) ?? false;
		assert.equal(paintPackage, false);
	}
	assert.ok(fs.existsSync(new URL("../extensions/teach-comfyui-paint.ts", import.meta.url)));
	assert.equal(fs.existsSync(new URL("../extensions/comfyui-image.ts", import.meta.url)), false);
});
