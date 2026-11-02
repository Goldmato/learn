import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	buildMossBoundingBoxState,
	buildMossWorkflowVariables,
	MAX_MOSS_LAYOUT_BOXES,
	MOSS_WORKFLOW,
	normalizeMossBoundingBoxes,
	pathOnlyResult,
	requirePreviewDisabled,
	resolveMossCanvasSize,
	suggestMossFilename,
	validateMossWorkflowInput,
} from "../lib/comfyui-image-policy.ts";

test("MOSS workflow is fixed to the approved API template", () => {
	assert.equal(MOSS_WORKFLOW, "MOSS_Image_base_T2i_BBoxes_API.json");
});

test("main agent has one prompt-and-placement paint tool backed by the isolated image-maker subagent", () => {
	const agent = fs.readFileSync(new URL("../agents/comfyui-image-maker.md", import.meta.url), "utf-8");
	const teachingSkill = fs.readFileSync(new URL("../skills/teach/SKILL.md", import.meta.url), "utf-8");
	const visualizeSkill = fs.readFileSync(new URL("../skills/visualize/SKILL.md", import.meta.url), "utf-8");
	const paintTool = fs.readFileSync(new URL("../extensions/teach-comfyui-paint.ts", import.meta.url), "utf-8");
	assert.match(agent, /^model: explabs\/claude-haiku-5\.5$/m);
	assert.match(agent, /^skills: false$/m);
	assert.match(agent, /^extensions: \.pi\\agents\\extensions\\comfyui-image\.ts, \.pi\\agents\\extensions\\teach-image-attachment\.ts$/m);
	assert.ok(fs.existsSync(new URL("../agents/extensions/comfyui-image.ts", import.meta.url)));
	assert.equal(fs.existsSync(new URL("../extensions/comfyui-image.ts", import.meta.url)), false);
	assert.match(paintTool, /name: "teach_comfyui_paint"/);
	assert.match(teachingSkill, /Call only `teach_comfyui_paint` with a plain-language `prompt`, specific human-readable `captionTitle`, concise 1–2 sentence `caption`, and `insertAfter`/);
	assert.match(teachingSkill, /%%pi-comfyui-image:<id>%%/);
	assert.match(teachingSkill, /caption explains what the image shows and means; it appears italicized in a titled quote callout/);
	assert.match(teachingSkill, /marker becomes a titled quote caption above a standard Obsidian embed/);
	assert.match(visualizeSkill, /ComfyUI is the default/);
	assert.match(visualizeSkill, /single `teach_comfyui_paint` tool/);
	assert.match(visualizeSkill, /Use a diagram instead/);
});

test("exported MOSS API workflow exposes the prompt variables used by the wrapper", () => {
	const workflowPath = new URL(`../comfyui_workflows/${MOSS_WORKFLOW}`, import.meta.url);
	const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
	assert.equal(workflow["36"].class_type, "MOSSImageLayoutPrompt");
	assert.equal(workflow["36"]._meta.title, "[VAR]PositivePrompt");
	assert.equal(workflow["34"]._meta.title, "[VAR]BoundingBoxes");
	assert.equal(workflow["18:5"]._meta.title, "[VAR]NegativePrompt");
	assert.equal(workflow["9"]._meta.title, "[OUTPUT:image]");
	assert.equal(workflow["33"]._meta.title, "[VAR]Resolution");
	assert.equal(workflow["33"].inputs.aspect_ratio, "1:1 (Square)");
	assert.equal(workflow["33"].inputs.megapixels, 1);
	assert.deepEqual(workflow["34"].inputs.editor_state.__value__, []);
	assert.deepEqual(workflow["34"].inputs.last_incoming.__value__, []);
	assert.equal(workflow["36"].inputs.prompt, "");
	assert.equal(workflow["36"].inputs.character_boxes, "");
});

test("image generation and job lookup require previews to remain disabled", () => {
	assert.doesNotThrow(() => requirePreviewDisabled(0));
	assert.throws(() => requirePreviewDisabled(1), /previews must be disabled/);
});

test("MOSS workflow inputs must match declared prompt variables", () => {
	const rawVars = { PositivePrompt: "node", BoundingBoxes: "node", Resolution: "node", NegativePrompt: "node" };
	assert.doesNotThrow(() => validateMossWorkflowInput(rawVars, { BoundingBoxes: [], Resolution: [] }, "blurry"));
	assert.throws(() => validateMossWorkflowInput({}, undefined, undefined), /PositivePrompt/);
	assert.throws(
		() => validateMossWorkflowInput(rawVars, { Unused: "value" }, undefined),
		/Unknown MOSS workflow variable.*Unused/,
	);
	assert.throws(
		() => validateMossWorkflowInput({ PositivePrompt: "node", Resolution: "node" }, undefined, "blurry"),
		/does not expose a \[VAR\]NegativePrompt/,
	);
	assert.throws(
		() => validateMossWorkflowInput({ PositivePrompt: "node" }, undefined, undefined),
		/missing the required \[VAR\]Resolution/,
	);
});

