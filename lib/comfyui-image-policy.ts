export const MOSS_WORKFLOW = "MOSS_Image_base_T2i_BBoxes_API.json";
export const MOSS_CANVAS_SIZE = 1024;
export const MAX_MOSS_LAYOUT_BOXES = 12;
export const MAX_MOSS_INPUT_BOXES = 64;

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

interface MOSSBoundingBox {
	x: number;
	y: number;
	width: number;
	height: number;
	metadata: {
		type: "obj" | "text";
		text: string;
		desc: string;
		palette: unknown[];
	};
}

interface MOSSBoundingBoxState {
	__value__: MOSSBoundingBox[];
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
	if (!rawVars.PositivePrompt) {
		throw new Error("MOSS workflow is missing the required [VAR]PositivePrompt annotation.");
	}
	if (!rawVars.Resolution) {
		throw new Error("MOSS workflow is missing the required [VAR]Resolution annotation.");
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

export function buildMossWorkflowVariables(
	rawVars: Readonly<Record<string, unknown>>,
	boxes?: MOSSBoundingBoxSpec[],
	prompt = "",
	requestedAspectRatio?: MOSSAspectRatio,
): Record<string, unknown[]> {
	const positivePrompt = getVariableInfo(rawVars, "PositivePrompt");
	const boundingBoxes = getVariableInfo(rawVars, "BoundingBoxes");
	const resolution = getVariableInfo(rawVars, "Resolution");
	if (!positivePrompt.keys.includes("prompt") || !positivePrompt.keys.includes("character_boxes")) {
		throw new Error("MOSS workflow PositivePrompt must include prompt and character_boxes inputs.");
	}
	if (!["width", "height", "editor_state", "last_incoming"].every((key) => boundingBoxes.keys.includes(key))) {
		throw new Error("MOSS workflow BoundingBoxes must include width, height, editor_state, and last_incoming inputs.");
	}
	if (!["aspect_ratio", "megapixels"].every((key) => resolution.keys.includes(key))) {
		throw new Error("MOSS workflow Resolution must include aspect_ratio and megapixels inputs.");
	}

	const normalizedBoxes = normalizeMossBoundingBoxes(boxes);
	const canvas = resolveMossCanvasSize(prompt, requestedAspectRatio);
	const state = buildMossBoundingBoxState(normalizedBoxes, canvas);
	const characters = normalizedBoxes.flatMap((box, index) => box.kind === "character" ? [index + 1] : []).join(", ");
	return {
		PositivePrompt: positivePrompt.keys.map((key, index) =>
			key === "character_boxes" ? characters : positivePrompt.defaults[index]),
		BoundingBoxes: boundingBoxes.keys.map((key, index) =>
			key === "editor_state" || key === "last_incoming" ? state : boundingBoxes.defaults[index]),
		Resolution: resolution.keys.map((key, index) =>
			key === "aspect_ratio" ? canvas.aspectRatio
				: key === "megapixels" ? canvas.megapixels
					: resolution.defaults[index]),
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

export function buildMossBoundingBoxState(
	boxes: MOSSBoundingBoxSpec[],
	canvas: Pick<MOSSCanvasSize, "width" | "height"> = { width: MOSS_CANVAS_SIZE, height: MOSS_CANVAS_SIZE },
): MOSSBoundingBoxState {
	if (!Array.isArray(boxes) || boxes.length === 0 || boxes.length > MAX_MOSS_LAYOUT_BOXES) {
		throw new Error(`MOSS layouts require 1-${MAX_MOSS_LAYOUT_BOXES} bounding boxes.`);
	}
	const background = boxes[0];
	if (
		!background ||
		typeof background !== "object" ||
		background.kind !== "object" ||
		background.x !== 0 ||
		background.y !== 0 ||
		background.width !== 1 ||
		background.height !== 1
	) {
		throw new Error("The first MOSS bounding box must be an object covering the full canvas background.");
	}
	const normalized = boxes.map((box, index) => {
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
		const kind = text ? "text" : box.kind === "character" ? "character" : "object";
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

		const x = Math.round(box.x * canvas.width);
		const y = Math.round(box.y * canvas.height);
		const right = Math.round((box.x + box.width) * canvas.width);
		const bottom = Math.round((box.y + box.height) * canvas.height);
		if (right <= x || bottom <= y) {
			throw new Error(`Bounding box ${index + 1} is too small after conversion to canvas pixels.`);
		}
		return {
			x,
			y,
			width: right - x,
			height: bottom - y,
			metadata: {
				type: kind === "text" ? "text" as const : "obj" as const,
				text,
				desc: description,
				palette: [],
			},
		};
	});
	return { __value__: normalized };
}

export function normalizeMossBoundingBoxes(boxes?: MOSSBoundingBoxSpec[]): MOSSBoundingBoxSpec[] {
	const supplied = boxes ?? [];
	if (!Array.isArray(supplied)) throw new Error("MOSS boxes must be an array when provided.");
	const background = {
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		kind: "object" as const,
		description: "Full-canvas scene background",
	};
	if (supplied.length === 0) return [background];

	const first = supplied[0];
	const includesBackground = first !== undefined && first.kind !== "character" && first.kind !== "text" &&
		first.x === 0 && first.y === 0 && first.width === 1 && first.height === 1;
	if (includesBackground) {
		const normalizedBackground = { ...first, kind: "object" as const };
		return [normalizedBackground, ...supplied.slice(1, MAX_MOSS_LAYOUT_BOXES)];
	}
	return [background, ...supplied.slice(0, MAX_MOSS_LAYOUT_BOXES - 1)];
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
