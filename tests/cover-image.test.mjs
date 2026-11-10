import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	buildMossResolutionVariables,
	createMossCoverWorkflow,
	MOSS_COVER_HEIGHT,
	MOSS_COVER_WIDTH,
} from "../lib/comfyui-image-policy.ts";
import {
	coverSourceExcerpt,
	coverFolderBorderStyle,
	coverTextBoxCanRender,
	noteBodyForCover,
	normalizeCoverOverview,
	prepareCoverBoxes,
	resolveCoverNoteTarget,
	updateCoverFrontmatter,
} from "../lib/cover-image-policy.ts";

test("cover text capacity is language-aware and rejects undersized boxes", () => {
	const box = { width: 0.3, height: 0.3 };
	assert.equal(coverTextBoxCanRender("ABCD", box), true);
	assert.equal(coverTextBoxCanRender("漢字かな", box), false);
	assert.equal(coverTextBoxCanRender("A", { width: 0.2, height: 0.1 }), false);
	assert.equal(coverTextBoxCanRender("   ", box), false);

	const prepared = prepareCoverBoxes([
		{ x: 0, y: 0, width: 0.3, height: 0.3, text: "漢字かな", description: "A title" },
		{ x: 0.4, y: 0.2, width: 0.3, height: 0.3, text: "ABCD" },
		{ x: 0.1, y: 0.1, width: 0.4, height: 0.3, kind: "text" },
	]);
	assert.equal(prepared.omittedTextCount, 2);
	assert.equal(prepared.boxes[0].kind, "object");
	assert.equal(prepared.boxes[0].text, undefined);
	assert.equal(prepared.boxes[1].text, "ABCD");
	assert.equal(prepared.boxes[2].kind, "object");
});

test("cover borders are stable within folders and distinct for the known vault folders", () => {
	const learning = coverFolderBorderStyle("100-Learning");
	assert.equal(coverFolderBorderStyle("100-Learning"), learning);
	assert.notEqual(coverFolderBorderStyle("200-Reviewing"), learning);
	assert.notEqual(coverFolderBorderStyle("300-Practicing"), learning);
	assert.notEqual(coverFolderBorderStyle("200-Reviewing"), coverFolderBorderStyle("300-Practicing"));
	assert.equal(coverFolderBorderStyle("Other Folder"), coverFolderBorderStyle("Other Folder"));
	assert.throws(() => coverFolderBorderStyle("  "), /must not be empty/);
});

test("cover frontmatter updates preserve existing note content, BOM, and line endings", () => {
	const original = "\uFEFF---\r\ntitle: Existing\r\ntags:\r\n  - learning\r\n---\r\n\r\nLesson body.\r\n";
	const updated = updateCoverFrontmatter(
		original,
		"[[001-Attachments/~covers/topic-cover.png]]",
		'This lesson explains how spaced practice strengthens recall.',
	);
	assert.ok(updated.startsWith("\uFEFF---\r\n"));
	assert.ok(updated.includes('overview: "This lesson explains how spaced practice strengthens recall."'));
	assert.ok(updated.endsWith("Lesson body.\r\n"));
	const replaced = updateCoverFrontmatter(
		updated,
		"[[new.png]]",
		"This lesson explains how spaced practice strengthens recall.",
	);
	assert.equal(replaced.match(/^cover:/gm)?.length, 1);
	assert.equal(replaced.match(/^overview:/gm)?.length, 1);
	assert.throws(
		() => updateCoverFrontmatter(
			"---\ncover: old\ncover: older\n---\nBody\n",
			"[[new.png]]",
			"This lesson explains how spaced practice strengthens recall.",
		),
		/duplicate root-level cover properties/,
	);
	assert.equal(
		updateCoverFrontmatter(
			"# Title\n\nBody\n",
			"[[new.png]]",
			"This lesson explains how spaced practice strengthens recall.",
		),
		'---\ncover: "[[new.png]]"\noverview: "This lesson explains how spaced practice strengthens recall."\n---\n# Title\n\nBody\n',
	);
	assert.throws(() => normalizeCoverOverview(" \n "), /non-whitespace/);
	assert.throws(() => normalizeCoverOverview("x".repeat(55)), /56–64 characters/);
	assert.throws(() => normalizeCoverOverview("x".repeat(65)), /56–64 characters/);
	assert.equal(normalizeCoverOverview("A".repeat(56)).length, 56);
	assert.equal(normalizeCoverOverview("A".repeat(64)).length, 64);
	assert.equal(normalizeCoverOverview(`${"A".repeat(28)}\n${"B".repeat(28)}`), `${"A".repeat(28)} ${"B".repeat(28)}`);
	assert.throws(
		() => updateCoverFrontmatter(
			"---\noverview: old\noverview: older\n---\nBody\n",
			"[[new.png]]",
			"This lesson explains how spaced practice strengthens recall.",
		),
		/duplicate root-level overview properties/,
	);
});

