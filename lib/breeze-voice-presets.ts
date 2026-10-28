import * as fs from "node:fs";
import * as path from "node:path";
import { listVoiceReferences, type BreezeVoicePreset } from "./teach-breeze-tts.ts";

export const BREEZE_VOICE_PRESET_ENTRY = "breeze-voice-preset";
export const STANDARD_BREEZE_VOICE_PRESET: BreezeVoicePreset = {
	id: "standard",
	name: "Standard Breeze voice",
	mode: "standard",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadBreezeVoicePresets(manifestPath: string): { presets: BreezeVoicePreset[]; diagnostics: string[] } {
	let manifest: unknown;
	try {
		const stat = fs.lstatSync(manifestPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("manifest path is not a regular file");
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return { presets: [], diagnostics: [] };
		throw new Error(`Could not load Breeze voice manifest "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.presets)) {
		throw new Error(`Breeze voice manifest "${manifestPath}" must contain version 1 and a presets array.`);
	}

	const presets: BreezeVoicePreset[] = [];
	const diagnostics: string[] = [];
	const seenIds = new Set<string>([STANDARD_BREEZE_VOICE_PRESET.id]);
	const seenNames = new Set<string>();
	for (const [index, rawPreset] of manifest.presets.entries()) {
		const label = `preset ${index + 1}`;
		if (!isRecord(rawPreset)) {
			diagnostics.push(`Skipped ${label}: expected a JSON object.`);
			continue;
		}
		const { id, name, wavsDirectory, transcriptsDirectory } = rawPreset;
		if (
			typeof id !== "string" ||
			!/^[a-z0-9][a-z0-9-]*$/.test(id) ||
			id === STANDARD_BREEZE_VOICE_PRESET.id ||
			typeof name !== "string" ||
			!name.trim() ||
			typeof wavsDirectory !== "string" ||
			!wavsDirectory.trim() ||
			typeof transcriptsDirectory !== "string" ||
			!transcriptsDirectory.trim()
		) {
			diagnostics.push(`Skipped ${label}: provide a unique id, name, WAV directory, and transcript directory.`);
			continue;
		}
		if (seenIds.has(id)) {
			diagnostics.push(`Skipped ${label} "${name}": duplicate preset id "${id}".`);
			continue;
		}
		const normalizedName = name.trim().toLowerCase();
		if (seenNames.has(normalizedName)) {
			diagnostics.push(`Skipped ${label} "${name}": duplicate preset name.`);
			continue;
		}
		const baseDirectory = path.dirname(path.resolve(manifestPath));
		const preset: BreezeVoicePreset = {
			id,
			name: name.trim(),
			mode: "clone",
			wavsDirectory: path.isAbsolute(wavsDirectory) ? path.normalize(wavsDirectory) : path.resolve(baseDirectory, wavsDirectory),
			transcriptsDirectory: path.isAbsolute(transcriptsDirectory)
				? path.normalize(transcriptsDirectory)
				: path.resolve(baseDirectory, transcriptsDirectory),
		};
		try {
			listVoiceReferences(preset.wavsDirectory, preset.transcriptsDirectory, preset.name);
		} catch (error) {
			diagnostics.push(`Skipped voice preset "${preset.name}": ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		seenIds.add(preset.id);
		seenNames.add(normalizedName);
		presets.push(preset);
	}
	return { presets, diagnostics };
}

export function getSelectedBreezeVoicePreset(entries: unknown[]): BreezeVoicePreset | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== BREEZE_VOICE_PRESET_ENTRY) continue;
		if (!isRecord(entry.data) || !isRecord(entry.data.preset)) {
			throw new Error("Saved Breeze voice preset in session history is invalid.");
		}
		const preset = entry.data.preset;
		if (preset.mode === "standard" && preset.id === STANDARD_BREEZE_VOICE_PRESET.id && typeof preset.name === "string") {
			return { id: preset.id, name: preset.name, mode: "standard" };
		}
		if (
			preset.mode === "clone" &&
			typeof preset.id === "string" &&
			typeof preset.name === "string" &&
			typeof preset.wavsDirectory === "string" &&
			typeof preset.transcriptsDirectory === "string"
		) {
			return {
				id: preset.id,
				name: preset.name,
				mode: "clone",
				wavsDirectory: preset.wavsDirectory,
				transcriptsDirectory: preset.transcriptsDirectory,
			};
		}
		throw new Error("Saved Breeze voice preset in session history is invalid.");
	}
	return undefined;
}
