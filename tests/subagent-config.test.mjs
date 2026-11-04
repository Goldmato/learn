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
	assert.match(frontmatter, /^tools: read, bash, ext:csv_tools\/csv_query$/m);
	assert.match(frontmatter, /^model: explabs\/claude-sonnet-5\.5$/m);
	assert.match(frontmatter, /^thinking: medium$/m);
	assert.match(frontmatter, /^prompt_mode: append$/m);
	assert.match(source, /Use subagent researcher\(s\) when needed/);
	assert.match(source, /Do not write AI-to-AI dispatch instructions/);
	assert.match(source, /%% curriculum-plan:start v1 %%/);
	assert.match(source, /%% curriculum-plan:end v1 %%/);
	assert.match(source, /never silently switch models/);
});

test("teaching skill requires per-dispatch consent and persists returned plans", () => {
	const skill = fs.readFileSync(path.join(repoRoot, "skills", "teach", "SKILL.md"), "utf-8");
	assert.match(skill, /Use the `curriculum-orchestrator` only when this phase genuinely needs a detailed plan\/map/);
	assert.match(skill, /Before every dispatch, ask for explicit permission with `ask_user_question`/);
	assert.match(skill, /If the user declines, cancels, gives any other answer, or the consent UI is unavailable, do not dispatch/);
	assert.match(skill, /If dispatch reports that `gemini-4-argon` is unavailable, do not substitute another model/);
	assert.match(skill, /%% curriculum-plan:start v1 %%/);
	assert.match(skill, /%% curriculum-plan:end v1 %%/);
	assert.match(skill, /one focused `researcher` agent/);
});

test("teaching mastery records immediate weighted evidence and uses a clean-room cross-provider critic", () => {
	const skill = fs.readFileSync(path.join(repoRoot, "skills", "teach", "SKILL.md"), "utf-8");
	assert.match(skill, /Supply `conceptId` on every teaching `quiz`/);
	assert.match(skill, /A mastery score is available from the first recorded event/);
	assert.match(skill, /A baseline is a purpose, not a question format/);
	assert.match(skill, /teach_record_round_assessment/);
	assert.match(skill, /never target a fixed count or pad/);
	assert.match(skill, /A multiple-choice answer tests recognition among those options/);
	assert.match(skill, /rather than repeating one convenient template/);
	assert.match(skill, /If the learner requests listening or chooses a mixed language-practice round/);
	assert.match(skill, /Choose media from the learning objective, not from a blanket/);
	assert.match(skill, /explicitly set `executionMode`/);
	assert.match(skill, /0\.8–1\.0/);
	assert.match(skill, /Do not include mastery scores, prior learner history/);
	assert.match(skill, /If the selected model\/provider or Agent tool is unavailable, proceed without critique/);
	assert.match(skill, /question-specific 3–5 word `summaryTitle`/);

	for (const [name, model, oppositeProvider] of [
		["mastery-critic-anthropic", "explabs/claude-haiku-5.5", "OpenAI"],
		["mastery-critic-google", "google/gemini-3-flash-latest", "Anthropic"],
		["mastery-critic-openai", "explabs/gpt-6-luna", "Google"],
	]) {
		const { source, frontmatter } = readAgent(name);
		assert.match(frontmatter, new RegExp(`^model: ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
		assert.match(frontmatter, /^tools: none$/m);
		assert.match(frontmatter, /^thinking: medium$/m);
		assert.match(frontmatter, /^prompt_mode: append$/m);
		assert.match(source, new RegExp(`when the main model is from ${oppositeProvider}`, "i"));
		assert.match(source, /do not inspect files/);
		assert.match(source, /Never include or request prior mastery/);
		assert.match(source, /Do not produce hidden chain-of-thought/);
	}
});

test("quiz and Breeze guidance distinguish language modalities and preserve diagnostic quality", () => {
	const quiz = fs.readFileSync(path.join(repoRoot, "extensions", "quiz.ts"), "utf-8");
	const breeze = fs.readFileSync(path.join(repoRoot, "extensions", "teach-breeze-tts.ts"), "utf-8");
	const learningTools = fs.readFileSync(path.join(repoRoot, "extensions", "teach-learning-tools.ts"), "utf-8");
	assert.match(quiz, /Do not make every item the same/);
	assert.match(quiz, /A correct selected option is evidence only for that narrowly tested recognition decision/);
	assert.match(quiz, /if the learner requested listening or chose a mixed language-practice round/i);
	assert.match(learningTools, /Do not treat an unspecified 'blend' as text-only by default/);
	assert.match(breeze, /an explicitly requested listening objective or a learner-selected mixed listening\/read\/retrieval round/i);
	assert.match(breeze, /do not expose the source sentence, pinyin, translation, or audio transcript until after the learner responds/i);
});

test("Breeze TTS subagent has only its audio-generation tool", () => {
	const { source, frontmatter } = readAgent("breeze-tts-maker");
	assert.match(frontmatter, /^tools: ext:breeze-tts\/teach_breeze_generate_audio$/m);
	assert.match(frontmatter, /^extensions: \.pi\\agents\\extensions\\breeze-tts\.ts$/m);
	assert.match(frontmatter, /^inherit_context: false$/m);
	assert.match(frontmatter, /^prompt_mode: replace$/m);
	assert.match(source, /For `exact`, speak `narrationText` verbatim/);
	assert.match(source, /For `interpretive`/);
	assert.match(source, /expressive dramatic quirky/);
	assert.match(source, /Do not inspect or edit the linked note/);
	assert.match(source, /main agent validates and places the generated audio/i);
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
		assert.ok(extensionLine, `${name} must declare its extension paths`);
		const extensionPaths = extensionLine.split(",").map((entry) => path.resolve(projectRoot, entry.trim()));
		const extensionPath = extensionPaths.find((candidate) => path.basename(candidate) === toolFile);
		assert.ok(extensionPath, `${name} must load ${toolFile}`);
		for (const candidate of extensionPaths) assert.ok(fs.statSync(candidate).isFile(), candidate);
		for (const toolName of toolNames) assert.match(frontmatter, new RegExp(`ext:${path.basename(toolFile, ".ts")}/${toolName}`));
		assert.match(frontmatter, /ext:teach-visual-attachment\/teach_attach_generated_visual/);
		assert.ok(extensionPaths.some((candidate) => path.basename(candidate) === "teach-visual-attachment.ts"));
		assert.match(frontmatter, /^prompt_mode: append$/m);
		assert.doesNotMatch(frontmatter, /system-prompt:|auto-exit:/);
	});
}
