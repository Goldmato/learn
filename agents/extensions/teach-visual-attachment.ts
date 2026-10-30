import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	isVisualKind,
	TEACH_ATTACH_VISUAL_TOOL,
	TEACH_VISUAL_PLACEMENT_ENTRY,
	type VisualKind,
	VISUAL_KINDS,
	visualMarker,
} from "../../lib/md-log-format.ts";
import { findVaultRoot } from "../../lib/teach-image-attachment.ts";
import {
	removeVisualPlaceholder,
	replaceVisualPlaceholder,
	validatePublishedVisual,
} from "../../lib/teach-visual-attachment.ts";
import { withMdLogWriteLock } from "../../lib/md-log-write-lock.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function teachVisualAttachment(pi: ExtensionAPI) {
	pi.registerTool({
		name: TEACH_ATTACH_VISUAL_TOOL,
		label: "Teaching: Place Published Picture",
		description: "Replace a diagram placeholder in the linked note with the published PNG, as a titled quote block and an embed.",
		promptSnippet: "Place the published picture at its supplied linked-note marker",
		promptGuidelines: [
			"Use only with the path returned by render_mermaid or render_svg after publishing with save_as.",
			"Do not read or inspect the PNG; this tool only validates and links it.",
			"Use the supplied markerId, notePath, and kind. If authoring failed, pass the exact reason without a sourcePath to clear the placeholder.",
		],
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("mermaid"), Type.Literal("svg")]),
			sourcePath: Type.Optional(Type.String({ minLength: 1, description: "Absolute path returned by the publish render." })),
			captionTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
			caption: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
			markerId: Type.String({ minLength: 1 }),
			notePath: Type.String({ minLength: 1 }),
			error: Type.Optional(Type.String({ minLength: 1, description: "Exact authoring error; provide this instead of sourcePath when the picture failed." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const kind: VisualKind | undefined = isVisualKind(params.kind) ? params.kind : undefined;
			if (!kind) throw new Error("kind must be mermaid or svg.");
			const markerId = params.markerId.trim();
			const notePathArg = params.notePath.trim();
			const sourcePathArg = params.sourcePath?.trim();
			const captionTitle = params.captionTitle?.trim();
			const caption = params.caption?.replace(/\s+/g, " ").trim();
			const errorMessage = params.error?.trim();
			if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("markerId must be the UUID supplied for this request.");
			if (!notePathArg) throw new Error("notePath must contain a file path.");
			if (errorMessage ? sourcePathArg || captionTitle || caption : !sourcePathArg || !captionTitle || !caption) {
				throw new Error("Provide sourcePath, captionTitle, and caption for a published picture or error for a failed one.");
			}

			return withMdLogWriteLock(() => {
				const notePath = path.isAbsolute(notePathArg) ? notePathArg : path.resolve(ctx.cwd, notePathArg);
				if (!fs.statSync(notePath).isFile()) throw new Error(`Linked md-log path is not a file: ${notePath}`);
				const vaultRoot = findVaultRoot(notePath);
				const entries = ctx.sessionManager.getEntries();
				const placementData = entries
					.filter((entry: unknown) =>
						isRecord(entry) &&
						entry.type === "custom" &&
						entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY &&
						isRecord(entry.data) &&
						entry.data.markerId === markerId)
					.map((entry: unknown) => (entry as { data: Record<string, unknown> }).data)
					.at(-1);

				if (!errorMessage) {
					const previous = entries.find((entry: unknown) =>
						isRecord(entry) &&
						entry.type === "custom" &&
						entry.customType === TEACH_VISUAL_PLACEMENT_ENTRY &&
						isRecord(entry.data) &&
						entry.data.markerId === markerId &&
						entry.data.status === "placed",
					);
					if (isRecord(previous) && isRecord(previous.data)) {
						const vaultRelativePath = previous.data.vaultRelativePath;
						if (typeof vaultRelativePath !== "string") {
							throw new Error(`Previously placed picture has no recorded path for marker ${markerId}.`);
						}
						return {
							content: [{ type: "text" as const, text: `Picture is already placed in the linked note (${vaultRelativePath}).` }],
							details: { status: "placed", markerId, vaultRelativePath },
						};
					}
				}

				if (errorMessage) {
					removeVisualPlaceholder(notePath, kind, markerId);
					pi.appendEntry(TEACH_VISUAL_PLACEMENT_ENTRY, { markerId, visualKind: kind, status: "failed", error: errorMessage });
					return {
						content: [{ type: "text" as const, text: `Visual placeholder cleared after authoring failed: ${errorMessage}` }],
						details: { status: "failed", markerId, error: errorMessage },
					};
				}

				if (!sourcePathArg || !captionTitle || !caption) {
					throw new Error("Provide sourcePath, captionTitle, and caption for a published picture.");
				}
				const vaultRelativePath = validatePublishedVisual(path.resolve(ctx.cwd, sourcePathArg), vaultRoot, kind);
				replaceVisualPlaceholder(notePath, kind, markerId, vaultRelativePath, captionTitle, caption);

				pi.appendEntry(TEACH_VISUAL_PLACEMENT_ENTRY, {
					markerId,
					visualKind: kind,
					status: "placed",
					sourcePath: path.resolve(ctx.cwd, sourcePathArg),
					vaultRelativePath,
					notePath,
					anchor: typeof placementData?.anchor === "string" ? placementData.anchor : undefined,
					captionTitle,
					caption,
				});
				return {
					content: [{ type: "text" as const, text: `Picture placed at its placeholder in the linked note (${vaultRelativePath}).` }],
					details: { status: "placed", markerId, vaultRelativePath },
				};
			});
		},
	});
}
