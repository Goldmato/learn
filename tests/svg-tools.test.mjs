import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSvgViewport, default as registerSvgTools } from "../extensions/visual-tools/tools/svg_tools.ts";
import { EXTRA_PATH, findChrome, publish, STAGING_ROOT } from "../extensions/visual-tools/tools/_common.ts";

function hasCommand(command) {
	const pathExtensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	return [...EXTRA_PATH, ...(process.env.PATH ?? "").split(path.delimiter)].some((directory) =>
		pathExtensions.some((extension) => fs.existsSync(path.join(directory, `${command}${extension}`))),
	);
}

test("SVG viewport respects intrinsic dimensions and scales oversized canvases", () => {
	assert.deepEqual(getSvgViewport('<svg width="640" height="360"></svg>'), { width: 640, height: 360 });
	assert.deepEqual(getSvgViewport('<svg viewBox="0 0 1600 900"></svg>'), { width: 1600, height: 900 });
	assert.deepEqual(getSvgViewport('<svg width="5in" viewBox="0 0 600 300"></svg>'), { width: 480, height: 240 });
	assert.deepEqual(getSvgViewport('<svg width="3200" height="2400"></svg>'), { width: 1600, height: 1200 });
});

test("visual publish places Mermaid diagrams in their dedicated vault attachment folder", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "visual-publish-mermaid-"));
	const cwd = process.cwd();
	fs.writeFileSync(path.join(root, "preview.png"), "rendered diagram");

	try {
		process.chdir(root);
		const published = publish(path.join(root, "preview.png"), "sample-diagram", "~mermaid");
		assert.match(published.filename, /^mermaid-sample-diagram-\d+\.png$/);
		assert.equal(path.dirname(published.path), path.join(root, "001-Attachments", "~mermaid"));
		assert.equal(fs.readFileSync(published.path, "utf-8"), "rendered diagram");
	} finally {
		process.chdir(cwd);
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("SVG tools render and publish a PNG with an available system renderer", async (t) => {
	if (!findChrome() && !hasCommand("rsvg-convert") && !hasCommand("magick")) {
		t.skip("No rsvg-convert, ImageMagick, or Chrome/Chromium renderer is installed.");
		return;
	}

	const cwd = process.cwd();
	const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "svg-tools-test-"));
	const sessionPath = path.join(STAGING_ROOT, `svg-${process.pid}`);
	process.chdir(tempRoot);
	try {
		const tools = new Map();
		registerSvgTools({ registerTool: (tool) => tools.set(tool.name, tool) });
		const writeSvg = tools.get("write_svg");
		const renderSvg = tools.get("render_svg");
		assert.ok(writeSvg);
		assert.ok(renderSvg);

		await writeSvg.execute("write", {
			source: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#ffffff"/><circle cx="160" cy="90" r="60" fill="#d33"/></svg>',
		});
		const result = await renderSvg.execute("render", { save_as: "render-check" });
		assert.equal(result.details.ok, true);
		assert.match(result.details.renderer, /^(rsvg-convert|ImageMagick|Chrome\/Chromium)$/);
		assert.match(result.details.path, /svg-render-check-\d+\.png$/);
		assert.equal(path.dirname(result.details.path), path.join(tempRoot, "001-Attachments", "~svg"));
		assert.ok(fs.existsSync(result.details.path));
		assert.ok(result.content.some((part) => part.type === "image" && part.mimeType === "image/png"));
	} finally {
		process.chdir(cwd);
		fs.rmSync(tempRoot, { recursive: true, force: true });
		fs.rmSync(sessionPath, { recursive: true, force: true });
	}
});
