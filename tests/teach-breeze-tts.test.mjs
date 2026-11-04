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
import { renderAudioTranscriptCallout, TEACH_BREEZE_TTS_PLACEMENT_ENTRY } from "../lib/md-log-format.ts";

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
		{ id: "anchor", parentId: "mdlog", type: "message", message: { role: "assistant", content: [{ type: "text", text: conceptText }] } },
	];
	const toolCalls = [];
	const registeredTools = new Map();
	const handlers = new Map();
	const eventHandlers = new Map();
	const pi = {
		events: {
			on(event, handler) { eventHandlers.set(event, handler); return () => eventHandlers.delete(event); },
			emit(event, payload) { return eventHandlers.get(event)?.(payload); },
		},
		on(event, handler) { handlers.set(event, handler); },
		registerTool(definition) { registeredTools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(path.join(root, "local-paths.json"), JSON.stringify({ version: 1 }), "utf-8");
	fs.writeFileSync(notePath, `---\nbreeze-voice-preset: "Standard Breeze voice"\n---\n\n# Lesson\n\n%% pi-md-log:start v1 %%\n\n> [!abstract] PI\n\n${conceptText}\n\n%% pi-md-log:end v1 %%\n`, "utf-8");
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
	return { root, vaultRoot, notePath, conceptText, entries, toolCalls, registeredTools, handlers, eventHandlers, pi, ctx };
}

function backgroundRequest(conceptText, scriptMode = "interpretive", narrationText) {
	return {
		conceptText,
		executionMode: "background",
		scriptMode,
		...(narrationText ? { narrationText } : {}),
	};
}

test("audio helpers insert, validate, attach, link, and remove exact WAV placeholders", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-audio-helper-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const outputRoot = path.join(root, "outputs");
	const sourcePath = path.join(outputRoot, "point.wav");
	const markerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a7";
	const anchorId = "64e2a2eb-5d4d-4987-89df-5bed565d0c87";
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(outputRoot);
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nA concept depends on its foundation.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	writeWav(sourcePath);

	try {
		assert.equal(findAudioVaultRoot(notePath), vaultRoot);
		assert.equal(validateGeneratedAudioSource(sourcePath, outputRoot), sourcePath);
		insertAudioPlaceholder(notePath, markerId, "A concept depends on its foundation.", anchorId);
		const placeholder = `%%pi-breeze-tts:${markerId}%%`;
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(placeholder));
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`%%pi-placement-anchor:${anchorId}:${markerId}%%`));
		// A lost anchor no longer fails the request; the marker is appended instead.
		insertAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8", "not in the note");
		assert.match(fs.readFileSync(notePath, "utf-8"), /%%pi-breeze-tts:e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8%%\n\n%% pi-md-log:end v1 %%/);
		removeAudioPlaceholder(notePath, "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8");
		assert.doesNotMatch(fs.readFileSync(notePath, "utf-8"), /e9bf16f0-8071-4f9d-9f60-5fcce8cf09a8/);

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
		const transcript = "First spoken line.\nSecond *spoken* line.";
		replaceAudioPlaceholder(
			notePath,
			markerId,
			attached.vaultRelativePath,
			"Foundations reveal hidden conceptual structure",
			transcript,
		);
		const placedNote = fs.readFileSync(notePath, "utf-8");
		assert.match(placedNote, /!\[\[001-Attachments\/~breezetts\/cave-johnson-foundations-reveal-hidden-conceptual-structure-1\.wav\]\]/);
		assert.ok(placedNote.includes(renderAudioTranscriptCallout(
			"Foundations reveal hidden conceptual structure",
			transcript,
		)));
		assert.ok(placedNote.includes('> "*First spoken line\\. Second \\*spoken\\* line\\.*"'));
		assert.ok(fs.existsSync(attached.path));

		const quotedNotePath = path.join(root, "quoted.md");
		const quotedMarkerId = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09a9";
		fs.writeFileSync(
			quotedNotePath,
			`%% pi-md-log:start v1 %%\nThe quoted statement ends here.\n\n%%pi-breeze-tts:${quotedMarkerId}%%\n> ”\n%% pi-md-log:end v1 %%\n`,
			"utf-8",
		);
		replaceAudioPlaceholder(
			quotedNotePath,
			quotedMarkerId,
			"001-Attachments/~breezetts/cave-johnson-foundations-reveal-hidden-conceptual-structure-2.wav",
		);
		const quotePreserved = fs.readFileSync(quotedNotePath, "utf-8");
		assert.ok(quotePreserved.indexOf("”") < quotePreserved.indexOf("![[001-Attachments/~breezetts/cave-johnson-foundations-reveal-hidden-conceptual-structure-2.wav]]"));

		const markdownQuotedPath = path.join(root, "markdown-quoted.md");
		const markdownQuotedMarker = "e9bf16f0-8071-4f9d-9f60-5fcce8cf09aa";
		fs.writeFileSync(
			markdownQuotedPath,
			`%% pi-md-log:start v1 %%\n> "*A quoted passage ends here\\.*"\n%% pi-md-log:end v1 %%\n`,
			"utf-8",
		);
		insertAudioPlaceholder(markdownQuotedPath, markdownQuotedMarker, "A quoted passage ends here\\.");
		const markdownQuoted = fs.readFileSync(markdownQuotedPath, "utf-8");
		assert.ok(markdownQuoted.indexOf('\\.*"') < markdownQuoted.indexOf(`%%pi-breeze-tts:${markdownQuotedMarker}%%`));

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

