export const MOSS_WORKFLOW = "MOSS_Image_4Step_SeedVR2_API.json";
export const MOSS_COVER_WIDTH = 1088;
export const MOSS_COVER_HEIGHT = 720;
export const MAX_MOSS_LAYOUT_BOXES = 64;
export const MAX_MOSS_INPUT_BOXES = 64;
export const MOSS_STEP_OPTIONS = [4, 8] as const;

export type MOSSGenerationSteps = typeof MOSS_STEP_OPTIONS[number];

const MOSS_STEP_LORAS: Record<MOSSGenerationSteps, string> = {
	4: "MOSS-Image-SFT-4-steps.safetensors",
	8: "lora_latest.safetensors",
};

export const MOSS_ASPECT_RATIOS = [
	"1:1 (Square)",
	"2:3 (Portrait Photo)",
	"3:2 (Photo)",
	"3:4 (Portrait Standard)",
	"4:3 (Standard)",
	"9:16 (Portrait Widescreen)",
	"16:9 (Widescreen)",
	"21:9 (Ultrawide)",
] as const;

export type MOSSAspectRatio = typeof MOSS_ASPECT_RATIOS[number];

export interface MOSSCanvasSize {
	width: number;
	height: number;
	aspectRatio: MOSSAspectRatio;
	megapixels: number;
}

const ASPECT_RATIO_VALUES: Record<MOSSAspectRatio, number> = {
	"1:1 (Square)": 1,
	"2:3 (Portrait Photo)": 2 / 3,
	"3:2 (Photo)": 3 / 2,
	"3:4 (Portrait Standard)": 3 / 4,
	"4:3 (Standard)": 4 / 3,
	"9:16 (Portrait Widescreen)": 9 / 16,
	"16:9 (Widescreen)": 16 / 9,
	"21:9 (Ultrawide)": 21 / 9,
};

export interface MOSSBoundingBoxSpec {
	x: number;
	y: number;
	width: number;
	height: number;
	kind?: "object" | "character" | "text";
	description?: string;
	text?: string;
}

interface WorkflowVariableInfo {
	keys: string[];
	defaults: unknown[];
}

interface MOSSLayoutBox {
	x: number;
	y: number;
	w: number;
	h: number;
	type: "obj" | "text";
	text: string;
	desc: string;
	palette: string[];
}

interface MOSSLayoutState {
	v: 1;
	boxes: MOSSLayoutBox[];
}

export function requirePreviewDisabled(inlineImageLimit: number): void {
	if (inlineImageLimit !== 0) {
		throw new Error("ComfyUI inline image previews must be disabled before retrieving or generating images.");
	}
}

export function validateMossWorkflowInput(
	rawVars: Readonly<Record<string, unknown>>,
	variables: Record<string, unknown> | undefined,
	negativePrompt: string | undefined,
): void {
	const requiredVariables = [
		"PositivePrompt",
		"Resolution",
		"BoundingBoxes",
		"CharacterBoxes",
		"LayoutEnabled",
		"FourStepSwitch",
		"EightStepSwitch",
		"SpeedLoRAs",
	];
	const missingVariables = requiredVariables.filter((name) => !rawVars[name]);
	if (missingVariables.length > 0) {
		throw new Error(`MOSS workflow is missing required [VAR] annotation(s): ${missingVariables.join(", ")}.`);
	}
	if (variables) {
		const unknownVariables = Object.keys(variables).filter((name) => !rawVars[name]);
		if (unknownVariables.length > 0) {
			throw new Error(`Unknown MOSS workflow variable(s): ${unknownVariables.join(", ")}`);
		}
	}
	if (negativePrompt && !rawVars.NegativePrompt) {
		throw new Error("MOSS workflow does not expose a [VAR]NegativePrompt variable.");
	}
}

