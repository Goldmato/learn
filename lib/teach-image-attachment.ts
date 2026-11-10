import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { formatImageNote, TRANSCRIPT_END, TRANSCRIPT_START } from "./md-log-format.ts";
import { placementAnchorMarker, removePlacementAnchorMarker } from "./placement-recovery.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

export interface ImageAttachment {
	filename: string;
	path: string;
	sourcePath: string;
}

function descriptiveSlug(value: string): string {
	const slug = imageSlug(value).slice(0, 64).replace(/-+$/g, "");
	return slug || "illustration";
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function imageSlug(value: string): string {
	const slug = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "illustration";
}

export function resolvePaintOutputRoot(projectRoot: string): string {
	const configPath = path.join(projectRoot, ".pi", "comfyui-paint.json");
	let configuredOutputDir: unknown;
	if (fs.existsSync(configPath)) {
		let config: unknown;
		try {
			config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
		} catch (error) {
			throw new Error(`Could not parse ComfyUI Paint config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (typeof config !== "object" || config === null || Array.isArray(config)) {
			throw new Error(`ComfyUI Paint config at ${configPath} must be a JSON object.`);
		}
		configuredOutputDir = (config as Record<string, unknown>).outputDir;
	}

	const environmentOutputDir = process.env.COMFYUI_OUTPUT_DIR?.trim();
	const outputDir = environmentOutputDir || configuredOutputDir;
	if (typeof outputDir === "string" && outputDir.trim()) {
		return path.resolve(projectRoot, outputDir);
	}
	if (outputDir !== undefined) {
		throw new Error("ComfyUI Paint outputDir must be a non-empty string.");
	}
	const userId = typeof process.getuid === "function" ? process.getuid() : "user";
	return path.join(os.tmpdir(), `pi-comfyui-paint-${userId}`);
}

export function findVaultRoot(notePath: string): string {
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

export function validateGeneratedImageSource(sourcePath: string, outputRoot: string): string {
	const source = path.resolve(sourcePath);
	const sourceStat = fs.lstatSync(source);
	if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
		throw new Error(`Generated image must be a regular file: ${source}`);
	}
	if (sourceStat.size === 0) throw new Error(`Generated image is empty: ${source}`);

	const extension = path.extname(source).toLowerCase();
	if (!IMAGE_EXTENSIONS.has(extension)) {
		throw new Error(`Unsupported generated image type "${extension || "(none)"}": ${source}`);
	}

	const realOutputRoot = fs.realpathSync(outputRoot);
	const realSource = fs.realpathSync(source);
	if (!isWithin(realOutputRoot, realSource)) {
		throw new Error(`Generated image is outside the configured ComfyUI output directory: ${source}`);
	}
	return realSource;
}

function ensureVaultDirectory(vaultRoot: string, directory: string): string {
	try {
		fs.mkdirSync(directory);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
	}

	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) {
		throw new Error(`Obsidian image destination must be a real directory: ${directory}`);
	}
	const realDirectory = fs.realpathSync(directory);
	if (!isWithin(vaultRoot, realDirectory)) {
		throw new Error(`Obsidian image destination escapes the vault: ${directory}`);
	}
	return realDirectory;
}

export function copyGeneratedImage(
	sourcePath: string,
	outputRoot: string,
	vaultRoot: string,
	topic: string,
): ImageAttachment {
	const realSource = validateGeneratedImageSource(sourcePath, outputRoot);
	const extension = path.extname(realSource).toLowerCase();

	const realVaultRoot = fs.realpathSync(vaultRoot);
	const attachmentRoot = ensureVaultDirectory(realVaultRoot, path.join(realVaultRoot, "001-Attachments"));
	const targetDir = ensureVaultDirectory(realVaultRoot, path.join(attachmentRoot, "~comfyui"));
	const realAttachmentDir = fs.realpathSync(targetDir);
	if (!isWithin(realVaultRoot, realAttachmentDir)) {
		throw new Error(`Obsidian image destination escapes the vault: ${targetDir}`);
	}

	const slug = imageSlug(topic);
	for (let sequence = 1; sequence <= 99_999; sequence++) {
		const filename = `comfyui-${slug}-${sequence}${extension}`;
		const targetPath = path.join(realAttachmentDir, filename);
		try {
			fs.copyFileSync(realSource, targetPath, fs.constants.COPYFILE_EXCL);
			return { filename, path: targetPath, sourcePath: realSource };
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	throw new Error(`Could not find an available ComfyUI attachment name for "${slug}".`);
}

export function copyCoverImage(
	sourcePath: string,
	outputRoot: string,
	vaultRoot: string,
	noteTitle: string,
): ImageAttachment {
	const realSource = validateGeneratedImageSource(sourcePath, outputRoot);
	const extension = path.extname(realSource).toLowerCase();
	const realVaultRoot = fs.realpathSync(vaultRoot);
	const attachmentRoot = ensureVaultDirectory(realVaultRoot, path.join(realVaultRoot, "001-Attachments"));
	const targetDir = ensureVaultDirectory(realVaultRoot, path.join(attachmentRoot, "~covers"));
	const slug = imageSlug(noteTitle);

	for (let sequence = 1; sequence <= 99_999; sequence++) {
		const suffix = sequence === 1 ? "" : `-${sequence}`;
		const filename = `${slug}-cover${suffix}${extension}`;
		const targetPath = path.join(targetDir, filename);
		try {
			fs.copyFileSync(realSource, targetPath, fs.constants.COPYFILE_EXCL);
			return { filename, path: targetPath, sourcePath: realSource };
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
		}
	}
	throw new Error(`Could not find an available cover filename for "${slug}".`);
}

export function moveGeneratedImage(
	sourcePath: string,
	outputRoot: string,
	vaultRoot: string,
	topic: string,
): ImageAttachment {
	const attached = copyGeneratedImage(sourcePath, outputRoot, vaultRoot, topic);
	try {
		fs.unlinkSync(attached.sourcePath);
	} catch (error) {
		try {
			fs.unlinkSync(attached.path);
		} catch (cleanupError) {
			throw new Error(
				`Could not move generated image into the vault (${error instanceof Error ? error.message : String(error)}); ` +
				`cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
			);
		}
		throw new Error(`Could not move generated image into the vault: ${error instanceof Error ? error.message : String(error)}`);
	}
	return attached;
}

export function renameGeneratedImage(
	sourcePath: string,
	outputRoot: string,
	descriptiveName: string,
): string {
	const source = validateGeneratedImageSource(sourcePath, outputRoot);
	const extension = path.extname(source).toLowerCase();
	const directory = path.dirname(source);
	const slug = descriptiveSlug(descriptiveName);
	for (let sequence = 1; sequence <= 99_999; sequence++) {
		const suffix = sequence === 1 ? "" : `-${sequence}`;
		const targetPath = path.join(directory, `${slug}${suffix}${extension}`);
		if (targetPath === source) return source;
		try {
			fs.copyFileSync(source, targetPath, fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
		try {
			fs.unlinkSync(source);
		} catch (error) {
			try {
				fs.unlinkSync(targetPath);
			} catch (cleanupError) {
				throw new Error(
					`Could not rename generated image (${error instanceof Error ? error.message : String(error)}); ` +
					`cleanup also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}).`,
				);
			}
			throw new Error(`Could not rename generated image: ${error instanceof Error ? error.message : String(error)}`);
		}
		return targetPath;
	}
	throw new Error(`Could not find an available generated image name for "${slug}".`);
}

/**
 * Placement markers are a projection of the transcript, not a note edit: the
 * renderer owns every position inside the managed section, so writing here too
 * would only drift. These helpers keep their signatures and validate arguments.
 */
export function insertImagePlaceholder(
	notePath: string,
	markerId: string,
	insertAfter: string,
	anchorId?: string,
): string {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Image placeholder ID must be a UUID.");
	if (anchorId !== undefined && !/^[a-f0-9-]{36}$/i.test(anchorId)) throw new Error("Image anchor ID must be a UUID.");
	const anchor = insertAfter.trim();
	if (!anchor) throw new Error("Image insertion anchor must contain non-whitespace text.");
	const stat = fs.lstatSync(notePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Linked md-log path is not a regular file: ${notePath}`);
	const existing = fs.readFileSync(notePath, "utf-8");
	const marker = `%%pi-comfyui-image:${markerId}%%`;
	if (existing.includes(marker)) throw new Error(`Image placeholder already exists: ${markerId}`);
	const idMarker = anchorId ? placementAnchorMarker(anchorId, markerId) : "";
	if (idMarker && existing.includes(idMarker)) throw new Error(`Image anchor already exists: ${anchorId}`);
	const managedStart = existing.lastIndexOf(TRANSCRIPT_START);
	const managedContentStart = managedStart < 0 ? -1 : managedStart + TRANSCRIPT_START.length;
	const managedEnd = managedContentStart < 0 ? -1 : existing.indexOf(TRANSCRIPT_END, managedContentStart);
	if (managedEnd < 0) throw new Error("Linked note does not contain a complete managed md-log transcript.");
	const anchorIndex = existing.indexOf(anchor, managedContentStart);
	if (anchorIndex < 0 || anchorIndex + anchor.length > managedEnd) {
		throw new Error("Image insertion anchor was not found in the managed linked-note transcript; choose exact existing transcript text.");
	}
	const insertAt = anchorIndex + anchor.length;
	const before = existing.slice(0, insertAt);
	const after = existing.slice(insertAt);
	const separator = before.endsWith("\n") ? "\n" : "\n\n";
	const trailingNewline = after.startsWith("\n") ? "" : "\n";
	fs.writeFileSync(notePath, `${before}${separator}${idMarker ? `${idMarker}\n\n` : ""}${marker}${trailingNewline}${after}`, "utf-8");
	return marker;
}

export function removeImagePlaceholder(notePath: string, markerId: string): void {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Image placeholder ID must be a UUID.");
	const marker = `%%pi-comfyui-image:${markerId}%%`;
	const existing = removePlacementAnchorMarker(fs.readFileSync(notePath, "utf-8"), markerId);
	const firstIndex = existing.indexOf(marker);
	if (firstIndex < 0) return;
	fs.writeFileSync(notePath, `${existing.slice(0, firstIndex)}${existing.slice(firstIndex + marker.length)}`, "utf-8");
}

export function replaceImagePlaceholder(
	notePath: string,
	markerId: string,
	attachmentPath: string,
	title: string,
	caption: string,
): void {
	if (!/^[a-f0-9-]{36}$/i.test(markerId)) throw new Error("Image placeholder ID must be a UUID.");
	const safeCaption = caption.replace(/\s+/g, " ").trim();
	if (!safeCaption || safeCaption.length > 500) throw new Error("Image caption must contain 1-500 non-whitespace characters.");
	if (!title.trim() || title.trim().length > 100) throw new Error("Image note title must contain 1-100 non-whitespace characters.");
	const pathParts = attachmentPath.split(/[\\/]/);
	const filename = pathParts.at(-1) ?? "";
	if (
		path.isAbsolute(attachmentPath) ||
		pathParts.some((part) => part !== "~comfyui" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
		!/\.(?:png|jpe?g|webp|gif)$/i.test(filename)
	) {
		throw new Error(`Invalid generated image attachment path: ${attachmentPath}`);
	}
	const marker = `%%pi-comfyui-image:${markerId}%%`;
	const existing = fs.readFileSync(notePath, "utf-8");
	const firstIndex = existing.indexOf(marker);
	if (firstIndex < 0) throw new Error(`Image placeholder was not found in the linked note: ${markerId}`);
	const imageBlock = `${formatImageNote(title, safeCaption)}\n\n![[${pathParts.join("/")}]]`;
	fs.writeFileSync(
		notePath,
		`${existing.slice(0, firstIndex)}${imageBlock}${existing.slice(firstIndex + marker.length)}`,
		"utf-8",
	);
}
