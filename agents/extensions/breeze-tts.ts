import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cleanupBreezeAudio,
	findAudioVaultRoot,
	generateBreezeAudio,
	moveGeneratedAudio,
	replaceAudioPlaceholder,
	validateAudioDescription,
} from "../../lib/teach-breeze-tts.ts";
import { TEACH_BREEZE_TTS_PLACEMENT_ENTRY } from "../../lib/md-log-format.ts";
import { withMdLogWriteLock } from "../../lib/md-log-write-lock.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function latestPlacement(entries: unknown[], markerId: string): Record<string, unknown> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			isRecord(entry.data) &&
			entry.data.markerId === markerId
		) {
			return entry.data;
		}
	}
	return undefined;
}

export default function breezeTts(pi: ExtensionAPI) {
	pi.registerTool({
		name: "teach_breeze_generate_and_attach",
		label: "Teaching: Generate and Place Breeze TTS",
		description: "Generate one Breeze TTS WAV from the supplied speech text and replace the exact linked-note placeholder with its Obsidian audio embed.",
		promptSnippet: "Generate a Breeze TTS WAV and place it in the linked lesson note",
		promptGuidelines: [
			"Use exactly once per request with the reframed spoken text, concise voice instruction, an exactly five-word description of the narration for its filename, markerId, and notePath provided by the main teacher. The tool applies the session-selected voice preset; clone presets use a random matching reference pair, and the standard preset does not clone.",
			"Do not inspect generated audio or call other commands. Return the exact failure output and keep the placeholder on failure.",
		],
		parameters: Type.Object({
			speechText: Type.String({ minLength: 1, maxLength: 12_000 }),
			voiceInstruction: Type.String({ minLength: 1, maxLength: 500 }),
			audioDescription: Type.String({ minLength: 1, maxLength: 120 }),
			markerId: Type.String({ minLength: 1 }),
			notePath: Type.String({ minLength: 1 }),
			voicePreset: Type.Object({
				id: Type.String({ minLength: 1 }),
				name: Type.String({ minLength: 1 }),
				mode: Type.Union([Type.Literal("standard"), Type.Literal("clone")]),
				wavsDirectory: Type.Optional(Type.String({ minLength: 1 })),
				transcriptsDirectory: Type.Optional(Type.String({ minLength: 1 })),
			}, { additionalProperties: false }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const markerId = params.markerId.trim();
			if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("markerId must be the UUID supplied for this speech request.");
			const notePath = path.isAbsolute(params.notePath) ? params.notePath : path.resolve(ctx.cwd, params.notePath);
			const initialPlacement = latestPlacement(ctx.sessionManager.getEntries(), markerId);
			if (initialPlacement?.status === "placed" && typeof initialPlacement.vaultRelativePath === "string") {
				return {
					content: [{ type: "text" as const, text: `RESULT:\nstatus: success\nattachmentPath: ${initialPlacement.vaultRelativePath}` }],
					details: { status: "success", markerId, attachmentPath: initialPlacement.vaultRelativePath },
				};
			}

			let generated: Awaited<ReturnType<typeof generateBreezeAudio>> | undefined;
			try {
				const noteStat = fs.lstatSync(notePath);
				if (!noteStat.isFile() || noteStat.isSymbolicLink()) throw new Error(`Linked md-log path is not a regular file: ${notePath}`);
				const vaultRoot = findAudioVaultRoot(notePath);
				if (initialPlacement && path.resolve(String(initialPlacement.notePath)) !== path.resolve(notePath)) {
					throw new Error(`Breeze TTS marker ${markerId} belongs to a different linked note.`);
				}
				if (initialPlacement && initialPlacement.status !== "pending" && initialPlacement.status !== "dispatched") {
					throw new Error(`Breeze TTS marker ${markerId} is not pending generation.`);
				}
				const marker = `%%pi-breeze-tts:${markerId}%%`;
				if (!fs.readFileSync(notePath, "utf-8").includes(marker)) {
					throw new Error(`Breeze TTS placeholder was not found in the linked note: ${markerId}`);
				}
				validateAudioDescription(params.audioDescription);
				const voicePreset = params.voicePreset;
				generated = await generateBreezeAudio(params.speechText, params.voiceInstruction, signal, voicePreset);
				const placement = await withMdLogWriteLock(() => {
					const markerData = latestPlacement(ctx.sessionManager.getEntries(), markerId);
					if (markerData?.status === "cancelled") {
						throw new Error(`Breeze TTS placeholder ${markerId} was cancelled before generation completed.`);
					}
					if (markerData && path.resolve(String(markerData.notePath)) !== path.resolve(notePath)) {
						throw new Error(`Breeze TTS placeholder ${markerId} no longer points to the supplied note.`);
					}
					const currentNote = fs.readFileSync(notePath, "utf-8");
					if (!currentNote.includes(marker)) throw new Error(`Breeze TTS placeholder was not found in the linked note: ${markerId}`);

					const placementData = markerData ?? initialPlacement ?? {
						markerId,
						notePath,
						status: "pending",
						anchor: "",
						conceptText: "",
					};
					const attached = moveGeneratedAudio(
						generated!.path,
						path.dirname(generated!.path),
						vaultRoot,
						params.audioDescription,
						generated!.voiceName,
					);
					try {
						replaceAudioPlaceholder(notePath, markerId, attached.vaultRelativePath);
					} catch (error) {
						try {
							fs.unlinkSync(attached.path);
						} catch (cleanupError) {
							throw new Error(
								`Could not replace the Breeze TTS placeholder (${errorMessage(error)}); ` +
								`could not remove the copied audio (${errorMessage(cleanupError)}).`,
							);
						}
						throw error;
					}
					pi.appendEntry(TEACH_BREEZE_TTS_PLACEMENT_ENTRY, {
						...placementData,
						markerId,
						status: "placed",
						filename: attached.filename,
						path: attached.path,
						vaultRelativePath: attached.vaultRelativePath,
						voicePresetId: voicePreset.id,
						voicePresetName: voicePreset.name,
						...(generated!.referenceId ? { voiceReferenceId: generated!.referenceId } : {}),
						notePath,
					});
					return attached;
				});

				let cleanupWarning: string | undefined;
				try {
					cleanupBreezeAudio(generated);
				} catch (error) {
					cleanupWarning = errorMessage(error);
				}
				return {
					content: [{
						type: "text" as const,
						text: [
							"RESULT:",
							"status: success",
							`attachmentPath: ${placement.vaultRelativePath}`,
							cleanupWarning ? `warning: generated temporary files could not be removed: ${cleanupWarning}` : "",
						].filter(Boolean).join("\n"),
					}],
					details: {
						status: "success",
						markerId,
						filename: placement.filename,
						path: placement.path,
						vaultRelativePath: placement.vaultRelativePath,
						voicePresetId: voicePreset.id,
						voicePresetName: voicePreset.name,
						...(generated.referenceId ? { voiceReferenceId: generated.referenceId } : {}),
						warning: cleanupWarning,
					},
				};
			} catch (error) {
				let failure = errorMessage(error);
				if (generated) {
					try {
						cleanupBreezeAudio(generated);
					} catch (cleanupError) {
						failure += `; temporary files could not be removed: ${errorMessage(cleanupError)}`;
					}
				}
				pi.appendEntry(TEACH_BREEZE_TTS_PLACEMENT_ENTRY, {
					...(initialPlacement ?? {}),
					markerId,
					status: "failed",
					error: failure,
					notePath,
				});
				return {
					content: [{
						type: "text" as const,
						text: `RESULT:\nstatus: failure\nmarkerId: ${markerId}\nerror: ${failure}`,
					}],
					details: { status: "failed", markerId, error: failure },
				};
			}
		},
	});
}