test("normalized MOSS boxes become bounded pixel geometry and exact text metadata", () => {
	const boxes = [
		{ x: 0, y: 0, width: 1, height: 1, kind: "object", description: "Full-scene background" },
		{ x: 0.25, y: 0.25, width: 0.5, height: 0.5, kind: "character", description: "Learner observing a cell" },
		{ x: 0.05, y: 0.05, width: 0.3, height: 0.1, kind: "text", text: "ATP", description: "Label at top left" },
	];
	const state = buildMossBoundingBoxState(boxes);
	assert.deepEqual(state.__value__[1], {
		x: 256,
		y: 256,
		width: 512,
		height: 512,
		metadata: { type: "obj", text: "", desc: "Learner observing a cell", palette: [] },
	});
	assert.deepEqual(state.__value__[2].metadata, {
		type: "text",
		text: "ATP",
		desc: "Label at top left",
		palette: [],
	});
});

test("MOSS layouts default the background and infer text-box kind from exact copy", () => {
	const boxes = [
		{ x: 0.1, y: 0.1, width: 0.3, height: 0.1, text: "ATP" },
	];
	const state = buildMossBoundingBoxState([
		{ x: 0, y: 0, width: 1, height: 1, kind: "object", description: "Full canvas" },
		...boxes,
	]);
	assert.equal(state.__value__.length, 2);
	assert.deepEqual(state.__value__[0].metadata, {
		type: "obj",
		text: "",
		desc: "Full canvas",
		palette: [],
	});
	assert.deepEqual(state.__value__[1].metadata, {
		type: "text",
		text: "ATP",
		desc: "Visible text: ATP",
		palette: [],
	});
});

test("MOSS variables preserve workflow links while replacing demo boxes and character indices", () => {
	const rawVars = {
		PositivePrompt: {
			keys: ["prompt", "width", "height", "character_boxes", "element"],
			defaults: ["", ["33", 0], ["33", 1], "", ["34", 2]],
		},
		BoundingBoxes: {
			keys: ["width", "height", "editor_state", "last_incoming"],
			defaults: [["33", 0], ["33", 1], { __value__: [] }, { __value__: [] }],
		},
		Resolution: {
			keys: ["aspect_ratio", "megapixels", "multiple"],
			defaults: ["1:1 (Square)", 1, 16],
		},
	};
	const boxes = [
		{ x: 0, y: 0, width: 1, height: 1, kind: "object", description: "Scene background" },
		{ x: 0.2, y: 0.2, width: 0.5, height: 0.5, kind: "character", description: "A scientist" },
	];
	const variables = buildMossWorkflowVariables(rawVars, boxes, "", "1:1 (Square)");
	const squareCanvas = resolveMossCanvasSize("", "1:1 (Square)");
	assert.deepEqual(variables.PositivePrompt, ["", ["33", 0], ["33", 1], "2", ["34", 2]]);
	assert.deepEqual(variables.BoundingBoxes, [
		["33", 0],
		["33", 1],
		{ __value__: buildMossBoundingBoxState(boxes, squareCanvas).__value__ },
		{ __value__: buildMossBoundingBoxState(boxes, squareCanvas).__value__ },
	]);
});

test("MOSS generation accepts prompt-only layouts and automatically adds a valid background", () => {
	const rawVars = {
		PositivePrompt: {
			keys: ["prompt", "width", "height", "character_boxes", "element"],
			defaults: ["", ["33", 0], ["33", 1], "", ["34", 2]],
		},
		BoundingBoxes: {
			keys: ["width", "height", "editor_state", "last_incoming"],
			defaults: [["33", 0], ["33", 1], { __value__: [] }, { __value__: [] }],
		},
		Resolution: {
			keys: ["aspect_ratio", "megapixels", "multiple"],
			defaults: ["1:1 (Square)", 1, 16],
		},
	};
	const variables = buildMossWorkflowVariables(rawVars);
	assert.deepEqual(variables.Resolution, ["3:2 (Photo)", 1.1, 16]);
	assert.equal(variables.BoundingBoxes[2].__value__.length, 1);
	assert.equal(variables.BoundingBoxes[2].__value__[0].x, 0);
	assert.equal(variables.BoundingBoxes[2].__value__[0].y, 0);
	assert.equal(variables.BoundingBoxes[2].__value__[0].width, resolveMossCanvasSize("").width);
	assert.equal(variables.BoundingBoxes[2].__value__[0].height, resolveMossCanvasSize("").height);
	assert.deepEqual(variables.BoundingBoxes[2].__value__[0].metadata, {
		type: "obj",
		text: "",
		desc: "Full-canvas scene background",
		palette: [],
	});
});