export function buildMossGenerationStepVariables(
	rawVars: Readonly<Record<string, unknown>>,
	steps: MOSSGenerationSteps,
): Record<string, unknown[]> {
	if (!MOSS_STEP_OPTIONS.includes(steps)) throw new Error(`Unsupported MOSS step count: ${steps}.`);
	const fourStepSwitch = getVariableInfo(rawVars, "FourStepSwitch");
	const eightStepSwitch = getVariableInfo(rawVars, "EightStepSwitch");
	const speedLoras = getVariableInfo(rawVars, "SpeedLoRAs");
	if (!fourStepSwitch.keys.includes("switch") || !eightStepSwitch.keys.includes("switch")) {
		throw new Error("MOSS step switch variables must expose a boolean switch input.");
	}
	const loraIndex = speedLoras.keys.indexOf("loras");
	const loraDefault = speedLoras.defaults[loraIndex];
	if (loraIndex < 0 || typeof loraDefault !== "string") {
		throw new Error("MOSS SpeedLoRAs variable must expose its serialized loras input.");
	}
	let loras: unknown;
	try {
		loras = JSON.parse(loraDefault);
	} catch (error) {
		throw new Error(`MOSS workflow LoRA list is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(loras)) throw new Error("MOSS workflow LoRA list must be a JSON array.");
	const selectedLora = MOSS_STEP_LORAS[steps];
	let foundSelectedLora = false;
	for (const entry of loras) {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.enabled !== "boolean") {
			throw new Error("MOSS workflow LoRA entries must include a name and enabled flag.");
		}
		if (Object.values(MOSS_STEP_LORAS).includes(entry.name)) {
			entry.enabled = entry.name === selectedLora;
			if (entry.enabled) foundSelectedLora = true;
		}
	}
	if (!foundSelectedLora) {
		throw new Error(`MOSS workflow is missing the ${steps}-step LoRA entry "${selectedLora}".`);
	}
	const withSwitch = (info: WorkflowVariableInfo, value: boolean): unknown[] =>
		info.keys.map((key, index) => key === "switch" ? value : info.defaults[index]);
	const loraValues = speedLoras.keys.map((key, index) =>
		key === "loras" ? JSON.stringify(loras) : speedLoras.defaults[index]);
	return {
		FourStepSwitch: withSwitch(fourStepSwitch, steps === 4),
		EightStepSwitch: withSwitch(eightStepSwitch, steps === 8),
		SpeedLoRAs: loraValues,
	};
}

export function validateMossWorkflowFeatures(workflow: Readonly<Record<string, unknown>>): void {
	const output = getWorkflowInputs(workflow, "13", "AUSBOSS_NODES_SaveImage");
	const resize = getWorkflowInputs(workflow, "105:110", "AUSBOSS_NODES_ImageResize");
	const seedVr = getWorkflowNode(workflow, "105:116", "SeedVR2PostProcessing");
	const fourStepSwitch = getWorkflowInputs(workflow, "39:101", "ComfySwitchNode");
	const eightStepSwitch = getWorkflowInputs(workflow, "39:100", "ComfySwitchNode");
	const cfgSwitch = getWorkflowInputs(workflow, "39:104", "ComfySwitchNode");
	if (!Array.isArray(output.images) ||
		output.images[0] !== "105:116" ||
		output.images[1] !== 0) {
		throw new Error("MOSS workflow output must pass through SeedVR2 post-processing.");
	}
	if (resize.target_mode !== "scale_factor" || resize.scale_factor !== 2) {
		throw new Error("MOSS workflow must keep the 2x SeedVR2 upscale enabled.");
	}
	if (!seedVr) throw new Error("MOSS workflow is missing its SeedVR2 post-processing node.");
	if (fourStepSwitch.switch !== true || eightStepSwitch.switch !== false || cfgSwitch.switch !== false) {
		throw new Error("MOSS workflow must keep its 4-step default and speed-LoRA CFG routing.");
	}
}

export function createMossCoverWorkflow(
	workflow: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	validateMossWorkflowFeatures(workflow);
	const coverWorkflow = structuredClone(workflow) as Record<string, unknown>;
	const output = getWorkflowInputs(coverWorkflow, "13", "AUSBOSS_NODES_SaveImage");
	output.images = ["39:30", 0];
	for (const nodeId of [
		"105:110", "105:111", "105:112", "105:113", "105:114",
		"105:115", "105:116", "105:117", "105:118", "106", "107",
	]) {
		delete coverWorkflow[nodeId];
	}
	validateMossCoverWorkflowFeatures(coverWorkflow);
	return coverWorkflow;
}

export function validateMossCoverWorkflowFeatures(
	workflow: Readonly<Record<string, unknown>>,
): void {
	const output = getWorkflowInputs(workflow, "13", "AUSBOSS_NODES_SaveImage");
	getWorkflowNode(workflow, "39:30", "VAEDecode");
	if (!Array.isArray(output.images) || output.images[0] !== "39:30" || output.images[1] !== 0) {
		throw new Error("MOSS cover workflow must save the native MOSS image without post-processing.");
	}
	for (const [nodeId, rawNode] of Object.entries(workflow)) {
		if (isRecord(rawNode) && typeof rawNode.class_type === "string" &&
			/^SeedVR2/.test(rawNode.class_type)) {
			throw new Error(`MOSS cover workflow must not include SeedVR2 node ${nodeId}.`);
		}
	}
}

export function buildMossResolutionVariables(
	rawVars: Readonly<Record<string, unknown>>,
	width: number,
	height: number,
): Record<string, unknown[]> {
	if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
		throw new Error("MOSS resolution dimensions must be positive integers.");
	}
	const resolution = getVariableInfo(rawVars, "Resolution");
	if (!resolution.keys.includes("width") || !resolution.keys.includes("height")) {
		throw new Error("MOSS workflow Resolution must include width and height inputs.");
	}
	return {
		Resolution: resolution.keys.map((key, index) =>
			key === "width" ? width : key === "height" ? height : resolution.defaults[index]),
	};
}

export function validateMossWorkflowRuntime(
	workflow: Readonly<Record<string, unknown>>,
	objectInfo: Readonly<Record<string, unknown>>,
	installedLoras: readonly string[],
	steps: MOSSGenerationSteps,
): void {
	const issues: string[] = [];
	if (!MOSS_STEP_OPTIONS.includes(steps)) {
		throw new Error(`Unsupported MOSS step count: ${steps}.`);
	}
	for (const [nodeId, rawNode] of Object.entries(workflow)) {
		if (!isRecord(rawNode) || typeof rawNode.class_type !== "string") continue;
		if (!Object.hasOwn(objectInfo, rawNode.class_type)) {
			issues.push(`Node ${nodeId} requires missing ComfyUI node "${rawNode.class_type}".`);
			continue;
		}
		const nodeInputs = isRecord(rawNode.inputs) ? rawNode.inputs : {};
		const nodeInfo = objectInfo[rawNode.class_type];
		const nodeSchema = isRecord(nodeInfo) && isRecord(nodeInfo.input) ? nodeInfo.input : {};
		for (const inputName of ["clip_name", "unet_name", "vae_name"]) {
			const modelName = nodeInputs[inputName];
			if (typeof modelName !== "string") continue;
			const inputSchema = isRecord(nodeSchema.required) ? nodeSchema.required : {};
			const schemaEntry = inputSchema[inputName];
			const options = Array.isArray(schemaEntry) && Array.isArray(schemaEntry[0])
				? schemaEntry[0]
				: undefined;
			if (!options || !options.includes(modelName)) {
				issues.push(`Node ${nodeId} cannot find model "${modelName}" in ComfyUI's installed model list.`);
			}
		}
	}

	const selectedLora = MOSS_STEP_LORAS[steps];
	if (!installedLoras.includes(selectedLora)) {
		issues.push(`The ${steps}-step LoRA "${selectedLora}" is not installed in ComfyUI's LoRA folder.`);
	}

	if (issues.length > 0) {
		throw new Error([
			"ComfyUI is not ready for this MOSS generation:",
			...issues.map((issue) => `- ${issue}`),
			"Install or update the named node/model in ComfyUI, then try generating again.",
		].join("\n"));
	}
}

