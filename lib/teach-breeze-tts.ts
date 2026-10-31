import { randomInt, randomUUID } from "node:crypto";
import { renderAudioTranscriptCallout } from "./md-log-format.ts";
import { placementAnchorMarker, removePlacementAnchorMarker } from "./placement-recovery.ts";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const AUDIO_MARKER_PREFIX = "%%pi-breeze-tts:";
const AUDIO_EXTENSIONS = new Set([".wav"]);
const MAX_CAPTURED_OUTPUT = 32_000;
const DEFAULT_VOICE_WAVS = String.raw`G:\Sounds\cave-johnson\wavs`;
const DEFAULT_VOICE_TRANSCRIPTS = String.raw`G:\Sounds\cave-johnson\transcripts`;
const MAX_REFERENCE_TRANSCRIPT_BYTES = 128 * 1024;

export interface GeneratedAudio {
	filename: string;
	path: string;
	vaultRelativePath: string;
}

export interface GeneratedBreezeOutput {
	path: string;
	tempRoot: string;
	stdout: string;
	stderr: string;
	referenceId?: string;
	voiceName?: string;
}

export interface VoiceReference {
	id: string;
	path: string;
	transcript: string;
	voiceName: string;
}

export interface BreezeVoicePreset {
	id: string;
	name: string;
	mode: "standard" | "clone";
	wavsDirectory?: string;
	transcriptsDirectory?: string;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function slug(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "") || "lesson-point";
}

function validateReferenceWav(filePath: string): string {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Voice reference must be a regular WAV file: ${filePath}`);
	if (stat.size <= 44) throw new Error(`Voice reference WAV is empty or truncated: ${filePath}`);
	const header = Buffer.alloc(12);
	const file = fs.openSync(filePath, "r");
	try {
		fs.readSync(file, header, 0, header.length, 0);
	} finally {
		fs.closeSync(file);
	}
	if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`Voice reference is not a valid WAV file: ${filePath}`);
	}
	return fs.realpathSync(filePath);
}

export function listVoiceReferences(
	wavsDirectory = DEFAULT_VOICE_WAVS,
	transcriptsDirectory = DEFAULT_VOICE_TRANSCRIPTS,
	voiceName = path.basename(path.dirname(path.resolve(wavsDirectory))),
): VoiceReference[] {
	for (const [label, directory] of [["WAV", wavsDirectory], ["transcript", transcriptsDirectory]] as const) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(directory);
		} catch (error) {
			throw new Error(`Breeze TTS ${label} reference directory is unavailable (${directory}): ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!stat.isDirectory()) throw new Error(`Breeze TTS ${label} reference path is not a directory: ${directory}`);
	}

	const wavFiles = fs.readdirSync(wavsDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && !entry.isSymbolicLink())
		.map((entry) => entry.name)
		.map((filename) => ({ filename, match: /^(\d{6})(?:[-_.][^.]*)?\.wav$/i.exec(filename) }))
		.filter((entry): entry is { filename: string; match: RegExpExecArray } => entry.match !== null);
	const candidates: VoiceReference[] = [];
	const invalidCandidates: string[] = [];
	for (const { filename, match } of wavFiles) {
		const id = match[1];
		const wavPath = path.join(wavsDirectory, filename);
		const transcriptPath = path.join(transcriptsDirectory, `${id}-transcript.txt`);
		if (!fs.existsSync(transcriptPath)) continue;
		const transcriptStat = fs.lstatSync(transcriptPath);
		if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink()) continue;
		if (transcriptStat.size === 0 || transcriptStat.size > MAX_REFERENCE_TRANSCRIPT_BYTES) continue;
		const transcript = fs.readFileSync(transcriptPath, "utf-8").replace(/^\uFEFF/, "").trim();
		if (!transcript) continue;
		try {
			candidates.push({ id, path: validateReferenceWav(wavPath), transcript, voiceName });
		} catch (error) {
			invalidCandidates.push(error instanceof Error ? error.message : String(error));
		}
	}

	if (candidates.length === 0) {
		throw new Error(
			`No valid Breeze TTS voice reference pairs were found. Expected six-digit .wav files in "${wavsDirectory}" ` +
			`with matching "{id}-transcript.txt" files in "${transcriptsDirectory}".` +
			(invalidCandidates.length ? `\nInvalid WAV references:\n${invalidCandidates.slice(0, 10).join("\n")}` : ""),
		);
	}
	return candidates;
}