test("isolated Breeze subagent registers only the audio-generation tool", () => {
	const tools = new Map();
	registerBreezeTtsAttachment({
		registerTool(definition) { tools.set(definition.name, definition); },
	});
	assert.deepEqual([...tools.keys()], ["teach_breeze_generate_audio"]);
	const tool = tools.get("teach_breeze_generate_audio");
	assert.deepEqual(Object.keys(tool.parameters.properties), ["speechText", "voiceInstruction", "audioDescription", "handoffPath", "voicePreset"]);
	assert.equal(tool.parameters.additionalProperties, false);
});

test("isolated Breeze generator does not receive or manipulate the linked note", async () => {
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
		const handoffDirectory = path.join(root, "handoff");
		fs.mkdirSync(handoffDirectory);
		const tool = tools.get("teach_breeze_generate_audio");
		const result = await tool.execute("call", {
			speechText: "A concise narration.",
			voiceInstruction: "Speak with clear, energetic delivery.",
			audioDescription: "Sound travels through moving air",
			handoffPath: path.join(handoffDirectory, "generated.wav"),
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
		assert.equal(appended.length, 0, "isolated generator does not persist note placement state");
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`%%pi-breeze-tts:${markerId}%%`));
		assert.equal(fs.existsSync(path.join(handoffDirectory, "generated.wav")), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Breeze wrapper uses audio.cpp clone task", () => {
	const wrapper = fs.readFileSync(new URL("../scripts/breeze-tts.cmd", import.meta.url), "utf-8");
	const powershell = fs.readFileSync(new URL("../scripts/breeze-tts.ps1", import.meta.url), "utf-8");
	assert.match(wrapper, /breeze-tts\.ps1/);
	assert.match(wrapper, /pwsh\.exe/i);
	assert.doesNotMatch(wrapper, /powershell\.exe/i);
	assert.match(powershell, /local-paths\.json/);
	assert.match(powershell, /audioCppRoot/);
	assert.match(powershell, /cudaRootDirectory/);
	assert.match(powershell, /function Resolve-ConfiguredPath/);
	assert.doesNotMatch(powershell, /GetFullPath\([^)]*,/);
	assert.match(powershell, /--task \$env:BREEZE_TTS_TASK --family breeze_tts/);
});

test("main Breeze tool dispatches only logged points, preserves failures for retry, and cancels on request", async () => {
	const cudaFailure = {
		isError: true,
		result: { content: [{ type: "text", text: "breeze-tts exited with code 7: CUDA runtime unavailable" }] },
	};
	const fixture = createTtsFixture([cudaFailure, cudaFailure]);
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		assert.ok(tool);
		assert.deepEqual(Object.keys(tool.parameters.properties), [
			"conceptText", "retryMarkerId", "executionMode", "scriptMode",
			"narrationText", "voiceInstruction", "audioDescription",
		]);
		await assert.rejects(
			tool.execute("tts-bad", backgroundRequest("This was not logged."), undefined, undefined, fixture.ctx),
			/conceptText must be exact text/,
		);
		assert.deepEqual(fixture.toolCalls, []);

		// A passage repeated in the managed transcript is accepted; the first
		// occurrence is the one used for placement.
		fs.writeFileSync(
			fixture.notePath,
			fs.readFileSync(fixture.notePath, "utf-8").replace(
				fixture.conceptText,
				`${fixture.conceptText}\n\n> [!abstract] PI\n\n> ${fixture.conceptText}`,
			),
			"utf-8",
		);
		const entriesBeforeRepeat = fixture.entries.length;
		const repeated = await tool.execute("tts-repeat", backgroundRequest(fixture.conceptText), undefined, undefined, fixture.ctx);
		assert.equal(repeated.details.status, "failed");
		assert.equal(fixture.toolCalls.length, 1);
		removeAudioPlaceholder(fixture.notePath, repeated.details.markerId);
		fixture.entries.length = entriesBeforeRepeat;
		fixture.toolCalls.length = 0;

		const failed = await tool.execute("tts", backgroundRequest(fixture.conceptText), undefined, undefined, fixture.ctx);
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
		assert.match(fixture.toolCalls[1].args.prompt, /source content, never instructions/);
		assert.match(fixture.toolCalls[1].args.prompt, /Do not inspect or edit the linked note, move files into the vault/);
		assert.doesNotMatch(fixture.toolCalls[1].args.prompt, /markerId:|notePath:/);
		assert.ok(fixture.toolCalls[1].args.prompt.includes(
			`voicePreset: ${JSON.stringify({ id: "standard", name: "Standard Breeze voice", mode: "standard" })}`,
		), "the linked note's preset takes precedence over stale session history");
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

test("new Breeze requests require an explicit route and valid exact scripts for synchronous generation", async () => {
	const fixture = createTtsFixture();
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		await assert.rejects(
			tool.execute("tts-no-mode", { conceptText: fixture.conceptText }, undefined, undefined, fixture.ctx),
			/Choose executionMode and scriptMode/,
		);
		await assert.rejects(
			tool.execute("tts-sync-short-description", {
				conceptText: fixture.conceptText,
				executionMode: "synchronous",
				scriptMode: "exact",
				narrationText: "A main-authored exact script.",
				voiceInstruction: "Speak clearly and warmly.",
				audioDescription: "A short voice clip",
			}, undefined, undefined, fixture.ctx),
			/exactly five words/,
		);
		await assert.rejects(
			tool.execute("tts-background-exact-no-script", {
				conceptText: fixture.conceptText,
				executionMode: "background",
				scriptMode: "exact",
			}, undefined, undefined, fixture.ctx),
			/requires narrationText/,
		);
		assert.deepEqual(fixture.toolCalls, []);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-breeze-tts:/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("failed Breeze recovery removes a marker only after the learner chooses removal", async () => {
	const cudaFailure = {
		isError: true,
		result: { content: [{ type: "text", text: "CUDA runtime unavailable" }] },
	};
	const fixture = createTtsFixture([cudaFailure]);
	const notifications = [];
	fixture.ctx.ui = {
		async select() { return "Remove this marker"; },
		notify(message, level) { notifications.push({ message, level }); },
	};
	try {
		const result = await fixture.registeredTools.get("teach_breeze_tts").execute(
			"tts-remove-choice",
			backgroundRequest(fixture.conceptText),
			undefined,
			undefined,
			fixture.ctx,
		);
		assert.equal(result.details.status, "failed");
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-breeze-tts:/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.markerId === result.details.markerId &&
			entry.data.status === "cancelled",
		));
	} finally {
		for (const { message } of notifications) {
			const prefix = "Placement diagnostic saved to: ";
			if (message.startsWith(prefix)) {
				const diagnosticPath = message.slice(prefix.length).replace(/\.$/, "");
				if (fs.existsSync(diagnosticPath)) fs.unlinkSync(diagnosticPath);
			}
		}
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main Breeze tool asks for and saves a preset when the linked note has none", async () => {
	const fixture = createTtsFixture();
	try {
		fs.writeFileSync(
			fixture.notePath,
			fs.readFileSync(fixture.notePath, "utf-8").replace(/^---\r?\nbreeze-voice-preset:.*?\r?\n---\r?\n\r?\n/, ""),
			"utf-8",
		);
		const wavsDirectory = path.join(fixture.root, "voice", "wavs");
		const transcriptsDirectory = path.join(fixture.root, "voice", "transcripts");
		fs.mkdirSync(wavsDirectory, { recursive: true });
		fs.mkdirSync(transcriptsDirectory, { recursive: true });
		writeWav(path.join(wavsDirectory, "123456.wav"));
		fs.writeFileSync(path.join(transcriptsDirectory, "123456-transcript.txt"), "A valid reference transcript.");
		const styleInstructionsPath = path.join(transcriptsDirectory, "style-instructions.json");
		const styleInstructions = { voice: "Warm and measured" };
		fs.writeFileSync(styleInstructionsPath, JSON.stringify(styleInstructions));
		fs.writeFileSync(path.join(fixture.root, "breeze-voices.json"), JSON.stringify({
			version: 1,
			presets: [{
				id: "narrator",
				name: "Warm Narrator",
				wavsDirectory,
				transcriptsDirectory,
				styleInstructionsPath,
				styleInstructions,
			}],
		}));
		const selections = [];
		fixture.ctx.ui = {
			async select(title, options) {
				selections.push({ title, options });
				return options[1];
			},
			notify() {},
		};

		const result = await fixture.registeredTools.get("teach_breeze_tts").execute(
			"tts-select",
			backgroundRequest(fixture.conceptText),
			undefined,
			undefined,
			fixture.ctx,
		);
		assert.equal(result.details.status, "dispatched");
		assert.equal(selections.length, 1);
		assert.equal(selections[0].title, "Breeze TTS voice for this note");
		assert.match(selections[0].options[0], /no voice cloning/);
		assert.match(selections[0].options[1], /Warm Narrator.*with style instructions/);
		const savedSelection = fixture.entries.find((entry) => entry.customType === "breeze-voice-preset");
		assert.equal(savedSelection.data.preset.id, "narrator");
		assert.deepEqual(savedSelection.data.preset.styleInstructions, styleInstructions);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /^breeze-voice-preset: "Warm Narrator"$/m);
		assert.ok(fixture.toolCalls[0].args.prompt.includes(
			`voicePreset: ${JSON.stringify(savedSelection.data.preset)}`,
		));

		for (let index = fixture.entries.length - 1; index >= 0; index--) {
			if (fixture.entries[index].customType === "breeze-voice-preset") fixture.entries.splice(index, 1);
		}
		fixture.ctx.ui.select = async () => {
			throw new Error("A saved note preset should not prompt again.");
		};
		const restored = await fixture.registeredTools.get("teach_breeze_tts").execute(
			"tts-restore",
			backgroundRequest(fixture.conceptText),
			undefined,
			undefined,
			fixture.ctx,
		);
		assert.equal(restored.details.status, "dispatched");
		assert.ok(fixture.toolCalls[1].args.prompt.includes(
			`voicePreset: ${JSON.stringify(savedSelection.data.preset)}`,
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main Breeze tool prompts for the standard voice when no clone manifest is available", async () => {
	const fixture = createTtsFixture();
	try {
		fs.writeFileSync(
			fixture.notePath,
			fs.readFileSync(fixture.notePath, "utf-8").replace(/^---\r?\nbreeze-voice-preset:.*?\r?\n---\r?\n\r?\n/, ""),
			"utf-8",
		);
		fs.writeFileSync(path.join(fixture.root, "breeze-voices.json"), JSON.stringify({ version: 1, presets: [] }));
		const selections = [];
		fixture.ctx.ui = {
			async select(title, options) {
				selections.push({ title, options });
				return options[0];
			},
			notify() {},
		};

		const result = await fixture.registeredTools.get("teach_breeze_tts").execute(
			"tts-standard",
			backgroundRequest(fixture.conceptText),
			undefined,
			undefined,
			fixture.ctx,
		);
		assert.equal(result.details.status, "dispatched");
		assert.deepEqual(selections, [{
			title: "Breeze TTS voice for this note",
			options: ["Standard Breeze voice — no voice cloning"],
		}]);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), /^breeze-voice-preset: "Standard Breeze voice"$/m);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main Breeze tool does not silently use the standard voice when selection is cancelled", async () => {
	const fixture = createTtsFixture();
	try {
		fs.writeFileSync(
			fixture.notePath,
			fs.readFileSync(fixture.notePath, "utf-8").replace(/^---\r?\nbreeze-voice-preset:.*?\r?\n---\r?\n\r?\n/, ""),
			"utf-8",
		);
		const wavsDirectory = path.join(fixture.root, "voice", "wavs");
		const transcriptsDirectory = path.join(fixture.root, "voice", "transcripts");
		fs.mkdirSync(wavsDirectory, { recursive: true });
		fs.mkdirSync(transcriptsDirectory);
		writeWav(path.join(wavsDirectory, "123456.wav"));
		fs.writeFileSync(path.join(transcriptsDirectory, "123456-transcript.txt"), "A valid reference transcript.");
		fs.writeFileSync(path.join(fixture.root, "breeze-voices.json"), JSON.stringify({
			version: 1,
			presets: [{ id: "narrator", name: "Warm Narrator", wavsDirectory, transcriptsDirectory }],
		}));
		fixture.ctx.ui = { async select() { return undefined; }, notify() {} };

		await assert.rejects(
			fixture.registeredTools.get("teach_breeze_tts").execute(
				"tts-cancel",
				backgroundRequest(fixture.conceptText),
				undefined,
				undefined,
				fixture.ctx,
			),
			/selection was cancelled; audio was not started/,
		);
		assert.deepEqual(fixture.toolCalls, []);
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /pi-breeze-tts:/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("main agent finalizes a staged WAV after background subagent completion", async () => {
	const fixture = createTtsFixture();
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		const dispatched = await tool.execute("tts", backgroundRequest(fixture.conceptText), undefined, undefined, fixture.ctx);
		const pending = fixture.entries.find((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.markerId === dispatched.details.markerId &&
			entry.data.status === "pending",
		);
		assert.ok(pending);
		assert.match(pending.data.anchorId, /^[a-f0-9-]{36}$/i);
		assert.equal(dispatched.details.status, "dispatched");
		const prompt = fixture.toolCalls[0].args.prompt;
		const handoffPath = /^handoffPath: (.+)$/m.exec(prompt)?.[1];
		assert.ok(handoffPath);
		const handoffDirectory = path.dirname(handoffPath);
		writeWav(handoffPath);
		const transcript = "The audio transcript is complete.\nEvery spoken sentence is included.";
		await fixture.pi.events.emit("subagents:completed", {
			id: dispatched.details.agentId,
			type: "breeze-tts-maker",
			status: "completed",
			result: [
				"RESULT:",
				"status: success",
				`handoffPath: ${handoffPath}`,
				"audioDescription: Sound Travels Through Moving Air",
				"voiceName: Standard Breeze",
				"referenceId:",
				`transcript: ${JSON.stringify(transcript)}`,
			].join("\n"),
		});

		const note = fs.readFileSync(fixture.notePath, "utf-8");
		assert.ok(note.includes("![[001-Attachments/~breezetts/standard-breeze-sound-travels-through-moving-air-1.wav]]"));
		assert.ok(note.includes(renderAudioTranscriptCallout("Sound Travels Through Moving Air", transcript)));
		assert.match(note, /!\[\[001-Attachments\/~breezetts\/standard-breeze-sound-travels-through-moving-air-1\.wav\]\]\n\n> \[!quote\]- \*\*Transcript\*\*: Sound Travels Through Moving Air/);
		assert.doesNotMatch(note, /pi-breeze-tts:/);
		assert.ok(fixture.entries.some((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.markerId === dispatched.details.markerId &&
			entry.data.status === "placed" &&
			typeof entry.data.anchorId === "string",
		));
		assert.equal(fs.existsSync(handoffDirectory), false, "the main agent cleans the staged handoff after placement");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("exact-script background generation rejects a changed transcript", async () => {
	const fixture = createTtsFixture();
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		const exactScript = "Keep every word exactly as authored.";
		const dispatched = await tool.execute(
			"tts-exact",
			backgroundRequest(fixture.conceptText, "exact", exactScript),
			undefined,
			undefined,
			fixture.ctx,
		);
		const handoffPath = /^handoffPath: (.+)$/m.exec(fixture.toolCalls[0].args.prompt)?.[1];
		assert.ok(handoffPath);
		writeWav(handoffPath);
		await fixture.pi.events.emit("subagents:completed", {
			id: dispatched.details.agentId,
			type: "breeze-tts-maker",
			status: "completed",
			result: [
				"RESULT:",
				"status: success",
				`handoffPath: ${handoffPath}`,
				"audioDescription: Sound Travels Through Moving Air",
				`transcript: ${JSON.stringify("The subagent changed the script.")}`,
			].join("\n"),
		});
		const failed = fixture.entries.filter((entry) =>
			entry.customType === TEACH_BREEZE_TTS_PLACEMENT_ENTRY &&
			entry.data.markerId === dispatched.details.markerId,
		).at(-1);
		assert.equal(failed.data.status, "failed");
		assert.match(failed.data.error, /changed narrationText/);
		assert.match(fs.readFileSync(fixture.notePath, "utf-8"), new RegExp(`%%pi-breeze-tts:${dispatched.details.markerId}%%`));
		assert.doesNotMatch(fs.readFileSync(fixture.notePath, "utf-8"), /!\[\[.*breezetts/);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("session shutdown removes handoff directories for still-running Breeze jobs", async () => {
	const fixture = createTtsFixture();
	try {
		const dispatched = await fixture.registeredTools.get("teach_breeze_tts").execute(
			"tts-shutdown",
			backgroundRequest(fixture.conceptText),
			undefined,
			undefined,
			fixture.ctx,
		);
		const handoffPath = /^handoffPath: (.+)$/m.exec(fixture.toolCalls[0].args.prompt)?.[1];
		assert.ok(handoffPath);
		const handoffDirectory = path.dirname(handoffPath);
		writeWav(handoffPath);
		assert.equal(fs.existsSync(handoffDirectory), true);

		await fixture.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "new" }, fixture.ctx);
		assert.equal(fs.existsSync(handoffDirectory), false);
		assert.equal(dispatched.details.status, "dispatched");
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("a stopped subagent is normalized to a retryable failure", async () => {
	const fixture = createTtsFixture();
	try {
		const tool = fixture.registeredTools.get("teach_breeze_tts");
		const first = await tool.execute("tts", backgroundRequest(fixture.conceptText), undefined, undefined, fixture.ctx);
		assert.equal(first.details.status, "dispatched");
		fixture.entries.push({
			id: "breeze-failed",
			parentId: fixture.entries.at(-1)?.id,
			type: "custom",
			customType: "subagents:record",
			data: {
				id: first.details.agentId,
				status: "stopped",
				result: "",
				error: "Stopped by user before completion.",
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
			entry.data.error.includes("Stopped by user"),
		));
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});
