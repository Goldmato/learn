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
	assert.match(frontmatter, /^tools: bash, read, ext:csv_tools\/csv_query$/m);
	assert.match(frontmatter, /^extensions: \.pi\\extensions\\csv_tools\.ts$/m);
	assert.match(frontmatter, /^prompt_mode: append$/m);
	assert.doesNotMatch(frontmatter, /system-prompt:|auto-exit:|safe_bash|web_search|web_fetch/);
	assert.match(source, /For local CSV research, use `csv_query` rather than dumping the whole file/);
	assert.match(source, /read-only HTTP GET requests/);
	assert.match(source, /www\.bing\.com\/search/);
	assert.match(source, /html\.duckduckgo\.com\/html\//);
	assert.match(source, /HTTP 200 challenge page/);
	assert.match(source, /--data-urlencode/);
	assert.match(source, /exact curl error and HTTP status/);
	assert.match(source, /Do not substitute invented results/);
});

test("researcher loads only the CSV tool extension", () => {
	const { frontmatter } = readAgent("researcher");
	const extensionPath = /^extensions:\s*(.+)$/m.exec(frontmatter)?.[1];
	assert.ok(extensionPath);
	assert.equal(path.resolve(projectRoot, extensionPath), path.join(repoRoot, "extensions", "csv_tools.ts"));
	assert.match(frontmatter, /ext:csv_tools\/csv_query/);
});

test("curriculum orchestrator uses the requested model and bounded agent tools", () => {
	const { source, frontmatter } = readAgent("curriculum-orchestrator");
	assert.match(frontmatter, /^tools: read, Agent$/m);
	assert.match(frontmatter, /^model: gpt-6\.1-sol$/m);
	assert.match(frontmatter, /^thinking: medium$/m);
	assert.match(frontmatter, /^prompt_mode: append$/m);
	assert.match(source, /one focused, foreground researcher call by default/);
	assert.match(source, /at most one additional researcher/);
	assert.match(source, /Do not launch agents in parallel/);
	assert.match(source, /%% curriculum-plan:start v1 %%/);
	assert.match(source, /%% curriculum-plan:end v1 %%/);
	assert.match(source, /never silently switch models/);
});

test("teaching skill requires per-dispatch consent and persists returned plans", () => {
	const skill = fs.readFileSync(path.join(repoRoot, "skills", "teach", "SKILL.md"), "utf-8");
	assert.match(skill, /Use the `curriculum-orchestrator` only when this phase genuinely needs a detailed plan\/map/);
	assert.match(skill, /Before every dispatch, ask for explicit permission with `ask_user_question`/);
	assert.match(skill, /If the user declines, cancels, gives any other answer, or the consent UI is unavailable, do not dispatch/);
	assert.match(skill, /If dispatch reports that `gpt-6\.1-sol` is unavailable, do not substitute another model/);
	assert.match(skill, /%% curriculum-plan:start v1 %%/);
	assert.match(skill, /%% curriculum-plan:end v1 %%/);
	assert.match(skill, /one focused `researcher` subagent/);
});

test("teaching mastery uses three evidence samples and a clean-room cross-provider critic", () => {
	const skill = fs.readFileSync(path.join(repoRoot, "skills", "teach", "SKILL.md"), "utf-8");
	assert.match(skill, /Supply `conceptId` on every teaching `quiz`/);
	assert.match(skill, /three distinct graded questions/);
	assert.match(skill, /0\.8–1\.0/);
	assert.match(skill, /Do not include mastery scores, prior learner history/);
	assert.match(skill, /If the selected model\/provider or Agent tool is unavailable, proceed without critique/);
	assert.match(skill, /question-specific 3–5 word `summaryTitle`/);

	for (const [name, model, oppositeProvider] of [
		["mastery-critic-anthropic", "explabs/claude-haiku-5.5", "OpenAI"],
		["mastery-critic-google", "google/gemini-3-flash-preview", "Anthropic"],
		["mastery-critic-openai", "explabs/gpt-6-luna", "Google"],
	]) {
		const { source, frontmatter } = readAgent(name);
		assert.match(frontmatter, new RegExp(`^model: ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
		assert.match(frontmatter, /^tools: none$/m);
		assert.match(frontmatter, /^thinking: low$/m);
		assert.match(frontmatter, /^prompt_mode: append$/m);
		assert.match(source, new RegExp(`when the main model is from ${oppositeProvider}`, "i"));
		assert.match(source, /do not inspect files/);
		assert.match(source, /Never include or request prior mastery/);
		assert.match(source, /Do not produce hidden chain-of-thought/);
	}
});

test("Breeze TTS subagent has only its generation-and-attachment tool", () => {
	const { source, frontmatter } = readAgent("breeze-tts-maker");
	assert.match(frontmatter, /^tools: ext:breeze-tts\/teach_breeze_generate_and_attach$/m);
	assert.match(frontmatter, /^extensions: \.pi\\agents\\extensions\\breeze-tts\.ts$/m);
	assert.match(frontmatter, /^inherit_context: false$/m);
	assert.match(frontmatter, /^prompt_mode: replace$/m);
	assert.match(source, /parenthetical expression and delivery cues/);
	assert.match(source, /sardonic mid-century corporate science executive/);
	assert.match(source, /clone presets use a random matching local WAV\/transcript pair/);
	assert.match(source, /standard preset uses Breeze's non-clone voice-design task/);
	const extensionPath = /^extensions:\s*(.+)$/m.exec(frontmatter)?.[1];
	assert.ok(extensionPath);
	assert.equal(path.resolve(projectRoot, extensionPath), path.join(repoRoot, "agents", "extensions", "breeze-tts.ts"));
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