test("cover-only MOSS graph bypasses SeedVR2 and uses aligned native cover resolution", () => {
	const workflowPath = new URL("../comfyui_workflows/MOSS_Image_4Step_SeedVR2_API.json", import.meta.url);
	const sourceWorkflow = JSON.parse(fs.readFileSync(workflowPath, "utf-8"));
	const coverWorkflow = createMossCoverWorkflow(sourceWorkflow);
	assert.deepEqual(coverWorkflow["13"].inputs.images, ["39:30", 0]);
	assert.equal(coverWorkflow["39:30"].class_type, "VAEDecode");
	assert.equal(coverWorkflow["105:116"], undefined);
	assert.equal(coverWorkflow["106"], undefined);
	assert.equal(sourceWorkflow["13"].inputs.images[0], "105:116");
	assert.deepEqual(
		buildMossResolutionVariables({
			Resolution: { keys: ["width", "height", "batch_size"], defaults: [1024, 1536, 1] },
		}, MOSS_COVER_WIDTH, MOSS_COVER_HEIGHT),
		{ Resolution: [1088, 720, 1] },
	);
	assert.throws(() => buildMossResolutionVariables({}, 1088, 720), /missing a usable/);
});

test("cover source excludes frontmatter and bounds long notes with opening and later content", () => {
	assert.equal(noteBodyForCover("---\ntitle: Lesson\n---\n\nBody\n"), "Body");
	const longNote = `---\ntitle: Lesson\n---\n# First idea\n${"opening ".repeat(1_500)}\n# Later lesson\n${"later ".repeat(1_500)}`;
	const excerpt = coverSourceExcerpt(longNote, 2_000);
	assert.ok(excerpt.length <= 2_000);
	assert.match(excerpt, /# First idea/);
	assert.match(excerpt, /# Later lesson/);
	assert.match(excerpt, /Middle excerpt/);
	assert.match(excerpt, /Later excerpt/);
});

function createVaultFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cover-image-test-"));
	const vaultRoot = path.join(root, "Vault With Space");
	fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
	const notePath = path.join(vaultRoot, "topic.md");
	fs.writeFileSync(notePath, "---\ntitle: Topic\n---\n\nA useful lesson about careful decisions.\n", "utf-8");
	return { root, vaultRoot, notePath };
}

test("/cover-image resolves native @file and linked-note targets inside an Obsidian vault", () => {
	const fixture = createVaultFixture();
	try {
		assert.deepEqual(
			resolveCoverNoteTarget(`@${fixture.notePath}`, undefined, fixture.root),
			{ notePath: fixture.notePath, vaultRoot: fixture.vaultRoot },
		);
		assert.deepEqual(
			resolveCoverNoteTarget("", fixture.notePath, fixture.root),
			{ notePath: fixture.notePath, vaultRoot: fixture.vaultRoot },
		);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("/cover-image rejects non-Markdown and non-vault targets", () => {
	const fixture = createVaultFixture();
	try {
		assert.throws(
			() => resolveCoverNoteTarget("@C:\\outside.txt", undefined, fixture.root),
			/Markdown/,
		);
		const outsidePath = path.join(fixture.root, "outside.md");
		fs.writeFileSync(outsidePath, "# Outside\n", "utf-8");
		assert.throws(
			() => resolveCoverNoteTarget(`@${outsidePath}`, undefined, fixture.root),
			/Obsidian vault/,
		);
	} finally {
		fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("/cover-image command and tool keep generation automatic and request-bound", () => {
	const extension = fs.readFileSync(new URL("../extensions/cover-image.ts", import.meta.url), "utf-8");
	assert.match(extension, /pi\.registerCommand\("cover-image"/);
	assert.match(extension, /customType: "cover-image-request"/);
	assert.match(extension, /triggerTurn: true/);
	assert.match(extension, /name: "cover_image_generate"/);
	const toolRegistration = extension.slice(extension.indexOf("pi.registerTool({"), extension.indexOf("async execute"));
	assert.ok(toolRegistration.length > 0, "cover generation tool registration must be present");
	assert.doesNotMatch(toolRegistration, /\$\{request\.|request\.folderBorderStyle/, "registration guidance must not access per-request state");
	assert.match(toolRegistration, /folder-specific border style supplied in the active \/cover-image request/);
	assert.match(extension, /This cover request is missing or expired/);
	assert.match(extension, /folderBorderStyle/);
	assert.match(extension, /native 1088x720 output with no upscaling/);
	assert.match(extension, /overview: Type\.String/);
	assert.match(extension, /exactly 56–64 characters inclusive/);
	assert.match(extension, /writeNoteAtomically\(request\.notePath/);
	assert.match(extension, /001-Attachments\/~covers/);
});
