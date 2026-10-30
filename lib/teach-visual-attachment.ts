import * as fs from "node:fs";
import * as path from "node:path";
import {
	formatImageNote,
	isVisualKind,
	TRANSCRIPT_END,
	TRANSCRIPT_START,
	type VisualKind,
	VISUAL_KINDS,
	visualMarker,
} from "./md-log-format.ts";

/**
 * Placeholder and attachment handling for the picture makers (mermaid, svg).
 *
 * Unlike ComfyUI, these makers publish straight into the vault, so attaching is
 * a validation step rather than a copy: the marker is replaced with the same
 * titled quote block and embed an image produces.
 */

const UUID = /^[a-f0-9-]{36}$/i;

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireKind(kind: unknown): VisualKind {
	if (!isVisualKind(kind)) throw new Error(`Unknown visual kind: ${String(kind)}`);
	return kind;
}

function requireMarkerId(markerId: string): void {
	if (!UUID.test(markerId)) throw new Error("Visual placeholder ID must be a UUID.");
}

/** Read the managed section and return its bounds, or throw when it is absent. */
function managedBounds(markdown: string): { start: number; end: number } {
	const markerStart = markdown.lastIndexOf(TRANSCRIPT_START);
	const start = markerStart < 0 ? -1 : markerStart + TRANSCRIPT_START.length;
	const end = start < 0 ? -1 : markdown.indexOf(TRANSCRIPT_END, start);
	if (end < 0) throw new Error("Linked note does not contain a complete managed md-log transcript.");
	return { start, end };
}

/** Locate the single occurrence of a marker, or throw. */
function markerIndex(markdown: string, marker: string, markerId: string): number {
	const first = markdown.indexOf(marker);
	if (first < 0) throw new Error(`Visual placeholder was not found in the linked note: ${markerId}`);
	if (markdown.indexOf(marker, first + marker.length) >= 0) {
		throw new Error(`Visual placeholder occurs more than once in the linked note: ${markerId}`);
	}
	return first;
}

export function insertVisualPlaceholder(
	notePath: string,
	kind: VisualKind,
	markerId: string,
	insertAfter: string,
): string {
	requireMarkerId(markerId);
	const visualKind = requireKind(kind);
	const anchor = insertAfter.trim();
	if (!anchor) throw new Error("Visual insertion anchor must contain non-whitespace text.");
	const stat = fs.lstatSync(notePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Linked md-log path is not a regular file: ${notePath}`);

	const existing = fs.readFileSync(notePath, "utf-8");
	const marker = visualMarker(visualKind, markerId);
	if (existing.includes(marker)) throw new Error(`Visual placeholder already exists: ${markerId}`);

	const { start, end } = managedBounds(existing);
	const anchorIndex = existing.indexOf(anchor, start);
	if (anchorIndex < 0 || anchorIndex + anchor.length > end) {
		throw new Error("Visual insertion anchor was not found in the managed linked-note transcript; choose exact existing transcript text.");
	}

	const insertAt = anchorIndex + anchor.length;
	const before = existing.slice(0, insertAt);
	const after = existing.slice(insertAt);
	const separator = before.endsWith("\n") ? "\n" : "\n\n";
	const trailingNewline = after.startsWith("\n") ? "" : "\n";
	fs.writeFileSync(notePath, `${before}${separator}${marker}${trailingNewline}${after}`, "utf-8");
	return marker;
}

export function removeVisualPlaceholder(notePath: string, kind: VisualKind, markerId: string): void {
	requireMarkerId(markerId);
	const marker = visualMarker(requireKind(kind), markerId);
	const existing = fs.readFileSync(notePath, "utf-8");
	const firstIndex = existing.indexOf(marker);
	if (firstIndex < 0) return;
	const lineStart = existing.lastIndexOf("\n", firstIndex - 1) + 1;
	const lineEnd = existing.indexOf("\n", firstIndex + marker.length);
	const removeStart = lineStart === firstIndex ? lineStart : firstIndex;
	const removeEnd = lineEnd < 0 ? existing.length : lineEnd + 1;
	fs.writeFileSync(notePath, `${existing.slice(0, removeStart)}${existing.slice(removeEnd)}`, "utf-8");
}

/**
 * Validate a published PNG and return its vault-relative path. The file must be
 * a regular file inside `001-Attachments/<kind folder>`.
 */
export function validatePublishedVisual(sourcePath: string, vaultRoot: string, kind: VisualKind): string {
	const visualKind = requireKind(kind);
	const source = path.resolve(sourcePath);
	const stat = fs.lstatSync(source);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Published picture must be a regular file: ${source}`);
	if (stat.size === 0) throw new Error(`Published picture is empty: ${source}`);
	if (path.extname(source).toLowerCase() !== ".png") {
		throw new Error(`Published picture must be a PNG: ${source}`);
	}

	const realVaultRoot = fs.realpathSync(vaultRoot);
	const realSource = fs.realpathSync(source);
	const expectedDir = fs.realpathSync(path.join(realVaultRoot, "001-Attachments", VISUAL_KINDS[visualKind].folder));
	if (!isWithin(expectedDir, realSource)) {
		throw new Error(`Published picture is outside ${VISUAL_KINDS[visualKind].folder}: ${source}`);
	}
	return path.relative(realVaultRoot, realSource).split(path.sep).join("/");
}

export function replaceVisualPlaceholder(
	notePath: string,
	kind: VisualKind,
	markerId: string,
	vaultRelativePath: string,
	title: string,
	caption: string,
): void {
	requireMarkerId(markerId);
	const visualKind = requireKind(kind);
	const safeCaption = caption.replace(/\s+/g, " ").trim();
	if (!safeCaption || safeCaption.length > 500) throw new Error("Visual caption must contain 1-500 non-whitespace characters.");
	if (!title.trim() || title.trim().length > 100) throw new Error("Visual note title must contain 1-100 non-whitespace characters.");

	const parts = vaultRelativePath.split(/[\\/]/);
	const filename = parts.at(-1) ?? "";
	const folder = VISUAL_KINDS[visualKind].folder;
	if (
		path.isAbsolute(vaultRelativePath) ||
		parts.some((part) => part !== folder && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)) ||
		!/\.png$/i.test(filename)
	) {
		throw new Error(`Invalid published picture path: ${vaultRelativePath}`);
	}

	const marker = visualMarker(visualKind, markerId);
	const existing = fs.readFileSync(notePath, "utf-8");
	const firstIndex = markerIndex(existing, marker, markerId);
	const block = `${formatImageNote(title, safeCaption)}\n\n![[${parts.join("/")}]]`;
	fs.writeFileSync(
		notePath,
		`${existing.slice(0, firstIndex)}${block}${existing.slice(firstIndex + marker.length)}`,
		"utf-8",
	);
}