export function buildMossWorkflowVariables(
	rawVars: Readonly<Record<string, unknown>>,
	boxes?: MOSSBoundingBoxSpec[],
	prompt = "",
	requestedAspectRatio?: MOSSAspectRatio,
): Record<string, unknown[]> {
	const positivePrompt = getVariableInfo(rawVars, "PositivePrompt");
	const boundingBoxes = getVariableInfo(rawVars, "BoundingBoxes");
	const resolution = getVariableInfo(rawVars, "Resolution");
	const characterBoxes = getVariableInfo(rawVars, "CharacterBoxes");
	const layoutEnabled = getVariableInfo(rawVars, "LayoutEnabled");
	if (positivePrompt.keys[0] !== "text") {
		throw new Error("MOSS workflow PositivePrompt must have text as its first input.");
	}
	if (!["width", "height", "layout"].every((key) => boundingBoxes.keys.includes(key))) {
		throw new Error("MOSS workflow BoundingBoxes must include width, height, and layout inputs.");
	}
	if (!["width", "height"].every((key) => resolution.keys.includes(key))) {
		throw new Error("MOSS workflow Resolution must include width and height inputs.");
	}
	if (!characterBoxes.keys.includes("character_boxes")) {
		throw new Error("MOSS workflow CharacterBoxes must include a character_boxes input.");
	}
	if (!layoutEnabled.keys.includes("switch")) {
		throw new Error("MOSS workflow LayoutEnabled must include a switch input.");
	}
	const normalizedBoxes = normalizeMossBoundingBoxes(boxes);
	const canvas = resolveMossCanvasSize(prompt, requestedAspectRatio);
	const state = buildMossLayout(normalizedBoxes);
	const characters = normalizedBoxes.flatMap((box, index) => box.kind === "character" ? [index + 1] : []).join(", ");
	const withOverrides = (
		info: WorkflowVariableInfo,
		overrides: Record<string, unknown>,
	): unknown[] => info.keys.map((key, index) =>
		Object.hasOwn(overrides, key) ? overrides[key] : info.defaults[index]);
	return {
		PositivePrompt: positivePrompt.defaults,
		BoundingBoxes: withOverrides(boundingBoxes, { layout: JSON.stringify(state) }),
		Resolution: withOverrides(resolution, { width: canvas.width, height: canvas.height }),
		CharacterBoxes: withOverrides(characterBoxes, { character_boxes: characters }),
		LayoutEnabled: withOverrides(layoutEnabled, { switch: normalizedBoxes.length > 0 }),
	};
}