export function selectRandomVoiceReference(
	wavsDirectory = DEFAULT_VOICE_WAVS,
	transcriptsDirectory = DEFAULT_VOICE_TRANSCRIPTS,
	voiceName?: string,
): VoiceReference {
	const candidates = listVoiceReferences(wavsDirectory, transcriptsDirectory, voiceName);
	return candidates[randomInt(candidates.length)];
}

export function buildBreezeCloneRequest(
	text: string,
	instruction: string,
	reference: VoiceReference,
	requestId = `lesson-${randomUUID()}`,
): { requests: Array<Record<string, unknown>> } {
	if (!text.trim()) throw new Error("Speech text must contain non-whitespace text.");
	if (!instruction.trim()) throw new Error("Voice instruction must contain non-whitespace text.");
	if (!reference.transcript.trim()) throw new Error("Voice reference transcript must contain non-whitespace text.");
	if (!path.isAbsolute(reference.path)) throw new Error("Voice reference WAV path must be absolute.");
	return {
		requests: [{
			id: requestId,
			text,
			instruct: instruction,
			voice_ref: reference.path,
			reference_text: reference.transcript,
		}],
	};
}

export function buildBreezeStandardRequest(
	text: string,
	instruction: string,
	requestId = `lesson-${randomUUID()}`,
): { requests: Array<Record<string, unknown>> } {
	if (!text.trim()) throw new Error("Speech text must contain non-whitespace text.");
	if (!instruction.trim()) throw new Error("Voice instruction must contain non-whitespace text.");
	return {
		requests: [{
			id: requestId,
			text,
			options: { instruction },
		}],
	};
}

