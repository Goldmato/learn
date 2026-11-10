import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
	buildMossLayout,
	buildMossGenerationStepVariables,
	buildMossWorkflowVariables,
	MAX_MOSS_LAYOUT_BOXES,
	MOSS_WORKFLOW,
	MOSS_STEP_OPTIONS,
	normalizeMossBoundingBoxes,
	pathOnlyResult,
	requirePreviewDisabled,
	resolveMossCanvasSize,
	suggestMossFilename,
	validateMossWorkflowFeatures,
	validateMossWorkflowInput,
	validateMossWorkflowRuntime,
} from "../lib/comfyui-image-policy.ts";

test("MOSS workflow is fixed to the approved API template", () => {
	assert.equal(MOSS_WORKFLOW, "MOSS_Image_4Step_SeedVR2_API.json");
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

test("published MOSS API workflow exposes selectable speed presets, layout, and SeedVR2 output", () => {
	const workflowPath = new URL(`../comfyui_workflows/${MOSS_WORKFLOW}`, import.meta.url);
	const workflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
	assert.equal(workflow["3"]._meta.title, "[VAR]PositivePrompt");
	assert.equal(workflow["5"]._meta.title, "[VAR]Resolution");
	assert.equal(workflow["71"]._meta.title, "[VAR]BoundingBoxes");
	assert.equal(workflow["39:74"]._meta.title, "[VAR]CharacterBoxes");
	assert.equal(workflow["39:75"]._meta.title, "[VAR]LayoutEnabled");
	assert.equal(workflow["39:77"]._meta.title, "[VAR]NegativePrompt");
	assert.equal(workflow["39:100"]._meta.title, "[VAR]EightStepSwitch");
	assert.equal(workflow["39:101"]._meta.title, "[VAR]FourStepSwitch");
	assert.equal(workflow["11"]._meta.title, "[VAR]SpeedLoRAs");
	assert.equal(workflow["13"]._meta.title, "[OUTPUT:image] Save Image");
	assert.equal(workflow["3"].inputs.text, "");
	assert.equal(workflow["8"].inputs.clip_name, "qwen3.5_9b_w4a8_gptq.safetensors");
	assert.equal(workflow["9"].inputs.vae_name, "flux2-vae_small.safetensors");
	assert.equal(workflow["39:101"].inputs.switch, true);
	assert.equal(workflow["39:104"].inputs.switch, false);
	assert.equal(workflow["71"].inputs.layout, "{\"v\": 1, \"boxes\": []}");
	assert.equal(workflow["13"].inputs.images[0], "105:116");
	assert.equal(workflow["105:110"].inputs.scale_factor, 2);
	assert.equal(workflow["106"].inputs.unet_name, "seedvr2_3b_int8_convrot.safetensors");
	assert.equal(workflow["107"].inputs.vae_name, "seedvr2_ema_vae_fp16.safetensors");
	assert.doesNotThrow(() => validateMossWorkflowFeatures(workflow));
	const loras = JSON.parse(workflow["11"].inputs.loras);
	assert.equal(loras.find((lora) => lora.name === "MOSS-Image-SFT-4-steps.safetensors").enabled, true);
	assert.equal(loras.find((lora) => lora.name === "lora_latest.safetensors").enabled, false);

	const rawVars = Object.fromEntries(Object.values(workflow)
		.filter((node) => node._meta.title.startsWith("[VAR]"))
		.map((node) => [
			node._meta.title.slice("[VAR]".length),
			{ keys: Object.keys(node.inputs), defaults: Object.values(node.inputs) },
		]));
	const boxes = [{ x: 0.2, y: 0.2, width: 0.4, height: 0.4, kind: "character", description: "A cell" }];
	const variables = buildMossWorkflowVariables(rawVars, boxes, "A labeled diagram", "3:2 (Photo)");
	assert.doesNotThrow(() => validateMossWorkflowInput(rawVars, variables, undefined));
	assert.equal(variables.LayoutEnabled[0], true);
	assert.equal(variables.CharacterBoxes[3], "1");
	assert.equal(JSON.parse(variables.BoundingBoxes[2]).boxes.length, 1);
});

test("MOSS step presets switch sampler branches and enable exactly the matching speed LoRA", () => {
	const workflow = JSON.parse(fs.readFileSync(
		new URL(`../comfyui_workflows/${MOSS_WORKFLOW}`, import.meta.url),
		"utf-8",
	));
	const rawVars = Object.fromEntries(Object.values(workflow)
		.filter((node) => node._meta.title.startsWith("[VAR]"))
		.map((node) => [
			node._meta.title.slice("[VAR]".length),
			{ keys: Object.keys(node.inputs), defaults: Object.values(node.inputs) },
		]));
	assert.deepEqual(MOSS_STEP_OPTIONS, [4, 8]);

	for (const steps of MOSS_STEP_OPTIONS) {
		const variables = buildMossGenerationStepVariables(rawVars, steps);
		assert.equal(variables.FourStepSwitch[0], steps === 4);
		assert.equal(variables.EightStepSwitch[0], steps === 8);
		const loras = JSON.parse(variables.SpeedLoRAs[0]);
		assert.equal(loras.find((lora) => lora.name === "MOSS-Image-SFT-4-steps.safetensors").enabled, steps === 4);
		assert.equal(loras.find((lora) => lora.name === "lora_latest.safetensors").enabled, steps === 8);
	}
});

test("MOSS runtime preflight detects unavailable nodes, models, and selected LoRAs", () => {
	const workflow = JSON.parse(fs.readFileSync(
		new URL(`../comfyui_workflows/${MOSS_WORKFLOW}`, import.meta.url),
		"utf-8",
	));
	const objectInfo = {};
	for (const node of Object.values(workflow)) {
		const nodeInfo = objectInfo[node.class_type] ??= { input: { required: {} } };
		for (const inputName of ["clip_name", "unet_name", "vae_name"]) {
			const model = node.inputs[inputName];
			if (typeof model !== "string") continue;
			const options = nodeInfo.input.required[inputName] ??= [[]];
			if (!options[0].includes(model)) options[0].push(model);
		}
	}
	const installedLoras = ["MOSS-Image-SFT-4-steps.safetensors", "lora_latest.safetensors"];
	assert.doesNotThrow(() => validateMossWorkflowRuntime(workflow, objectInfo, installedLoras, 4));
	assert.doesNotThrow(() => validateMossWorkflowRuntime(workflow, objectInfo, installedLoras, 8));

	delete objectInfo.AUSBOSS_NODES_LayoutBoxes;
	assert.throws(
		() => validateMossWorkflowRuntime(workflow, objectInfo, installedLoras, 4),
		/missing ComfyUI node "AUSBOSS_NODES_LayoutBoxes"/,
	);
	objectInfo.AUSBOSS_NODES_LayoutBoxes = { input: { required: {} } };
	assert.throws(
		() => validateMossWorkflowRuntime(workflow, objectInfo, installedLoras.filter((lora) => lora !== "lora_latest.safetensors"), 8),
		/not installed in ComfyUI's LoRA folder/,
	);
	const missingMossModel = structuredClone(workflow);
	missingMossModel["10"].inputs.unet_name = "missing-moss-model.safetensors";
	assert.throws(
		() => validateMossWorkflowRuntime(missingMossModel, objectInfo, installedLoras, 4),
		/not find model "missing-moss-model.safetensors"/,
	);
});

test("image generation and job lookup require previews to remain disabled", () => {
	assert.doesNotThrow(() => requirePreviewDisabled(0));
	assert.throws(() => requirePreviewDisabled(1), /previews must be disabled/);
});

test("MOSS workflow inputs must match declared prompt variables", () => {
	const rawVars = {
		PositivePrompt: "node",
		BoundingBoxes: "node",
		Resolution: "node",
		CharacterBoxes: "node",
		LayoutEnabled: "node",
		FourStepSwitch: "node",
		EightStepSwitch: "node",
		SpeedLoRAs: "node",
		NegativePrompt: "node",
	};
	assert.doesNotThrow(() => validateMossWorkflowInput(rawVars, { BoundingBoxes: [], Resolution: [] }, "blurry"));
	assert.throws(() => validateMossWorkflowInput({}, undefined, undefined), /PositivePrompt/);
	assert.throws(
		() => validateMossWorkflowInput(rawVars, { Unused: "value" }, undefined),
		/Unknown MOSS workflow variable.*Unused/,
	);
	assert.throws(
		() => validateMossWorkflowInput({
			PositivePrompt: "node",
			Resolution: "node",
			BoundingBoxes: "node",
			CharacterBoxes: "node",
			LayoutEnabled: "node",
			FourStepSwitch: "node",
			EightStepSwitch: "node",
			SpeedLoRAs: "node",
		}, undefined, "blurry"),
		/does not expose a \[VAR\]NegativePrompt/,
	);
});

test("MOSS boxes use AusBoss normalized layout geometry and exact text metadata", () => {
	const boxes = [
		{ x: 0.25, y: 0.25, width: 0.5, height: 0.5, kind: "character", description: "Learner observing a cell" },
		{ x: 0.05, y: 0.05, width: 0.3, height: 0.1, kind: "text", text: "ATP", description: "Label at top left" },
	];
	const state = buildMossLayout(boxes);
	assert.deepEqual(state, {
		v: 1,
		boxes: [
			{
				x: 0.25,
				y: 0.25,
				w: 0.5,
				h: 0.5,
				type: "obj",
				text: "",
				desc: "Learner observing a cell",
				palette: [],
			},
			{
				x: 0.05,
				y: 0.05,
				w: 0.3,
				h: 0.1,
				type: "text",
				text: "ATP",
				desc: "Label at top left",
				palette: [],
			},
		],
	});
});

test("MOSS layouts stay empty when boxes are omitted and infer text type from exact copy", () => {
	const state = buildMossLayout(normalizeMossBoundingBoxes());
	assert.deepEqual(state, { v: 1, boxes: [] });
	const textBox = buildMossLayout([
		{ x: 0.1, y: 0.1, width: 0.3, height: 0.1, text: "ATP" },
	]);
	assert.deepEqual(textBox.boxes[0], {
		x: 0.1,
		y: 0.1,
		w: 0.3,
		h: 0.1,
		type: "text",
		text: "ATP",
		desc: "Visible text: ATP",
		palette: [],
	});
});

test("MOSS variables preserve workflow links while replacing layout, size, and character indices", () => {
	const rawVars = {
		PositivePrompt: {
			keys: ["text"],
			defaults: [""],
		},
		BoundingBoxes: {
			keys: ["width", "height", "layout"],
			defaults: [["5", 0], ["5", 1], "{\"v\": 1, \"boxes\": []}"],
		},
		Resolution: {
			keys: ["width", "height", "latent", "batch_size"],
			defaults: [1024, 1536, "128ch", 1],
		},
		CharacterBoxes: {
			keys: ["prompt", "width", "height", "character_boxes", "element"],
			defaults: [["41:92", 0], ["5", 0], ["5", 1], "", ["71", 2]],
		},
		LayoutEnabled: {
			keys: ["switch", "on_false", "on_true"],
			defaults: [false, ["41:92", 0], ["39:74", 0]],
		},
	};
	const boxes = [
		{ x: 0.2, y: 0.2, width: 0.5, height: 0.5, kind: "character", description: "A scientist" },
		{ x: 0.05, y: 0.05, width: 0.2, height: 0.1, text: "CELL" },
	];
	const variables = buildMossWorkflowVariables(rawVars, boxes, "", "1:1 (Square)");
	const squareCanvas = resolveMossCanvasSize("", "1:1 (Square)");
	assert.deepEqual(variables.PositivePrompt, [""]);
	assert.deepEqual(variables.CharacterBoxes, [["41:92", 0], ["5", 0], ["5", 1], "1", ["71", 2]]);
	assert.deepEqual(variables.LayoutEnabled, [true, ["41:92", 0], ["39:74", 0]]);
	assert.deepEqual(variables.Resolution, [squareCanvas.width, squareCanvas.height, "128ch", 1]);
	assert.deepEqual(variables.BoundingBoxes, [
		["5", 0],
		["5", 1],
		JSON.stringify(buildMossLayout(boxes)),
	]);
});

test("MOSS generation accepts prompt-only requests without enabling layout boxes", () => {
	const rawVars = {
		PositivePrompt: {
			keys: ["text"],
			defaults: [""],
		},
		BoundingBoxes: {
			keys: ["width", "height", "layout"],
			defaults: [["5", 0], ["5", 1], "{\"v\": 1, \"boxes\": []}"],
		},
		Resolution: {
			keys: ["width", "height", "latent", "batch_size"],
			defaults: [1024, 1536, "128ch", 1],
		},
		CharacterBoxes: {
			keys: ["prompt", "width", "height", "character_boxes", "element"],
			defaults: [["41:92", 0], ["5", 0], ["5", 1], "", ["71", 2]],
		},
		LayoutEnabled: {
			keys: ["switch", "on_false", "on_true"],
			defaults: [false, ["41:92", 0], ["39:74", 0]],
		},
	};
	const variables = buildMossWorkflowVariables(rawVars);
	assert.deepEqual(variables.Resolution, [
		resolveMossCanvasSize("").width,
		resolveMossCanvasSize("").height,
		"128ch",
		1,
	]);
	assert.equal(variables.BoundingBoxes[2], "{\"v\":1,\"boxes\":[]}");
	assert.equal(variables.LayoutEnabled[0], false);
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

test("MOSS layouts accept 64 boxes and reject excess boxes instead of silently dropping them", () => {
	const boxes = Array.from({ length: MAX_MOSS_LAYOUT_BOXES }, (_, index) => ({
		x: 0.01 * index,
		y: 0.01 * index,
		width: 0.1,
		height: 0.1,
		description: `Element ${index + 1}`,
	}));
	const normalized = normalizeMossBoundingBoxes(boxes);
	assert.equal(normalized.length, MAX_MOSS_LAYOUT_BOXES);
	assert.equal(normalized[0].description, "Element 1");
	assert.equal(normalized.at(-1)?.description, "Element 64");
	assert.throws(
		() => normalizeMossBoundingBoxes([...boxes, boxes[0]]),
		/support up to 64 bounding boxes; received 65/,
	);
});

test("invalid MOSS box layouts fail explicitly", () => {
	const validBox = { x: 0.1, y: 0.1, width: 0.5, height: 0.5, kind: "object", description: "Main scene" };
	assert.throws(
		() => buildMossLayout([{ ...validBox, x: 0.8 }]),
		/stay within the canvas/,
	);
	assert.doesNotThrow(() => buildMossLayout([{ ...validBox, kind: "text", text: "OK" }]));
	assert.throws(
		() => buildMossLayout([{ ...validBox, kind: "text", text: "" }]),
		/must contain 1.100 characters/,
	);
	const missingDescription = buildMossLayout([{ ...validBox, description: " ".repeat(3) }]);
	assert.equal(missingDescription.boxes[0].desc, "Composition element 1");
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
