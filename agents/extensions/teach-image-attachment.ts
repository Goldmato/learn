import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	TEACH_ATTACH_IMAGE_TOOL,
	TEACH_IMAGE_PLACEMENT_ENTRY,
} from "../../lib/md-log-format.ts";
import {
	copyGeneratedImage,
	findVaultRoot,
	removeImagePlaceholder,
	replaceImagePlaceholder,
	resolvePaintOutputRoot,
	validateGeneratedImageSource,
} from "../../lib/teach-image-attachment.ts";
import { withMdLogWriteLock } from "../../lib/md-log-write-lock.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function teachImageAttachment(pi: ExtensionAPI) {
	pi.registerTool({
		name: TEACH_ATTACH_IMAGE_TOOL,
		label: "Teaching: Place Generated Image",
		description: "Duplicate a generated image into the vault and replace its exact note marker with an image embed.",
		promptSnippet: "Place the generated image at its supplied linked-note marker",
		promptGuidelines: [
			"Use only with the source path returned by the ComfyUI generation tool.",
			"Do not read or inspect the generated image; this tool copies it without exposing image bytes.",
			"Use the supplied markerId and notePath. If generation fails, pass the exact error without a sourcePath to clear the placeholder.",
		],
		parameters: Type.Object({
			sourcePath: Type.Optional(Type.String({ minLength: 1 })),
			topic: Type.Optional(Type.String({ minLength: 1, description: "Short topic label used to name the attachment." })),
			captionTitle: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Short, human-readable callout title describing the image's subject." })),
			caption: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Short main-agent-written explanation shown above the image." })),
			markerId: Type.String({ minLength: 1 }),
			notePath: Type.String({ minLength: 1 }),
			error: Type.Optional(Type.String({ minLength: 1, description: "Exact generation or attachment error; provide this instead of sourcePath when the job failed." })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const markerId = params.markerId.trim();
			const notePathArg = params.notePath.trim();
			const sourcePathArg = params.sourcePath?.trim();
			const topic = params.topic?.trim();
			const captionTitle = params.captionTitle?.trim();
			const caption = params.caption?.replace(/\s+/g, " ").trim();
			const errorMessage = params.error?.trim();
			if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("markerId must be the UUID supplied for this image request.");
			if (!notePathArg) throw new Error("notePath must contain a file path.");
			if (errorMessage ? sourcePathArg || topic || captionTitle || caption : !sourcePathArg || !topic || !captionTitle || !caption) {
				throw new Error("Provide sourcePath, topic, captionTitle, and caption for successful generation or error for a failed job.");
			}

			return withMdLogWriteLock(() => {
				const notePath = path.isAbsolute(notePathArg) ? notePathArg : path.resolve(ctx.cwd, notePathArg);
				if (!fs.statSync(notePath).isFile()) throw new Error(`Linked md-log path is not a file: ${notePath}`);
				const vaultRoot = findVaultRoot(notePath);
				const entries = ctx.sessionManager.getEntries();
				const pendingPlacement = entries.find((entry: unknown) =>
					isRecord(entry) &&
					entry.type === "custom" &&
					entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
					isRecord(entry.data) &&
					entry.data.markerId === markerId,
				);
				const placementData = isRecord(pendingPlacement) && isRecord(pendingPlacement.data)
					? pendingPlacement.data
					: undefined;

				if (!errorMessage) {
					const previous = entries.find((entry: unknown) =>
						isRecord(entry) &&
						entry.type === "custom" &&
						entry.customType === TEACH_IMAGE_PLACEMENT_ENTRY &&
						isRecord(entry.data) &&
						entry.data.markerId === markerId &&
						entry.data.status === "placed",
					);
					if (isRecord(previous) && isRecord(previous.data)) {
						const filename = previous.data.filename;
						const attachmentPath = previous.data.path;
						if (typeof filename !== "string" || typeof attachmentPath !== "string" || !fs.existsSync(attachmentPath)) {
							throw new Error(`Previously placed image is missing from the vault for marker ${markerId}.`);
						}
						const vaultRelativePath = path.relative(vaultRoot, attachmentPath).split(path.sep).join("/");
						return {
							content: [{ type: "text" as const, text: `Image is already placed in the linked note (${vaultRelativePath}).` }],
							details: { status: "placed", markerId, filename, path: attachmentPath, vaultRelativePath },
						};
					}
				}

				const marker = `%%pi-comfyui-image:${markerId}%%`;
				const noteContents = fs.readFileSync(notePath, "utf-8");
				const firstMarker = noteContents.indexOf(marker);
				if (firstMarker < 0) throw new Error(`Image placeholder was not found in the linked note: ${markerId}`);
				if (noteContents.indexOf(marker, firstMarker + marker.length) >= 0) {
					throw new Error(`Image placeholder occurs more than once in the linked note: ${markerId}`);
				}

				if (errorMessage) {
					removeImagePlaceholder(notePath, markerId);
					pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, { markerId, status: "failed", error: errorMessage });
					return {
						content: [{ type: "text" as const, text: `Image placeholder cleared after generation failed: ${errorMessage}` }],
						details: { status: "failed", markerId, error: errorMessage },
					};
				}

				if (!sourcePathArg || !topic || !captionTitle) {
					throw new Error("Provide sourcePath, topic, and captionTitle for successful image placement.");
				}
				const outputRoot = resolvePaintOutputRoot(ctx.cwd);
				const realSourcePath = validateGeneratedImageSource(
					path.resolve(ctx.cwd, sourcePathArg),
					outputRoot,
				);
				const attached = copyGeneratedImage(realSourcePath, outputRoot, vaultRoot, topic);
				const vaultRelativePath = path.relative(vaultRoot, attached.path).split(path.sep).join("/");
				try {
					if (!caption) throw new Error("A short explanatory caption is required to place the generated image.");
					replaceImagePlaceholder(notePath, markerId, vaultRelativePath, captionTitle, caption);
				} catch (error) {
					try {
						fs.unlinkSync(attached.path);
					} catch (cleanupError) {
						throw new Error(
							`Could not replace the image placeholder (${error instanceof Error ? error.message : String(error)}); ` +
							`could not remove the copied image (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
						);
					}
					throw error;
				}

				pi.appendEntry(TEACH_IMAGE_PLACEMENT_ENTRY, {
					markerId,
					status: "placed",
					sourcePath: attached.sourcePath,
					filename: attached.filename,
					path: attached.path,
					vaultRelativePath,
					notePath,
					anchor: typeof placementData?.anchor === "string" ? placementData.anchor : undefined,
					captionTitle,
					caption,
				});
				return {
					content: [{ type: "text" as const, text: `Image placed at its placeholder in the linked note (${vaultRelativePath}).` }],
					details: {
						status: "placed",
						markerId,
						sourcePath: attached.sourcePath,
						filename: attached.filename,
						path: attached.path,
						vaultRelativePath,
					},
				};
			});
		},
	});
}
