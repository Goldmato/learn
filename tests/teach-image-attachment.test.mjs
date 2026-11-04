import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	copyGeneratedImage,
	findVaultRoot,
	insertImagePlaceholder,
	moveGeneratedImage,
	renameGeneratedImage,
	replaceImagePlaceholder,
	resolvePaintOutputRoot,
	validateGeneratedImageSource,
} from "../lib/teach-image-attachment.ts";
import { buildBackfill, TEACH_IMAGE_PLACEMENT_ENTRY } from "../lib/md-log-format.ts";

let registerImageTools;
try {
	registerImageTools = (await import("../agents/extensions/teach-image-attachment.ts")).default;
} catch (error) {
	if (!(error instanceof Error) || !error.message.includes("Cannot find package '@sinclair/typebox'")) throw error;
}

test("generated image copies stay inside the vault and increment topic filenames", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-copy-"));
	const outputRoot = path.join(root, "paint-jobs");
	const vaultRoot = path.join(root, "vault");
	const outputPath = path.join(outputRoot, "job-1", "outputs", "image.webp");
	const notePath = path.join(vaultRoot, "lesson.md");
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, "001-Attachments"));
	fs.writeFileSync(outputPath, Buffer.from("generated image bytes"));
	fs.writeFileSync(notePath, "# Lesson\n");

	try {
		assert.equal(findVaultRoot(notePath), vaultRoot);
		const first = copyGeneratedImage(outputPath, outputRoot, vaultRoot, "Energy flow");
		const retryPath = path.join(outputRoot, "job-2", "outputs", "image.webp");
		fs.mkdirSync(path.dirname(retryPath), { recursive: true });
		fs.writeFileSync(retryPath, Buffer.from("retry image bytes"));
		const retry = copyGeneratedImage(retryPath, outputRoot, vaultRoot, "Energy flow");

		assert.equal(first.filename, "comfyui-energy-flow-1.webp");
		assert.equal(retry.filename, "comfyui-energy-flow-2.webp");
		assert.equal(path.dirname(first.path), path.join(vaultRoot, "001-Attachments", "~comfyui"));
		assert.deepEqual(fs.readFileSync(first.path), fs.readFileSync(outputPath));
		assert.deepEqual(fs.readFileSync(retry.path), fs.readFileSync(retryPath));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("generated image is descriptively renamed, moved to an existing attachment folder, and linked at its marker", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-placement-"));
	const outputRoot = path.join(root, "paint-jobs");
	const vaultRoot = path.join(root, "vault");
	const outputPath = path.join(outputRoot, "job-1", "outputs", "paint_0.png");
	const notePath = path.join(vaultRoot, "lesson.md");
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, "001-Attachments"));
	fs.writeFileSync(outputPath, Buffer.from("generated image bytes"));
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nIntroductory note text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");

	try {
		const renamedPath = renameGeneratedImage(outputPath, outputRoot, "Prismatic Glass Refraction Diagram");
		assert.equal(path.basename(renamedPath), "prismatic-glass-refraction-diagram.png");
		assert.equal(fs.existsSync(outputPath), false);

		const marker = insertImagePlaceholder(notePath, markerId, "Introductory note text.");
		const noteWithMarker = fs.readFileSync(notePath, "utf-8");
		assert.ok(noteWithMarker.includes(marker));
		assert.ok(noteWithMarker.indexOf(marker) > noteWithMarker.indexOf("Introductory note text."));
		assert.ok(noteWithMarker.indexOf(marker) < noteWithMarker.indexOf("Introductory note text.") + 60);
		fs.appendFileSync(notePath, "\nText added while image generation ran.\n", "utf-8");
		const attached = moveGeneratedImage(renamedPath, outputRoot, vaultRoot, "Prismatic Glass Refraction");
		replaceImagePlaceholder(
			notePath,
			markerId,
			path.relative(vaultRoot, attached.path),
			"Prismatic Glass Refraction",
			"A prism separates white light into colors, revealing how refraction depends on wavelength.",
		);

		const note = fs.readFileSync(notePath, "utf-8");
		assert.ok(note.includes(`> [!quote] Prismatic Glass Refraction\n> *"A prism separates white light into colors, revealing how refraction depends on wavelength."*\n\n![[001-Attachments/~comfyui/${attached.filename}]]`));
		assert.ok(note.includes("Text added while image generation ran."));
		assert.ok(fs.existsSync(attached.path));
		assert.equal(fs.existsSync(renamedPath), false);
		assert.equal(path.dirname(attached.path), path.join(vaultRoot, "001-Attachments", "~comfyui"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("generated images create the required attachment subfolder when it is absent", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-root-fallback-"));
	const outputRoot = path.join(root, "paint-jobs");
	const vaultRoot = path.join(root, "vault");
	const outputPath = path.join(outputRoot, "image.webp");
	fs.mkdirSync(outputRoot);
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(outputPath, Buffer.from("generated image bytes"));

	try {
		const attached = copyGeneratedImage(outputPath, outputRoot, vaultRoot, "Cell Energy Flow");
		assert.equal(path.dirname(attached.path), path.join(vaultRoot, "001-Attachments", "~comfyui"));
		assert.ok(fs.existsSync(path.join(vaultRoot, "001-Attachments")));
		assert.equal(attached.filename, "comfyui-cell-energy-flow-1.webp");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("image placement markers preserve later note edits and stay quiet during md-log backfill", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-tools-"));
	const notePath = path.join(root, "lesson.md");
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const anchorId = "64e2a2eb-5d4d-4987-89df-5bed565d0c87";
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nIntro text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");

	try {
		insertImagePlaceholder(notePath, markerId, "Intro text.", anchorId);
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`%%pi-placement-anchor:${anchorId}:${markerId}%%`));
		assert.ok(fs.readFileSync(notePath, "utf-8").includes(`%%pi-comfyui-image:${markerId}%%`));
		fs.appendFileSync(notePath, "\nNew note text added while ComfyUI was running.\n", "utf-8");
		replaceImagePlaceholder(
			notePath,
			markerId,
			"001-Attachments/~comfyui/comfyui-prismatic-glass-refraction-1.png",
			"Prism Refraction",
			"This diagram shows how a prism separates white light into its component colors.",
		);
		const note = fs.readFileSync(notePath, "utf-8");
		assert.match(note, new RegExp(`%%pi-placement-anchor:${anchorId}:${markerId}%%`));
		assert.ok(note.includes("![[001-Attachments/~comfyui/comfyui-prismatic-glass-refraction-1.png]]"));
		assert.ok(note.includes("> [!quote] Prism Refraction\n> *\"This diagram shows how a prism separates white light into its component colors.\"*"));
		assert.ok(note.includes("New note text added while ComfyUI was running."));
		assert.doesNotMatch(note, /pi-comfyui-image:/);
		const backfill = buildBackfill([
			{ id: "session", type: "session" },
			{
				id: "placement",
				parentId: "session",
				type: "custom",
				customType: TEACH_IMAGE_PLACEMENT_ENTRY,
				data: { markerId, status: "placed" },
			},
		]);
		assert.deepEqual(backfill.diagnostics, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("registered attachment tool duplicates the image and replaces the marker after later edits", {
	skip: !registerImageTools,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-tool-integration-"));
	const vaultRoot = path.join(root, "vault");
	const outputRoot = path.join(root, "paint-jobs");
	const notePath = path.join(vaultRoot, "lesson.md");
	const sourcePath = path.join(outputRoot, "job-1", "outputs", "paint_0.png");
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const oldOutputDir = process.env.COMFYUI_OUTPUT_DIR;
	const entries = [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
		{
			id: "placement",
			parentId: "mdlog",
			type: "custom",
			customType: TEACH_IMAGE_PLACEMENT_ENTRY,
			data: {
				markerId,
				status: "dispatched",
				notePath,
				anchor: "Intro text.",
				captionTitle: "Goblin Hibernation Cycle",
				caption: "The cycle shows how seasonal conditions trigger dormancy and renewed activity.",
			},
		},
	];
	const tools = new Map();
	const pi = {
		registerTool(definition) { tools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.mkdirSync(path.join(vaultRoot, "001-Attachments"));
	fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
	fs.writeFileSync(notePath, "# Lesson\n\n%% pi-md-log:start v1 %%\n\nIntro text.\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	fs.writeFileSync(sourcePath, Buffer.from("generated image"));
	const ctx = {
		cwd: root,
		sessionManager: { getEntries: () => entries },
	};

	try {
		process.env.COMFYUI_OUTPUT_DIR = outputRoot;
		insertImagePlaceholder(notePath, markerId, "Intro text.");
		registerImageTools(pi);
		const attach = tools.get("teach_attach_generated_image");
		assert.ok(attach);
		assert.equal(tools.has("teach_prepare_generated_image"), false);
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`pi-comfyui-image:${markerId}`));

		fs.appendFileSync(notePath, "\nText appended while the image job ran.\n", "utf-8");
		const placed = await attach.execute("attach", {
			sourcePath,
			topic: "Goblin Hibernation Cycle",
			captionTitle: "Seasonal Dormancy Cycle",
			caption: "The cycle shows how seasonal conditions trigger dormancy and renewed activity.",
			markerId,
			notePath,
		}, undefined, undefined, ctx);
		const filename = placed.details.filename;
		assert.equal(placed.details.status, "placed");
		assert.ok(fs.existsSync(placed.details.path));
		assert.equal(path.dirname(placed.details.path), path.join(vaultRoot, "001-Attachments", "~comfyui"));
		assert.ok(fs.readFileSync(notePath, "utf-8").includes(`> [!quote] Seasonal Dormancy Cycle\n> *"The cycle shows how seasonal conditions trigger dormancy and renewed activity."*\n\n![[001-Attachments/~comfyui/${filename}]]`));
		assert.ok(fs.readFileSync(notePath, "utf-8").includes("Text appended while the image job ran."));
		assert.equal(fs.existsSync(sourcePath), true);

		const repeated = await attach.execute("attach-again", {
			sourcePath,
			topic: "Goblin Hibernation Cycle",
			captionTitle: "Seasonal Dormancy Cycle",
			caption: "The cycle shows how seasonal conditions trigger dormancy and renewed activity.",
			markerId,
			notePath,
		}, undefined, undefined, ctx);
		assert.equal(repeated.details.path, placed.details.path);
	} finally {
		if (oldOutputDir === undefined) delete process.env.COMFYUI_OUTPUT_DIR;
		else process.env.COMFYUI_OUTPUT_DIR = oldOutputDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("attachment tool preserves its marker when the generator reports an error", {
	skip: !registerImageTools,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-failure-cleanup-"));
	const vaultRoot = path.join(root, "vault");
	const notePath = path.join(vaultRoot, "lesson.md");
	const markerId = "91accc63-53db-4d7f-9f04-790f6879ee2a";
	const entries = [
		{ id: "session", type: "session" },
		{ id: "mdlog", parentId: "session", type: "custom", customType: "md-log", data: { file: notePath } },
	];
	const tools = new Map();
	const pi = {
		registerTool(definition) { tools.set(definition.name, definition); },
		appendEntry(customType, data) {
			entries.push({ id: `entry-${entries.length}`, parentId: entries.at(-1)?.id, type: "custom", customType, data });
		},
	};
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	fs.writeFileSync(notePath, "%% pi-md-log:start v1 %%\n\n# Lesson\n\n%% pi-md-log:end v1 %%\n", "utf-8");
	insertImagePlaceholder(notePath, markerId, "# Lesson");
	registerImageTools(pi);

	try {
		const attach = tools.get("teach_attach_generated_image");
		const result = await attach.execute("failure", {
			markerId,
			notePath,
			error: "ComfyUI generation timed out",
		}, undefined, undefined, {
			cwd: root,
			sessionManager: { getEntries: () => entries },
		});
		assert.equal(result.details.status, "failed");
		assert.match(fs.readFileSync(notePath, "utf-8"), new RegExp(`%%pi-comfyui-image:${markerId}%%`));
		assert.ok(entries.some((entry) => entry.data?.status === "failed" && entry.data.error === "ComfyUI generation timed out"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("only regular image files under the configured ComfyUI output root are accepted", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-guard-"));
	const outputRoot = path.join(root, "paint-jobs");
	const sourcePath = path.join(outputRoot, "image.png");
	const externalPath = path.join(root, "external.png");
	const unsupportedPath = path.join(outputRoot, "notes.txt");
	fs.mkdirSync(outputRoot);
	fs.writeFileSync(sourcePath, "generated");
	fs.writeFileSync(externalPath, "not a generated output");
	fs.writeFileSync(unsupportedPath, "not an image");

	try {
		assert.equal(validateGeneratedImageSource(sourcePath, outputRoot), fs.realpathSync(sourcePath));
		assert.throws(
			() => validateGeneratedImageSource(externalPath, outputRoot),
			/outside the configured ComfyUI output directory/,
		);
		assert.throws(
			() => validateGeneratedImageSource(unsupportedPath, outputRoot),
			/Unsupported generated image type/,
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("ComfyUI output root follows project config and explicit environment overrides", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "teach-image-config-"));
	const configDir = path.join(root, ".pi");
	const configPath = path.join(configDir, "comfyui-paint.json");
	const oldOutputDir = process.env.COMFYUI_OUTPUT_DIR;
	fs.mkdirSync(configDir);
	fs.writeFileSync(configPath, JSON.stringify({ outputDir: ".pi/paint-jobs" }));

	try {
		delete process.env.COMFYUI_OUTPUT_DIR;
		assert.equal(resolvePaintOutputRoot(root), path.join(root, ".pi", "paint-jobs"));
		process.env.COMFYUI_OUTPUT_DIR = "custom-output";
		assert.equal(resolvePaintOutputRoot(root), path.join(root, "custom-output"));
	} finally {
		if (oldOutputDir === undefined) delete process.env.COMFYUI_OUTPUT_DIR;
		else process.env.COMFYUI_OUTPUT_DIR = oldOutputDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