export function findAudioVaultRoot(notePath: string): string {
	const realNotePath = fs.realpathSync(notePath);
	if (!fs.statSync(realNotePath).isFile()) throw new Error(`Linked md-log path is not a file: ${notePath}`);

	let directory = path.dirname(realNotePath);
	while (true) {
		const marker = path.join(directory, ".obsidian");
		if (fs.existsSync(marker)) {
			if (!fs.statSync(marker).isDirectory()) throw new Error(`Obsidian marker is not a directory: ${marker}`);
			return directory;
		}
		const parent = path.dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	throw new Error(`Could not locate an Obsidian vault root above linked note: ${notePath}`);
}

/**
 * Markers are a projection of the transcript, not a note edit: the renderer owns
 * every position inside the managed section. These helpers validate arguments.
 */
export function insertAudioPlaceholder(
	notePath: string,
	markerId: string,
	anchor: string,
	anchorId?: string,
): string {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Audio placeholder ID must be a UUID.");
	if (anchorId !== undefined && !/^[a-f0-9-]{36}$/i.test(anchorId)) throw new Error("Audio anchor ID must be a UUID.");
	const exactAnchor = anchor.trim();
	if (!exactAnchor) throw new Error("Audio insertion anchor must contain non-whitespace text.");
	const stat = fs.lstatSync(notePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Linked md-log path is not a regular file: ${notePath}`);

	const existing = fs.readFileSync(notePath, "utf-8");
	const marker = `${AUDIO_MARKER_PREFIX}${markerId}%%`;
	if (existing.includes(marker)) throw new Error(`Audio placeholder already exists: ${markerId}`);
	const idMarker = anchorId ? placementAnchorMarker(anchorId, markerId) : "";
	if (idMarker && existing.includes(idMarker)) throw new Error(`Audio anchor already exists: ${anchorId}`);
	const managedStart = existing.lastIndexOf("%% pi-md-log:start v1 %%");
	const contentStart = managedStart < 0 ? -1 : managedStart + "%% pi-md-log:start v1 %%".length;
	const managedEnd = contentStart < 0 ? -1 : existing.indexOf("%% pi-md-log:end v1 %%", contentStart);
	if (managedEnd < 0) throw new Error("Linked note does not contain a complete managed md-log transcript.");
	const anchorIndex = existing.indexOf(exactAnchor, contentStart);
	if (anchorIndex < 0 || anchorIndex + exactAnchor.length > managedEnd) {
		// The passage may have been rewritten since the request was queued. Keep the
		// marker rather than failing the whole request; the next sync re-anchors it.
		const before = existing.slice(0, managedEnd).trimEnd();
		const after = existing.slice(managedEnd);
		fs.writeFileSync(notePath, `${before}\n\n${idMarker ? `${idMarker}\n\n` : ""}${marker}\n\n${after}`, "utf-8");
		return marker;
	}
	const insertAt = anchorIndex + exactAnchor.length;
	const before = existing.slice(0, insertAt);
	const after = existing.slice(insertAt);
	const separator = before.endsWith("\n") ? "\n" : "\n\n";
	const trailingNewline = after.startsWith("\n") ? "" : "\n";
	fs.writeFileSync(notePath, `${before}${separator}${idMarker ? `${idMarker}\n\n` : ""}${marker}${trailingNewline}${after}`, "utf-8");
	return marker;
}

export function removeAudioPlaceholder(notePath: string, markerId: string): void {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Audio placeholder ID must be a UUID.");
	const marker = `${AUDIO_MARKER_PREFIX}${markerId}%%`;
	const existing = removePlacementAnchorMarker(fs.readFileSync(notePath, "utf-8"), markerId);
	const firstIndex = existing.indexOf(marker);
	if (firstIndex < 0) return;
	fs.writeFileSync(notePath, `${existing.slice(0, firstIndex)}${existing.slice(firstIndex + marker.length)}`, "utf-8");
}

function ensureVaultDirectory(vaultRoot: string, directory: string): string {
	try {
		fs.mkdirSync(directory);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Obsidian audio destination must be a real directory: ${directory}`);
	}
	const realDirectory = fs.realpathSync(directory);
	if (!isWithin(vaultRoot, realDirectory)) throw new Error(`Obsidian audio destination escapes the vault: ${directory}`);
	return realDirectory;
}

export function validateGeneratedAudioSource(sourcePath: string, outputRoot: string): string {
	const source = path.resolve(sourcePath);
	const sourceStat = fs.lstatSync(source);
	if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
		throw new Error(`Generated audio must be a regular file: ${source}`);
	}
	if (sourceStat.size <= 44) throw new Error(`Generated audio is empty or truncated: ${source}`);
	const extension = path.extname(source).toLowerCase();
	if (!AUDIO_EXTENSIONS.has(extension)) throw new Error(`Unsupported generated audio type "${extension || "(none)"}": ${source}`);
	const header = Buffer.alloc(12);
	const file = fs.openSync(source, "r");
	try {
		fs.readSync(file, header, 0, header.length, 0);
	} finally {
		fs.closeSync(file);
	}
	if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`Generated audio is not a valid WAV file: ${source}`);
	}

	const realOutputRoot = fs.realpathSync(outputRoot);
	const realSource = fs.realpathSync(source);
	if (!isWithin(realOutputRoot, realSource)) {
		throw new Error(`Generated audio is outside its temporary output directory: ${source}`);
	}
	return realSource;
}

export function validateAudioDescription(description: string): void {
	const words = description.trim().split(/\s+/);
	if (words.length !== 5) throw new Error("Audio filename description must contain exactly five words.");
	const wordSlugs = words.map((word) => word
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
	);
	if (wordSlugs.some((word) => !word)) {
		throw new Error("Audio filename description must use five words containing letters or numbers.");
	}
}

