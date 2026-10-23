import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(repoRoot, "..");

function readAgent(name) {
	const source = fs.readFileSync(path.join(repoRoot, "agents", `${name}.md`), "utf-8");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1];
	assert.ok(frontmatter, `${name} should have YAML frontmatter`);
	return { source, frontmatter };
}

test("researcher agent uses tintinweb pi-subagents metadata and restricted built-ins", () => {
	const { source, frontmatter } = readAgent("researcher");
	assert.match(frontmatter, /^tools: bash, read$/m);
	assert.match(frontmatter, /^extensions: false$/m);
	assert.match(frontmatter, /^prompt_mode: append$/m);
	assert.doesNotMatch(frontmatter, /system-prompt:|auto-exit:|safe_bash|web_search|web_fetch/);
	assert.match(source, /read-only HTTP GET requests/);
});

for (const [name, toolFile, toolNames] of [
	["mermaid-maker", "mermaid_tools.ts", ["write_mermaid", "edit_mermaid", "render_mermaid"]],
	["svg-maker", "svg_tools.ts", ["write_svg", "edit_svg", "render_svg"]],
]) {
	test(`${name} loads only its visual-tool extension and declared tools`, () => {
		const { frontmatter } = readAgent(name);
		const extensionLine = /^extensions:\s*(.+)$/m.exec(frontmatter)?.[1];
		assert.ok(extensionLine, `${name} must declare its extension path`);
		const extensionPath = path.resolve(projectRoot, extensionLine);
		assert.equal(path.basename(extensionPath), toolFile);
		assert.ok(fs.statSync(extensionPath).isFile());
		for (const toolName of toolNames) assert.match(frontmatter, new RegExp(`ext:${path.basename(toolFile, ".ts")}/${toolName}`));
		assert.match(frontmatter, /^prompt_mode: append$/m);
		assert.doesNotMatch(frontmatter, /system-prompt:|auto-exit:/);
	});
}
