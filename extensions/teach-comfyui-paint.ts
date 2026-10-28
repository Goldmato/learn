import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	extractManagedTranscript,
	TEACH_IMAGE_PLACEMENT_ENTRY,
} from "../lib/md-log-format.ts";
import {
	findVaultRoot,
	insertImagePlaceholder,
	removeImagePlaceholder,
} from "../lib/teach-image-attachment.ts";
import { readLinkedNotePath } from "../lib/teach-learning-state.ts";
import { withMdLogWriteLock } from "../lib/md-log-write-lock.ts";

const IMAGE_MAKER_AGENT = "comfyui-image-maker";

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBackgroundAgentResult(value: unknown): value is { status: "background"; agentId: string } {
	return typeof value === "object" &&
		value !== null &&
		"status" in value &&
		value.status === "background" &&
		"agentId" in value &&
		typeof value.agentId === "string" &&
		value.agentId.length > 0;
}

export default function teachComfyuiPaint(pi: ExtensionAPI) {
	const authorizedAgentCalls = new Set<string>();
	pi.on("tool_call", (event) => {
		if (event.toolName !== "Agent" || !isRecord(event.input) || event.input.subagent_type !== IMAGE_MAKER_AGENT) {
			return;
		}
		if (event.parentToolCallId && authorizedAgentCalls.has(event.parentToolCallId)) return;
		return {
			block: true,
			reason: `Launch ${IMAGE_MAKER_AGENT} only through teach_comfyui_paint so the linked-note marker and attachment context are supplied.`,
		};
	});

	pi.registerTool({
		name: "teach_comfyui_paint",
		label: "Teaching: Paint an Image",
		description: "The only supported way to request a ComfyUI image. Provide a plain-language prompt, a short descriptive caption title, an explanatory caption, and an exact, unique sentence or paragraph in the managed linked-note transcript after which the image should appear; the tool places a marker there and starts the image-maker in the background.",
		promptSnippet: "Request a supporting image with a simple visual prompt",
		promptGuidelines: [
			"Use this tool for every ComfyUI image request; do not launch comfyui-image-maker directly with Agent.",
			"Provide a plain-language visual request, a concise human-readable captionTitle naming the image's subject, a brief caption explaining what the image shows and represents, and an exact, unique sentence or paragraph from the managed linked-note transcript as insertAfter. Choose the most contextually appropriate location; do not use image bytes to make these choices.",
		],
		parameters: Type.Object({
			prompt: Type.String({ minLength: 1, description: "Plain-language description of the image to create." }),
			captionTitle: Type.String({ minLength: 1, maxLength: 100, description: "Short human-readable title for the image description callout." }),
			caption: Type.String({ minLength: 1, maxLength: 500, description: "One or two concise sentences describing what the image shows and what it represents." }),
			insertAfter: Type.String({ minLength: 1, description: "Exact unique sentence or paragraph in the managed linked-note transcript; the image will appear immediately after it." }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const prompt = params.prompt.trim();
			if (!prompt) throw new Error("Image prompt must contain non-whitespace text.");
			const captionTitle = params.captionTitle.replace(/\s+/g, " ").trim();
			if (!captionTitle || captionTitle.length > 100) throw new Error("Image captionTitle must contain 1-100 non-whitespace characters.");
			const caption = params.caption.replace(/\s+/g, " ").trim();
			if (!caption || caption.length > 500) throw new Error("Image caption must contain 1-500 non-whitespace characters.");
			const insertAfter = params.insertAfter.trim();
			if (!insertAfter) throw new Error("Image insertion anchor must contain non-whitespace text.");

			const { markerId, notePath } = await withMdLogWriteLock(() => {
				const linkedNote = readLinkedNotePath(ctx.sessionManager.getEntries());
				if (!linkedNote) throw new Error("Link the current lesson note with /md-log before requesting an image.");
				const resolvedNote = path.isAbsolute(linkedNote) ? linkedNote : path.resolve(ctx.cwd, linkedNote);
				if (!fs.statSync(resolvedNote).isFile()) throw new Error(`Linked md-log path is not a file: ${resolvedNote}`);
				findVaultRoot(resolvedNote);
				const managedTranscript = extractManagedTranscript(fs.readFileSync(resolvedNote, "utf-8"));
				const anchorIndex = managedTranscript?.indexOf(insertAfter) ?? -1;
				if (anchorIndex < 0) {
					throw new Error("Image insertion anchor must be exact text from the managed linked-note transcript.");
				}
				if (managedTranscript?.indexOf(insertAfter, anchorIndex + insertAfter.length) >= 0) {
					throw new Error("Image insertion anchor occurs more than once in the managed transcript; choose a more specific passage.");
				}
				const id = randomUUID();
				insertImagePlaceholder(resolvedNote, id, insertAfter);
				pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
					markerId: id,
					status: "pending",
					notePath: resolvedNote,
					anchor: insertAfter,
					captionTitle,
					caption,
				});
				return { markerId: id, notePath: resolvedNote };
			});

			const subagentPrompt = [
				"Create one image for this plain-language request. Interpret the request yourself and make all ComfyUI API/workflow choices.",
				"Use only the fixed MOSS image workflow available through your tools. Choose a suitable aspect ratio and layout; use the workflow's supported box limit.",
				"Do not inspect project files, request extra context, or return image data.",
				"When generation succeeds, call teach_attach_generated_image with the exact generated sourcePath, a short descriptive topic, the exact captionTitle and caption below, and the markerId and notePath below. The attachment tool duplicates the image into the vault and replaces the marker with a titled, italicized quote block followed by a standard Obsidian image embed.",
				"If generation fails, call teach_attach_generated_image with markerId, notePath, and the exact error (no sourcePath, topic, captionTitle, or caption) to remove the placeholder; then return that error without claiming success.",
				"",
				`Image request: ${prompt}`,
				`Caption: ${caption}`,
				`Caption title: ${captionTitle}`,
				`markerId: ${markerId}`,
				`notePath: ${notePath}`,
				`insertAfter: ${insertAfter}`,
			].join("\n");
			const recordFailure = (failure: string) => withMdLogWriteLock(() => {
				removeImagePlaceholder(notePath, markerId);
				pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
					markerId,
					status: "failed",
					error: failure,
					notePath,
					anchor: insertAfter,
					captionTitle,
					caption,
				});
			});

			authorizedAgentCalls.add(_toolCallId);
			let outcome: Awaited<ReturnType<typeof ctx.executeTool>>;
			try {
				outcome = await ctx.executeTool("Agent", {
					subagent_type: IMAGE_MAKER_AGENT,
					description: "Generate and place an image",
					prompt: subagentPrompt,
					run_in_background: true,
					inherit_context: false,
				}, { signal });
			} catch (error) {
				const failure = error instanceof Error ? error.message : String(error);
				await recordFailure(failure);
				throw error;
			} finally {
				authorizedAgentCalls.delete(_toolCallId);
			}

			const backgroundAgent = outcome.result.details;
			if (outcome.isError || !isBackgroundAgentResult(backgroundAgent)) {
				const failure = resultText(outcome.result) || "The image-maker subagent could not be started.";
				await recordFailure(failure);
				throw new Error(failure);
			}

			pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
				markerId,
				status: "dispatched",
				agentId: backgroundAgent.agentId,
				notePath,
				anchor: insertAfter,
				captionTitle,
				caption,
			});
			return {
				content: [{ type: "text" as const, text: "Image request started in the background; a placeholder is in the linked note." }],
				details: { status: "dispatched", agentId: backgroundAgent.agentId },
			};
		},
	});
}
