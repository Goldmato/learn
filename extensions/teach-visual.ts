import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	transcriptContainsAnchor,
	TEACH_VISUAL_PLACEMENT_ENTRY,
	type VisualKind,
	VISUAL_KINDS,
} from "../lib/md-log-format.ts";
import { findVaultRoot } from "../lib/teach-image-attachment.ts";
import { insertVisualPlaceholder, removeVisualPlaceholder } from "../lib/teach-visual-attachment.ts";
import { readLinkedNotePath } from "../lib/teach-learning-state.ts";
import { withMdLogWriteLock } from "../lib/md-log-write-lock.ts";

const VISUAL_MAKERS: Record<VisualKind, string> = {
	mermaid: "mermaid-maker",
	svg: "svg-maker",
};

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

export default function teachVisual(pi: ExtensionAPI) {
	const authorizedAgentCalls = new Set<string>();
	pi.on("tool_call", (event) => {
		if (event.toolName !== "Agent" || !isRecord(event.input)) return;
		const type = event.input.subagent_type;
		if (type !== VISUAL_MAKERS.mermaid && type !== VISUAL_MAKERS.svg) return;
		if (event.parentToolCallId && authorizedAgentCalls.has(event.parentToolCallId)) return;
		return {
			block: true,
			reason: `Launch ${String(type)} only through teach_visual so the linked-note marker and attachment context are supplied.`,
		};
	});

	pi.registerTool({
		name: "teach_visual",
		label: "Teaching: Draw a Picture",
		description: "The only supported way to request a diagram. Pick the kind, give a brief, a short caption title, an explanatory caption, and an exact unique anchor in the managed linked-note transcript; the tool places a marker there and starts the matching maker in the background. The published picture replaces the marker as a captioned embed.",
		promptSnippet: "Request a supporting diagram (mermaid or svg)",
		promptGuidelines: [
			"Use this tool for every diagram request; do not launch mermaid-maker or svg-maker directly with Agent.",
			"Choose kind: mermaid for structural/relational pictures (dependency graphs, flows, sequences, state machines, trees, ER, timelines); svg for spatial/geometric pictures (coordinates, number lines, vectors, plots, physical layouts).",
			"The brief is a plain-language description of the idea to show. Do not write Mermaid or SVG source yourself.",
			"Provide a concise captionTitle naming the picture's subject, a brief caption explaining what it shows, and an exact unique sentence or paragraph from the managed linked-note transcript as insertAfter.",
		],
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("mermaid"), Type.Literal("svg")], {
				description: "mermaid for structural/relational pictures, svg for spatial/geometric ones.",
			}),
			brief: Type.String({ minLength: 1, description: "Plain-language description of the idea the picture must show." }),
			captionTitle: Type.String({ minLength: 1, maxLength: 100, description: "Short human-readable title for the picture's description callout." }),
			caption: Type.String({ minLength: 1, maxLength: 500, description: "One or two concise sentences describing what the picture shows and what it represents." }),
			insertAfter: Type.String({ minLength: 1, description: "Exact unique sentence or paragraph in the managed linked-note transcript; the picture will appear immediately after it." }),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const kind = params.kind;
			const brief = params.brief.trim();
			if (!brief) throw new Error("Visual brief must contain non-whitespace text.");
			const captionTitle = params.captionTitle.replace(/\s+/g, " ").trim();
			if (!captionTitle || captionTitle.length > 100) throw new Error("Visual captionTitle must contain 1-100 non-whitespace characters.");
			const caption = params.caption.replace(/\s+/g, " ").trim();
			if (!caption || caption.length > 500) throw new Error("Visual caption must contain 1-500 non-whitespace characters.");
			const insertAfter = params.insertAfter.trim();
			if (!insertAfter) throw new Error("Visual insertion anchor must contain non-whitespace text.");

			const { markerId, notePath } = await withMdLogWriteLock(() => {
				const linkedNote = readLinkedNotePath(ctx.sessionManager.getEntries());
				if (!linkedNote) throw new Error("Link the current lesson note with /md-log before requesting a diagram.");
				const resolvedNote = path.isAbsolute(linkedNote) ? linkedNote : path.resolve(ctx.cwd, linkedNote);
				if (!fs.statSync(resolvedNote).isFile()) throw new Error(`Linked md-log path is not a file: ${resolvedNote}`);
				findVaultRoot(resolvedNote);
				if (!transcriptContainsAnchor(ctx.sessionManager.getEntries(), insertAfter)) {
					throw new Error("Visual insertion anchor must be exact text from the managed linked-note transcript.");
				}
				const id = randomUUID();
				insertVisualPlaceholder(resolvedNote, kind, id, insertAfter);
				pi.appendEntry(TEACH_VISUAL_PLACEMENT_ENTRY, {
					markerId: id,
					visualKind: kind,
					status: "pending",
					notePath: resolvedNote,
					anchor: insertAfter,
					captionTitle,
					caption,
				});
				return { markerId: id, notePath: resolvedNote };
			});

			const subagentPrompt = [
				`Create one ${VISUAL_KINDS[kind].label.toLowerCase()} for this brief. Interpret it yourself and make all composition choices.`,
				"Follow your normal authoring loop: write, preview-render, LOOK at the result, iterate until it is correct and clean, then publish with save_as.",
				"After publishing, call teach_attach_generated_visual with the exact published path, the exact captionTitle and caption below, and the markerId and notePath below. That tool replaces the note marker with a titled quote block and an embed.",
				"If you cannot produce a correct picture, call teach_attach_generated_visual with markerId, notePath, and the exact reason (no sourcePath, captionTitle, or caption) to clear the placeholder; then return that reason.",
				"",
				`Brief: ${brief}`,
				`Caption: ${caption}`,
				`Caption title: ${captionTitle}`,
				`markerId: ${markerId}`,
				`notePath: ${notePath}`,
			].join("\n");

			const recordFailure = (failure: string) => withMdLogWriteLock(() => {
				removeVisualPlaceholder(notePath, kind, markerId);
				pi.appendEntry(TEACH_VISUAL_PLACEMENT_ENTRY, {
					markerId,
					visualKind: kind,
					status: "failed",
					error: failure,
					notePath,
					anchor: insertAfter,
					captionTitle,
					caption,
				});
			});

			authorizedAgentCalls.add(toolCallId);
			let outcome: Awaited<ReturnType<typeof ctx.executeTool>>;
			try {
				outcome = await ctx.executeTool("Agent", {
					subagent_type: VISUAL_MAKERS[kind],
					description: `Draw and place a ${kind} picture`,
					prompt: subagentPrompt,
					run_in_background: true,
					inherit_context: false,
				}, { signal });
			} catch (error) {
				const failure = error instanceof Error ? error.message : String(error);
				await recordFailure(failure);
				throw error;
			} finally {
				authorizedAgentCalls.delete(toolCallId);
			}

			const backgroundAgent = outcome.result.details;
			if (outcome.isError || !isBackgroundAgentResult(backgroundAgent)) {
				const failure = resultText(outcome.result) || `The ${kind}-maker subagent could not be started.`;
				await recordFailure(failure);
				throw new Error(failure);
			}

			pi.appendEntry(TEACH_VISUAL_PLACEMENT_ENTRY, {
				markerId,
				visualKind: kind,
				status: "dispatched",
				agentId: backgroundAgent.agentId,
				notePath,
				anchor: insertAfter,
				captionTitle,
				caption,
			});
			return {
				content: [{ type: "text" as const, text: `${VISUAL_KINDS[kind].label} request started in the background; a placeholder is in the linked note.` }],
				details: { status: "dispatched", agentId: backgroundAgent.agentId, markerId },
			};
		},
	});
}
