import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	BREEZE_VOICE_PRESET_ENTRY,
	getSelectedBreezeVoicePreset,
	loadBreezeVoicePresets,
	STANDARD_BREEZE_VOICE_PRESET,
} from "../lib/breeze-voice-presets.ts";

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

test("manifest loads only named presets with a valid matching reference pair", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-presets-"));
	const wavs = path.join(root, "voice", "wavs");
	const transcripts = path.join(root, "voice", "transcripts");
	const manifestPath = path.join(root, "breeze-voices.json");
	fs.mkdirSync(wavs, { recursive: true });
	fs.mkdirSync(transcripts);
	writeWav(path.join(wavs, "123456.wav"));
	fs.writeFileSync(path.join(transcripts, "123456-transcript.txt"), "A valid reference transcript.");
	fs.writeFileSync(manifestPath, JSON.stringify({
		version: 1,
		presets: [
			{ id: "narrator", name: "Warm Narrator", wavsDirectory: wavs, transcriptsDirectory: transcripts },
			{ id: "missing", name: "Unavailable Voice", wavsDirectory: path.join(root, "missing"), transcriptsDirectory: transcripts },
		],
	}));
	try {
		const result = loadBreezeVoicePresets(manifestPath);
		assert.deepEqual(result.presets, [{
			id: "narrator",
			name: "Warm Narrator",
			mode: "clone",
			wavsDirectory: wavs,
			transcriptsDirectory: transcripts,
		}]);
		assert.equal(result.diagnostics.length, 1);
		assert.match(result.diagnostics[0], /Skipped voice preset "Unavailable Voice"/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("a missing manifest means no clone presets, while standard voice remains available", () => {
	const loaded = loadBreezeVoicePresets(path.join(os.tmpdir(), "missing-breeze-voices.json"));
	assert.deepEqual(loaded, { presets: [], diagnostics: [] });
	assert.deepEqual(STANDARD_BREEZE_VOICE_PRESET, {
		id: "standard",
		name: "Standard Breeze voice",
		mode: "standard",
	});
});

test("session voice selection restores the latest preset and reports malformed state", () => {
	const standard = { type: "custom", customType: BREEZE_VOICE_PRESET_ENTRY, data: { preset: STANDARD_BREEZE_VOICE_PRESET } };
	const clone = {
		type: "custom",
		customType: BREEZE_VOICE_PRESET_ENTRY,
		data: {
			preset: {
				id: "narrator",
				name: "Warm Narrator",
				mode: "clone",
				wavsDirectory: "C:\\voices\\wavs",
				transcriptsDirectory: "C:\\voices\\transcripts",
			},
		},
	};
	assert.deepEqual(getSelectedBreezeVoicePreset([standard, clone]), clone.data.preset);
	assert.throws(
		() => getSelectedBreezeVoicePreset([{ ...clone, data: { preset: { id: "broken", mode: "clone" } } }]),
		/Saved Breeze voice preset in session history is invalid/,
	);
});
