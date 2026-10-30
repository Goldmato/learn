import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	cleanupBreezeAudio,
	generateBreezeAudio,
	validateGeneratedAudioSource,
} from "../../lib/teach-breeze-tts.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function breezeTts(pi: ExtensionAPI) {
	pi.registerTool({
		name: "teach_breeze_generate_audio",
		label: "Teaching: Generate Breeze TTS Audio",
		description: "Generate a Breeze TTS WAV, return its exact spoken transcript, and stage it at the exact temporary path supplied by the main teacher. Does not access or edit the linked note.",
		promptSnippet: "Generate and stage one Breeze TTS WAV",
		promptGuidelines: [
			"Generate exactly one narration using the supplied voice preset and stage the WAV at the exact handoffPath supplied by the main teacher.",
			"Do not inspect or edit notes, move files into the vault, or perform placeholder or attachment operations. Return the exact RESULT block from the tool, including the complete JSON-encoded transcript field.",
		],
		parameters: Type.Object({
			speechText: Type.String({ minLength: 1, maxLength: 12_000 }),
			voiceInstruction: Type.String({ minLength: 1, maxLength: 500 }),
			audioDescription: Type.String({ minLength: 1, maxLength: 120 }),
			handoffPath: Type.String({ minLength: 1 }),
			voicePreset: Type.Object({
				id: Type.String({ minLength: 1 }),
				name: Type.String({ minLength: 1 }),
				mode: Type.Union([Type.Literal("standard"), Type.Literal("clone")]),
				wavsDirectory: Type.Optional(Type.String({ minLength: 1 })),
				transcriptsDirectory: Type.Optional(Type.String({ minLength: 1 })),
				styleInstructionsPath: Type.Optional(Type.String({ minLength: 1 })),
				styleInstructions: Type.Optional(Type.Unknown()),
			}, { additionalProperties: false }),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal) {
			const handoffPath = path.resolve(params.handoffPath);
			let generated: Awaited<ReturnType<typeof generateBreezeAudio>> | undefined;
			try {
				const directory = path.dirname(handoffPath);
				const directoryStat = fs.lstatSync(directory);
				if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
					throw new Error("Breeze handoff directory must be an existing, real directory.");
				}
				if (path.extname(handoffPath).toLowerCase() !== ".wav" || fs.existsSync(handoffPath)) {
					throw new Error("Breeze handoff path must be a new WAV file path.");
				}
				generated = await generateBreezeAudio(params.speechText, params.voiceInstruction, signal, params.voicePreset);
				fs.copyFileSync(generated.path, handoffPath, fs.constants.COPYFILE_EXCL);
				validateGeneratedAudioSource(handoffPath, directory);
				const descriptionWords = params.audioDescription.trim().split(/\s+/);
				if (descriptionWords.length !== 5) throw new Error("Audio filename description must contain exactly five words.");
				return {
					content: [{
						type: "text" as const,
						text: [
							"RESULT:",
							"status: success",
							`handoffPath: ${handoffPath}`,
							`audioDescription: ${params.audioDescription.trim()}`,
							`voiceName: ${generated.voiceName ?? ""}`,
							`referenceId: ${generated.referenceId ?? ""}`,
							`transcript: ${JSON.stringify(params.speechText)}`,
						].join("\n"),
					}],
					details: {
						status: "success",
						handoffPath,
						audioDescription: params.audioDescription.trim(),
						voiceName: generated.voiceName,
						referenceId: generated.referenceId,
						transcript: params.speechText,
					},
				};
			} catch (error) {
				try {
					if (fs.existsSync(handoffPath)) fs.unlinkSync(handoffPath);
				} catch { /* preserve the generation error */ }
				return {
					content: [{ type: "text" as const, text: `RESULT:\nstatus: failure\nerror: ${errorMessage(error)}` }],
					details: { status: "failed", error: errorMessage(error) },
				};
			} finally {
				if (generated) {
					try {
						cleanupBreezeAudio(generated);
					} catch { /* the main agent owns staged-artifact cleanup */ }
				}
			}
		},
	});
}