export function resolveMossCanvasSize(
	prompt: string,
	requestedAspectRatio?: MOSSAspectRatio,
): MOSSCanvasSize {
	const aspectRatio = requestedAspectRatio ?? inferMossAspectRatio(prompt);
	if (!MOSS_ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`Unsupported MOSS aspect ratio: ${aspectRatio}`);
	const ratio = ASPECT_RATIO_VALUES[aspectRatio];
	const megapixels = ratio === 1 ? 1.2
		: ratio === 3 / 2 || ratio === 2 / 3 || ratio === 4 / 3 || ratio === 3 / 4 ? 1.1
			: ratio === 21 / 9 ? 0.8 : 0.9;
	const pixelArea = megapixels * 1024 * 1024;
	const width = Math.max(16, Math.round(Math.sqrt(pixelArea * ratio) / 16) * 16);
	const height = Math.max(16, Math.round(Math.sqrt(pixelArea / ratio) / 16) * 16);
	return { width, height, aspectRatio, megapixels };
}

export function suggestMossFilename(prompt: string): string {
	const words = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.match(/[a-z0-9]+/g) ?? [];
	const ignored = new Set([
		"a", "an", "and", "about", "as", "at", "by", "create", "depict", "detailed",
		"dense", "educational", "fictional", "generate", "high", "image", "illustration",
		"infographic", "information", "level", "make", "of", "picture", "polished",
		"show", "the", "with",
	]);
	const selected = words.filter((word) => !ignored.has(word)).slice(0, 5);
	return selected.join("-").slice(0, 48).replace(/-+$/g, "") || "generated-illustration";
}

function inferMossAspectRatio(prompt: string): MOSSAspectRatio {
	const ratioMatch = prompt.match(/(?:^|[^\d])(\d{1,2}:\d{1,2})(?:[^\d]|$)/);
	if (ratioMatch) {
		const ratio = ratioMatch[1];
		const match = MOSS_ASPECT_RATIOS.find((option) => option.startsWith(`${ratio} `));
		if (match) return match;
	}
	if (/\b(square|icon|avatar|tile)\b/i.test(prompt)) return MOSS_ASPECT_RATIOS[0];
	if (/\b(ultrawide|panorama|panoramic)\b/i.test(prompt)) return MOSS_ASPECT_RATIOS[7];
	if (/\b(9:16|vertical video|phone wallpaper|story format)\b/i.test(prompt)) return MOSS_ASPECT_RATIOS[5];
	if (/\b(portrait|vertical|tall|book cover|phone screen)\b/i.test(prompt)) return MOSS_ASPECT_RATIOS[3];
	if (/\b(16:9|widescreen|wide screen|banner|landscape|horizontal)\b/i.test(prompt)) return MOSS_ASPECT_RATIOS[2];
	return MOSS_ASPECT_RATIOS[2];
}

