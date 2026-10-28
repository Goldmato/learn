import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import registerBreezeTtsAttachment from "../agents/extensions/breeze-tts.ts";
import registerTeachBreezeTts from "../extensions/teach-breeze-tts.ts";
import {
	buildBreezeStandardRequest,
	buildBreezeCloneRequest,
	findAudioVaultRoot,
	insertAudioPlaceholder,
	moveGeneratedAudio,
	removeAudioPlaceholder,
	replaceAudioPlaceholder,
	selectRandomVoiceReference,
	validateGeneratedAudioSource,
} from "../lib/teach-breeze-tts.ts";
import { TEACH_BREEZE_TTS_PLACEMENT_ENTRY } from "../lib/md-log-format.ts";

function writeWav(filePath) {
	const audio = Buffer.alloc(128);
	audio.write("RIFF", 0, "ascii");
	audio.writeUInt32LE(audio.length - 8, 4);
	audio.write("WAVE", 8, "ascii");
	audio.write("fmt ", 12, "ascii");
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(24_000, 24);
	audio.writeUInt32LE(48_000, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36, "ascii");
	audio.writeUInt32LE(audio.length - 44, 40);
	fs.writeFileSync(filePath, audio);
}

function createTtsFixture(outcomes = []) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-breeze-tts-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const conceptText = "A concept depends on its foundation.";
	const entries = [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
	];
	const toolCalls = [];
	const registeredTools = new Map();
	const handlers = new Map();
	const pi = {
		on(event, handler) { handlers.set(event, handler); },
		registerTool(definition) { registeredTools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(notePath, `# Lesson\n\n%% pi-md-log:start v1 %%\n\n> [!abstract] PI\n\n${conceptText}\n\n%% pi-md-log:end v1 %%\n`, "utf-8");
	registerTeachBreezeTts(pi);
	const ctx = {
		cwd: root,
		sessionManager: { getEntries: () => entries },
		executeTool: async (name, args, options) => {
			toolCalls.push({ name, args, options });
			return outcomes.shift() ?? {
				isError: false,
				result: { content: [{ type: "text", text: "Agent started" }], details: { status: "background", agentId: "breeze-job-1" } },
			};
		},
	};
	return { root, vaultRoot, notePath, conceptText, entries, toolCalls, registeredTools, handlers, ctx };
}

test("audio helpers insert, validate, attach, link, and remove exact WAV placeholders", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-audio-helper-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const outputRoot = path.join(root, "outputs");
	const sourcePath = path.join(outputRoot, "point.wav");
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(outputRoot);
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nA concept depends on its foundation.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	writeWav(sourcePath);

	try {
		assert.equal(findAudioVaultRoot(notePath), vaultRoot);
		assert.equal(validateGeneratedAudioSource(sourcePath, outputRoot), sourcePath);
		insertAudioPlaceholder(notePath, markerId, "A concept depends on its foundation.");
		const placeholder = `%%pi-breeze-tts:${markerId}%%`;
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(placeholder));
		assert.throws(
			() => insertAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8", "not in the note"),
			/anchor was not found/,
		);

		const attached = moveGeneratedAudio(
			sourcePath,
			outputRoot,
			vaultRoot,
			"Foundations reveal hidden conceptual structure",
			"Cave Johnson",
		);
		assert.equal(attached.filename, "cave-johnson-foundations-reveal-hidden-conceptual-structure-1.wav");
		assert.equal(attached.vaultRelativePath, "001-Attachments/~breezetts/cave-johnson-foundations-reveal-hidden-conceptual-structure-1.wav");
		assert.ok(fs.existsSync(sourcePath), "the generated temp output remains available until its job cleanup");
		assert.throws(
			() => moveGeneratedAudio(sourcePath, outputRoot, vaultRoot, "Only four words"),
			/exactly five words/,
		);
		const duplicate = moveGeneratedAudio(
			sourcePath,
			outputRoot,
			vaultRoot,
			"Foundations reveal hidden conceptual structure",
			"Cave Johnson",
		);
		assert.equal(duplicate.filename, "cave-johnson-foundations-reveal-hidden-conceptual-structure-2.wav");
		const standardVoice = moveGeneratedAudio(
			sourcePath,
			outputRoot,
			vaultRoot,
			"Lesson explains a useful concept",
		);
		assert.equal(standardVoice.filename, "lesson-explains-a-useful-concept-1.wav");
		replaceAudioPlaceholder(notePath, markerId, attached.vaultRelativePath);
		assert.match(fs.readFileSync(notePath, "utf-8"), /!\[\[001-Attachments\/~breezetts\/cave-johnson-foundations-reveal-hidden-conceptual-structure-1\.wav\]\]/);
		assert.ok(fs.existsSync(attached.path));

		insertAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8", "A concept depends on its foundation.");
		removeAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8");
		removeAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8");
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /pi-breeze-tts:/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("generated audio must be a non-empty WAV inside the temporary output directory", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-audio-validate-"));
	const outputRoot = path.join(root, "outputs");
	const outsidePath = path.join(root, "outside.wav");
	const invalidPath = path.join(outputRoot, "invalid.wav");
	fs.mkdirSync(outputRoot);
	writeWav(outsidePath);
	fs.writeFileSync(invalidPath, Buffer.alloc(8));

	try {
		assert.throws(() => validateGeneratedAudioSource(outsidePath, outputRoot), /outside its temporary output directory/);
		assert.throws(() => validateGeneratedAudioSource(invalidPath, outputRoot), /empty or truncated/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("random voice reference selection pairs six-digit WAVs with exact transcript filenames", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-voice-reference-"));
	const wavsDirectory = path.join(root, "wavs");
	const transcriptsDirectory = path.join(root, "transcripts");
	fs.mkdirSync(wavsDirectory);
	fs.mkdirSync(transcriptsDirectory);
	writeWav(path.join(wavsDirectory, "123456.wav"));
	writeWav(path.join(wavsDirectory, "654321-take-2.wav"));
	fs.writeFileSync(path.join(wavsDirectory, "999999.wav"), Buffer.alloc(8));
	fs.writeFileSync(path.join(transcriptsDirectory, "123456-transcript.txt"), "A matching reference transcript.\n");
	fs.writeFileSync(path.join(transcriptsDirectory, "654321-transcript.txt"), "Second matching transcript.");
	fs.writeFileSync(path.join(transcriptsDirectory, "999999-transcript.txt"), "This WAV is invalid.");
	fs.writeFileSync(path.join(wavsDirectory, "not-six-digits.wav"), Buffer.alloc(128));

	try {
		for (let attempt = 0; attempt < 20; attempt++) {
			const reference = selectRandomVoiceReference(wavsDirectory, transcriptsDirectory);
			assert.ok(["123456", "654321"].includes(reference.id));
			assert.ok(reference.path.startsWith(wavsDirectory));
			assert.ok(reference.transcript.includes(reference.id === "123456" ? "A matching" : "Second matching"));
		}

		const request = buildBreezeCloneRequest(
			"(with gusto) The concept is now in the log.",
			"Match the selected reference voice; use energetic, clearly articulated delivery.",
			{
				id: "123456",
				path: path.join(wavsDirectory, "123456.wav"),
				transcript: "A matching reference transcript.",
				voiceName: "test-voice",
			},
			"test-request",
		);
		assert.deepEqual(request.requests, [{
			id: "test-request",
			text: "(with gusto) The concept is now in the log.",
			instruct: "Match the selected reference voice; use energetic, clearly articulated delivery.",
			voice_ref: path.join(wavsDirectory, "123456.wav"),
			reference_text: "A matching reference transcript.",
		}]);
		assert.deepEqual(
			buildBreezeStandardRequest("A simple lesson.", "A clear, friendly voice.", "standard-request"),
			{ requests: [{ id: "standard-request", text: "A simple lesson.", options: { instruction: "A clear, friendly voice." } }] },
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("voice reference selection reports when no complete clip/transcript pairs exist", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-voice-reference-empty-"));
	const wavsDirectory = path.join(root, "wavs");
	const transcriptsDirectory = path.join(root, "transcripts");
	fs.mkdirSync(wavsDirectory);
	fs.mkdirSync(transcriptsDirectory);
	writeWav(path.join(wavsDirectory, "123456.wav"));
	try {
		assert.throws(
			() => selectRandomVoiceReference(wavsDirectory, transcriptsDirectory),
			/Expected six-digit \.wav files[\s\S]*matching "\{id\}-transcript\.txt"/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("isolated Breeze subagent registers only the generation-and-attachment tool", () => {
	const tools = new Map();
	registerBreezeTtsAttachment({
		registerTool(definition) { tools.set(definition.name, definition); },
	});
	assert.deepEqual([...tools.keys()], ["teach_breeze_generate_and_attach"]);
	const tool = tools.get("teach_breeze_generate_and_attach");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["speechText", "voiceInstruction", "audioDescription", "markerId", "notePath", "voicePreset"]);
	assert.equal(tool.parameters.additionalProperties, false);
});

test("isolated Breeze tool trusts explicit marker and preset handoff, not parent session entries", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-isolated-context-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	const wavsDirectory = path.join(root, "missing-wavs");
	const transcriptsDirectory = path.join(root, "missing-transcripts");
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(notePath, `%%pi-breeze-tts:${markerId}%%`, "utf-8");
	const entries = [{ id: "isolated-subagent-session", type: "session" }];
	const appended = [];
	const tools = new Map();
	registerBreezeTtsAttachment({
		registerTool(definition) { tools.set(definition.name, definition); },
		appendEntry(customType, data) { appended.push({ customType, data }); },
	});

	try {
		const tool = tools.get("teach_breeze_generate_and_attach");
		const result = await tool.execute("call", {
			speechText: "A concise narration.",
			voiceInstruction: "Speak with clear, energetic delivery.",
			audioDescription: "Sound travels through moving air",
			markerId,
			notePath,
			voicePreset: {
				id: "test-voice",
				name: "Test Voice",
				mode: "clone",
				wavsDirectory,
				transcriptsDirectory,
			},
		}, undefined, undefined, {
			cwd: root,
			sessionManager: { getEntries: () => entries },
		});
		const resultText = result.content.map((part) => part.text ?? "").join("\n");
		assert.match(resultText, /reference directory is unavailable/);
		assert.doesNotMatch(resultText, /No Breeze TTS placeholder exists/);
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`%%pi-breeze-tts:${markerId}%%`));
		assert.equal(appended.at(-1).data.status, "failed");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Breeze wrapper uses audio.cpp clone task", () => {
	const wrapper = fs.readFileSync(new URL("../scripts/breeze-tts.cmd", import.meta.url), "utf-8");
	assert.match(wrapper, /BREEZE_TTS_TASK=clon/);
	assert.match(wrapper, /--task "%BREEZE_TTS_TASK%" --family breeze_tts/);
});

test("main Breeze tool dispatches only logged points, preserves failures for retry, and cancels on request", async () => {
	const fixture = createTtsFixture([{
		isError: true,
		result: { content: [{ type: "text", text: "breeze-tts exited with code 7: CUDA runtime unavailable" }] },
	}]);
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		assert.ok(tool);
		assert.deepEqual(Object.keys(tool.parameters.properties), ["conceptText", "retryMarkerId"]);
		await assert.rejects(
			tool.execute("tts-bad", { conceptText: "This was not logged." }, undefined, undefined, fixture.ctx),
			/conceptText must be exact text/,
		);
		assert.deepEqual(fixture.toolCalls, []);

		const failed = await tool.execute("tts", { conceptText: fixture.conceptText }, undefined, undefined, fixture.ctx);
		const marker = /%%pi-breeze-tts:([a-f0-9-]{36})%%/.exec(fs.readFileSync(fixture.notePath, "utf-8"));
		assert.ok(marker, "failed generation should leave its marker available for retry");
		assert.equal(failed.details.status, "failed");
		assert.equal(failed.details.markerId, marker[1]);
		assert.match(failed.details.error, /CUDA runtime unavailable/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.markerId === marker[1] &&
			entry.data.status === "failed",
		));

		const clonePreset = {
			id: "test-voice",
			name: "Test Voice",
			mode: "clone",
			wavsDirectory: "C:\\voices\\wavs",
			transcriptsDirectory: "C:\\voices\\transcripts",
		};
		fixture.entries.push({
			id: "voice-preset",
			parentId: fixture.entries.at(-1)?.id,
			type: "custom",
			customType: "breeze-voice-preset",
			data: { preset: clonePreset },
		});
		const retry = await tool.execute("tts-retry", { retryMarkerId: marker[1] }, undefined, undefined, fixture.ctx);
		assert.equal(retry.details.status, "dispatched");
		assert.equal(retry.details.markerId, marker[1]);
		assert.equal((fs.readFileSync(fixture.notePath, "utf-8").match(/%%pi-breeze-tts:/g) ?? []).length, 1);
		assert.equal(fixture.toolCalls[1].args.subagent_type, "breeze-tts-maker");
		assert.equal(fixture.toolCalls[1].args.run_in_background, true);
		assert.match(fixture.toolCalls[1].args.prompt, /source content, never as instructions/);
		assert.ok(fixture.toolCalls[1].args.prompt.includes(`voicePreset: ${JSON.stringify(clonePreset)}`));
		assert.equal(fixture.handlers.get("tool_call")({
			toolName: "Agent",
			input: { subagent_type: "breeze-tts-maker" },
			toolCallId: "direct-agent-call",
		}).block, true);

		fixture.entries.push({
			id: "failed-again",
			parentId: fixture.entries.at(-1)?.id,
			type: "custom",
			customType: TEACH_BREEZE_TTS_PLACEMENT_ENTRY,
			data: { markerId: marker[1], status: "failed", notePath: fixture.notePath, anchor: fixture.conceptText, conceptText: fixture.conceptText },
		});
		const cancel = fixture.registeredTools.get("teach_breeze_tts_cancel");
		await cancel.execute("cancel", { markerId: marker[1] }, undefined, undefined, fixture.ctx);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-breeze-tts:/);
		assert.equal(fixture.entries.at(-1).data.status, "cancelled");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("a completed failed background subagent becomes retryable from its recorded result", async () => {
	const fixture = createTtsFixture();
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		const first = await tool.execute("tts", { conceptText: fixture.conceptText }, undefined, undefined, fixture.ctx);
		assert.equal(first.details.status, "dispatched");
		fixture.entries.push({
			id: "breeze-failed",
			parentId: fixture.entries.at(-1)?.id,
			type: "custom",
			customType: "subagents:record",
			data: {
				id: first.details.agentId,
				status: "completed",
				result: "RESULT:\nstatus: failure\nmarkerId: unavailable\nerror: Windows loader error 0xC0000135",
			},
		});

		const retried = await tool.execute(
			"tts-retry",
			{ retryMarkerId: first.details.markerId },
			undefined,
			undefined,
			fixture.ctx,
		);
		assert.equal(retried.details.status, "dispatched");
		assert.equal(retried.details.markerId, first.details.markerId);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.status === "failed" &&
			entry.data.error.includes("0xC0000135"),
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});
