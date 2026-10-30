import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	BREEZE_VOICE_PRESET_ENTRY,
	findBreezeVoicePresetByName,
	getSelectedBreezeVoicePreset,
	getBreezeVoicePresetOptions,
	loadBreezeVoicePresets,
	readBreezeVoicePresetName,
	resolveBreezeVoiceManifestPath,
	STANDARD_BREEZE_VOICE_PRESET,
	updateBreezeVoicePresetFrontmatter,
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
	const styleInstructionsPath = path.join(transcripts, "style-instructions.json");
	const styleInstructions = { voice: "Warm and measured", pace: "deliberate" };
	fs.writeFileSync(styleInstructionsPath, JSON.stringify(styleInstructions));
	fs.writeFileSync(manifestPath, JSON.stringify({
		version: 1,
		presets: [
			{
				id: "narrator",
				name: "Warm Narrator",
				wavsDirectory: wavs,
				transcriptsDirectory: transcripts,
				styleInstructionsPath,
				styleInstructions,
			},
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
			styleInstructionsPath,
			styleInstructions,
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

test("manifest resolution falls back to the extension config when cwd is the vault", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "breeze-manifest-location-"));
	const vault = path.join(root, "vault");
	const extensionDirectory = path.join(root, ".pi", "extensions");
	const extensionManifest = path.join(root, ".pi", "breeze-voices.json");
	const workspaceManifest = path.join(vault, "breeze-voices.json");
	const wavs = path.join(root, "voice", "wavs");
	const transcripts = path.join(root, "voice", "transcripts");
	fs.mkdirSync(vault, { recursive: true });
	fs.mkdirSync(extensionDirectory, { recursive: true });
	fs.mkdirSync(wavs, { recursive: true });
	fs.mkdirSync(transcripts);
	writeWav(path.join(wavs, "123456.wav"));
	fs.writeFileSync(path.join(transcripts, "123456-transcript.txt"), "A valid reference transcript.");
	fs.writeFileSync(extensionManifest, JSON.stringify({
		version: 1,
		presets: [{ id: "cave-johnson", name: "Cave Johnson", wavsDirectory: wavs, transcriptsDirectory: transcripts }],
	}), "utf-8");
	try {
		const resolved = resolveBreezeVoiceManifestPath(vault, extensionDirectory);
		assert.equal(resolved, extensionManifest);
		assert.deepEqual(loadBreezeVoicePresets(resolved).presets.map(({ id, name }) => ({ id, name })), [
			{ id: "cave-johnson", name: "Cave Johnson" },
		]);
		fs.writeFileSync(workspaceManifest, "{}", "utf-8");
		assert.equal(resolveBreezeVoiceManifestPath(vault, extensionDirectory), workspaceManifest);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
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
				styleInstructionsPath: "C:\\voices\\transcripts\\style-instructions.json",
				styleInstructions: { voice: "Warm" },
			},
		},
	};
	assert.deepEqual(getSelectedBreezeVoicePreset([standard, clone]), clone.data.preset);
	assert.throws(
		() => getSelectedBreezeVoicePreset([{ ...clone, data: { preset: { id: "broken", mode: "clone" } } }]),
		/Saved Breeze voice preset in session history is invalid/,
	);
});

test("note frontmatter stores and resolves a human-readable Breeze preset name", () => {
	const presets = [{
		id: "narrator",
		name: "Warm Narrator",
		mode: "clone",
		wavsDirectory: "C:\\voices\\wavs",
		transcriptsDirectory: "C:\\voices\\transcripts",
	}];
	const original = "---\r\ntitle: Lesson\r\ntags:\r\n  - teaching\r\n---\r\n\r\nLesson text.\r\n";
	const updated = updateBreezeVoicePresetFrontmatter(original, "Warm Narrator");

	assert.equal(readBreezeVoicePresetName(updated), "Warm Narrator");
	assert.match(updated, /title: Lesson\r\ntags:\r\n  - teaching\r\nbreeze-voice-preset: "Warm Narrator"\r\n---/);
	assert.ok(updated.endsWith("Lesson text.\r\n"));
	assert.deepEqual(findBreezeVoicePresetByName(readBreezeVoicePresetName(updated), presets), presets[0]);
	assert.deepEqual(findBreezeVoicePresetByName(STANDARD_BREEZE_VOICE_PRESET.name, presets), STANDARD_BREEZE_VOICE_PRESET);
	assert.deepEqual(getBreezeVoicePresetOptions(presets), [
		"Standard Breeze voice — no voice cloning",
		"Warm Narrator (narrator) — voice clone",
	]);
});

test("frontmatter writer creates metadata on notes without frontmatter and replaces stale preset values", () => {
	const inserted = updateBreezeVoicePresetFrontmatter("# Lesson\n\nBody.\n", "A \"Quoted\" Voice");
	assert.match(inserted, /^---\nbreeze-voice-preset: "A \\"Quoted\\" Voice"\n---\n\n# Lesson/);
	assert.equal(readBreezeVoicePresetName(inserted), "A \"Quoted\" Voice");

	const replaced = updateBreezeVoicePresetFrontmatter(
		"---\nbreeze-voice-preset: Old Voice\nother: kept\n---\nBody.\n",
		"Warm Narrator",
	);
	assert.equal(readBreezeVoicePresetName(replaced), "Warm Narrator");
	assert.match(replaced, /other: kept/);
	assert.throws(
		() => readBreezeVoicePresetName("---\nbreeze-voice-preset: One\nbreeze-voice-preset: Two\n---\n"),
		/repeats "breeze-voice-preset"/,
	);
});
