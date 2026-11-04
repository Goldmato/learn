import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	renameGeneratedImage,
	resolvePaintOutputRoot,
} from "../../lib/teach-image-attachment.ts";
import { getConfig } from "../../npm/node_modules/pi-comfyui-paint/src/config.ts";
import { createJobStatusTool } from "../../npm/node_modules/pi-comfyui-paint/src/tools/job-status.ts";
import { createPaintTool } from "../../npm/node_modules/pi-comfyui-paint/src/tools/paint.ts";
import { createValidateWorkflowTool } from "../../npm/node_modules/pi-comfyui-paint/src/tools/validate-workflow.ts";
import {
	buildMossWorkflowVariables,
	MAX_MOSS_INPUT_BOXES,
	MOSS_ASPECT_RATIOS,
	MOSS_WORKFLOW,
	normalizeMossBoundingBoxes,
	pathOnlyResult,
	requirePreviewDisabled,
	resolveMossCanvasSize,
	suggestMossFilename,
	validateMossWorkflowInput,
} from "../../lib/comfyui-image-policy.ts";
import {
	loadWorkflowJson,
	parseWorkflowDetails,
	resolveWorkflowPath,
} from "../../npm/node_modules/pi-comfyui-paint/src/workflow.ts";

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameCompletedImage<T extends {
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
}>(result: T, filename: string, outputRoot: string): T {
	if (result.details?.state !== "completed") return result;
	const files = result.details.files;
	if (!Array.isArray(files)) throw new Error("Completed ComfyUI job did not include output file details.");
	const images = files.filter((file) =>
		isRecord(file) &&
		typeof file.path === "string" &&
		typeof file.mimeType === "string" &&
		file.mimeType.startsWith("image/"),
	);
	if (images.length !== 1 || !isRecord(images[0]) || typeof images[0].path !== "string") {
		throw new Error(`Expected exactly one generated image, but ComfyUI returned ${images.length}.`);
	}

	const previousPath = images[0].path;
	const renamedPath = renameGeneratedImage(previousPath, outputRoot, filename);
	const renamedFiles = files.map((file) =>
		isRecord(file) && file.path === previousPath
			? { ...file, path: renamedPath, filename: renamedPath.split(/[\\/]/).at(-1) }
			: file,
	);
	return {
		...result,
		content: result.content.map((part) =>
			part.type === "text" && typeof part.text === "string"
				? { ...part, text: part.text.replaceAll(previousPath, renamedPath) }
				: part,
		),
		details: { ...result.details, files: renamedFiles },
	};
}

