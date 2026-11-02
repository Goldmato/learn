import * as fs from "node:fs";
import * as path from "node:path";
import { readLocalPaths } from "./local-paths.ts";
import { listVoiceReferences, type BreezeVoicePreset } from "./teach-breeze-tts.ts";

export const BREEZE_VOICE_PRESET_ENTRY = "breeze-voice-preset";
export const BREEZE_VOICE_PRESET_FRONTMATTER_FIELD = "breeze-voice-preset";
export const STANDARD_BREEZE_VOICE_PRESET: BreezeVoicePreset = {
	id: "standard",
	name: "Standard Breeze voice",
	mode: "standard",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function frontmatterBounds(markdown: string): { start: number; end: number } | undefined {
	const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
	if (!match) return undefined;
	const start = /^---[ \t]*\r?\n/.exec(markdown)?.[0].length ?? 0;
	const end = /\r?\n---[ \t]*(?:\r?\n|$)$/.exec(match[0])?.index ?? match[0].length;
	return { start, end };
}

export function readBreezeVoicePresetName(markdown: string): string | undefined {
	const bounds = frontmatterBounds(markdown);
	if (!bounds) return undefined;
	const field = BREEZE_VOICE_PRESET_FRONTMATTER_FIELD;
	const values = markdown.slice(bounds.start, bounds.end).split(/\r?\n/)
		.flatMap((line) => {
			const match = new RegExp(`^(?:"${field}"|${field}):[ \\t]*(.*)$`).exec(line);
			return match ? [match[1]] : [];
		});
	if (values.length > 1) throw new Error(`Linked note repeats "${field}" frontmatter.`);
	if (values.length === 0) return undefined;
	const raw = values[0].trim();
	if (!raw) throw new Error(`Linked note has an empty "${field}" frontmatter value.`);
	if (raw.startsWith('"')) {
		try {
			const name: unknown = JSON.parse(raw);
			if (typeof name !== "string" || !name.trim()) throw new Error();
			return name;
		} catch {
			throw new Error(`Linked note has an invalid "${field}" frontmatter value.`);
		}
	}
	if (/^[|>&*!#,'"`@\[\]{}]/.test(raw) || /:\s|[\[\]{}]/.test(raw)) {
		throw new Error(`Linked note has an unsupported "${field}" frontmatter value.`);
	}
	return raw;
}

export function findBreezeVoicePresetByName(
	name: string | undefined,
	presets: BreezeVoicePreset[],
): BreezeVoicePreset | undefined {
	if (name === STANDARD_BREEZE_VOICE_PRESET.name) return STANDARD_BREEZE_VOICE_PRESET;
	return presets.find((preset) => preset.name === name);
}

export function getBreezeVoicePresetOptions(presets: BreezeVoicePreset[]): string[] {
	return [
		`${STANDARD_BREEZE_VOICE_PRESET.name} — no voice cloning`,
		...presets.map((preset) =>
			`${preset.name} (${preset.id}) — voice clone${preset.styleInstructionsPath ? ", with style instructions" : ""}`,
		),
	];
}

export function resolveBreezeVoiceManifestPath(cwd: string, extensionDirectory: string): string {
	const workspaceManifest = path.join(cwd, "breeze-voices.json");
	if (fs.existsSync(workspaceManifest)) return workspaceManifest;
	return path.resolve(extensionDirectory, "..", "breeze-voices.json");
}

export function updateBreezeVoicePresetFrontmatter(markdown: string, name: string): string {
	if (!name.trim()) throw new Error("Breeze voice preset name must contain non-whitespace text.");
	const bounds = frontmatterBounds(markdown);
	if (!bounds) {
		return `---\n${BREEZE_VOICE_PRESET_FRONTMATTER_FIELD}: ${JSON.stringify(name)}\n---\n\n${markdown}`;
	}
	const frontmatter = markdown.slice(bounds.start, bounds.end);
	const newline = frontmatter.includes("\r\n") ? "\r\n" : "\n";
	const lines = frontmatter.split(/\r?\n/);
	const field = BREEZE_VOICE_PRESET_FRONTMATTER_FIELD;
	const matches = lines.flatMap((line, index) =>
		new RegExp(`^(?:"${field}"|${field}):`).test(line) ? [index] : [],
	);
	if (matches.length > 1) throw new Error(`Linked note repeats "${field}" frontmatter.`);
	const rendered = `${field}: ${JSON.stringify(name)}`;
	if (matches.length === 1) {
		lines[matches[0]] = rendered;
	} else {
		let insertionIndex = lines.length;
		while (insertionIndex > 0 && !lines[insertionIndex - 1].trim()) insertionIndex--;
		lines.splice(insertionIndex, 0, rendered);
	}
	return `${markdown.slice(0, bounds.start)}${lines.join(newline)}${markdown.slice(bounds.end)}`;
}

export function loadBreezeVoicePresets(
	manifestPath: string,
	localConfigRoot = path.dirname(path.resolve(manifestPath)),
): { presets: BreezeVoicePreset[]; diagnostics: string[] } {
	let manifest: unknown = { version: 1, presets: [] };
	try {
		const stat = fs.lstatSync(manifestPath);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("manifest path is not a regular file");
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw new Error(`Could not load Breeze voice manifest "${manifestPath}": ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!isRecord(manifest) || manifest.version !== 1 || !Array.isArray(manifest.presets)) {
		throw new Error(`Breeze voice manifest "${manifestPath}" must contain version 1 and a presets array.`);
	}

	const presets: BreezeVoicePreset[] = [];
	const diagnostics: string[] = [];
	const seenIds = new Set<string>([STANDARD_BREEZE_VOICE_PRESET.id]);
	const seenNames = new Set<string>();
	const config = readLocalPaths(localConfigRoot);
	const voiceValues = [
		config.breezeVoice.name,
		config.breezeVoice.wavsDirectory,
		config.breezeVoice.transcriptsDirectory,
	];
	const hasConfiguredVoice = voiceValues.some(Boolean);
	const configuredVoice = hasConfiguredVoice && voiceValues.every(Boolean)
		? [{
			id: config.breezeVoice.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
			name: config.breezeVoice.name,
			wavsDirectory: path.isAbsolute(config.breezeVoice.wavsDirectory)
				? path.normalize(config.breezeVoice.wavsDirectory)
				: path.resolve(localConfigRoot, config.breezeVoice.wavsDirectory),
			transcriptsDirectory: path.isAbsolute(config.breezeVoice.transcriptsDirectory)
				? path.normalize(config.breezeVoice.transcriptsDirectory)
				: path.resolve(localConfigRoot, config.breezeVoice.transcriptsDirectory),
		}]
		: [];
	if (hasConfiguredVoice && configuredVoice.length === 0) {
		diagnostics.push("Skipped the default Breeze clone: configure its name and both folders with /configure-paths.");
	}
	for (const [index, rawPreset] of [...manifest.presets, ...configuredVoice].entries()) {
		const label = `preset ${index + 1}`;
		if (!isRecord(rawPreset)) {
			diagnostics.push(`Skipped ${label}: expected a JSON object.`);
			continue;
		}
		const { id, name, wavsDirectory, transcriptsDirectory, styleInstructionsPath, styleInstructions } = rawPreset;
		const hasStyleInstructionsPath = Object.hasOwn(rawPreset, "styleInstructionsPath");
		const hasStyleInstructions = Object.hasOwn(rawPreset, "styleInstructions");
		if (
			typeof id !== "string" ||
			!/^[a-z0-9][a-z0-9-]*$/.test(id) ||
			id === STANDARD_BREEZE_VOICE_PRESET.id ||
			typeof name !== "string" ||
			!name.trim() ||
			typeof wavsDirectory !== "string" ||
			!wavsDirectory.trim() ||
			typeof transcriptsDirectory !== "string" ||
			!transcriptsDirectory.trim() ||
			(hasStyleInstructionsPath && (typeof styleInstructionsPath !== "string" || !styleInstructionsPath.trim())) ||
			(hasStyleInstructionsPath !== hasStyleInstructions)
		) {
			diagnostics.push(`Skipped ${label}: provide a unique id, name, WAV directory, transcript directory, and valid optional style instructions.`);
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
			...(typeof styleInstructionsPath === "string" && hasStyleInstructions
				? {
					styleInstructionsPath: path.isAbsolute(styleInstructionsPath)
						? path.normalize(styleInstructionsPath)
						: path.resolve(baseDirectory, styleInstructionsPath),
					styleInstructions,
				}
				: {}),
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
			typeof preset.transcriptsDirectory === "string" &&
			Object.hasOwn(preset, "styleInstructionsPath") === Object.hasOwn(preset, "styleInstructions") &&
			(!Object.hasOwn(preset, "styleInstructionsPath") || typeof preset.styleInstructionsPath === "string")
		) {
			return {
				id: preset.id,
				name: preset.name,
				mode: "clone",
				wavsDirectory: preset.wavsDirectory,
				transcriptsDirectory: preset.transcriptsDirectory,
				...(typeof preset.styleInstructionsPath === "string" && Object.hasOwn(preset, "styleInstructions")
					? {
						styleInstructionsPath: preset.styleInstructionsPath,
						styleInstructions: preset.styleInstructions,
					}
					: {}),
			};
		}
		throw new Error("Saved Breeze voice preset in session history is invalid.");
	}
	return undefined;
}
