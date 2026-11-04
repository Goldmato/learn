import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	transcriptContainsAnchor,
	TEACH_IMAGE_PLACEMENT_ENTRY,
} from "../lib/md-log-format.ts";
import {
	findVaultRoot,
	insertImagePlaceholder,
	removeImagePlaceholder,
} from "../lib/teach-image-attachment.ts";
import { recoverUnresolvedPlacement } from "../lib/placement-recovery-ui.ts";
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
	const activeAgents = new Map<string, { markerId: string; notePath: string; anchor: string; ctx: any }>();
	const earlyCompletions = new Map<string, Record<string, unknown>>();

	function latestPlacement(ctx: any, markerId: string): Record<string, unknown> | undefined {
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (isRecord(entry) && entry.type === "custom" &&
				entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY && isRecord(entry.data) &&
				entry.data.markerId === markerId) return entry.data;
		}
		return undefined;
	}

	async function recover(markerId: string, notePath: string, ctx: any, event: unknown): Promise<void> {
		const marker = `%%pi-comfyui-image:${markerId}%%`;
		await recoverUnresolvedPlacement(ctx, {
			markerId,
			generator: IMAGE_MAKER_AGENT,
			kind: "image",
			status: "unresolved",
			notePath,
		}, event, {
			remove: () => withMdLogWriteLock(() => {
				const placement = latestPlacement(ctx, markerId);
				const note = fs.readFileSync(notePath, "utf-8");
				const firstIndex = note.indexOf(marker);
				if (firstIndex < 0 || note.indexOf(marker, firstIndex + marker.length) >= 0) {
					throw new Error("The exact image marker is missing or duplicated; it was not removed.");
				}
				removeImagePlaceholder(notePath, markerId);
				pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
					...placement, markerId, status: "cancelled", notePath,
				});
			}),
		});
	}

	async function finalizeAgent(event: Record<string, unknown>): Promise<void> {
		if (event.type !== IMAGE_MAKER_AGENT || typeof event.id !== "string") return;
		const agentId = event.id;
		const request = activeAgents.get(agentId);
		if (!request) {
			earlyCompletions.set(agentId, event);
			return;
		}
		activeAgents.delete(agentId);
		const placement = latestPlacement(request.ctx, request.markerId);
		if (placement?.status === "placed" || placement?.status === "cancelled") return;
		if (placement?.status !== "failed") {
			pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
				...placement,
				markerId: request.markerId,
				status: "failed",
				error: "The image generator returned without a confirmed placement.",
				notePath: request.notePath,
				anchor: request.anchor,
			});
		}
		await recover(request.markerId, request.notePath, request.ctx, event);
	}

	pi.events?.on("subagents:completed", (data) => { if (isRecord(data)) return finalizeAgent(data); });
	pi.events?.on("subagents:failed", (data) => { if (isRecord(data)) return finalizeAgent(data); });
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
			"Generate an image only when it materially helps explain or contextualize the current learning point; after an assessment, do not generate one mechanically or before it could reveal the answer.",
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

			const { markerId, anchorId, notePath } = await withMdLogWriteLock(() => {
				const linkedNote = readLinkedNotePath(ctx.sessionManager.getEntries());
				if (!linkedNote) throw new Error("Link the current lesson note with /md-log before requesting an image.");
				const resolvedNote = path.isAbsolute(linkedNote) ? linkedNote : path.resolve(ctx.cwd, linkedNote);
				if (!fs.statSync(resolvedNote).isFile()) throw new Error(`Linked md-log path is not a file: ${resolvedNote}`);
				findVaultRoot(resolvedNote);
				if (!transcriptContainsAnchor(ctx.sessionManager.getEntries(), insertAfter)) {
					throw new Error("Image insertion anchor must be exact text from the managed linked-note transcript.");
				}
				const id = randomUUID();
				const anchorId = randomUUID();
				insertImagePlaceholder(resolvedNote, id, insertAfter, anchorId);
				pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
					markerId: id,
					anchorId,
					status: "pending",
					notePath: resolvedNote,
					anchor: insertAfter,
					captionTitle,
					caption,
				});
				return { markerId: id, anchorId, notePath: resolvedNote };
			});

			const subagentPrompt = [
				"Create one image for this plain-language request. Interpret the request yourself and make all ComfyUI API/workflow choices.",
				"Use only the fixed MOSS image workflow available through your tools. Choose a suitable aspect ratio and layout; use the workflow's supported box limit.",
				"Do not inspect project files, request extra context, or return image data.",
				"When generation succeeds, call teach_attach_generated_image with the exact generated sourcePath, a short descriptive topic, the exact captionTitle and caption below, and the markerId and notePath below. The attachment tool duplicates the image into the vault and replaces the marker with a titled, italicized quote block followed by a standard Obsidian image embed.",
				"If generation fails, call teach_attach_generated_image with markerId, notePath, and the exact error (no sourcePath, topic, captionTitle, or caption). The marker is preserved for the learner's recovery choice; return the exact error without claiming success.",
				"",
				`Image request: ${prompt}`,
				`Caption: ${caption}`,
				`Caption title: ${captionTitle}`,
				`markerId: ${markerId}`,
				`notePath: ${notePath}`,
				`insertAfter: ${insertAfter}`,
			].join("\n");
			const recordFailure = (failure: string) => withMdLogWriteLock(() => {
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
				await recover(markerId, notePath, ctx, { result: failure });
				throw error;
			} finally {
				authorizedAgentCalls.delete(_toolCallId);
			}

			const backgroundAgent = outcome.result.details;
			if (outcome.isError || !isBackgroundAgentResult(backgroundAgent)) {
				const failure = resultText(outcome.result) || "The image-maker subagent could not be started.";
				await recordFailure(failure);
				await recover(markerId, notePath, ctx, outcome.result);
				throw new Error(failure);
			}

			pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
				markerId,
				anchorId,
				status: "dispatched",
				agentId: backgroundAgent.agentId,
				notePath,
				anchor: insertAfter,
				captionTitle,
				caption,
			});
			activeAgents.set(backgroundAgent.agentId, { markerId, notePath, anchor: insertAfter, ctx });
			const earlyCompletion = earlyCompletions.get(backgroundAgent.agentId);
			if (earlyCompletion) {
				earlyCompletions.delete(backgroundAgent.agentId);
				void finalizeAgent(earlyCompletion);
			}
			return {
				content: [{ type: "text" as const, text: "Image request started in the background; a placeholder is in the linked note." }],
				details: { status: "dispatched", agentId: backgroundAgent.agentId },
			};
		},
	});
}