test("MOSS chooses ratio and megapixels from content intent and keeps boxes on that canvas", () => {
	const landscape = resolveMossCanvasSize("Educational cycle diagram, landscape 3:2 composition");
	const portrait = resolveMossCanvasSize("Portrait book cover of the lifecycle");
	const square = resolveMossCanvasSize("Square icon");
	const ultrawide = resolveMossCanvasSize("Panoramic landscape scene");

	assert.equal(landscape.aspectRatio, "3:2 (Photo)");
	assert.equal(portrait.aspectRatio, "3:4 (Portrait Standard)");
	assert.equal(square.aspectRatio, "1:1 (Square)");
	assert.equal(ultrawide.aspectRatio, "21:9 (Ultrawide)");
	for (const canvas of [landscape, portrait, square, ultrawide]) {
		assert.ok(canvas.megapixels >= 0.8 && canvas.megapixels <= 1.2);
		assert.equal(canvas.width % 16, 0);
		assert.equal(canvas.height % 16, 0);
	}
	assert.ok(landscape.width > landscape.height);
	assert.ok(portrait.height > portrait.width);
	assert.ok(ultrawide.megapixels < landscape.megapixels);
	assert.ok(Math.abs((landscape.width * landscape.height) / (1024 * 1024) - landscape.megapixels) < 0.03);
	assert.equal(suggestMossFilename("Create a polished educational infographic about goblin hibernation cycles"), "goblin-hibernation-cycles");
});

test("oversized MOSS layouts are capped to the workflow limit instead of rejected", () => {
	const boxes = Array.from({ length: 20 }, (_, index) => ({
		x: 0.01 * index,
		y: 0.01 * index,
		width: 0.2,
		height: 0.2,
		description: `Element ${index + 1}`,
	}));
	const normalized = normalizeMossBoundingBoxes(boxes);
	assert.equal(normalized.length, MAX_MOSS_LAYOUT_BOXES);
	assert.equal(normalized[0].description, "Full-canvas scene background");
	assert.equal(normalized.at(-1)?.description, "Element 11");
});

test("invalid MOSS box layouts fail explicitly", () => {
	const background = { x: 0, y: 0, width: 1, height: 1, kind: "object", description: "Scene background" };
	const validBox = { x: 0.1, y: 0.1, width: 0.5, height: 0.5, kind: "object", description: "Main scene" };
	assert.throws(() => buildMossBoundingBoxState([]), /require 1-12 bounding boxes/);
	assert.throws(
		() => buildMossBoundingBoxState([validBox]),
		/first MOSS bounding box must be an object covering the full canvas/,
	);
	assert.throws(
		() => buildMossBoundingBoxState([background, { ...validBox, x: 0.8 }]),
		/stay within the canvas/,
	);
	assert.doesNotThrow(() => buildMossBoundingBoxState([background, { ...validBox, kind: "text" }]));
	const missingDescription = buildMossBoundingBoxState([background, { ...validBox, description: " ".repeat(3) }]);
	assert.equal(missingDescription.__value__[1].metadata.desc, "Composition element 2");
});

test("ComfyUI output is returned only when all content is text", () => {
	const textResult = { content: [{ type: "text", text: "job completed at C:\\paint-jobs\\image.png" }] };
	assert.equal(pathOnlyResult(textResult), textResult);
	assert.throws(
		() => pathOnlyResult({ content: [{ type: "image" }] }),
		/non-text output.*not exposed/,
	);
});

test("generation errors are preserved and retries require learner consent", () => {
	const agent = fs.readFileSync(new URL("../agents/comfyui-image-maker.md", import.meta.url), "utf-8");
	const skill = fs.readFileSync(new URL("../skills/teach/SKILL.md", import.meta.url), "utf-8");
	assert.match(agent, /Boxes can be omitted for ordinary images/i);
	assert.match(skill, /launches `comfyui-image-maker` through global `@tintinweb\/pi-subagents` `Agent` in the background/);
	assert.match(skill, /marker becomes a titled quote caption above a standard Obsidian embed/);
	assert.match(agent, /the placeholder remains for the learner's recovery choice/);
	assert.match(skill, /give the exact error and offer Retry or Pause\/Exit/);
	assert.match(skill, /retry only after he chooses/);
});