export function moveGeneratedAudio(
	sourcePath: string,
	outputRoot: string,
	vaultRoot: string,
	audioDescription: string,
	voiceName?: string,
): GeneratedAudio {
	const realSource = validateGeneratedAudioSource(sourcePath, outputRoot);
	const realVaultRoot = fs.realpathSync(vaultRoot);
	const attachmentRoot = ensureVaultDirectory(realVaultRoot, path.join(realVaultRoot, "001-Attachments"));
	const targetDirectory = ensureVaultDirectory(realVaultRoot, path.join(attachmentRoot, "~breezetts"));
	const realTargetDirectory = fs.realpathSync(targetDirectory);
	if (!isWithin(realVaultRoot, realTargetDirectory)) throw new Error(`Obsidian audio destination escapes the vault: ${targetDirectory}`);

	validateAudioDescription(audioDescription);
	const words = audioDescription.trim().split(/\s+/);
	const wordSlugs = words.map((word) => word
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
	);
	const descriptionSlug = wordSlugs.join("-");
	const base = [voiceName ? slug(voiceName) : "", descriptionSlug].filter(Boolean).join("-");
	for (let sequence = 1; sequence <= 99_999; sequence++) {
		const filename = `${base}-${sequence}.wav`;
		const targetPath = path.join(realTargetDirectory, filename);
		try {
			fs.copyFileSync(realSource, targetPath, fs.constants.COPYFILE_EXCL);
			const vaultRelativePath = path.relative(realVaultRoot, targetPath).split(path.sep).join("/");
			return { filename, path: targetPath, vaultRelativePath };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error(`Could not find an available Breeze TTS attachment name for "${base}".`);
}

export function replaceAudioPlaceholder(
	notePath: string,
	markerId: string,
	vaultRelativePath: string,
	transcriptDescription?: string,
	transcript?: string,
): void {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Audio placeholder ID must be a UUID.");
	const parts = vaultRelativePath.split(/[\\/]/);
	const filename = parts.at(-1) ?? "";
	if (
		parts.length !== 3 ||
		parts[0] !== "001-Attachments" ||
		parts[1] !== "~breezetts" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]*\.wav$/i.test(filename)
	) {
		throw new Error(`Invalid generated audio attachment path: ${vaultRelativePath}`);
	}
	if ((transcriptDescription === undefined) !== (transcript === undefined)) {
		throw new Error("Audio transcript description and text must be supplied together.");
	}
	if (transcriptDescription !== undefined) validateAudioDescription(transcriptDescription);

	const marker = `${AUDIO_MARKER_PREFIX}${markerId}%%`;
	const existing = fs.readFileSync(notePath, "utf-8");
	const firstIndex = existing.indexOf(marker);
	if (firstIndex < 0) throw new Error(`Audio placeholder was not found in the linked note: ${markerId}`);
	const transcriptCallout = transcriptDescription !== undefined && transcript !== undefined
		? `\n\n${renderAudioTranscriptCallout(transcriptDescription, transcript)}`
		: "";
	const suffixStart = firstIndex + marker.length;
	const closingQuotes = /^(?:(?:[ \t]*\r?\n[ \t]*>[ \t]?)|[ \t])*(?:[*_~]{1,3})?(?:["'“”‘’「」『』»]+)/.exec(existing.slice(suffixStart))?.[0] ?? "";
	fs.writeFileSync(
		notePath,
		`${existing.slice(0, firstIndex)}${closingQuotes}![[${parts.join("/")}]]${transcriptCallout}${existing.slice(suffixStart + closingQuotes.length)}`,
		"utf-8",
	);
}

function appendOutput(current: string, chunk: Buffer | string): string {
	return `${current}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT);
}

function runBreezeCommand(
	requestPath: string,
	outputDir: string,
	task: "clon" | "tts",
	signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const windows = process.platform === "win32";
		const powershellCommand = [
			"$ErrorActionPreference = 'Stop';",
			"try {",
			"$request = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json;",
			`$env:BREEZE_TTS_TASK = '${task}';`,
			"$command = Get-Command 'breeze-tts.cmd' -ErrorAction Stop;",
			"& $command.Source '--request-sequence' $request.requestPath '--out-dir' $request.outputDir;",
			"exit $LASTEXITCODE;",
			"} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 127 }",
		].join(" ");
		const child = spawn(
			windows ? "powershell.exe" : "breeze-tts",
			windows
				? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellCommand]
				: ["--request-sequence", requestPath, "--out-dir", outputDir],
			{
				windowsHide: true,
				signal,
				env: { ...process.env, BREEZE_TTS_TASK: task },
			},
		);
		child.stdin?.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(new Error(`Could not pass the Breeze TTS request to its command wrapper: ${error.message}`));
		});
		if (windows) {
			child.stdin?.end(Buffer.from(JSON.stringify({ requestPath, outputDir }), "utf-8").toString("base64"));
		}
		child.stdout?.on("data", (chunk: Buffer | string) => { stdout = appendOutput(stdout, chunk); });
		child.stderr?.on("data", (chunk: Buffer | string) => { stderr = appendOutput(stderr, chunk); });
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(new Error(`Could not start breeze-tts: ${error.message}`));
		});
		child.once("close", (code, childSignal) => {
			if (settled) return;
			settled = true;
			if (code !== 0) {
				const status = code === null
					? `signal ${childSignal ?? "unknown"}`
					: (code >>> 0) === 0xc0000135
						? "Windows loader error 0xC0000135 (a required DLL could not be found)"
						: `exit code ${code}`;
				reject(new Error([
					`breeze-tts failed with ${status}.`,
					stdout && `stdout:\n${stdout}`,
					stderr && `stderr:\n${stderr}`,
				].filter(Boolean).join("\n")));
				return;
			}
			resolve({ stdout, stderr });
		});
	});
}

function findWavOutputs(directory: string): string[] {
	const files: string[] = [];
	for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) files.push(...findWavOutputs(entryPath));
		else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".wav") files.push(entryPath);
	}
	return files;
}

export async function generateBreezeAudio(
	text: string,
	instruction: string,
	signal?: AbortSignal,
	preset: BreezeVoicePreset = { id: "standard", name: "Standard Breeze voice", mode: "standard" },
): Promise<GeneratedBreezeOutput> {
	if (!text.trim()) throw new Error("Speech text must contain non-whitespace text.");
	if (!instruction.trim()) throw new Error("Voice instruction must contain non-whitespace text.");
	let reference: VoiceReference | undefined;
	let task: "clon" | "tts";
	let request: { requests: Array<Record<string, unknown>> };
	if (preset.mode === "clone") {
		if (!preset.wavsDirectory || !preset.transcriptsDirectory) {
			throw new Error(`Voice-clone preset "${preset.name}" is missing its WAV or transcript directory.`);
		}
		reference = selectRandomVoiceReference(preset.wavsDirectory, preset.transcriptsDirectory, preset.name);
		task = "clon";
		request = buildBreezeCloneRequest(text, instruction, reference);
	} else {
		task = "tts";
		request = buildBreezeStandardRequest(text, instruction);
	}
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-breeze-tts-"));
	const outputDir = path.join(tempRoot, "outputs");
	fs.mkdirSync(outputDir);
	const requestPath = path.join(tempRoot, "requests.json");
	fs.writeFileSync(requestPath, JSON.stringify(request, null, 2), "utf-8");

	try {
		const result = await runBreezeCommand(requestPath, outputDir, task, signal);
		const wavs = findWavOutputs(outputDir);
		if (wavs.length !== 1) {
			throw new Error(`Breeze TTS produced ${wavs.length} WAV files; expected exactly one.${result.stdout ? `\nstdout:\n${result.stdout}` : ""}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`);
		}
		return {
			path: validateGeneratedAudioSource(wavs[0], outputDir),
			tempRoot,
			referenceId: reference?.id,
			voiceName: reference?.voiceName,
			...result,
		};
	} catch (error) {
		try {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new Error(
				`Breeze TTS failed (${error instanceof Error ? error.message : String(error)}); ` +
				`temporary files could not be removed (${errorMessageForCleanup(cleanupError)}).`,
			);
		}
		throw error;
	}
}

export function cleanupBreezeAudio(output: Pick<GeneratedBreezeOutput, "tempRoot">): void {
	fs.rmSync(output.tempRoot, { recursive: true, force: true });
}

function errorMessageForCleanup(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