export default function comfyuiImage(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const config = getConfig(cwd);
	const validateTool = createValidateWorkflowTool(config);
	const jobStatusTool = createJobStatusTool(config);
	const paintTool = createPaintTool(config, cwd);

	pi.registerTool({
		name: "teach_comfyui_job_status",
		label: "Teaching: MOSS Job Status",
		description: "Check a MOSS image-generation job and retrieve its output path without returning image data.",
		promptSnippet: "Check a MOSS image-generation job by ID",
		parameters: Type.Object({
			jobId: Type.String({ minLength: 1 }),
			filename: Type.Optional(Type.String({
				maxLength: 80,
				description: "Optional descriptive base name supplied at generation; omit the file extension.",
			})),
		}),
		async execute(_toolCallId, params, signal) {
			requirePreviewDisabled(config.inlineImageLimit);
			const filename = params.filename?.trim() || `generated-illustration-${params.jobId.trim()}`;
			const result = await jobStatusTool.execute({ job_id: params.jobId.trim() }, signal);
			const pathResult = renameCompletedImage(pathOnlyResult(result),
				filename,
				resolvePaintOutputRoot(cwd),
			);
			if (pathResult.details) pathResult.details = { ...pathResult.details, filename };
			return pathResult;
		},
	});

	pi.registerTool({
		name: "teach_comfyui_generate",
		label: "Teaching: Generate MOSS Image",
		description: "Generate one learner-facing MOSS image from a bounded prompt and the fixed approved workflow.",
		promptSnippet: "Generate a learner-facing MOSS image from the approved workflow",
		promptGuidelines: [
			"Use only the fixed MOSS workflow; do not inspect local files or request access to other workflows.",
			"Keep the prompt focused on the requested illustration and its visible composition.",
			"Select an aspectRatio that fits the composition. If omitted, the tool infers one from the prompt; it does not default every image to square.",
			"Bounding boxes are optional. If omitted, the tool adds a valid full-canvas background box. The workflow supports 12 boxes total; extra boxes are safely omitted rather than causing the generation call to fail.",
			"Use normalized coordinates. A visible text value automatically makes its box a text box; otherwise kind defaults to object.",
			"Supply a concise, descriptive filename of a few words when practical; otherwise the tool derives one from the prompt and safely renames the completed output.",
			"Resolution is computed automatically from aspect ratio using 0.8-1.2 megapixels.",
		],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1 }),
			filename: Type.Optional(Type.String({
				maxLength: 80,
				description: "A few-word descriptive base name for the generated image, without a file extension.",
			})),
			aspectRatio: Type.Optional(Type.Union(MOSS_ASPECT_RATIOS.map((ratio) => Type.Literal(ratio)))),
			negativePrompt: Type.Optional(Type.String()),
			boxes: Type.Optional(Type.Array(Type.Object({
				x: Type.Number({ minimum: 0, maximum: 1 }),
				y: Type.Number({ minimum: 0, maximum: 1 }),
				width: Type.Number({ minimum: 0, maximum: 1 }),
				height: Type.Number({ minimum: 0, maximum: 1 }),
				kind: Type.Optional(Type.Union([
					Type.Literal("object"),
					Type.Literal("character"),
					Type.Literal("text"),
				])),
				description: Type.Optional(Type.String({ maxLength: 240 })),
				text: Type.Optional(Type.String({ maxLength: 100 })),
			}), { maxItems: MAX_MOSS_INPUT_BOXES })),
		}),
		async execute(_toolCallId, params, signal, onUpdate) {
			requirePreviewDisabled(config.inlineImageLimit);
			const prompt = params.prompt.trim();
			const filename = params.filename?.trim() || suggestMossFilename(prompt);
			if (!prompt) throw new Error("Image prompt must contain non-whitespace text.");
			const validation = await validateTool.execute({ workflow: MOSS_WORKFLOW }, signal);
			if (validation.details?.valid !== true) {
				throw new Error(`MOSS workflow validation failed:\n${textContent(validation)}`);
			}

			const workflowPath = resolveWorkflowPath(
				config.workflowDir,
				MOSS_WORKFLOW,
				config.bundledWorkflowDir,
			);
			const workflow = loadWorkflowJson(workflowPath);
			if (!workflow) throw new Error(`Failed to load MOSS workflow: ${workflowPath}`);
			const details = parseWorkflowDetails(workflow);
			const negativePrompt = params.negativePrompt?.trim();
			const canvas = resolveMossCanvasSize(prompt, params.aspectRatio);
			const normalizedBoxes = normalizeMossBoundingBoxes(params.boxes);
			const omittedBoxes = Math.max(0, (params.boxes?.length ?? 0) - normalizedBoxes.length);
			const variables = buildMossWorkflowVariables(details.rawVars, params.boxes, prompt, canvas.aspectRatio);
			validateMossWorkflowInput(details.rawVars, variables, negativePrompt);

			const result = await paintTool.execute({
				prompt,
				workflow: MOSS_WORKFLOW,
				...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
				variables,
			}, signal, onUpdate);
			const pathResult = renameCompletedImage(pathOnlyResult(result),
				filename,
				resolvePaintOutputRoot(cwd),
			);
			if (pathResult.details) {
				pathResult.details = {
					...pathResult.details,
					filename,
					...(pathResult.details.state === "completed" ? {
						imageSettings: { aspectRatio: canvas.aspectRatio, megapixels: canvas.megapixels },
						...(omittedBoxes > 0 ? { omittedLayoutBoxes: omittedBoxes } : {}),
					} : {}),
				};
			}
			return pathResult;
		},
	});
}
