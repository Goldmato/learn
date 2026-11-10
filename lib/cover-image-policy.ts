import * as fs from "node:fs";
import * as path from "node:path";
import type { MOSSBoundingBoxSpec } from "./comfyui-image-policy.ts";
import { findVaultRoot } from "./teach-image-attachment.ts";

const COVER_ASPECT_RATIO = 3 / 2;

const KNOWN_FOLDER_BORDERS: Record<string, string> = {
	"100-learning": "a narrow, continuous oxidized-copper and deep-teal double-brush border, with restrained dry-brush texture",
	"200-reviewing": "a narrow, continuous warm-ochre and charcoal border, with fine crosshatched brush corners",
	"300-practicing": "a narrow, continuous indigo and muted-vermilion border, with broken stamped-brush corner marks",
};

const FALLBACK_BORDER_COLORS = [
	"slate blue", "moss green", "burnt sienna", "plum", "sea-glass green", "rosewood",
	"smoky violet", "copper", "petrol blue", "mustard", "brick red", "pine green",
];
const FALLBACK_BORDER_STYLES = [
	"a fine paired brush line",
	"a broken dry-brush band",
	"a lightly stippled brush frame",
	"a restrained crosshatched corner frame",
	"a softly scalloped brush edge",
	"a spare ink-and-gouache double line",
];

export function coverFolderBorderStyle(folderName: string): string {
	const normalized = folderName.trim().normalize("NFKC").toLowerCase();
	if (!normalized) throw new Error("Cover folder name must not be empty.");
	const known = KNOWN_FOLDER_BORDERS[normalized];
	if (known) return known;

	let hash = 2166136261;
	for (const character of normalized) {
		hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
	}
	const primaryIndex = hash % FALLBACK_BORDER_COLORS.length;
	const secondaryOffset = ((hash >>> 8) % (FALLBACK_BORDER_COLORS.length - 1)) + 1;
	const primary = FALLBACK_BORDER_COLORS[primaryIndex];
	const secondary = FALLBACK_BORDER_COLORS[(primaryIndex + secondaryOffset) % FALLBACK_BORDER_COLORS.length];
	const style = FALLBACK_BORDER_STYLES[(hash >>> 16) % FALLBACK_BORDER_STYLES.length];
	return `${style} in ${primary} and ${secondary}`;
}