export function buildMossLayout(boxes: MOSSBoundingBoxSpec[]): MOSSLayoutState {
	if (!Array.isArray(boxes) || boxes.length > MAX_MOSS_LAYOUT_BOXES) {
		throw new Error(`MOSS layouts support up to ${MAX_MOSS_LAYOUT_BOXES} bounding boxes.`);
	}
	const normalized = boxes.map((box, index): MOSSLayoutBox => {
		if (!box || typeof box !== "object") throw new Error(`Bounding box ${index + 1} must be an object.`);
		for (const key of ["x", "y", "width", "height"] as const) {
			if (!Number.isFinite(box[key]) || box[key] < 0 || box[key] > 1) {
				throw new Error(`Bounding box ${index + 1} ${key} must be a number from 0 to 1.`);
			}
		}
		if (box.width === 0 || box.height === 0 || box.x + box.width > 1 || box.y + box.height > 1) {
			throw new Error(`Bounding box ${index + 1} must have positive size and stay within the canvas.`);
		}
		const text = typeof box.text === "string" ? box.text.trim() : "";
		const kind = text ? "text" : box.kind ?? "object";
		if (!["object", "character", "text"].includes(kind)) {
			throw new Error(`Bounding box ${index + 1} kind must be object, character, or text.`);
		}
		const description = typeof box.description === "string" && box.description.trim()
			? box.description.trim()
			: text ? `Visible text: ${text}` : `Composition element ${index + 1}`;
		if (!description || description.length > 240) {
			throw new Error(`Bounding box ${index + 1} description must contain 1–240 characters.`);
		}
		if (kind === "text" && (!text || text.length > 100)) {
			throw new Error(`Text box ${index + 1} must contain 1–100 characters of exact visible text.`);
		}
		return {
			x: box.x,
			y: box.y,
			w: box.width,
			h: box.height,
			type: kind === "text" ? "text" : "obj",
			text: kind === "text" ? text : "",
			desc: description,
			palette: [],
		};
	});
	return { v: 1, boxes: normalized };
}

export function normalizeMossBoundingBoxes(boxes?: MOSSBoundingBoxSpec[]): MOSSBoundingBoxSpec[] {
	const supplied = boxes ?? [];
	if (!Array.isArray(supplied)) throw new Error("MOSS boxes must be an array when provided.");
	if (supplied.length > MAX_MOSS_LAYOUT_BOXES) {
		throw new Error(`MOSS layouts support up to ${MAX_MOSS_LAYOUT_BOXES} bounding boxes; received ${supplied.length}.`);
	}
	return supplied;
}

export function pathOnlyResult<T extends { content: Array<{ type: string }> }>(result: T): T {
	if (result.content.some((part) => part.type !== "text")) {
		throw new Error("ComfyUI returned non-text output while image previews were disabled; output was not exposed.");
	}
	return result;
}

function getVariableInfo(rawVars: Readonly<Record<string, unknown>>, name: string): WorkflowVariableInfo {
	const value = rawVars[name];
	if (!isWorkflowVariableInfo(value)) {
		throw new Error(`MOSS workflow is missing a usable [VAR]${name} annotation.`);
	}
	return value;
}

function isWorkflowVariableInfo(value: unknown): value is WorkflowVariableInfo {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("keys" in value) || !("defaults" in value)) return false;
	return Array.isArray(value.keys) &&
		value.keys.every((key): key is string => typeof key === "string") &&
		Array.isArray(value.defaults) &&
		value.keys.length === value.defaults.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getWorkflowNode(
	workflow: Readonly<Record<string, unknown>>,
	nodeId: string,
	expectedType: string,
): Record<string, unknown> | undefined {
	const node = workflow[nodeId];
	return isRecord(node) && node.class_type === expectedType ? node : undefined;
}

function getWorkflowInputs(
	workflow: Readonly<Record<string, unknown>>,
	nodeId: string,
	expectedType: string,
): Readonly<Record<string, unknown>> {
	const node = getWorkflowNode(workflow, nodeId, expectedType);
	if (!node || !isRecord(node.inputs)) {
		throw new Error(`MOSS workflow is missing expected node ${nodeId} (${expectedType}).`);
	}
	return node.inputs;
}
