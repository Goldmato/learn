import { validateAudioDescription } from "./teach-breeze-tts.ts";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped", "aborted", "error"]);

export interface BreezeCompletionEvent {
	status?: unknown;
	result?: unknown;
	error?: unknown;
}

export type BreezeCompletion =
	| { kind: "success"; handoffPath: string; audioDescription: string; voiceName?: string; referenceId?: string; transcript: string }
	| { kind: "failure"; error: string };

function resultBlock(value: unknown): string {
	if (typeof value !== "string") return "";
	return /RESULT:\s*([\s\S]*)/.exec(value)?.[1] ?? value;
}

function field(block: string, name: string): string | undefined {
	return new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(block)?.[1];
}

function errorText(error: unknown): string | undefined {
	return typeof error === "string" && error.trim() ? error : undefined;
}

export function isTerminalBreezeCompletionStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

/** Classify lifecycle state and validate the textual RESULT contract in one place. */
export function classifyBreezeCompletion(event: BreezeCompletionEvent): BreezeCompletion {
	const block = resultBlock(event.result);
	const resultStatus = /^status:\s*(success|failure)\s*$/m.exec(block)?.[1];
	if (event.status !== "completed" || resultStatus !== "success") {
		const failure = errorText(event.error) ??
			(resultStatus === "failure" ? block.trim() || "Subagent reported failure without details." : undefined) ??
			`Breeze TTS subagent ended with status ${String(event.status ?? "unknown")}.`;
		return { kind: "failure", error: failure };
	}

	try {
		const handoffPath = field(block, "handoffPath")?.trim();
		if (!handoffPath) throw new Error("Breeze TTS subagent returned no audio handoff path.");

		const audioDescription = field(block, "audioDescription")?.trim() ?? "";
		validateAudioDescription(audioDescription);

		const transcriptJson = field(block, "transcript");
		if (transcriptJson === undefined) throw new Error("Breeze TTS subagent returned no transcript for the generated audio.");
		let transcript: unknown;
		try {
			transcript = JSON.parse(transcriptJson);
		} catch {
			throw new Error("Breeze TTS subagent returned an invalid JSON transcript.");
		}
		if (typeof transcript !== "string" || !transcript.trim()) {
			throw new Error("Breeze TTS subagent returned an empty or invalid transcript.");
		}

		const voiceName = field(block, "voiceName")?.trim() || undefined;
		const referenceId = field(block, "referenceId")?.trim() || undefined;
		return {
			kind: "success",
			handoffPath,
			audioDescription,
			...(voiceName ? { voiceName } : {}),
			...(referenceId ? { referenceId } : {}),
			transcript,
		};
	} catch (error) {
		return { kind: "failure", error: error instanceof Error ? error.message : String(error) };
	}
}