export function resolveCoverNoteTarget(
	argument: string,
	linkedPath: string | undefined,
	cwd: string,
): { notePath: string; vaultRoot: string } {
	let target = argument.trim();
	if (target) {
		if (target.startsWith("@")) target = target.slice(1).trim();
		if ((target.startsWith('"') && target.endsWith('"')) ||
			(target.startsWith("'") && target.endsWith("'")) ||
			(target.startsWith("<") && target.endsWith(">"))) {
			target = target.slice(1, -1).trim();
		}
	} else {
		target = linkedPath ?? "";
	}
	if (!target) {
		throw new Error("No linked md-log note was found. Link one with /md-log or pass /cover-image @path/to/note.md.");
	}

	const resolved = path.resolve(cwd, target);
	if (path.extname(resolved).toLowerCase() !== ".md") throw new Error("Cover targets must be Markdown (.md) files.");
	const stat = fs.lstatSync(resolved);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Cover target must be a regular, non-symlink Markdown file: ${resolved}`);
	}
	const notePath = fs.realpathSync(resolved);
	return { notePath, vaultRoot: fs.realpathSync(findVaultRoot(notePath)) };
}

export function coverTextBoxCanRender(text: string, box: Pick<MOSSBoundingBoxSpec, "width" | "height">): boolean {
	const normalizedText = text.trim();
	if (!normalizedText || box.width <= 0 || box.height < 0.16) return false;

	const glyphHeight = Math.min(0.13, box.height * 0.68);
	if (glyphHeight < 0.08) return false;
	const capacity = box.width * COVER_ASPECT_RATIO * 0.86 / glyphHeight;
	const textWidth = Array.from(normalizedText).reduce((total, character) => {
		if (/\p{M}/u.test(character)) return total;
		if (/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(character)) return total + 1;
		if (/[A-Za-z0-9]/.test(character)) return total + 0.55;
		if (/\s/.test(character)) return total + 0.3;
		if (/[.,:;'"!?()[\]{}\-–—/\\]/u.test(character)) return total + 0.38;
		return total + 0.85;
	}, 0);

	return textWidth <= capacity;
}

export function prepareCoverBoxes(boxes: MOSSBoundingBoxSpec[]): {
	boxes: MOSSBoundingBoxSpec[];
	omittedTextCount: number;
} {
	let omittedTextCount = 0;
	const prepared = boxes.map((box) => {
		const text = typeof box.text === "string" ? box.text.trim() : "";
		if (!text && box.kind !== "text") return box;
		if (text && coverTextBoxCanRender(text, box)) return { ...box, kind: "text" as const, text };
		omittedTextCount++;
		return {
			...box,
			kind: "object" as const,
			text: undefined,
			description: "A nonverbal visual mark; no lettering.",
		};
	});
	return { boxes: prepared, omittedTextCount };
}

export function noteBodyForCover(markdown: string): string {
	return markdown
		.replace(/^\uFEFF/, "")
		.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "")
		.replace(/%%[\s\S]*?%%/g, " ")
		.trim();
}

export function coverSourceExcerpt(markdown: string, maxCharacters = 24_000): string {
	const body = noteBodyForCover(markdown);
	if (body.length <= maxCharacters) return body;

	const headings = body.split(/\r?\n/).filter((line) => /^#{1,6}\s+\S/.test(line)).join("\n");
	const headingBudget = Math.min(Math.floor(maxCharacters / 5), headings.length);
	const excerptBudget = maxCharacters - headingBudget - 120;
	const excerptLength = Math.floor(excerptBudget / 3);
	const headingExcerpt = headings.slice(0, headingBudget);
	const beginning = body.slice(0, excerptLength);
	const middleStart = Math.max(0, Math.floor((body.length - excerptLength) / 2));
	const middle = body.slice(middleStart, middleStart + excerptLength);
	const ending = body.slice(-excerptLength);
	return `${headingExcerpt}\n\n[Opening excerpt]\n${beginning}\n\n[Middle excerpt]\n${middle}\n\n[Later excerpt]\n${ending}`;
}

export function normalizeCoverOverview(value: string): string {
	const overview = value.replace(/\s+/g, " ").trim();
	if (!overview) throw new Error("Cover overview must contain non-whitespace text.");
	const characterCount = Array.from(overview).length;
	if (characterCount < 56 || characterCount > 64) {
		throw new Error(`Cover overview must contain 56–64 characters; received ${characterCount}.`);
	}
	return overview;
}

export function updateCoverFrontmatter(markdown: string, wikilink: string, overviewText: string): string {
	if (!wikilink.trim() || /[\r\n]/.test(wikilink)) {
		throw new Error("Cover wikilink must be a non-empty, single-line value.");
	}
	const overview = normalizeCoverOverview(overviewText);
	const properties = {
		cover: wikilink,
		overview,
	};
	const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
	const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
	const content = bom ? markdown.slice(1) : markdown;
	const match = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/.exec(content);
	if (!match) {
		const entries = Object.entries(properties)
			.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
			.join(newline);
		return `${bom}---${newline}${entries}${newline}---${newline}${content}`;
	}

	const lines = match[2].split(/\r?\n/);
	for (const [key, value] of Object.entries(properties)) {
		const propertyLines = lines.reduce<number[]>((found, line, index) => {
			if (new RegExp(`^(?:${key}|"${key}"|'${key}')[ \\t]*:`).test(line)) found.push(index);
			return found;
		}, []);
		if (propertyLines.length > 1) {
			throw new Error(`Markdown frontmatter contains duplicate root-level ${key} properties.`);
		}
		const line = `${key}: ${JSON.stringify(value)}`;
		if (propertyLines.length === 1) lines[propertyLines[0]] = line;
		else lines.push(line);
	}

	const replacement = `${match[1]}${lines.join(newline)}${match[3]}`;
	return `${bom}${content.slice(0, match.index)}${replacement}${content.slice(match.index + match[0].length)}`;
}
